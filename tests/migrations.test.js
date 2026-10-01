// Tests for data format versions (kernel/migrations.js) and how the boot
// report shows them. Everything runs in temp directories.
// Run: node tests/migrations.test.js

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'llmos-mig-'));
process.env.LLMOS_DATA_DIR = root;
const { migrateData, readSchema, DATA_SCHEMA } = await import('../src/kernel/migrations.js');
const { withDataFormat } = await import('../src/kernel/boot.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
let n = 0;
const fresh = () => { const d = join(root, `d${n++}`); mkdirSync(d, { recursive: true }); return d; };

console.log('\nbaseline:');
let d = fresh();
let r = migrateData({ dataDir: d, version: '0.4.3' });
assert(r.status === 'ok' && r.from === 1 && r.to === DATA_SCHEMA, 'data from before schema.json counts as format 1');
assert(readSchema(d)?.version === DATA_SCHEMA && readSchema(d)?.writtenBy === '0.4.3', 'schema.json written with the version that wrote it');
r = migrateData({ dataDir: d, version: '0.4.3' });
assert(r.status === 'ok', 'second boot: nothing to do');

console.log('\nupgrade:');
d = fresh();
writeFileSync(join(d, 'registry.json'), '[{"title":"old shape"}]');
const steps = [
  { to: 2, files: ['registry.json'], migrate(dd) { writeFileSync(join(dd, 'registry.json'), '{"apps":[{"title":"old shape"}]}'); } },
  { to: 3, files: ['missing.json'], migrate() {} },
];
r = migrateData({ dataDir: d, target: 3, steps, version: '9.9.9' });
assert(r.status === 'migrated' && r.steps.join() === '2,3', 'steps run in order up to the target');
assert(JSON.parse(readFileSync(join(d, 'registry.json'), 'utf-8')).apps.length === 1, 'step changed the file');
const backups = readdirSync(join(d, 'migration-backups'));
assert(backups.length === 1 && readFileSync(join(d, 'migration-backups', backups[0], 'registry.json'), 'utf-8').includes('[{'), 'the file was backed up before it changed');
assert(readSchema(d).version === 3, 'schema.json now at the target');

console.log('\nfailure:');
d = fresh();
const bad = [
  { to: 2, files: [], migrate() {} },
  { to: 3, files: [], migrate() { throw new Error('disk full'); } },
];
r = migrateData({ dataDir: d, target: 3, steps: bad });
assert(r.status === 'error' && /disk full/.test(r.error) && r.steps.join() === '2', 'a failing step stops the run and says which');
assert(readSchema(d).version === 2, 'progress up to the failing step is recorded (next boot resumes there)');

console.log('\nrollback (data newer than this version):');
d = fresh();
migrateData({ dataDir: d, target: 3, steps: [], version: '0.6.0' });
r = migrateData({ dataDir: d, target: 1, steps: [], version: '0.4.3' });
assert(r.status === 'newer' && r.from === 3 && r.writtenBy === '0.6.0', 'detected, with the version that wrote it');
assert(readSchema(d).version === 3 && readSchema(d).writtenBy === '0.6.0', 'schema.json is not lowered');

console.log('\nboot report:');
const base = { status: 'ok', detail: 'data disk /dev/vdb · 8 GB free' };
assert(withDataFormat(base, { status: 'ok' }) === base, 'ok: unchanged');
assert(/updated to format 2/.test(withDataFormat(base, { status: 'migrated', to: 2 }).detail), 'migrated: said once');
const nw = withDataFormat(base, { status: 'newer', writtenBy: '0.6.0' });
assert(nw.status === 'warn' && /0\.6\.0/.test(nw.detail) && /Upgrade/.test(nw.fix), 'newer: warning with what to do');
assert(withDataFormat(base, { status: 'error', error: 'x', backup: '/b' }).status === 'error', 'error: shown as an error');

rmSync(root, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
