// Data format versions — so an upgrade can change how user data is stored,
// and a rollback to an older version can't quietly damage it.
//
// data/schema.json records the format the data is in: { version, writtenBy }.
// The file formats themselves stay as they are (an older LLM OS just ignores
// schema.json), so this costs nothing until a format really changes. Then:
//
//   1. Add an entry to MIGRATIONS: { to, files, migrate(dataDir) }.
//   2. Bump DATA_SCHEMA.
//
// At boot, data older than DATA_SCHEMA is migrated step by step; the files a
// step touches are copied to data/migration-backups/ first. Data NEWER than
// this version understands (after a rollback) is not converted back, and the
// boot report warns about it. schema.json keeps the newer version, so the
// next upgrade doesn't re-run steps that already happened. A future format
// change that an older version could damage by writing must be made
// backwards-readable, or ship with that older version knowing to stay
// read-only on the file.

import { readFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { writeFileAtomic } from './fsutil.js';
import { DATA_DIR } from './paths.js';

/** The data format this version of LLM OS reads and writes. */
export const DATA_SCHEMA = 1;

/**
 * Ordered migration steps. Each one moves the data from version `to - 1`
 * to `to`. `files` are paths relative to the data directory that the step
 * may change; they are backed up before it runs. Example for a future step:
 *
 *   { to: 2, files: ['registry.json'], migrate(dir) { ... } }
 */
export const MIGRATIONS = [];

function schemaFile(dataDir) {
  return join(dataDir, 'schema.json');
}

/** Read the recorded format, or null when none was written yet. */
export function readSchema(dataDir = DATA_DIR) {
  try {
    const s = JSON.parse(readFileSync(schemaFile(dataDir), 'utf-8'));
    return Number.isInteger(s.version) && s.version > 0 ? s : null;
  } catch {
    return null;
  }
}

/**
 * Bring the data directory to DATA_SCHEMA.
 * @returns {{ status: 'ok'|'migrated'|'newer'|'error', from, to, writtenBy?, steps?, error? }}
 */
export function migrateData({ dataDir = DATA_DIR, target = DATA_SCHEMA, steps = MIGRATIONS, version = 'unknown' } = {}) {
  const current = readSchema(dataDir);
  // No schema.json: everything written before 0.4.3 is format 1
  const from = current?.version ?? 1;

  if (from > target) {
    return { status: 'newer', from, to: target, writtenBy: current?.writtenBy };
  }

  const applied = [];
  for (const step of steps.filter(s => s.to > from && s.to <= target).sort((a, b) => a.to - b.to)) {
    const backupDir = join(dataDir, 'migration-backups', `${step.to - 1}-to-${step.to}-${Date.now()}`);
    try {
      for (const rel of step.files || []) {
        const src = join(dataDir, rel);
        if (!existsSync(src)) continue;
        const dst = join(backupDir, rel);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst, { recursive: true });
      }
      step.migrate(dataDir);
      applied.push(step.to);
      // Record progress after every step: a crash resumes where it stopped
      writeFileAtomic(schemaFile(dataDir), JSON.stringify({ version: step.to, writtenBy: version }, null, 2));
    } catch (err) {
      return { status: 'error', from, to: target, steps: applied, error: `step to format ${step.to}: ${err.message}`, backup: backupDir };
    }
  }

  if (!current || current.version !== target || applied.length) {
    writeFileAtomic(schemaFile(dataDir), JSON.stringify({ version: target, writtenBy: version }, null, 2));
  }
  return { status: applied.length ? 'migrated' : 'ok', from, to: target, steps: applied };
}
