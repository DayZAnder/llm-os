// Persistent per-app storage
// Stores data as JSON files in data/apps/<appId>/store.json
// Isolated by appId — one app cannot read another's data

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dataPath } from './paths.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = dataPath('apps');

// Default quota: 5MB per app
const DEFAULT_QUOTA = 5 * 1024 * 1024;

// In-memory cache of loaded stores
const cache = new Map(); // appId → { data: Map, dirty: false }

// Debounced writes
const writeTimers = new Map();
const WRITE_DELAY = 500; // ms

// Sanitized id: prevents path traversal, and is also the cache key — two ids
// that map to the same directory must share one in-memory store, or the
// last flush would overwrite the other's data.
function safeId(appId) {
  return String(appId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function appDir(appId) {
  return join(DATA_DIR, safeId(appId));
}

function storePath(appId) {
  return join(appDir(appId), 'store.json');
}

function loadStore(rawId) {
  const appId = safeId(rawId);
  if (cache.has(appId)) return cache.get(appId);

  const path = storePath(appId);
  let data = new Map();

  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      data = new Map(Object.entries(raw));
    } catch {
      // Unreadable: keep it for recovery instead of overwriting it on the next save
      try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch {}
    }
  }

  const entry = { data, dirty: false };
  cache.set(appId, entry);
  return entry;
}

function scheduleSave(rawId) {
  const appId = safeId(rawId);
  if (writeTimers.has(appId)) clearTimeout(writeTimers.get(appId));
  writeTimers.set(appId, setTimeout(() => flushApp(appId), WRITE_DELAY));
}

function flushApp(rawId) {
  const appId = safeId(rawId);
  const entry = cache.get(appId);
  if (!entry || !entry.dirty) return;

  const dir = appDir(appId);
  mkdirSync(dir, { recursive: true });

  const obj = Object.fromEntries(entry.data);
  // Write-then-rename: a crash mid-write never leaves a cut-off store.json
  const tmp = `${storePath(appId)}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, storePath(appId));
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
  if (value === undefined) return { ok: false, error: 'value is required (use remove to delete a key)' };
  const store = loadStore(appId);

  // Check quota before writing; on failure the old value stays
  const had = store.data.has(key);
  const previous = store.data.get(key);
  store.data.set(key, value);
  const size = calcSize(store.data);
  if (size > DEFAULT_QUOTA) {
    if (had) store.data.set(key, previous); else store.data.delete(key);
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
export function storageDelete(rawId) {
  const appId = safeId(rawId);
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
  const merged = new Map(store.data);
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined) merged.set(key, value);
  }

  const size = calcSize(merged);
  if (size > DEFAULT_QUOTA) {
    // Nothing applied: the store stays as it was
    return { ok: false, error: `Import would exceed quota (${formatBytes(size)} > ${formatBytes(DEFAULT_QUOTA)})` };
  }

  store.data = merged;
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
    size += JSON.stringify(key).length + (JSON.stringify(value) ?? 'null').length + 4; // "key":value,
  }
  return size;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
