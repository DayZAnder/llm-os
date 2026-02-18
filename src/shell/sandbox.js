// Iframe Sandbox Manager
// Creates isolated iframes, injects SDK, handles postMessage bridge

export class SandboxManager {
  constructor(containerEl, sdkCode, callbacks = {}) {
    this.container = containerEl;
    this.sdkCode = sdkCode;
    this.apps = new Map(); // appId → { iframe, capabilities, title }
    this.callbacks = callbacks; // { onNotify, onConfirm, onCapRequest, onStorageGet, onStorageSet, ... }
    this._listen();
  }

  _listen() {
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.source !== 'llmos-app') return;

      // Find which app sent this
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

  async _handleMessage(appId, msg) {
    const { id, type, payload } = msg;
    const app = this.apps.get(appId);
    if (!app) return;

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
          result = await this.callbacks.onNotify?.(appId, payload.message, payload);
          break;
        case 'confirm':
          result = await this.callbacks.onConfirm?.(appId, payload.message);
          break;
        case 'caps:has':
          result = app.capabilities.includes(payload.capability);
          break;
        case 'caps:request':
          result = await this.callbacks.onCapRequest?.(appId, payload.capability) ?? false;
          break;
        default:
          throw new Error(`Unknown SDK call: ${type}`);
      }

      app.iframe.contentWindow.postMessage({
        source: 'llmos-kernel',
        id,
        result,
      }, '*');

    } catch (err) {
      app.iframe.contentWindow.postMessage({
        source: 'llmos-kernel',
        id,
        error: err.message,
      }, '*');
    }
  }

  launch(appId, code, capabilities, title, tokens = {}) {
    // Build the sandboxed HTML
    const tokensJson = JSON.stringify(tokens).replace(/</g, '\\u003c');
    const sandboxedHtml = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 12px; font-family: 'Segoe UI', system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  #llmos-root { width: 100%; height: 100%; }
</style>
<script>
// Capability tokens — injected at launch, read-only
window.__LLMOS_TOKENS__ = Object.freeze(${tokensJson});
// LLM-OS SDK injected by kernel
${this.sdkCode}
</script>
</head>
<body>
<div id="llmos-root"></div>
${this._extractBody(code)}
</body>
</html>`;

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts';
    iframe.style.cssText = 'width:100%;height:100%;border:none;background:#1a1a2e;';
    iframe.srcdoc = sandboxedHtml;

    this.apps.set(appId, { iframe, capabilities, title });
    return iframe;
  }

  _extractBody(code) {
    // If the code is a full HTML document, extract the body + scripts
    // If it's just a fragment, wrap it
    const bodyMatch = code.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const scriptMatches = code.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    const styleMatches = code.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];

    if (bodyMatch) {
      // Full HTML doc — extract body content
      const styles = styleMatches.join('\n');
      return styles + '\n' + bodyMatch[1];
    }

    // Not a full doc — include scripts and styles
    return code.replace(/<!DOCTYPE[^>]*>/i, '')
               .replace(/<\/?html[^>]*>/gi, '')
               .replace(/<\/?head[^>]*>/gi, '')
               .replace(/<\/?body[^>]*>/gi, '')
               .replace(/<meta[^>]*>/gi, '')
               .replace(/<!--\s*capabilities\s*:.*?-->/i, '');
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
