// LLM OS SDK — runs INSIDE the iframe sandbox
// Communicates with kernel via postMessage
// This file is injected into every generated app
//
// The SDK is a convenience layer only. It holds no authority: every call is
// checked by the shell (sandbox.js) against the app's granted capabilities,
// and fs/net/ai calls are checked again by the kernel via signed tokens.

(function() {
  'use strict';

  const pendingRequests = new Map();
  let requestId = 0;

  // Portable UI core (src/sdk/ui.js) is injected just before this file
  const UI = window.__LLMOS_UI__ || null;
  let portableRenderer = null;
  if (UI) {
    const style = document.createElement('style');
    style.textContent = UI.CSS;
    document.head.appendChild(style);
  }
  const post = window.parent.postMessage.bind(window.parent);

  // Send a message to the kernel and wait for response
  function kernelCall(type, payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pendingRequests.set(id, { resolve, reject });

      post({ source: 'llmos-app', id, type, payload }, '*');

      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`Kernel call timeout: ${type}`));
        }
      }, timeoutMs);
    });
  }

  // Fire-and-forget message (no response expected)
  function kernelSignal(type, payload) {
    post({ source: 'llmos-app', id: 0, type, payload }, '*');
  }

  const ipcHandlers = new Map(); // topic → Set<fn>

  // Listen for kernel responses and events
  window.addEventListener('message', (event) => {
    // Only the shell speaks for the kernel. Sibling apps can reach this
    // window through event.source.frames and would otherwise forge replies.
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.source !== 'llmos-kernel') return;

    if (msg.event === 'theme') {
      // Live re-theme: only --llmos-* tokens, no CSS syntax in values
      for (const [k, v] of Object.entries(msg.vars || {})) {
        if (/^--llmos-[a-z0-9-]+$/.test(k) && !/[;{}<>]/.test(String(v))) {
          document.documentElement.style.setProperty(k, String(v));
        }
      }
      return;
    }

    if (msg.event === 'ipc') {
      const fns = ipcHandlers.get(msg.topic);
      if (fns) for (const fn of fns) { try { fn(msg.data, msg.from); } catch (e) { reportError(e); } }
      return;
    }

    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    pendingRequests.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  });

  // --- Runtime error reporting (feeds the OS "fix with AI" loop) ---
  let reported = 0;
  function reportError(err, where) {
    if (reported >= 50) return; // don't flood the kernel from a render loop
    reported++;
    const message = err && err.message ? err.message : String(err);
    const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : '';
    kernelSignal('sys:error', { message: String(message).slice(0, 500), where: where || '', stack: stack.slice(0, 800) });
  }
  window.addEventListener('error', (e) => {
    reportError(e.error || e.message, e.lineno ? `line ${e.lineno}:${e.colno}` : '');
  });
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'unhandled promise rejection'));

  // --- System hotkeys ---
  // Keys pressed while an app has focus never reach the shell (the app is a
  // separate, sandboxed document), so forward the OS shortcuts: window
  // switcher (Alt+Tab, Alt+`) and launcher (Super/Windows key, Ctrl+Space).
  let superAlone = false;
  window.addEventListener('keydown', (e) => {
    let combo = null;
    if (e.altKey && (e.key === 'Tab' || e.key === '`')) combo = e.shiftKey ? 'switch-prev' : 'switch-next';
    else if (e.ctrlKey && e.code === 'Space') combo = 'launcher';
    else if (e.ctrlKey && e.altKey && e.code === 'KeyU') combo = 'upgrade';
    superAlone = e.key === 'Meta' || e.key === 'OS';
    if (combo) {
      e.preventDefault();
      kernelSignal('sys:hotkey', { combo });
    }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') kernelSignal('sys:hotkey', { combo: 'alt-up' });
    if ((e.key === 'Meta' || e.key === 'OS') && superAlone) kernelSignal('sys:hotkey', { combo: 'launcher' });
    superAlone = false;
  }, true);
  const origConsoleError = console.error.bind(console);
  console.error = function(...args) {
    reportError(args.map(a => (a && a.message) || (typeof a === 'string' ? a : JSON.stringify(a))).join(' '), 'console.error');
    origConsoleError(...args);
  };

  // UI namespace
  const ui = {
    // Create a DOM element
    h(tag, props, ...children) {
      const el = document.createElement(tag);

      if (props) {
        for (const [key, value] of Object.entries(props)) {
          if (key === 'style' && typeof value === 'object') {
            Object.assign(el.style, value);
          } else if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2).toLowerCase(), value);
          } else if (key === 'className') {
            el.className = value;
          } else if (key === 'value' || key === 'checked' || key === 'disabled') {
            el[key] = value;
          } else if (value != null && value !== false) {
            el.setAttribute(key, value === true ? '' : value);
          }
        }
      }

      for (const child of children.flat(Infinity)) {
        if (child == null || child === false) continue;
        if (typeof child === 'string' || typeof child === 'number') {
          el.appendChild(document.createTextNode(String(child)));
        } else if (child instanceof Node) {
          el.appendChild(child);
        }
      }

      return el;
    },

    // Render an element to the page
    render(element) {
      const root = document.getElementById('llmos-root') || document.body;
      root.replaceChildren();
      if (element instanceof Node) {
        root.appendChild(element);
      }
    },

    // Show a notification (sends to kernel)
    async notify(message, options = {}) {
      return kernelCall('notify', { message: String(message), ...options });
    },

    // Show a confirm dialog
    async confirm(message) {
      return kernelCall('confirm', { message: String(message) }, 120000);
    },

    // --- Portable UI (see ui.js): renderer-independent component trees ---
    c: UI ? UI.c : {},

    // Run an app from state + view. Returns { set, get }.
    app(def) {
      if (!UI) throw new Error('Portable UI not available');
      const root = document.getElementById('llmos-root') || document.body;
      portableRenderer = UI.createDomRenderer(root, document);
      return UI.createApp(def, portableRenderer, (err) => reportError(err, 'ui.app'));
    },

    // JSON copy of the current portable tree (what a native renderer draws)
    snapshot() {
      const tree = portableRenderer && portableRenderer.tree();
      return tree ? UI.snapshot(tree) : null;
    },
  };

  // Storage namespace — private per-app key/value store
  const storage = {
    get(key) { return kernelCall('storage:get', { key }); },
    set(key, value) { return kernelCall('storage:set', { key, value }); },
    remove(key) { return kernelCall('storage:remove', { key }); },
    keys() { return kernelCall('storage:keys', {}); },
  };

  // Filesystem namespace — the user's shared files
  const fs = {
    list(path = '/') { return kernelCall('fs:list', { path }); },
    read(path) { return kernelCall('fs:read', { path }); },
    write(path, content) { return kernelCall('fs:write', { path, content }); },
    stat(path) { return kernelCall('fs:stat', { path }); },
    mkdir(path) { return kernelCall('fs:mkdir', { path }); },
    remove(path) { return kernelCall('fs:remove', { path }); },
  };

  // Network namespace — proxied through the kernel
  const net = {
    request(url, options = {}) {
      return kernelCall('net:request', { url: String(url), method: options.method, headers: options.headers, body: options.body }, 30000);
    },
    async json(url, options = {}) {
      const res = await net.request(url, options);
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${url}`);
      return JSON.parse(res.body);
    },
  };

  // AI namespace — the OS language model
  const ai = {
    async complete(prompt, options = {}) {
      const r = await kernelCall('ai:complete', { prompt: String(prompt), system: options.system, maxTokens: options.maxTokens }, 300000);
      return r.text;
    },
  };

  // Clipboard namespace
  const clipboard = {
    write(text) { return kernelCall('clipboard:write', { text: String(text) }); },
    read() { return kernelCall('clipboard:read', {}); },
  };

  // OS integration
  const os = {
    args: Object.freeze(Object.assign({}, window.__LLMOS_ARGS__ || {})),
    appId: window.__LLMOS_APP_ID__ || null,
    open(path) { return kernelCall('os:open', { path: String(path) }, 600000); },
    setTitle(title) { return kernelCall('os:setTitle', { title: String(title) }); },
  };

  // Inter-app message bus
  const ipc = {
    publish(topic, data) { return kernelCall('ipc:publish', { topic: String(topic), data }); },
    async subscribe(topic, fn) {
      topic = String(topic);
      await kernelCall('ipc:subscribe', { topic });
      if (!ipcHandlers.has(topic)) ipcHandlers.set(topic, new Set());
      ipcHandlers.get(topic).add(fn);
      return () => ipcHandlers.get(topic)?.delete(fn);
    },
  };

  // Timer namespace — runs directly (safe, no capability needed)
  const timer = {
    setTimeout(fn, ms) {
      return window.setTimeout(fn, ms);
    },
    clearTimeout(id) {
      return window.clearTimeout(id);
    },
    setInterval(fn, ms) {
      return window.setInterval(fn, ms);
    },
    clearInterval(id) {
      return window.clearInterval(id);
    },
  };

  // Capabilities namespace
  const caps = {
    async has(capability) {
      return kernelCall('caps:has', { capability });
    },
    async request(capability) {
      return kernelCall('caps:request', { capability }, 120000);
    },
    getToken(capability) {
      const tokens = window.__LLMOS_TOKENS__ || {};
      return tokens[capability] || null;
    },
  };

  // Expose as global
  window.LLMOS = Object.freeze({ ui, storage, fs, net, ai, clipboard, os, ipc, timer, caps, version: 2 });
})();
