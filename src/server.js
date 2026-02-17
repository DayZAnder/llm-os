import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './kernel/config.js';
import { generate, generateProcess, getProviders } from './kernel/gateway.js';
import { analyze, analyzeDockerfile } from './kernel/analyzer.js';
import { proposeCapabilities, grantCapabilities, getAppStorage, checkCapability, inferAppType } from './kernel/capabilities.js';
import { dockerPing } from './kernel/docker/client.js';
import { buildImage, launchContainer, stopContainer, healthCheck, getContainerLogs, listProcesses } from './kernel/docker/process-manager.js';
import { publishApp, getApp, searchApps, browseApps, getTags, getStats, recordLaunch, deleteApp, syncCommunity, isCommunityApp } from './kernel/registry/store.js';
import { storageGet, storageSet, storageRemove, storageKeys, storageUsage, storageClear, storageExport, storageImport, storageListApps, storageExportAll, storageFlushAll } from './kernel/storage.js';
import * as scheduler from './kernel/scheduler.js';
import { tasks as selfImproveTasks } from './kernel/self-improve/index.js';
import { loadQueue, queueClaudeTask } from './kernel/self-improve/claude-agent.js';
import { loadProfile, reloadProfile, getBootApps, solidify, goEphemeral, isSolidified, getSnapshotInfo } from './kernel/profile.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(url, res) {
  // Map URLs to files
  let filePath;
  if (url === '/' || url === '/index.html') {
    filePath = join(__dirname, 'shell', 'index.html');
  } else if (url.startsWith('/sdk/')) {
    filePath = join(__dirname, '..', 'src', url.slice(1));
  } else {
    filePath = join(__dirname, 'shell', url.slice(1));
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);

  res.writeHead(200, { 'Content-Type': mime });
  res.end(content);
}

