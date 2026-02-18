// Process app lifecycle management.
// Build, run, stop, health check, port allocation, logs.

import { dockerRequest, dockerStream } from './client.js';
import { config } from '../config.js';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const allocatedPorts = new Set();
const processes = new Map();

/**
 * @typedef {object} ProcessInfo
 * @property {string} appId
 * @property {string} containerId
 * @property {string} containerName
 * @property {number} port
 * @property {'building'|'starting'|'running'|'stopped'|'failed'} status
 * @property {string} title
 * @property {string[]} capabilities
 * @property {boolean} hasWebUI
 * @property {number} createdAt
 */

function allocatePort() {
  const { portStart, portEnd } = config.docker;
  for (let port = portStart; port <= portEnd; port++) {
    if (!allocatedPorts.has(port)) {
      allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error(`No available ports in range ${portStart}-${portEnd}`);
}

function freePort(port) {
  allocatedPorts.delete(port);
}

/**
 * Build a Docker image from Dockerfile content.
 * Uses docker CLI (tar archive API is too complex for zero-dep prototype).
 */
export async function buildImage(appId, dockerfile, contextFiles = {}) {
  const buildDir = join(tmpdir(), `llmos-build-${appId}`);
  if (existsSync(buildDir)) rmSync(buildDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });

  writeFileSync(join(buildDir, 'Dockerfile'), dockerfile);
  for (const [filename, content] of Object.entries(contextFiles)) {
    const filePath = join(buildDir, filename);
    const dir = join(filePath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
  }

  const imageName = `llmos-${appId}`;
  try {
    execSync(`docker build -t ${imageName} "${buildDir}"`, {
      stdio: 'pipe',
      timeout: 120000,
    });
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    throw new Error(`Image build failed: ${stderr.slice(0, 500)}`);
  } finally {
    // Cleanup build dir
    try { rmSync(buildDir, { recursive: true }); } catch {}
  }

  return imageName;
}

/**
 * Launch a container from an image.
 */
export async function launchContainer(appId, imageName, capabilities = [], containerConfig = {}) {
  if (processes.size >= config.docker.maxContainers) {
    throw new Error(`Max containers reached (${config.docker.maxContainers})`);
  }

  const port = containerConfig.port ? allocatePort() : 0;
  const containerName = `llmos-${appId}`;
  const hasNetwork = capabilities.includes('process:network');
  const hasVolume = capabilities.includes('process:volume');
  const hasAnthropicKey = capabilities.includes('api:anthropic');

  // Build env vars
  const env = [
    `LLMOS_APP_ID=${appId}`,
    `LLMOS_CAPABILITIES=${capabilities.join(',')}`,
    ...(containerConfig.env || []),
  ];
  if (hasAnthropicKey && config.claude.apiKey) {
    env.push(`ANTHROPIC_API_KEY=${config.claude.apiKey}`);
  }

  // Build port bindings
  const portBindings = {};
  if (containerConfig.port && port) {
    portBindings[`${containerConfig.port}/tcp`] = [{ HostPort: String(port) }];
  }

  // Build volume bindings
  const binds = [];
  if (hasVolume) {
    const dataDir = join(process.cwd(), 'data', appId);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    binds.push(`${dataDir}:/app/data`);
  }

  // Create container
  const createBody = {
    Image: imageName,
    Env: env,
    ExposedPorts: containerConfig.port ? { [`${containerConfig.port}/tcp`]: {} } : {},
    HostConfig: {
      PortBindings: portBindings,
      Binds: binds,
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,  // no swap
      NanoCpus: 1_000_000_000,
      PidsLimit: 64,
      ReadonlyRootfs: true,
      NetworkMode: hasNetwork ? 'bridge' : 'none',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
      Ulimits: [
        { Name: 'nofile', Soft: 1024, Hard: 2048 },
      ],
    },
  };

  let containerId;
  try {
    const result = await dockerRequest('POST', `/containers/create?name=${containerName}`, createBody);
    containerId = result.Id;
  } catch (err) {
    if (port) freePort(port);
    throw err;
  }

  // Start container
  try {
    await dockerRequest('POST', `/containers/${containerId}/start`);
  } catch (err) {
    if (port) freePort(port);
    try { await dockerRequest('DELETE', `/containers/${containerId}`); } catch {}
    throw err;
  }

  const processInfo = {
    appId,
    containerId,
    containerName,
    port,
    status: 'starting',
    title: containerConfig.title || appId,
    capabilities,
    hasWebUI: !!containerConfig.port,
    createdAt: Date.now(),
  };

  processes.set(appId, processInfo);

  // Check status after a short delay
  setTimeout(async () => {
    try {
      const health = await healthCheck(appId);
      if (health.running) processInfo.status = 'running';
      else processInfo.status = 'failed';
    } catch {
      processInfo.status = 'failed';
    }
  }, 3000);

  // Wall clock timeout — kill after 30 minutes
  const CONTAINER_TIMEOUT_MS = 30 * 60 * 1000;
  setTimeout(async () => {
    if (processes.has(appId)) {
      console.log(`[process-mgr] Timeout: killing ${appId} after 30 minutes`);
      try { await stopContainer(appId); } catch {}
    }
  }, CONTAINER_TIMEOUT_MS);

  return processInfo;
}

/**
 * Stop and remove a container.
 */
export async function stopContainer(appId) {
  const proc = processes.get(appId);
  if (!proc) throw new Error(`Process ${appId} not found`);

  try {
    await dockerRequest('POST', `/containers/${proc.containerId}/stop?t=5`);
  } catch {}
  try {
    await dockerRequest('DELETE', `/containers/${proc.containerId}`);
  } catch {}

  if (proc.port) freePort(proc.port);
  processes.delete(appId);
}

/**
 * Get container health/status.
 */
export async function healthCheck(appId) {
  const proc = processes.get(appId);
  if (!proc) return { running: false, status: 'not_found' };

  try {
    const info = await dockerRequest('GET', `/containers/${proc.containerId}/json`);
    const running = info.State?.Running ?? false;
    if (proc.status !== 'stopped') {
      proc.status = running ? 'running' : 'stopped';
    }
    return {
      running,
      status: info.State?.Status,
      exitCode: info.State?.ExitCode,
      startedAt: info.State?.StartedAt,
    };
  } catch {
    return { running: false, status: 'unreachable' };
  }
}

/**
 * Get container logs as a string.
 */
export async function getContainerLogs(appId, { tail = 200 } = {}) {
  const proc = processes.get(appId);
  if (!proc) throw new Error(`Process ${appId} not found`);

  const stream = await dockerStream(
    `/containers/${proc.containerId}/logs?stdout=true&stderr=true&tail=${tail}`
  );

  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => {
      // Docker log stream has 8-byte header per frame; strip it
      const raw = Buffer.concat(chunks);
      const lines = [];
      let offset = 0;
      while (offset < raw.length) {
        if (offset + 8 > raw.length) break;
        const size = raw.readUInt32BE(offset + 4);
        if (offset + 8 + size > raw.length) break;
        lines.push(raw.slice(offset + 8, offset + 8 + size).toString());
        offset += 8 + size;
      }
      resolve(lines.join(''));
    });
    stream.on('error', reject);
    setTimeout(() => resolve(chunks.map(c => c.toString()).join('')), 5000);
  });
}

/** List all active processes. */
export function listProcesses() {
  return Array.from(processes.values());
}

/** Get a specific process. */
export function getProcess(appId) {
  return processes.get(appId);
}

/** Stop all running containers (for server shutdown). */
export async function stopAll() {
  for (const appId of processes.keys()) {
    try { await stopContainer(appId); } catch {}
  }
}
