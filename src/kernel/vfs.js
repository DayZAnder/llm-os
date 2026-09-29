// Virtual filesystem — a shared, user-owned file space for all apps.
//
// Per-app storage (storage.js) is private to one app. The VFS is the
// opposite: files that belong to the *user*, outlive any single app, and can
// be opened by whichever app handles their type — like a real OS.
//
// Access is gated by capabilities (fs:read, fs:write), enforced by the shell
// and verified again here via signed capability tokens in server.js.
// Paths are POSIX-style ("/notes/todo.md"), always resolved inside data/fs.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync, renameSync } from 'fs';
import { join, resolve, sep, dirname, extname } from 'path';
import { dataPath } from './paths.js';

const DEFAULT_ROOT = dataPath('fs');
const MAX_FILE_BYTES = 10 * 1024 * 1024;     // 10 MB per file
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;   // 500 MB per filesystem

let root = DEFAULT_ROOT;

/** Point the VFS at a different directory (tests). */
export function setRoot(dir) {
  root = resolve(dir);
}

export function getRoot() {
  return root;
}

function ensureRoot() {
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

/**
 * Normalize a virtual path. Returns "/a/b" form or throws on invalid input.
 * Rejects "..", NUL bytes, backslashes and drive letters outright instead of
 * trying to be clever about them.
 */
export function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) {
    throw new Error('Invalid path');
  }
  if (/[\0\\]/.test(p) || /^[a-zA-Z]:/.test(p)) throw new Error('Invalid path');
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new Error('Path traversal not allowed');
    if (seg.length > 255) throw new Error('Path segment too long');
    if (/[\x00-\x1f]/.test(seg)) throw new Error('Invalid path');
    // On Windows "a.txt:x" is a hidden alternate data stream (invisible to
    // the quota), and CON/NUL/… or a trailing dot/space aren't real files.
    if (process.platform === 'win32' &&
        (/[:*?"<>|]/.test(seg) || /[. ]$/.test(seg) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(seg))) {
      throw new Error('Invalid file name on this system');
    }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

function toReal(vpath) {
  const norm = normalizePath(vpath);
  const real = resolve(join(root, norm));
  // Defense in depth: the resolved path must stay inside the root
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error('Path escapes filesystem root');
  }
  return real;
}

function dirSize(dir) {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

// Simple extension → MIME map so the shell can route files to handler apps
const MIME = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.svg': 'image/svg+xml', '.xml': 'application/xml',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.log': 'text/plain',
};

export function mimeOf(vpath) {
  return MIME[extname(vpath).toLowerCase()] || 'application/octet-stream';
}

function entryInfo(vpath, st) {
  return {
    path: vpath,
    name: vpath.split('/').pop() || '/',
    type: st.isDirectory() ? 'dir' : 'file',
    size: st.isDirectory() ? 0 : st.size,
    mime: st.isDirectory() ? null : mimeOf(vpath),
    modified: st.mtimeMs,
  };
}

export function stat(vpath) {
  ensureRoot();
  const norm = normalizePath(vpath);
  const real = toReal(norm);
  if (!existsSync(real)) return null;
  return entryInfo(norm, statSync(real));
}

export function list(vpath = '/') {
  ensureRoot();
  const norm = normalizePath(vpath);
  const real = toReal(norm);
  if (!existsSync(real)) throw new Error(`No such directory: ${norm}`);
  if (!statSync(real).isDirectory()) throw new Error(`Not a directory: ${norm}`);
  return readdirSync(real)
    .map(name => {
      const child = norm === '/' ? `/${name}` : `${norm}/${name}`;
      return entryInfo(child, statSync(join(real, name)));
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

export function read(vpath) {
  ensureRoot();
  const norm = normalizePath(vpath);
  const real = toReal(norm);
  if (!existsSync(real)) throw new Error(`No such file: ${norm}`);
  if (statSync(real).isDirectory()) throw new Error(`Is a directory: ${norm}`);
  return readFileSync(real, 'utf-8');
}

export function write(vpath, content) {
  ensureRoot();
  if (typeof content !== 'string') content = JSON.stringify(content);
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_FILE_BYTES) throw new Error(`File too large (${bytes} bytes, max ${MAX_FILE_BYTES})`);

  const norm = normalizePath(vpath);
  if (norm === '/') throw new Error('Cannot write to root');
  const real = toReal(norm);
  if (existsSync(real) && statSync(real).isDirectory()) throw new Error(`Is a directory: ${norm}`);

  const existing = existsSync(real) ? statSync(real).size : 0;
  if (dirSize(root) - existing + bytes > MAX_TOTAL_BYTES) throw new Error('Filesystem quota exceeded');

  mkdirSync(dirname(real), { recursive: true });
  // Write-then-rename so a crash never leaves a half-written file
  const tmp = `${real}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, real);
  } catch (err) {
    rmSync(tmp, { force: true }); // a failed write must not leave uncounted data behind
    throw err;
  }
  return entryInfo(norm, statSync(real));
}

export function mkdir(vpath) {
  ensureRoot();
  const norm = normalizePath(vpath);
  mkdirSync(toReal(norm), { recursive: true });
  return entryInfo(norm, statSync(toReal(norm)));
}

export function remove(vpath) {
  ensureRoot();
  const norm = normalizePath(vpath);
  if (norm === '/') throw new Error('Cannot remove root');
  const real = toReal(norm);
  if (!existsSync(real)) return false;
  rmSync(real, { recursive: true });
  return true;
}
