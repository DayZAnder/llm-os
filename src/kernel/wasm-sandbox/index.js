// WASM Sandbox — runs WASM modules in isolated worker threads with
// capability-gated host functions, memory limits, and CPU timeouts.
//
// Interface mirrors SandboxManager (src/shell/sandbox.js) for consistency.
// This is a server-side compute sandbox — more restrictive than iframes.

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'worker.js');

// SharedArrayBuffer layout constants (must match worker.js)
const STATE_IDLE = 0;
const STATE_PENDING = 1;
const STATE_READY = 2;
const SAB_DATA_START = 12;
const SAB_SIZE = 65536; // 64KB

// Host call type constants (must match worker.js)
const CALL = {
  STORAGE_GET: 1,
  STORAGE_SET: 2,
  STORAGE_REMOVE: 3,
  STORAGE_KEYS: 4,
  NOTIFY: 5,
  CAP_REQUEST: 6,
};

// Defaults
const DEFAULT_TIMEOUT_MS = 30_000;  // 30 seconds
const DEFAULT_MEMORY_PAGES = 16;    // 16 pages = 1MB initial
const DEFAULT_MAX_MEMORY_PAGES = 1024; // 1024 pages = 64MB maximum

export class WasmSandbox {
  /**
   * @param {object} callbacks — same shape as SandboxManager callbacks
   *   onStorageGet(appId, key) → value
   *   onStorageSet(appId, key, value)
   *   onStorageRemove(appId, key)
   *   onStorageKeys(appId) → string[]
   *   onNotify(appId, message, payload)
   *   onCapRequest(appId, capability) → boolean
   */
  constructor(callbacks = {}) {
    this.apps = new Map(); // appId → AppEntry
    this.callbacks = callbacks;
  }