async function handleAPI(method, fullUrl, body, res) {
  const url = fullUrl.split('?')[0]; // path only for exact matching

  // Track user activity for scheduler defer
  scheduler.recordActivity();

  try {
    // --- Scheduler endpoints ---

    // GET /api/scheduler/tasks — list all tasks with state
    if (method === 'GET' && url === '/api/scheduler/tasks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scheduler.getAllTasks()));
      return;
    }

    // POST /api/scheduler/enable/:taskId
    const enableMatch = url.match(/^\/api\/scheduler\/enable\/([^/]+)$/);
    if (method === 'POST' && enableMatch) {
      const { interval } = body ? JSON.parse(body) : {};
      const result = scheduler.enableTask(enableMatch[1], interval);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/scheduler/disable/:taskId
    const disableMatch = url.match(/^\/api\/scheduler\/disable\/([^/]+)$/);
    if (method === 'POST' && disableMatch) {
      const result = scheduler.disableTask(disableMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/scheduler/run/:taskId — manual run
    const runMatch = url.match(/^\/api\/scheduler\/run\/([^/]+)$/);
    if (method === 'POST' && runMatch) {
      const result = await scheduler.runNow(runMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/scheduler/history/:taskId
    const historyMatch = url.match(/^\/api\/scheduler\/history\/([^/]+)$/);
    if (method === 'GET' && historyMatch) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scheduler.getHistory(historyMatch[1])));
      return;
    }

    // POST /api/scheduler/pause — pause all tasks
    if (method === 'POST' && url === '/api/scheduler/pause') {
      scheduler.pause();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/scheduler/resume — resume all tasks
    if (method === 'POST' && url === '/api/scheduler/resume') {
      scheduler.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/scheduler/reset/:taskId — reset circuit breaker
    const resetMatch = url.match(/^\/api\/scheduler\/reset\/([^/]+)$/);
    if (method === 'POST' && resetMatch) {
      const result = scheduler.resetCircuitBreaker(resetMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/self-improve/stats — aggregate stats
    if (method === 'GET' && url === '/api/self-improve/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scheduler.getAggregateStats()));
      return;
    }

    // --- Claude Code agent task queue ---

    // GET /api/claude-tasks — list all tasks
    if (method === 'GET' && url === '/api/claude-tasks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadQueue()));
      return;
    }

    // POST /api/claude-tasks — queue a new task
    if (method === 'POST' && url === '/api/claude-tasks') {
      const { prompt } = JSON.parse(body);
      if (!prompt) {
        res.writeHead(400);
        res.end('Missing prompt');
        return;
      }
      const task = queueClaudeTask(prompt, 'api');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    // --- OS Profile ---

    // GET /api/profile — current profile
    if (method === 'GET' && url === '/api/profile') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadProfile()));
      return;
    }

    // POST /api/profile/reload — reload profile from disk
    if (method === 'POST' && url === '/api/profile/reload') {
      const profile = reloadProfile();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(profile));
      return;
    }

    // POST /api/profile/solidify — freeze current state for reuse across boots
    if (method === 'POST' && url === '/api/profile/solidify') {
      const result = solidify();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/profile/ephemeral — switch back to regenerating on boot
    if (method === 'POST' && url === '/api/profile/ephemeral') {
      const { clearSnapshot } = body ? JSON.parse(body) : {};
      const result = goEphemeral(clearSnapshot === true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/profile/snapshot — get snapshot info
    if (method === 'GET' && url === '/api/profile/snapshot') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        solidified: isSolidified(),
        snapshot: getSnapshotInfo(),
      }));
      return;
    }

    // POST /api/generate — generate an app from prompt
    if (method === 'POST' && url === '/api/generate') {
      const { prompt } = JSON.parse(body);
      if (!prompt) {
        res.writeHead(400);
        res.end('Missing prompt');
        return;
      }

      const result = await generate(prompt);

      // Also propose capabilities based on the prompt
      const proposed = proposeCapabilities(prompt);
      // Merge with LLM-declared capabilities
      const allCaps = [...new Set([...result.capabilities, ...proposed])];
      result.capabilities = allCaps;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/analyze — run static analysis on code
    if (method === 'POST' && url === '/api/analyze') {
      const { code } = JSON.parse(body);
      const result = analyze(code);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/status — check LLM + Docker connectivity
    if (method === 'GET' && url === '/api/status') {
      const providerStatus = getProviders();
      let docker = false;

      if (config.docker.enabled) {
        try { docker = await dockerPing(); } catch {}
      }

      // Backward compat: include top-level ollama/claude booleans
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        providers: providerStatus,
        ollama: providerStatus.ollama?.available || false,
        claude: providerStatus.claude?.available || false,
        docker,
      }));
      return;
    }

    // GET /api/storage/:appId/:key — read storage
    const storageGetMatch = url.match(/^\/api\/storage\/([^/]+)\/(.+)$/);
    if (method === 'GET' && storageGetMatch) {
      const [, appId, key] = storageGetMatch;
      const value = storageGet(appId, decodeURIComponent(key));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value }));
      return;
    }

    // PUT /api/storage/:appId/:key — write storage
    const storagePutMatch = url.match(/^\/api\/storage\/([^/]+)\/(.+)$/);
    if (method === 'PUT' && storagePutMatch) {
      const [, appId, key] = storagePutMatch;
      const { value } = JSON.parse(body);
      const result = storageSet(appId, decodeURIComponent(key), value);
      if (!result.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // DELETE /api/storage/:appId/:key — remove key
    const storageDelMatch = url.match(/^\/api\/storage\/([^/]+)\/(.+)$/);
    if (method === 'DELETE' && storageDelMatch) {
      const [, appId, key] = storageDelMatch;
      storageRemove(appId, decodeURIComponent(key));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/storage/:appId — list keys + usage
    const storageInfoMatch = url.match(/^\/api\/storage\/([^/]+)$/);
    if (method === 'GET' && storageInfoMatch) {
      const appId = storageInfoMatch[1];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        keys: storageKeys(appId),
        usage: storageUsage(appId),
      }));
      return;
    }

    // DELETE /api/storage/:appId — clear all app storage
    const storageClearMatch = url.match(/^\/api\/storage\/([^/]+)$/);
    if (method === 'DELETE' && storageClearMatch) {
      storageClear(storageClearMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/storage-export/:appId — export app data
    const exportMatch = url.match(/^\/api\/storage-export\/([^/]+)$/);
    if (method === 'GET' && exportMatch) {
      const data = storageExport(exportMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    // POST /api/storage-import/:appId — import app data
    const importMatch = url.match(/^\/api\/storage-import\/([^/]+)$/);
    if (method === 'POST' && importMatch) {
      const data = JSON.parse(body);
      const result = storageImport(importMatch[1], data);
      res.writeHead(result.ok ? 200 : 413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/storage-export-all — export all apps data
    if (method === 'GET' && url === '/api/storage-export-all') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(storageExportAll()));
      return;
    }

    // --- Process app endpoints ---

    // POST /api/process/build — build Docker image
    if (method === 'POST' && url === '/api/process/build') {
      const { appId, dockerfile, context } = JSON.parse(body);
      const analysis = analyzeDockerfile(dockerfile);
      if (!analysis.passed) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dockerfile blocked by security analysis', analysis }));
        return;
      }
      const imageName = await buildImage(appId, dockerfile, context || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ imageName }));
      return;
    }

    // POST /api/process/launch — start container
    if (method === 'POST' && url === '/api/process/launch') {
      const { appId, imageName, capabilities, config: containerConfig } = JSON.parse(body);
      const result = await launchContainer(appId, imageName, capabilities, containerConfig);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/process/stop/:appId — stop container
    const stopMatch = url.match(/^\/api\/process\/stop\/([^/]+)$/);
    if (method === 'POST' && stopMatch) {
      await stopContainer(stopMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/process/status/:appId — health check
    const statusMatch = url.match(/^\/api\/process\/status\/([^/]+)$/);
    if (method === 'GET' && statusMatch) {
      const health = await healthCheck(statusMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }

    // GET /api/process/logs/:appId — container logs
    const logsMatch = url.match(/^\/api\/process\/logs\/([^/]+)$/);
    if (method === 'GET' && logsMatch) {
      const logs = await getContainerLogs(logsMatch[1]);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(logs);
      return;
    }

    // GET /api/process/list — list running containers
    if (method === 'GET' && url === '/api/process/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listProcesses()));
      return;
    }

    // POST /api/generate-process — generate a process app
    if (method === 'POST' && url === '/api/generate-process') {
      const { prompt } = JSON.parse(body);
      const result = await generateProcess(prompt);
      const proposed = proposeCapabilities(prompt);
      result.capabilities = [...new Set([...result.capabilities, ...proposed])];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // --- Registry endpoints ---

    // GET /api/registry/stats — registry overview
    if (method === 'GET' && url === '/api/registry/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStats()));
      return;
    }

    // POST /api/registry/sync — trigger community sync
    if (method === 'POST' && url === '/api/registry/sync') {
      await syncCommunity();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStats()));
      return;
    }

    // GET /api/registry/tags — all tags with counts
    if (method === 'GET' && url === '/api/registry/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getTags()));
      return;
    }

    // GET /api/registry/search?q=... — search by prompt similarity
    if (method === 'GET' && url === '/api/registry/search') {
      const params = new URL(`http://x${fullUrl}`).searchParams;
      const query = params.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(searchApps(query)));
      return;
    }

    // GET /api/registry/browse?offset=0&limit=20&tag=...&type=... — browse apps
    if (method === 'GET' && url === '/api/registry/browse') {
      const params = new URL(`http://x${fullUrl}`).searchParams;
      const result = browseApps({
        offset: parseInt(params.get('offset') || '0', 10),
        limit: parseInt(params.get('limit') || '20', 10),
        tag: params.get('tag') || null,
        type: params.get('type') || null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/registry/publish — save app to registry
    if (method === 'POST' && url === '/api/registry/publish') {
      const data = JSON.parse(body);
      const result = publishApp(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/registry/launch/:hash — record a launch from registry
    const launchMatch = url.match(/^\/api\/registry\/launch\/([a-f0-9]+)$/);
    if (method === 'POST' && launchMatch) {
      recordLaunch(launchMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/registry/:hash — get specific app
    const appMatch = url.match(/^\/api\/registry\/([a-f0-9]{16})$/);
    if (method === 'GET' && appMatch) {
      const entry = getApp(appMatch[1]);
      if (!entry) {
        res.writeHead(404);
        res.end('App not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entry));
      return;
    }

    res.writeHead(404);
    res.end('API not found');
  } catch (err) {
    console.error('[server] API error:', err);
    res.writeHead(500);
    res.end(err.message);
  }
}

// Flush storage on shutdown
process.on('SIGINT', () => { storageFlushAll(); process.exit(0); });
process.on('SIGTERM', () => { storageFlushAll(); process.exit(0); });

const server = createServer((req, res) => {
  const pathOnly = req.url.split('?')[0];

  if (pathOnly.startsWith('/api/')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    // Pass full URL (with query string) to API handler
    req.on('end', () => handleAPI(req.method, req.url, body, res));
  } else {
    serveStatic(pathOnly, res);
  }
});

const host = process.env.HOST || 'localhost';
server.listen(config.port, host, () => {
  const provs = getProviders();
  const provLines = Object.entries(provs)
    .map(([name, info]) => `  ${name}: ${info.available ? `${info.model}` : 'not configured'}`)
    .join('\n');
  console.log(`
  ╔══════════════════════════════════════╗
  ║           LLM OS v0.2.1             ║
  ║  http://localhost:${config.port}              ║
  ╚══════════════════════════════════════╝

  Providers:
${provLines}
  `);

  // Load OS profile
  const profile = loadProfile();
  const bootApps = getBootApps();
  const solid = isSolidified();
  const modeLabel = solid ? 'solidified (reusing snapshot)' : 'ephemeral';
  if (profile.name) {
    console.log(`  [profile] User: ${profile.name} | Locale: ${profile.locale} | Mode: ${modeLabel}`);
  } else {
    console.log(`  [profile] Default | Mode: ${modeLabel} (create data/profile.yaml to customize)`);
  }
  if (bootApps.length > 0 && !solid) {
    console.log(`  [profile] ${bootApps.length} boot app(s) queued for generation`);
  } else if (bootApps.length > 0 && solid) {
    console.log(`  [profile] ${bootApps.length} boot app(s) loaded from snapshot`);
  }

  // Register self-improvement tasks
  for (const taskDef of selfImproveTasks) {
    scheduler.registerTask(taskDef);
  }
  if (config.scheduler.enabled) {
    console.log(`  [scheduler] ${selfImproveTasks.length} self-improvement tasks registered`);
    console.log(`  [scheduler] Provider: ${config.scheduler.provider} | Budget: ${config.scheduler.dailyBudget}/day`);
  } else {
    console.log(`  [scheduler] Disabled (set SCHEDULER_ENABLED=true to enable)`);
  }
});
