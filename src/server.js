import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './kernel/config.js';
import { generate, generateProcess, getProviders, evolve, complete, extractManifest, generateTheme, generateDesktop, listUpgradeModels } from './kernel/gateway.js';
import { loadTheme, saveTheme, resetTheme, validateTheme } from './kernel/theme.js';
import { loadLayout, saveLayout, resetLayout, validateLayout, PRESETS as DESKTOP_PRESETS } from './kernel/desktop.js';
import { checkApiRequest } from './kernel/http-guard.js';
import * as vfs from './kernel/vfs.js';
import { request as netRequest } from './kernel/net.js';
import { analyze, analyzeDockerfile } from './kernel/analyzer.js';
import { proposeCapabilities, grantCapabilities, getAppStorage, checkCapability, inferAppType, initTokenKey, verifyToken } from './kernel/capabilities.js';
import { dockerPing } from './kernel/docker/client.js';
import { buildImage, launchContainer, stopContainer, healthCheck, getContainerLogs, listProcesses, syncRunningContainers } from './kernel/docker/process-manager.js';
import { findHandlers, getLineage, publishApp, getApp, searchApps, browseApps, getTags, getStats, recordLaunch, rateApp, updateSpec, deleteApp, syncCommunity, isCommunityApp } from './kernel/registry/store.js';
import { storageGet, storageSet, storageRemove, storageKeys, storageUsage, storageClear, storageExport, storageImport, storageListApps, storageExportAll, storageFlushAll } from './kernel/storage.js';
import * as scheduler from './kernel/scheduler.js';
import { tasks as selfImproveTasks } from './kernel/self-improve/index.js';
import { loadQueue, queueClaudeTask } from './kernel/self-improve/claude-agent.js';
import { loadProfile, reloadProfile, getBootApps, solidify, goEphemeral, isSolidified, getSnapshotInfo } from './kernel/profile.js';
import * as knowledgeBase from './kernel/knowledge.js';
import * as usageTracker from './kernel/usage-tracker.js';
import { getShellPath, listVersions as listShellVersions, getCurrentId as getShellCurrentId, getCurrentVersion as getShellCurrentVersion, setCurrentId as setShellCurrentId, readVersionHtml } from './kernel/shell-versions/store.js';
import { improveShell, addSseClient, removeSseClient, notifyShellReload } from './kernel/shell-versions/improve.js';
import { matchKnownApp } from './apps/nanoclaw.js';
import { routePrompt } from './kernel/prompt-router.js';
import { probe as probeResources, getResourceSummary } from './kernel/resource-monitor.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const VERSION = pkg.version;

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
    filePath = getShellPath();
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

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Syscalls from apps (fs, net, ai) must carry the signed capability token the
// kernel issued for that app. The shell already enforces capabilities; this
// is the second, independent check.
const FS_OP_CAPS = { list: 'fs:read', read: 'fs:read', stat: 'fs:read', write: 'fs:write', mkdir: 'fs:write', remove: 'fs:write' };

/**
 * Run a generation job and reply either as one JSON document or, when
 * streaming, as NDJSON with batched text deltas followed by the result.
 */
