// Tests for shell version store and improvement validation
// Run: node tests/shell-versions.test.js

import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Clean up test data BEFORE importing store (which loads on import)
const testFiles = [
  join(DATA_DIR, 'shell-versions.json'),
  join(DATA_DIR, 'shell-current.json'),
  join(DATA_DIR, 'shell-versions'),
];
for (const f of testFiles) {
  if (existsSync(f)) rmSync(f, { recursive: true, force: true });
}

// Dynamic import so cleanup runs first
const {
  listVersions, saveVersion, getVersion, getCurrentVersion,
  getCurrentId, setCurrentId, getShellPath, readCurrentShell,
  readVersionHtml,
} = await import('../src/kernel/shell-versions/store.js');

const {
  validateShellOutput, codeDiffPercent,
} = await import('../src/kernel/shell-versions/improve.js');

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

function assertEq(actual, expected, name) {
  assert(actual === expected, `${name} (got: ${actual}, expected: ${expected})`);
}

// --- Store Tests ---

console.log('\nShell Version Store:');

assert(Array.isArray(listVersions()), 'listVersions returns array');
assertEq(listVersions().length, 0, 'starts empty');
assertEq(getCurrentId(), null, 'no current id initially');
assertEq(getCurrentVersion(), null, 'no current version initially');

// getShellPath falls back to original
const shellPath = getShellPath();
assert(shellPath.includes('shell'), 'getShellPath falls back to src/shell/index.html');
assert(shellPath.endsWith('index.html'), 'fallback path ends with index.html');

// readCurrentShell returns the original shell
const originalHtml = readCurrentShell();
assert(originalHtml.includes('<!DOCTYPE html>') || originalHtml.includes('<html'), 'readCurrentShell returns HTML');
assert(originalHtml.length > 100, 'original shell has substantial content');

// Save a version
const testHtml = '<!DOCTYPE html><html><body>test shell v1</body></html>';
const meta1 = saveVersion({
  id: 'sv_test_001',
  html: testHtml,
  source: 'user',
  prompt: 'make it better',
  diff: 25,
  parentId: null,
});

assert(meta1.id === 'sv_test_001', 'saveVersion returns correct id');
assert(meta1.byteSize > 0, 'saveVersion calculates byteSize');
assert(meta1.createdAt > 0, 'saveVersion sets createdAt');
assertEq(meta1.source, 'user', 'saveVersion preserves source');
assertEq(meta1.diff, 25, 'saveVersion preserves diff');
assertEq(listVersions().length, 1, 'one version after save');

// Read version HTML
const readBack = readVersionHtml('sv_test_001');
assertEq(readBack, testHtml, 'readVersionHtml returns saved HTML');
assertEq(readVersionHtml('nonexistent'), null, 'readVersionHtml returns null for missing id');

// Set current and verify
setCurrentId('sv_test_001');
assertEq(getCurrentId(), 'sv_test_001', 'getCurrentId after set');

const currentVersion = getCurrentVersion();
assert(currentVersion !== null, 'getCurrentVersion returns entry');
assertEq(currentVersion.id, 'sv_test_001', 'getCurrentVersion has correct id');

// getShellPath now points to version file
const versionPath = getShellPath();
assert(versionPath.includes('sv_test_001'), 'getShellPath returns version file');

// Save more versions
for (let i = 2; i <= 12; i++) {
  saveVersion({
    id: `sv_test_${String(i).padStart(3, '0')}`,
    html: `<!DOCTYPE html><html><body>test shell v${i}</body></html>`,
    source: 'scheduler',
    prompt: null,
    diff: 10 + i,
    parentId: `sv_test_${String(i - 1).padStart(3, '0')}`,
  });
}

// Should cap at MAX_VERSIONS (10)
const allVersions = listVersions();
assertEq(allVersions.length, 10, 'capped at MAX_VERSIONS (10)');
assertEq(allVersions[0].id, 'sv_test_012', 'newest version is first');

// getVersion by id
const v5 = getVersion('sv_test_005');
assert(v5 !== null, 'getVersion finds existing version');
assertEq(v5.id, 'sv_test_005', 'getVersion returns correct id');
assertEq(getVersion('nonexistent'), null, 'getVersion returns null for missing');

// --- Validation Tests ---

console.log('\nShell Output Validation:');

// Valid shell (has all required patterns)
const validShell = `<!DOCTYPE html>
<html>
<head><title>LLM OS</title></head>
<body>
<script type="module">
import { SandboxManager } from './sandbox.js';
const sdk = await fetch('/sdk/sdk.js');
const btn = document.getElementById('generateBtn');
btn.onclick = () => fetch('/api/generate', { method: 'POST' });
window.addEventListener('message', (e) => { if (e.data.postMessage) {} });
document.getElementById('capModal').style.display = 'block';
function openRegistry() { /* browse app registry */ }
</script>
</body>
</html>`;

const { valid: v1valid, failures: v1f } = validateShellOutput(validShell);
assert(v1valid, 'valid shell passes validation');
assertEq(v1f.length, 0, 'no failures for valid shell');

// Missing SandboxManager
const noSandbox = validShell.replace('SandboxManager', 'FooBar');
const { valid: v2valid } = validateShellOutput(noSandbox);
assert(!v2valid, 'rejects shell missing SandboxManager');

// Missing sandbox.js import
const noSandboxJs = validShell.replace('sandbox.js', 'other.js');
const { valid: v3valid } = validateShellOutput(noSandboxJs);
assert(!v3valid, 'rejects shell missing sandbox.js');

// Missing SDK path
const noSdk = validShell.replace('/sdk/sdk.js', '/other/path.js');
const { valid: v4valid } = validateShellOutput(noSdk);
assert(!v4valid, 'rejects shell missing /sdk/sdk.js');

// Missing /api/generate
const noApi = validShell.replace('/api/generate', '/other/api');
const { valid: v5valid } = validateShellOutput(noApi);
assert(!v5valid, 'rejects shell missing /api/generate');

// Missing capability modal
const noModal = validShell.replace('capModal', 'otherModal');
const { valid: v6valid } = validateShellOutput(noModal);
assert(!v6valid, 'rejects shell missing capability modal');

// Missing closing html tag
const noClose = validShell.replace('</html>', '');
const { valid: v7valid } = validateShellOutput(noClose);
assert(!v7valid, 'rejects shell missing </html>');

// --- codeDiffPercent Tests ---

console.log('\nCode Diff Percent:');

assertEq(codeDiffPercent('hello', 'hello'), 0, 'identical strings = 0%');
assertEq(codeDiffPercent('', ''), 0, 'empty strings = 0%');
assert(codeDiffPercent('aaaa', 'zzzz') === 100, 'completely different = 100%');
assert(codeDiffPercent('hello world', 'hello earth') > 20, 'partial diff > 20%');
assert(codeDiffPercent('hello world', 'hello earth') < 80, 'partial diff < 80%');

const longA = 'a'.repeat(100);
const longB = 'a'.repeat(50) + 'b'.repeat(50);
const halfDiff = codeDiffPercent(longA, longB);
assert(halfDiff >= 45 && halfDiff <= 55, `half-changed = ~50% (got ${halfDiff}%)`);

// --- Summary ---

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
