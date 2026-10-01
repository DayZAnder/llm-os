// Runs before anything reads user data: server.js imports this first, and
// ES modules evaluate imports in order, so the registry, storage and the rest
// only ever see data in the current format.

import { readFileSync } from 'fs';
import { join } from 'path';
import { migrateData } from './migrations.js';
import { PROJECT_ROOT } from './paths.js';

let version = 'unknown';
try { version = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')).version; } catch {}

export const dataMigration = (() => {
  try {
    return migrateData({ version });
  } catch (err) {
    return { status: 'error', error: err.message };
  }
})();

if (dataMigration.status === 'migrated') console.log(`[data] Migrated user data to format ${dataMigration.to} (steps: ${dataMigration.steps.join(', ')})`);
if (dataMigration.status === 'newer') console.warn(`[data] Data is format ${dataMigration.from} (written by LLM OS ${dataMigration.writtenBy || '?'}); this version understands up to ${dataMigration.to}. Not converting it back.`);
if (dataMigration.status === 'error') console.error(`[data] Migration failed: ${dataMigration.error}`);
