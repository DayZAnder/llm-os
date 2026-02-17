import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './kernel/config.js';
import { generate, generateProcess } from './kernel/gateway.js';
import { analyze, analyzeDockerfile } from './kernel/analyzer.js';
import { proposeCapabilities, grantCapabilities, getAppStorage, checkCapability, inferAppType } from './kernel/capabilities.js';
import { dockerPing } from './kernel/docker/client.js';
import { buildImage, launchContainer, stopContainer, healthCheck, getContainerLogs, listProcesses } from './kernel/docker/process-manager.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Per-app storage (in-memory for prototype)
const appStorageMap = new Map();

function getStorage(appId) {
  if (!appStorageMap.has(appId)) appStorageMap.set(appId, new Map());
  return appStorageMap.get(appId);
}

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

async function handleAPI(method, url, body, res) {
  try {
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
      let ollama = false;
      let claude = !!config.claude.apiKey;
      let docker = false;

      try {
        const r = await fetch(`${config.ollama.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        ollama = r.ok;
      } catch {}

      if (config.docker.enabled) {
        try { docker = await dockerPing(); } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ollama, claude, docker }));
      return;
    }

    // GET /api/storage/:appId/:key — read storage
    const storageGetMatch = url.match(/^\/api\/storage\/([^/]+)\/(.+)$/);
    if (method === 'GET' && storageGetMatch) {
      const [, appId, key] = storageGetMatch;
      const store = getStorage(appId);
      const value = store.get(decodeURIComponent(key)) ?? null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value }));
      return;
    }

    // PUT /api/storage/:appId/:key — write storage
    const storagePutMatch = url.match(/^\/api\/storage\/([^/]+)\/(.+)$/);
    if (method === 'PUT' && storagePutMatch) {
      const [, appId, key] = storagePutMatch;
      const { value } = JSON.parse(body);
      const store = getStorage(appId);
      store.set(decodeURIComponent(key), value);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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

    res.writeHead(404);
    res.end('API not found');
  } catch (err) {
    console.error('[server] API error:', err);
    res.writeHead(500);
    res.end(err.message);
  }
}

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url.startsWith('/api/')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => handleAPI(req.method, url, body, res));
  } else {
    serveStatic(url, res);
  }
});

server.listen(config.port, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║           LLM OS v0.1.0             ║
  ║                                      ║
  ║  http://localhost:${config.port}              ║
  ║                                      ║
  ║  Ollama: ${config.ollama.url}  ║
  ║  Claude: ${config.claude.apiKey ? 'configured' : 'not configured (add ANTHROPIC_API_KEY)'}       ║
  ╚══════════════════════════════════════╝
  `);
});