  /**
   * Launch a WASM module in an isolated worker thread.
   * @param {string} appId — unique app identifier
   * @param {Uint8Array|Buffer} wasmBytes — raw WASM binary
   * @param {string[]} capabilities — granted capabilities
   * @param {string} title — display name
   * @param {object} options
   * @param {string} options.entryFn — exported function to call (default: 'main')
   * @param {number[]} options.args — arguments to pass (default: [])
   * @param {number} options.timeoutMs — CPU timeout in ms (default: 30000)
   * @param {number} options.memoryPages — initial WASM memory pages (default: 16)
   * @param {number} options.maxMemoryPages — max WASM memory pages (default: 1024)
   * @param {object} options.tokens — capability tokens (optional, for future use)
   * @returns {Promise<number>} — return value of the WASM entry function
   */
  async launch(appId, wasmBytes, capabilities = [], title = '', options = {}) {
    if (this.apps.has(appId)) {
      throw new Error(`App ${appId} already running`);
    }

    const {
      entryFn = 'main',
      args = [],
      timeoutMs = DEFAULT_TIMEOUT_MS,
      memoryPages = DEFAULT_MEMORY_PAGES,
      maxMemoryPages = DEFAULT_MAX_MEMORY_PAGES,
      tokens = {},
    } = options;

    const sharedBuffer = new SharedArrayBuffer(SAB_SIZE);

    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: {
          wasmBytes: Buffer.from(wasmBytes),
          capabilities,
          tokens,
          memoryPages,
          maxMemoryPages,
          entryFn,
          args,
          sharedBuffer,
        },
      });

      // Don't let worker keep the event loop alive or affect process exit code
      worker.unref();

      const entry = {
        worker,
        capabilities,
        title,
        status: 'running',
        sharedBuffer,
        timeoutHandle: null,
        reject: null, // stored so kill() can settle the promise
      };

      entry.reject = reject;

      this.apps.set(appId, entry);

      // CPU timeout — hard-kill the worker
      entry.timeoutHandle = setTimeout(() => {
        if (entry.status === 'running') {
          worker.terminate();
          entry.status = 'killed';
          entry.reject = null;
          this.apps.delete(appId);
          reject(new Error(`App ${appId} exceeded CPU timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      worker.on('message', async (msg) => {
        if (msg.type === 'host-call') {
          await this._handleHostCall(appId, entry);
          return;
        }

        if (msg.type === 'result') {
          clearTimeout(entry.timeoutHandle);
          entry.status = 'done';
          entry.reject = null;
          this.apps.delete(appId);
          resolve(msg.value);
          return;
        }

        if (msg.type === 'error') {
          clearTimeout(entry.timeoutHandle);
          entry.status = 'failed';
          entry.reject = null;
          this.apps.delete(appId);
          reject(new Error(msg.message));
        }
      });

      worker.on('error', (err) => {
        clearTimeout(entry.timeoutHandle);
        entry.status = 'failed';
        entry.reject = null;
        this.apps.delete(appId);
        reject(err);
      });

      // Absorb worker exit event (fired on terminate) to prevent unhandled errors
      worker.on('exit', () => {});
    });
  }

  /**
   * Kill a running WASM app immediately.
   */
  kill(appId) {
    const entry = this.apps.get(appId);
    if (!entry) return false;
    clearTimeout(entry.timeoutHandle);
    entry.worker.terminate();
    entry.status = 'killed';
    this.apps.delete(appId);
    // Settle the launch promise so callers don't hang
    if (entry.reject) {
      entry.reject(new Error(`App ${appId} was killed`));
      entry.reject = null;
    }
    return true;
  }

  /**
   * Kill all running WASM apps.
   */
  killAll() {
    for (const [appId] of this.apps) {
      this.kill(appId);
    }
  }

  /**
   * Get info about a running app.
   */
  getApp(appId) {
    const entry = this.apps.get(appId);
    if (!entry) return undefined;
    return {
      capabilities: entry.capabilities,
      title: entry.title,
      status: entry.status,
    };
  }

  /**
   * List all running apps.
   */
  listApps() {
    return Array.from(this.apps.entries()).map(([id, entry]) => ({
      id,
      title: entry.title,
      capabilities: entry.capabilities,
      status: entry.status,
    }));
  }

  // --- Internal: handle synchronous host function calls from worker ---

  async _handleHostCall(appId, entry) {
    const sab = entry.sharedBuffer;
    const i32 = new Int32Array(sab);
    const u8 = new Uint8Array(sab);

    // Read request from SharedArrayBuffer
    const callType = Atomics.load(i32, 1);
    const dataLen = Atomics.load(i32, 2);
    const jsonStr = Buffer.from(u8.slice(SAB_DATA_START, SAB_DATA_START + dataLen)).toString('utf-8');
    const payload = JSON.parse(jsonStr);

    let result;
    try {
      result = await this._dispatchHostCall(appId, entry, callType, payload);
    } catch (err) {
      // Write error response
      const errBytes = Buffer.from(JSON.stringify({ error: err.message }), 'utf-8');
      u8.set(errBytes, SAB_DATA_START);
      Atomics.store(i32, 2, errBytes.length);
      Atomics.store(i32, 0, STATE_READY);
      Atomics.notify(i32, 0, 1);
      return;
    }

    // Write success response
    const respBytes = Buffer.from(JSON.stringify({ value: result }), 'utf-8');
    u8.set(respBytes, SAB_DATA_START);
    Atomics.store(i32, 2, respBytes.length);
    Atomics.store(i32, 0, STATE_READY);
    Atomics.notify(i32, 0, 1);
  }

  async _dispatchHostCall(appId, entry, callType, payload) {
    const caps = entry.capabilities;

    switch (callType) {
      case CALL.STORAGE_GET:
        if (!caps.includes('storage:local')) throw new Error('storage:local not granted');
        return await this.callbacks.onStorageGet?.(appId, payload.key) ?? null;

      case CALL.STORAGE_SET:
        if (!caps.includes('storage:local')) throw new Error('storage:local not granted');
        await this.callbacks.onStorageSet?.(appId, payload.key, payload.value);
        return true;

      case CALL.STORAGE_REMOVE:
        if (!caps.includes('storage:local')) throw new Error('storage:local not granted');
        await this.callbacks.onStorageRemove?.(appId, payload.key);
        return true;

      case CALL.STORAGE_KEYS:
        if (!caps.includes('storage:local')) throw new Error('storage:local not granted');
        return await this.callbacks.onStorageKeys?.(appId) ?? [];

      case CALL.NOTIFY:
        await this.callbacks.onNotify?.(appId, payload.message, payload);
        return true;

      case CALL.CAP_REQUEST:
        return await this.callbacks.onCapRequest?.(appId, payload.capability) ?? false;

      default:
        throw new Error(`Unknown host call type: ${callType}`);
    }
  }
}
