// Persistent per-app storage
// Stores data as JSON files in data/apps/<appId>/store.json
// Isolated by appId — one app cannot read another's data

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'apps');

// Default quota: 5MB per app
const DEFAULT_QUOTA = 5 * 1024 * 1024;

// In-memory cache of loaded stores
const cache = new Map(); // appId → { data: Map, dirty: false }

// Debounced writes
const writeTimers = new Map();
const WRITE_DELAY = 500; // ms

function appDir(appId) {
  // Sanitize appId to prevent path traversal
  const safe = String(appId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(DATA_DIR, safe);
}

function storePath(appId) {
  return join(appDir(appId), 'store.json');
}

function loadStore(appId) {
  if (cache.has(appId)) return cache.get(appId);

  const path = storePath(appId);
  let data = new Map();

  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      data = new Map(Object.entries(raw));
    } catch {
      // Corrupted file — start fresh
    }
  }

  const entry = { data, dirty: false };
  cache.set(appId, entry);
  return entry;
}

function scheduleSave(appId) {
  if (writeTimers.has(appId)) clearTimeout(writeTimers.get(appId));
  writeTimers.set(appId, setTimeout(() => flushApp(appId), WRITE_DELAY));
}

function flushApp(appId) {
  const entry = cache.get(appId);
  if (!entry || !entry.dirty) return;

  const dir = appDir(appId);
  mkdirSync(dir, { recursive: true });

  const obj = Object.fromEntries(entry.data);
  writeFileSync(storePath(appId), JSON.stringify(obj, null, 2));
  entry.dirty = false;
  writeTimers.delete(appId);
}

/**
 * Get a value from app storage.
 */
export function storageGet(appId, key) {
  const store = loadStore(appId);
  return store.data.get(key) ?? null;
}

/**
 * Set a value in app storage. Returns { ok, error? }.
 */
export function storageSet(appId, key, value) {
  const store = loadStore(appId);

  // Check quota before writing
  store.data.set(key, value);
  const size = calcSize(store.data);
  if (size > DEFAULT_QUOTA) {
    store.data.delete(key); // rollback
    return { ok: false, error: `Storage quota exceeded (${formatBytes(DEFAULT_QUOTA)} limit)` };
  }

  store.dirty = true;
  scheduleSave(appId);
  return { ok: true };
}

/**
 * Remove a key from app storage.
 */
export function storageRemove(appId, key) {
  const store = loadStore(appId);
  const existed = store.data.delete(key);
  if (existed) {
    store.dirty = true;
    scheduleSave(appId);
  }
  return existed;
}

/**
 * List all keys in app storage.
 */
export function storageKeys(appId) {
  const store = loadStore(appId);
  return [...store.data.keys()];
}

/**
 * Get storage usage for an app: { keys, bytes, quota, percent }.
 */
export function storageUsage(appId) {
  const store = loadStore(appId);
  const bytes = calcSize(store.data);
  return {
    keys: store.data.size,
    bytes,
    quota: DEFAULT_QUOTA,
    percent: Math.round((bytes / DEFAULT_QUOTA) * 100),
    formatted: `${formatBytes(bytes)} / ${formatBytes(DEFAULT_QUOTA)}`,
  };
}

/**
 * Clear all storage for an app.
 */
export function storageClear(appId) {
  const store = loadStore(appId);
  store.data.clear();
  store.dirty = true;
  flushApp(appId);
}

/**
 * Delete all storage data for an app (including the directory).
 */
export function storageDelete(appId) {
  cache.delete(appId);
  if (writeTimers.has(appId)) {
    clearTimeout(writeTimers.get(appId));
    writeTimers.delete(appId);
  }
  const dir = appDir(appId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

/**
 * Export all storage data for an app as a plain object.
 */
export function storageExport(appId) {
  const store = loadStore(appId);
  return Object.fromEntries(store.data);
}

/**
 * Import storage data for an app (merges with existing).
 */
export function storageImport(appId, data) {
  const store = loadStore(appId);
  for (const [key, value] of Object.entries(data)) {
    store.data.set(key, value);
  }

  const size = calcSize(store.data);
  if (size > DEFAULT_QUOTA) {
    return { ok: false, error: `Import would exceed quota (${formatBytes(size)} > ${formatBytes(DEFAULT_QUOTA)})` };
  }

  store.dirty = true;
  scheduleSave(appId);
  return { ok: true, keys: store.data.size };
}

/**
 * List all app IDs that have storage data.
 */
export function storageListApps() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR).filter(name => {
    const path = join(DATA_DIR, name, 'store.json');
    return existsSync(path);
  });
}

/**
 * Export ALL storage (all apps) as { appId: { key: value } }.
 */
export function storageExportAll() {
  const result = {};
  for (const appId of storageListApps()) {
    result[appId] = storageExport(appId);
  }
  return result;
}

/**
 * Flush all pending writes to disk. Call on shutdown.
 */
export function storageFlushAll() {
  for (const [appId] of cache) {
    flushApp(appId);
  }
}

// --- Helpers ---

function calcSize(dataMap) {
  let size = 2; // {}
  for (const [key, value] of dataMap) {
    size += JSON.stringify(key).length + JSON.stringify(value).length + 4; // "key":value,
  }
  return size;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
