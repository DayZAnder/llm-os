// Iframe Sandbox Manager
// Creates isolated iframes, injects SDK, handles postMessage bridge
//
// This is the enforcement point for capabilities. Apps can bypass the SDK and
// postMessage the shell directly, so every message is checked here against
// the capabilities the user granted — never against what the app claims.

// Syscall → required capability (null = always allowed)
export const SYSCALL_CAPS = Object.freeze({
  'storage:get': 'storage:local',
  'storage:set': 'storage:local',
  'storage:remove': 'storage:local',
  'storage:keys': 'storage:local',
  'fs:list': 'fs:read',
  'fs:read': 'fs:read',
  'fs:stat': 'fs:read',
  'fs:write': 'fs:write',
  'fs:mkdir': 'fs:write',
  'fs:remove': 'fs:write',
  'net:request': 'network:http',
  'ai:complete': 'ai:generate',
  'clipboard:read': 'clipboard:rw',
  'clipboard:write': 'clipboard:rw',
  'ipc:publish': 'ipc:bus',
  'ipc:subscribe': 'ipc:bus',
  'notify': null,
  'confirm': null,
  'caps:has': null,
  'caps:request': null,
  'os:open': null,
  'os:setTitle': null,
  'sys:error': null,
  'sys:hotkey': null,
});

const HOTKEYS = ['switch-next', 'switch-prev', 'alt-up', 'launcher', 'upgrade'];

/**
 * Check whether an app may perform a syscall.
 * @returns {string|null} error message, or null if allowed
 */
export function checkSyscall(type, capabilities) {
  if (!Object.prototype.hasOwnProperty.call(SYSCALL_CAPS, type)) return `Unknown SDK call: ${type}`;
  const cap = SYSCALL_CAPS[type];
  if (cap && !capabilities.includes(cap)) return `Permission denied: ${type} requires capability "${cap}"`;
  return null;
}

// Design tokens shared by the shell and every app. Apps are told to use these
// CSS variables, so re-theming the OS re-themes every generated app.
export const DEFAULT_THEME = Object.freeze({
  '--llmos-bg': '#12121f',
  '--llmos-surface': '#1a1a2e',
  '--llmos-surface-2': '#24243d',
  '--llmos-fg': '#e0e0f0',
  '--llmos-muted': '#8888a8',
  '--llmos-accent': '#6c63ff',
  '--llmos-accent-fg': '#ffffff',
  '--llmos-border': '#2e2e4a',
  '--llmos-danger': '#ff5c7a',
  '--llmos-success': '#3ddc97',
  '--llmos-radius': '8px',
  '--llmos-font': "'Segoe UI', system-ui, -apple-system, sans-serif",
  '--llmos-mono': "'Cascadia Code', 'Fira Code', Consolas, monospace",
});

function themeCss(theme) {
  return Object.entries(theme)
    .filter(([k, v]) => /^--llmos-[a-z0-9-]+$/.test(k) && !/[;{}<>]/.test(String(v)))
    .map(([k, v]) => `${k}: ${v};`).join(' ');
}

const MAX_ERRORS_PER_APP = 50;

export class SandboxManager {
  constructor(containerEl, sdkCode, callbacks = {}) {
    this.container = containerEl;
    this.sdkCode = sdkCode;
    this.apps = new Map(); // appId → { iframe, capabilities, title, tokens, args, errors, topics }
    this.callbacks = callbacks; // { onStorageGet, ..., onSyscall(appId, type, payload, app), onAppError(appId, err) }
    this.theme = { ...DEFAULT_THEME };
    this._listen();
  }

  _listen() {
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.source !== 'llmos-app') return;

      // Find which app sent this — identity comes from the window, never the message
      let appId = null;
      for (const [id, app] of this.apps) {
        if (app.iframe.contentWindow === event.source) {
          appId = id;
          break;
        }
      }
      if (!appId) return;

