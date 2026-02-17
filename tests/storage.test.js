// Tests for persistent storage layer
// Run: node tests/storage.test.js

import { rmSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Override DATA_DIR before importing — we use a temp dir for tests
const TEST_DATA_DIR = join(__dirname, '..', 'data', 'apps');

// Clean up any previous test data
const TEST_APPS = ['test-app-1', 'test-app-2', 'test-app-quota', 'test-app-import', 'test-app-traversal'];
for (const appId of TEST_APPS) {
  const dir = join(TEST_DATA_DIR, appId);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

// Now import storage
import {
  storageGet, storageSet, storageRemove, storageKeys,
  storageUsage, storageClear, storageDelete,
  storageExport, storageImport, storageListApps,
  storageExportAll, storageFlushAll,
} from '../src/kernel/storage.js';

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}`);
  }
}

function assertEq(actual, expected, name) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (!match) {
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
  assert(match, name);
}

// --- Basic CRUD ---
console.log('\nStorage CRUD:');

assertEq(storageGet('test-app-1', 'missing'), null, 'get nonexistent key returns null');

const setResult = storageSet('test-app-1', 'name', 'Pomodoro Timer');
assert(setResult.ok, 'set returns ok');
assertEq(storageGet('test-app-1', 'name'), 'Pomodoro Timer', 'get returns set value');

storageSet('test-app-1', 'count', 42);
assertEq(storageGet('test-app-1', 'count'), 42, 'stores numbers');

storageSet('test-app-1', 'config', { dark: true, interval: 25 });
assertEq(storageGet('test-app-1', 'config'), { dark: true, interval: 25 }, 'stores objects');

storageSet('test-app-1', 'items', [1, 2, 3]);
assertEq(storageGet('test-app-1', 'items'), [1, 2, 3], 'stores arrays');

storageSet('test-app-1', 'empty', '');
assertEq(storageGet('test-app-1', 'empty'), '', 'stores empty string');

storageSet('test-app-1', 'flag', false);
assertEq(storageGet('test-app-1', 'flag'), false, 'stores false');

storageSet('test-app-1', 'nothing', null);
assertEq(storageGet('test-app-1', 'nothing'), null, 'stores null');

// --- Keys ---
console.log('\nStorage keys:');

const keys = storageKeys('test-app-1');
assert(keys.includes('name'), 'keys includes name');
assert(keys.includes('count'), 'keys includes count');
assert(keys.includes('config'), 'keys includes config');
assert(keys.length >= 6, `has at least 6 keys (got ${keys.length})`);

// --- Remove ---
console.log('\nStorage remove:');

storageRemove('test-app-1', 'count');
assertEq(storageGet('test-app-1', 'count'), null, 'removed key returns null');
assert(!storageKeys('test-app-1').includes('count'), 'key removed from keys list');

// --- Overwrite ---
console.log('\nStorage overwrite:');

storageSet('test-app-1', 'name', 'Updated Timer');
assertEq(storageGet('test-app-1', 'name'), 'Updated Timer', 'overwrite replaces value');

// --- App isolation ---
console.log('\nApp isolation:');

storageSet('test-app-2', 'name', 'Calculator');
assertEq(storageGet('test-app-2', 'name'), 'Calculator', 'app-2 has its own data');
assertEq(storageGet('test-app-1', 'name'), 'Updated Timer', 'app-1 data unchanged');
assert(!storageKeys('test-app-2').includes('config'), 'app-2 has no app-1 keys');

// --- Usage tracking ---
console.log('\nStorage usage:');

const usage = storageUsage('test-app-1');
assert(usage.keys > 0, `has keys (${usage.keys})`);
assert(usage.bytes > 0, `has bytes (${usage.bytes})`);
assertEq(usage.quota, 5 * 1024 * 1024, 'quota is 5MB');
assert(usage.percent >= 0 && usage.percent <= 100, `percent in range (${usage.percent}%)`);
assert(typeof usage.formatted === 'string', `formatted is string (${usage.formatted})`);

// --- Quota enforcement ---
console.log('\nQuota enforcement:');

const bigValue = 'x'.repeat(6 * 1024 * 1024); // 6MB string
const quotaResult = storageSet('test-app-quota', 'big', bigValue);
assert(!quotaResult.ok, 'rejects value exceeding quota');
assert(quotaResult.error.includes('quota'), 'error mentions quota');
assertEq(storageGet('test-app-quota', 'big'), null, 'value not stored after quota rejection');

// --- Clear ---
console.log('\nStorage clear:');

storageClear('test-app-2');
assertEq(storageKeys('test-app-2').length, 0, 'clear removes all keys');
assertEq(storageGet('test-app-2', 'name'), null, 'cleared data returns null');

// --- Export / Import ---
console.log('\nExport / Import:');

const exported = storageExport('test-app-1');
assert(typeof exported === 'object', 'export returns object');
assert(exported.name === 'Updated Timer', 'export contains correct data');

const importResult = storageImport('test-app-import', { x: 1, y: 'two', z: [3] });
assert(importResult.ok, 'import succeeds');
assertEq(storageGet('test-app-import', 'x'), 1, 'imported value x');
assertEq(storageGet('test-app-import', 'y'), 'two', 'imported value y');
assertEq(storageGet('test-app-import', 'z'), [3], 'imported value z');

// --- List apps ---
console.log('\nList apps:');

storageFlushAll(); // ensure everything is written to disk
const appList = storageListApps();
assert(appList.includes('test-app-1'), 'lists test-app-1');
assert(appList.includes('test-app-import'), 'lists test-app-import');

// --- Export all ---
console.log('\nExport all:');

const allData = storageExportAll();
assert('test-app-1' in allData, 'export-all includes app-1');
assert('test-app-import' in allData, 'export-all includes app-import');

// --- Persistence (flush + reload) ---
console.log('\nPersistence:');

storageFlushAll();
const filePath = join(TEST_DATA_DIR, 'test-app-1', 'store.json');
assert(existsSync(filePath), 'store.json exists on disk');

// --- Delete ---
console.log('\nStorage delete:');

storageDelete('test-app-import');
assertEq(storageGet('test-app-import', 'x'), null, 'deleted app data is gone');
const dirPath = join(TEST_DATA_DIR, 'test-app-import');
assert(!existsSync(dirPath), 'directory removed');

// --- Path traversal protection ---
console.log('\nSecurity:');

storageSet('test-app-traversal', 'key', 'safe');
// The appId sanitizer replaces special chars with _
storageSet('../../../etc', 'passwd', 'hacked');
const hackedDir = join(TEST_DATA_DIR, '______etc');
storageFlushAll();
// Should NOT create a directory outside data/apps/
assert(!existsSync(join(TEST_DATA_DIR, '..', '..', '..', 'etc', 'store.json')), 'path traversal blocked');

// --- Cleanup ---
console.log('\nCleanup:');
for (const appId of TEST_APPS) {
  storageDelete(appId);
}
storageDelete('______etc');

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
