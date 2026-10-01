// Minimal Chrome DevTools Protocol driver for end-to-end tests — no npm
// dependencies, like the rest of LLM OS. Launches headless Chrome, and can
// evaluate code in the page and inside sandboxed app iframes (each is its
// own target, reached through auto-attach sessions).

import { spawn } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CANDIDATES = [
  process.env.CHROME,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Start headless Chrome and return its first page target (one retry). */
async function startChrome(bin, width, height) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const port = 9300 + Math.floor(Math.random() * 600);
    const profile = mkdtempSync(join(tmpdir(), 'llmos-e2e-chrome-'));
    const chrome = spawn(bin, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--disable-dev-shm-usage', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    let targets = [];
    // A cold start on a busy CI machine can take a while
    for (let i = 0; i < 240 && !targets.some(t => t.type === 'page') && chrome.exitCode === null; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch {}
      await sleep(250);
    }
    const page = targets.find(t => t.type === 'page');
    if (page) return { chrome, page, profile };
    chrome.kill();
    lastErr = `attempt ${attempt}: exit ${chrome.exitCode}; ${stderr.trim().split('\n').slice(-3).join(' | ')}`;
    console.error(`Chrome did not start (${lastErr})`);
  }
  throw new Error(`Chrome did not start — ${lastErr}`);
}

export async function launch({ width = 1600, height = 1000 } = {}) {
  const bin = CANDIDATES.find(p => existsSync(p));
  if (!bin) throw new Error('Chrome not found (set CHROME=/path/to/chrome)');
  const { chrome, page, profile } = await startChrome(bin, width, height);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });

  let msgId = 0;
  const pending = new Map();
  const sessions = [];
  const consoleLines = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Target.attachedToTarget') sessions.push(m.params.sessionId);
    if (m.method === 'Target.detachedFromTarget') { const i = sessions.indexOf(m.params.sessionId); if (i >= 0) sessions.splice(i, 1); }
    if (m.method === 'Runtime.exceptionThrown') consoleLines.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleLines.push('[error] ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  });
  function send(method, params = {}, sessionId) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise(r => pending.set(id, r));
  }
  /** Evaluate an expression (in the page, or an app frame's session); promises are awaited. */
  async function evaluate(expression, sessionId) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  }
  /** Poll a page expression until it is truthy. */
  async function waitFor(expression, { timeout = 15000, interval = 200, sessionId } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      let v;
      try { v = await evaluate(expression, sessionId); } catch {}
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for: ${expression.slice(0, 120)}`);
      await sleep(interval);
    }
  }
  /** Session of the sandboxed iframe running appId. */
  async function appSession(appId, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const sid of [...sessions]) {
        try {
          await send('Runtime.enable', {}, sid);
          if ((await evaluate('window.__LLMOS_APP_ID__', sid)) === appId) return sid;
        } catch {}
      }
      await sleep(300);
    }
    throw new Error(`no frame for app ${appId}`);
  }
  async function screenshot(path) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.from(r.result.data, 'base64'));
  }
  async function goto(url) {
    await send('Page.navigate', { url });
  }
  function close() {
    try { ws.close(); } catch {}
    chrome.kill();
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 1000);
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return { send, evaluate, waitFor, appSession, screenshot, goto, close, consoleLines };
}