      this._handleMessage(appId, msg);
    });
  }

  _reply(app, id, result, error) {
    if (!id) return; // fire-and-forget signal
    app.iframe.contentWindow?.postMessage(
      error ? { source: 'llmos-kernel', id, error } : { source: 'llmos-kernel', id, result },
      '*'
    );
  }

  async _handleMessage(appId, msg) {
    const { id, type } = msg;
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    const app = this.apps.get(appId);
    if (!app) return;

    const denied = checkSyscall(type, app.capabilities);
    if (denied) {
      this._reply(app, id, null, denied);
      return;
    }

    try {
      let result;

      switch (type) {
        case 'storage:get':
          result = await this.callbacks.onStorageGet?.(appId, payload.key) ?? null;
          break;
        case 'storage:set':
          await this.callbacks.onStorageSet?.(appId, payload.key, payload.value);
          result = true;
          break;
        case 'storage:remove':
          await this.callbacks.onStorageRemove?.(appId, payload.key);
          result = true;
          break;
        case 'storage:keys':
          result = await this.callbacks.onStorageKeys?.(appId) ?? [];
          break;
        case 'notify':
          result = await this.callbacks.onNotify?.(appId, String(payload.message ?? ''), payload);
          break;
        case 'confirm':
          result = await this.callbacks.onConfirm?.(appId, String(payload.message ?? ''));
          break;
        case 'caps:has':
          result = app.capabilities.includes(payload.capability);
          break;
        case 'caps:request':
          result = await this.callbacks.onCapRequest?.(appId, payload.capability) ?? false;
          break;
        case 'sys:error':
          if (app.errors.length < MAX_ERRORS_PER_APP) {
            const err = {
              message: String(payload.message ?? '').slice(0, 500),
              where: String(payload.where ?? '').slice(0, 100),
              stack: String(payload.stack ?? '').slice(0, 800),
              time: Date.now(),
            };
            app.errors.push(err);
            this.callbacks.onAppError?.(appId, err, app.errors.length);
          }
          return;
        case 'sys:hotkey':
          // Only the fixed set of OS shortcuts; an app can at most open the
          // switcher or launcher, which the user then controls.
          if (HOTKEYS.includes(payload.combo)) this.callbacks.onHotkey?.(payload.combo, appId);
          return;
        case 'ipc:subscribe':
          app.topics.add(String(payload.topic).slice(0, 100));
          result = true;
          break;
        case 'ipc:publish':
          result = this.publish(appId, String(payload.topic).slice(0, 100), payload.data);
          break;
        default:
          // fs, net, ai, clipboard, os — delegated to the shell
          if (!this.callbacks.onSyscall) throw new Error(`SDK call not supported: ${type}`);
          result = await this.callbacks.onSyscall(appId, type, payload, app);
      }

      this._reply(app, id, result);
    } catch (err) {
      this._reply(app, id, null, err.message || String(err));
    }
  }

  /** Change the design tokens for new apps and push them to running ones. */
  setTheme(vars) {
    this.theme = { ...DEFAULT_THEME };
    for (const [k, v] of Object.entries(vars || {})) {
      if (/^--llmos-[a-z0-9-]+$/.test(k) && !/[;{}<>]/.test(String(v))) this.theme[k] = String(v);
    }
    for (const app of this.apps.values()) {
      app.iframe.contentWindow?.postMessage({ source: 'llmos-kernel', event: 'theme', vars: this.theme }, '*');
    }
  }

  /** Deliver an IPC message to every other app subscribed to the topic. */
  publish(fromAppId, topic, data) {
    let delivered = 0;
    for (const [id, app] of this.apps) {
      if (id === fromAppId || !app.topics.has(topic) || !app.capabilities.includes('ipc:bus')) continue;
      app.iframe.contentWindow?.postMessage({ source: 'llmos-kernel', event: 'ipc', topic, data, from: fromAppId }, '*');
      delivered++;
    }
    return delivered;
  }

  _buildDocument(appId, code, tokens, args) {
    const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:;">
<style>
  :root { ${themeCss(this.theme)} color-scheme: dark; }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; padding: 0; font-family: var(--llmos-font); background: var(--llmos-bg); color: var(--llmos-fg); }
  #llmos-root:empty { display: none; }
  #llmos-root { width: 100%; height: 100%; }
</style>
<script>
// Kernel-provided launch context — read-only
window.__LLMOS_TOKENS__ = Object.freeze(${json(tokens)});
window.__LLMOS_ARGS__ = Object.freeze(${json(args)});
window.__LLMOS_APP_ID__ = ${json(appId)};
// LLM-OS SDK injected by kernel
${this.sdkCode}
</script>
${this._extractHead(code)}
</head>
<body>
<div id="llmos-root"></div>
${this._extractBody(code)}
</body>
</html>`;
  }

  launch(appId, code, capabilities, title, tokens = {}, args = {}) {
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts';
    iframe.style.cssText = 'width:100%;height:100%;border:none;background:var(--llmos-bg, #12121f);';
    iframe.srcdoc = this._buildDocument(appId, code, tokens, args);

    this.apps.set(appId, { iframe, capabilities: [...capabilities], title, tokens, args, errors: [], topics: new Set(), code });
    return iframe;
  }

  /**
   * Hot-swap an app's code in its existing window (used by evolve/fix).
   * Storage is keyed by appId, so the new version keeps the user's data.
   */
  replace(appId, code, capabilities, tokens = {}) {
    const app = this.apps.get(appId);
    if (!app) throw new Error(`No such app: ${appId}`);
    app.capabilities = [...capabilities];
    app.tokens = tokens;
    app.errors = [];
    app.topics = new Set();
    app.code = code;
    app.iframe.srcdoc = this._buildDocument(appId, code, tokens, app.args);
  }

  getErrors(appId) {
    return this.apps.get(appId)?.errors || [];
  }

  // Head content of a full document: scripts, styles, and nothing that could
  // redirect or loosen the page (meta refresh/CSP, base, external links).
  _extractHead(code) {
    const headMatch = code.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (!headMatch) return '';
    return headMatch[1]
      .replace(/<meta[^>]*>/gi, '')
      .replace(/<base[^>]*>/gi, '')
      .replace(/<link[^>]*>/gi, '')
      .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
  }

  _extractBody(code) {
    // Full HTML doc — the body; head content is handled by _extractHead
    const bodyMatch = code.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
      // Models sometimes put scripts after </body> — keep them
      const tail = code.slice(code.search(/<\/body>/i));
      const trailing = tail.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
      return bodyMatch[1] + trailing.join('\n');
    }

    // Fragment or a document without <body> — strip document-level wrappers
    return code.replace(/<!DOCTYPE[^>]*>/i, '')
               .replace(/<head[^>]*>[\s\S]*?<\/head>/i, (m) => this._extractHead(m))
               .replace(/<\/?html[^>]*>/gi, '')
               .replace(/<\/?body[^>]*>/gi, '')
               .replace(/<meta[^>]*>/gi, '')
               .replace(/<base[^>]*>/gi, '')
               .replace(/<!--\s*(capabilities|app)\s*:[\s\S]*?-->/gi, '');
  }

  kill(appId) {
    const app = this.apps.get(appId);
    if (!app) return;
    app.iframe.remove();
    this.apps.delete(appId);
  }

  killAll() {
    for (const appId of this.apps.keys()) {
      this.kill(appId);
    }
  }

  getApp(appId) {
    return this.apps.get(appId);
  }

  listApps() {
    return [...this.apps.entries()].map(([id, app]) => ({
      id,
      title: app.title,
      capabilities: app.capabilities,
    }));
  }
}