async function respond(res, stream, job) {
  if (!stream) {
    sendJson(res, 200, await job(undefined));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  let pending = '';
  let timer = null;
  const line = (obj) => JSON.stringify(obj) + '\n';
  const flush = () => {
    timer = null;
    if (pending) { res.write(line({ type: 'delta', text: pending })); pending = ''; }
  };
  const onText = (chunk) => {
    pending += chunk;
    if (!timer) timer = setTimeout(flush, 100);
  };
  // A provider failed mid-stream and another one starts over
  const onReset = () => {
    clearTimeout(timer);
    timer = null;
    pending = '';
    res.write(line({ type: 'reset' }));
  };
  try {
    const result = await job(onText, onReset);
    clearTimeout(timer);
    flush();
    res.end(line({ type: 'result', ...result }));
  } catch (err) {
    clearTimeout(timer);
    flush();
    console.error('[server] Streaming job failed:', err.message);
    res.end(line({ type: 'error', message: err.message }));
  }
}

async function requireCap(appId, token, cap) {
  const v = await verifyToken(token);
  if (!v.valid) return `capability token rejected (${v.error})`;
  if (v.payload.cap !== cap) return `token is for ${v.payload.cap}, not ${cap}`;
  if (v.payload.appId !== appId) return 'token belongs to another app';
  return null;
}

async function handleAPI(method, fullUrl, body, res) {
  const url = fullUrl.split('?')[0]; // path only for exact matching

  // Track user activity for scheduler defer
  scheduler.recordActivity();

  try {
    // GET /api/version — returns current version
    if (method === 'GET' && url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: VERSION }));
      return;
    }

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

    // --- Knowledge Base ---

    // GET /api/knowledge — knowledge base stats
    if (method === 'GET' && url === '/api/knowledge') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(knowledgeBase.getStats()));
      return;
    }

    // GET /api/knowledge/entries — all past generations
    if (method === 'GET' && url === '/api/knowledge/entries') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(knowledgeBase.getEntries()));
      return;
    }

    // GET /api/knowledge/similar?q=... — find similar past prompts
    if (method === 'GET' && url === '/api/knowledge/similar') {
      const params = new URL(`http://x${fullUrl}`).searchParams;
      const query = params.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(knowledgeBase.findSimilar(query)));
      return;
    }

    // --- Usage Tracking ---

    // GET /api/usage — usage stats + model breakdown + recent
    if (method === 'GET' && url === '/api/usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        stats: usageTracker.getStats(),
        byModel: usageTracker.getByModel(),
        byProvider: usageTracker.getByProvider(),
        recent: usageTracker.getRecent(20),
      }));
      return;
    }

    // DELETE /api/usage — clear usage data
    if (method === 'DELETE' && url === '/api/usage') {
      usageTracker.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/generate — generate an app from prompt
    // { force: true } skips clarification. { stream: true } answers with
    // NDJSON: {type:"delta",text} lines while the model writes, then one
    // {type:"result",...} (or {type:"error",message}) line.
    if (method === 'POST' && url === '/api/generate') {
      const { prompt, force, stream, fresh } = JSON.parse(body);
      if (!prompt) {
        res.writeHead(400);
        res.end('Missing prompt');
        return;
      }
      await respond(res, stream, async (onText, onReset) => {
        const result = await generate(prompt, { force, fresh, onText, onReset });
        if (result.needsClarification) return result;
        // Merge LLM-declared capabilities with keyword-proposed ones
        result.capabilities = [...new Set([...result.capabilities, ...proposeCapabilities(prompt)])];
        knowledgeBase.recordGeneration(prompt, result);
        return result;
      });
      return;
    }

    // POST /api/evolve — modify or repair an app: { code, instruction?, errors?, prompt?, stream? }
    if (method === 'POST' && url === '/api/evolve') {
      const input = JSON.parse(body);
      await respond(res, input.stream, async (onText, onReset) => {
        const result = await evolve(input, { onText, onReset });
        const proposed = input.instruction ? proposeCapabilities(input.instruction) : [];
        result.capabilities = [...new Set([...result.capabilities, ...proposed])];
        return result;
      });
      return;
    }

    // GET /api/models — models the user can pick to upgrade/rewrite an app
    if (method === 'GET' && url === '/api/models') {
      sendJson(res, 200, await listUpgradeModels());
      return;
    }

    // GET /api/theme — current system theme
    if (method === 'GET' && url === '/api/theme') {
      sendJson(res, 200, loadTheme());
      return;
    }

    // POST /api/theme — { description, stream? } asks the model for a theme;
    // { vars, name? } sets one directly. Both are validated before saving.
    if (method === 'POST' && url === '/api/theme') {
      const input = JSON.parse(body);
      if (input.vars) {
        const check = validateTheme(input.vars);
        if (!check.ok) { sendJson(res, 400, { error: 'Theme rejected', problems: check.problems }); return; }
        const theme = { name: String(input.name || 'Custom').slice(0, 60), description: '', vars: check.vars };
        saveTheme(theme);
        sendJson(res, 200, theme);
        return;
      }
      await respond(res, input.stream, async (onText, onReset) => {
        const theme = await generateTheme(input.description, { onText, onReset });
        saveTheme(theme);
        return theme;
      });
      return;
    }

    // GET /api/desktop — current desktop layout (+ preset names)
    if (method === 'GET' && url === '/api/desktop') {
      sendJson(res, 200, { ...loadLayout(), presets: Object.keys(DESKTOP_PRESETS) });
      return;
    }

    // POST /api/desktop — { preset } picks a built-in layout, { description, stream? }
    // asks the model, { layout } sets one directly. Always validated.
    if (method === 'POST' && url === '/api/desktop') {
      const input = JSON.parse(body);
      if (input.preset) {
        if (!DESKTOP_PRESETS[input.preset]) { sendJson(res, 400, { error: `Unknown preset: ${input.preset}` }); return; }
        const layout = { ...validateLayout(DESKTOP_PRESETS[input.preset], DESKTOP_PRESETS[input.preset]).layout, preset: input.preset };
        saveLayout(layout);
        sendJson(res, 200, layout);
        return;
      }
      if (input.layout) {
        const base = DESKTOP_PRESETS[input.layout.base] || DESKTOP_PRESETS.windows;
        const { layout, problems } = validateLayout(input.layout, base);
        if (problems.length) { sendJson(res, 400, { error: 'Layout rejected', problems }); return; }
        saveLayout({ ...layout, preset: input.layout.base || 'windows' });
        sendJson(res, 200, layout);
        return;
      }
      await respond(res, input.stream, async (onText, onReset) => {
        const layout = await generateDesktop(input.description, { onText, onReset });
        saveLayout(layout);
        return layout;
      });
      return;
    }

    // POST /api/desktop/reset — back to the classic shell
    if (method === 'POST' && url === '/api/desktop/reset') {
      sendJson(res, 200, resetLayout());
      return;
    }

    // POST /api/theme/reset — back to the default theme
    if (method === 'POST' && url === '/api/theme/reset') {
      sendJson(res, 200, resetTheme());
      return;
    }

    // POST /api/fs — filesystem syscall: { appId, token, op, path, content? }
    if (method === 'POST' && url === '/api/fs') {
      const { appId, token, op, path, content } = JSON.parse(body);
      const cap = FS_OP_CAPS[op];
      if (!cap) { sendJson(res, 400, { error: `Unknown fs op: ${op}` }); return; }
      const denied = await requireCap(appId, token, cap);
      if (denied) { sendJson(res, 403, { error: denied }); return; }
      try {
        let result;
        switch (op) {
          case 'list': result = vfs.list(path || '/'); break;
          case 'read': result = vfs.read(path); break;
          case 'stat': result = vfs.stat(path); break;
          case 'write': result = vfs.write(path, content ?? ''); break;
          case 'mkdir': result = vfs.mkdir(path); break;
          case 'remove': result = vfs.remove(path); break;
        }
        sendJson(res, 200, { result });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    // POST /api/net — HTTP proxy syscall: { appId, token, url, method?, headers?, body? }
    if (method === 'POST' && url === '/api/net') {
      const req = JSON.parse(body);
      const denied = await requireCap(req.appId, req.token, 'network:http');
      if (denied) { sendJson(res, 403, { error: denied }); return; }
      try {
        sendJson(res, 200, { result: await netRequest(req) });
      } catch (err) {
        sendJson(res, 502, { error: err.message });
      }
      return;
    }

    // POST /api/ai — language model syscall: { appId, token, prompt, system?, maxTokens? }
    if (method === 'POST' && url === '/api/ai') {
      const req = JSON.parse(body);
      const denied = await requireCap(req.appId, req.token, 'ai:generate');
      if (denied) { sendJson(res, 403, { error: denied }); return; }
      try {
        sendJson(res, 200, { result: await complete(req) });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    // GET /api/registry/handlers?path=/a/b.csv — apps that can open a file
    if (method === 'GET' && url === '/api/registry/handlers') {
      const params = new URL(`http://x${fullUrl}`).searchParams;
      const path = params.get('path') || '';
      const handlers = findHandlers(path, vfs.mimeOf(path)).slice(0, 5)
        .map(a => ({ hash: a.hash, title: a.title, manifest: a.manifest, capabilities: a.capabilities, model: a.model }));
      sendJson(res, 200, handlers);
      return;
    }

    // GET /api/registry/:hash/lineage — version history
    const lineageMatch = url.match(/^\/api\/registry\/([a-f0-9]{16})\/lineage$/);
    if (method === 'GET' && lineageMatch) {
      sendJson(res, 200, getLineage(lineageMatch[1]));
      return;
    }

    // POST /api/inject — inject pre-generated HTML as an app (bypasses LLM)
    if (method === 'POST' && url === '/api/inject') {
      const { code, title, model, provider } = JSON.parse(body);
      if (!code) {
        res.writeHead(400);
        res.end('Missing code');
        return;
      }
      const capabilities = [];
      const capMatch = code.match(/<!--\s*capabilities:\s*(\[.*?\])\s*-->/);
      if (capMatch) {
        try { capabilities.push(...JSON.parse(capMatch[1])); } catch {}
      }
      const proposed = proposeCapabilities(title || 'injected app');
      const allCaps = [...new Set([...capabilities, ...proposed])];
      const result = {
        code,
        capabilities: allCaps,
        manifest: extractManifest(code),
        model: model || 'manual',
        provider: provider || 'inject',
        complexity: 'medium',
        generationTime: 0,
        sanitization: { flagged: false, flags: [] },
      };
      knowledgeBase.recordGeneration(title || 'injected app', result);
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

    // POST /api/grant — grant capabilities and return signed tokens
    if (method === 'POST' && url === '/api/grant') {
      const { appId, capabilities } = JSON.parse(body);
      const result = await grantCapabilities(appId, capabilities);
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

    // POST /api/route — classify a prompt (LLM routing with regex fallback)
    if (method === 'POST' && url === '/api/route') {
      const { prompt } = JSON.parse(body);
      const route = await routePrompt(prompt);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(route));
      return;
    }

    // GET /api/resources — available models and resource summary
    if (method === 'GET' && url === '/api/resources') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getResourceSummary()));
      return;
    }

    // POST /api/resources/probe — force re-probe available models
    if (method === 'POST' && url === '/api/resources/probe') {
      const models = await probeResources();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: models.length, summary: getResourceSummary() }));
      return;
    }

    // POST /api/generate-process — generate a process app (or match known template)
    if (method === 'POST' && url === '/api/generate-process') {
      const { prompt } = JSON.parse(body);

      // Check known app templates first (skip LLM generation)
      const knownApp = matchKnownApp(prompt);
      if (knownApp) {
        console.log(`[server] Matched known app: ${knownApp.name}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'process',
          dockerfile: knownApp.dockerfile,
          code: knownApp.code,
          capabilities: knownApp.capabilities,
          model: 'template',
          provider: 'built-in',
          generationTime: 0,
          containerConfig: knownApp.containerConfig,
          setupInstructions: knownApp.setupInstructions,
        }));
        return;
      }

      const result = await generateProcess(prompt);
      const proposed = proposeCapabilities(prompt);
      result.capabilities = [...new Set([...result.capabilities, ...proposed])];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // --- Shell self-improvement endpoints ---

    // GET /api/shell/versions — list all shell versions (metadata only)
    if (method === 'GET' && url === '/api/shell/versions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listShellVersions()));
      return;
    }

    // GET /api/shell/current — current shell version info
    if (method === 'GET' && url === '/api/shell/current') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: getShellCurrentId(), version: getShellCurrentVersion() }));
      return;
    }

    // POST /api/shell/improve — generate an improved shell
    if (method === 'POST' && url === '/api/shell/improve') {
      const { prompt } = body ? JSON.parse(body) : {};
      const result = await improveShell(prompt || null, 'user');
      if (result.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/shell/rollback/:id — roll back to a previous version
    const shellRollbackMatch = url.match(/^\/api\/shell\/rollback\/([^/]+)$/);
    if (method === 'POST' && shellRollbackMatch) {
      const id = shellRollbackMatch[1];
      const html = readVersionHtml(id);
      if (!html) {
        res.writeHead(404);
        res.end('Version not found');
        return;
      }
      setShellCurrentId(id);
      notifyShellReload(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id }));
      return;
    }

    // GET /api/shell/version/:id/html — get full HTML of a version
    const shellHtmlMatch = url.match(/^\/api\/shell\/version\/([^/]+)\/html$/);
    if (method === 'GET' && shellHtmlMatch) {
      const html = readVersionHtml(shellHtmlMatch[1]);
      if (!html) {
        res.writeHead(404);
        res.end('Version not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
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

    // POST /api/registry/rate/:hash — rate an app (thumbs up/down)
    const rateMatch = url.match(/^\/api\/registry\/rate\/([a-f0-9]+)$/);
    if (method === 'POST' && rateMatch) {
      const { rating } = JSON.parse(body);
      const result = rateApp(rateMatch[1], rating);
      if (!result) {
        res.writeHead(404);
        res.end('App not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/registry/:hash/spec — get app spec
    const specGetMatch = url.match(/^\/api\/registry\/([a-f0-9]+)\/spec$/);
    if (method === 'GET' && specGetMatch) {
      const entry = getApp(specGetMatch[1]);
      if (!entry) { res.writeHead(404); res.end('App not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ spec: entry.spec || '' }));
      return;
    }

    // PUT /api/registry/:hash/spec — update app spec
    const specPutMatch = url.match(/^\/api\/registry\/([a-f0-9]+)\/spec$/);
    if (method === 'PUT' && specPutMatch) {
      const { spec } = JSON.parse(body);
      const result = updateSpec(specPutMatch[1], spec);
      if (result === null) { res.writeHead(404); res.end('App not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // DELETE /api/registry/:hash — delete an app from registry
    const deleteMatch = url.match(/^\/api\/registry\/([a-f0-9]{16})$/);
    if (method === 'DELETE' && deleteMatch) {
      const existed = deleteApp(deleteMatch[1]);
      if (!existed) {
        res.writeHead(404);
        res.end('App not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hash: deleteMatch[1] }));
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

// Initialize capability token signing key (session-scoped, rotates on restart)
await initTokenKey();

const MAX_BODY_BYTES = 25 * 1024 * 1024;

const server = createServer((req, res) => {
  const pathOnly = req.url.split('?')[0];

  if (pathOnly.startsWith('/api/')) {
    const verdict = checkApiRequest(req);
    if (!verdict.ok) {
      console.warn(`[server] Rejected ${req.method} ${pathOnly}: ${verdict.reason}`);
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Forbidden: ${verdict.reason}`);
      return;
    }
  }

  // SSE endpoint — handle before body collection (long-lived connection)
  if (pathOnly === '/api/shell/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':\n\n'); // comment to establish connection
    addSseClient(res);
    req.on('close', () => removeSseClient(res));
    return;
  }

  if (pathOnly.startsWith('/api/')) {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413);
        res.end('Request body too large');
        req.destroy();
        return;
      }
      body += chunk;
    });
    // Pass full URL (with query string) to API handler
    req.on('end', () => { if (size <= MAX_BODY_BYTES) handleAPI(req.method, req.url, body, res); });
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
  ║           LLM OS v${VERSION.padEnd(18)}║
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

  // Recover running containers from before restart
  syncRunningContainers().then(() => {
    const count = listProcesses().length;
    if (count > 0) console.log(`  [docker] Recovered ${count} running container(s)`);
  }).catch(() => {});

  // Probe available models (async, non-blocking)
  probeResources().then(models => {
    if (models.length > 0) {
      const best = models[0];
      const weakest = models[models.length - 1];
      console.log(`  [resources] ${models.length} model(s) available — best: ${best.name} (tier ${best.tier}), routing: ${weakest.name} (tier ${weakest.tier})`);
    } else {
      console.log('  [resources] No models detected (will use regex routing)');
    }
  }).catch(() => {});

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
