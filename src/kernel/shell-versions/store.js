// Shell Version Store — manages AI-generated shell UI versions.
// Each version is stored as a flat .html file with metadata in an index.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const VERSIONS_DIR = join(DATA_DIR, 'shell-versions');
const INDEX_FILE = join(DATA_DIR, 'shell-versions.json');
const POINTER_FILE = join(DATA_DIR, 'shell-current.json');
const ORIGINAL_SHELL = join(__dirname, '..', '..', 'shell', 'index.html');

const MAX_VERSIONS = 10;

// In-memory index (metadata only, no HTML)
let versions = []; // sorted newest-first

// --- Persistence ---

function loadIndex() {
  if (!existsSync(INDEX_FILE)) return;
  try {
    versions = JSON.parse(readFileSync(INDEX_FILE, 'utf-8'));
  } catch (err) {
    console.warn('[shell-versions] Failed to load index:', err.message);
    versions = [];
  }
}

function saveIndex() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(versions, null, 2));
}

// --- Pointer (which version is current) ---

export function getCurrentId() {
  if (!existsSync(POINTER_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(POINTER_FILE, 'utf-8'));
    return data.id || null;
  } catch {
    return null;
  }
}

export function setCurrentId(id) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(POINTER_FILE, JSON.stringify({ id }));
}

// --- Version CRUD ---

/**
 * Save a new shell version. Caps history at MAX_VERSIONS.
 * @param {Object} entry - { id, html, source, prompt, diff, parentId }
 */
export function saveVersion({ id, html, source, prompt, diff, parentId }) {
  mkdirSync(VERSIONS_DIR, { recursive: true });

  // Write HTML file
  writeFileSync(join(VERSIONS_DIR, `${id}.html`), html);

  // Add metadata to index
  const meta = {
    id,
    byteSize: Buffer.byteLength(html, 'utf-8'),
    createdAt: Date.now(),
    source, // 'user' or 'scheduler'
    prompt,
    diff,
    parentId,
  };
  versions.unshift(meta);

  // Cap at MAX_VERSIONS
  while (versions.length > MAX_VERSIONS) {
    versions.pop();
  }

  saveIndex();
  return meta;
}

/**
 * List all versions (metadata only, newest first).
 */
export function listVersions() {
  return [...versions];
}

/**
 * Get version metadata by id.
 */
export function getVersion(id) {
  return versions.find(v => v.id === id) || null;
}

/**
 * Get current version metadata.
 */
export function getCurrentVersion() {
  const id = getCurrentId();
  if (!id) return null;
  return getVersion(id);
}

/**
 * Get the filesystem path to serve as the shell.
 * Falls back to the original hand-written index.html.
 */
export function getShellPath() {
  const id = getCurrentId();
  if (!id) return ORIGINAL_SHELL;
  const versionFile = join(VERSIONS_DIR, `${id}.html`);
  if (!existsSync(versionFile)) return ORIGINAL_SHELL;
  return versionFile;
}

/**
 * Read the current shell HTML string.
 */
export function readCurrentShell() {
  return readFileSync(getShellPath(), 'utf-8');
}

/**
 * Read a specific version's HTML.
 */
export function readVersionHtml(id) {
  const file = join(VERSIONS_DIR, `${id}.html`);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf-8');
}

// Load on import
loadIndex();
