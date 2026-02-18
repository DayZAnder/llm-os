// Tests for WASM sandbox — launch, kill, capability enforcement, memory limits, CPU timeout
// Run: node tests/wasm-sandbox.test.js

// Node.js v24 propagates terminated worker exit codes as unhandled rejections.
// Swallow them so the test runner exits cleanly when all tests pass.
process.on('unhandledRejection', () => {});

import { WasmSandbox } from '../src/kernel/wasm-sandbox/index.js';

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
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name} — expected ${b}, got ${a}`);
  }
}

async function assertRejects(fn, msgSubstr, name) {
  try {
    await fn();
    failed++;
    console.log(`  \u2717 ${name} — did not reject`);
  } catch (err) {
    if (err.message.includes(msgSubstr)) {
      passed++;
      console.log(`  \u2713 ${name}`);
    } else {
      failed++;
      console.log(`  \u2717 ${name} — rejected with "${err.message}", expected "${msgSubstr}"`);
    }
  }
}

// =====================================================================
// WASM binary builder — avoids manual byte counting errors
// =====================================================================

function leb128u(value) {
  const bytes = [];
  do {
    let byte = value & 0x7F;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function section(id, content) {
  return [id, ...leb128u(content.length), ...content];
}

function buildWasm(sections) {
  const magic = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];
  const bytes = [...magic];
  for (const s of sections) bytes.push(...s);
  return new Uint8Array(bytes);
}

function typeSection(...types) {
  const c = [...leb128u(types.length)];
  for (const t of types) {
    c.push(0x60, ...leb128u(t[0].length), ...t[0], ...leb128u(t[1].length), ...t[1]);
  }
  return section(1, c);
}

function importSection(...imports) {
  const c = [...leb128u(imports.length)];
  for (const [mod, name, kind, idx] of imports) {
    const modB = [...Buffer.from(mod)];
    const nameB = [...Buffer.from(name)];
    c.push(...leb128u(modB.length), ...modB, ...leb128u(nameB.length), ...nameB, kind, ...leb128u(idx));
  }
  return section(2, c);
}

function funcSection(...typeIndices) {
  return section(3, [...leb128u(typeIndices.length), ...typeIndices]);
}

function memSection(initial, max) {
  if (max !== undefined) {
    return section(5, [0x01, 0x01, ...leb128u(initial), ...leb128u(max)]);
  }
  return section(5, [0x01, 0x00, ...leb128u(initial)]);
}

function exportSection(...exports) {
  const c = [...leb128u(exports.length)];
  for (const [name, kind, idx] of exports) {
    const nameB = [...Buffer.from(name)];
    c.push(...leb128u(nameB.length), ...nameB, kind, ...leb128u(idx));
  }
  return section(7, c);
}

function codeSection(...bodies) {
  const c = [...leb128u(bodies.length)];
  for (const body of bodies) {
    const bodyBytes = [0x00, ...body]; // 0 local declarations + instructions
    c.push(...leb128u(bodyBytes.length), ...bodyBytes);
  }
  return section(10, c);
}

const I32 = 0x7F;

// =====================================================================
// WASM Test Fixtures
// =====================================================================

// add(i32, i32) → i32, bounded memory (1 page initial, 16 max)
const ADD_WASM = buildWasm([
  typeSection([[I32, I32], [I32]]),           // type 0: (i32,i32)→i32
  funcSection(0),                             // func 0 uses type 0
  memSection(1, 16),                          // memory: 1 page, max 16
  exportSection(['memory', 0x02, 0], ['add', 0x00, 0]),
  codeSection([0x20, 0x00, 0x20, 0x01, 0x6A, 0x0B]),  // local.get 0, local.get 1, i32.add, end
]);

// run() infinite loop, bounded memory
const INFINITE_LOOP_WASM = buildWasm([
  typeSection([[], []]),                       // type 0: ()→void
  funcSection(0),
  memSection(1, 16),
  exportSection(['run', 0x00, 0]),
  codeSection([0x03, 0x40, 0x0C, 0x00, 0x0B, 0x0B]),  // loop(void), br 0, end, end
]);

// grow() → i32, tries memory.grow 200 pages (max 16 → returns -1)
const MEMORY_HOG_WASM = buildWasm([
  typeSection([[], [I32]]),                    // type 0: ()→i32
  funcSection(0),
  memSection(1, 16),
  exportSection(['memory', 0x02, 0], ['grow', 0x00, 0]),
  codeSection([0x41, 0xC8, 0x01, 0x40, 0x00, 0x0B]),  // i32.const 200, memory.grow 0, end
]);

// same as ADD but memory has no maximum (flags=0) → rejected by validator
const UNBOUNDED_MEMORY_WASM = buildWasm([
  typeSection([[I32, I32], [I32]]),
  funcSection(0),
  memSection(1),                              // no max!
  exportSection(['memory', 0x02, 0], ['add', 0x00, 0]),
  codeSection([0x20, 0x00, 0x20, 0x01, 0x6A, 0x0B]),
]);

// Module that imports llmos.storage_get — used for capability denial test
// Imports: llmos.storage_get (type 0: (i32,i32,i32)→i32)
// Defines: run (type 1: ()→i32) that calls storage_get(0, 4, 100)
const IMPORTS_STORAGE_WASM = buildWasm([
  typeSection([[I32, I32, I32], [I32]], [[], [I32]]),  // type 0: (i32,i32,i32)→i32, type 1: ()→i32
  importSection(['llmos', 'storage_get', 0x00, 0]),    // import func 0 = llmos.storage_get, type 0
  funcSection(1),                                       // func 1 (defined) uses type 1
  memSection(1, 16),
  exportSection(['memory', 0x02, 0], ['run', 0x00, 1]),  // export func 1
  codeSection([
    0x41, 0x00,     // i32.const 0 (keyPtr)
    0x41, 0x04,     // i32.const 4 (keyLen)
    0x41, 0x64,     // i32.const 100 (outPtr)
    0x10, 0x00,     // call func 0 (storage_get)
    0x0B,           // end
  ]),
]);

// =====================================================================
// Tests
// =====================================================================

// --- Basic launch and call ---
console.log('\nBasic launch and call:');

{
  const sb = new WasmSandbox({});
  const result = await sb.launch('add-app', ADD_WASM, [], 'Add App', {
    entryFn: 'add',
    args: [3, 4],
  });
  assertEq(result, 7, 'add(3, 4) returns 7');
}

{
  const sb = new WasmSandbox({});
  const result = await sb.launch('add-zero', ADD_WASM, [], 'Add Zero', {
    entryFn: 'add',
    args: [0, 0],
  });
  assertEq(result, 0, 'add(0, 0) returns 0');
}

{
  const sb = new WasmSandbox({});
  const result = await sb.launch('add-large', ADD_WASM, [], 'Add Large', {
    entryFn: 'add',
    args: [1000000, 2000000],
  });
  assertEq(result, 3000000, 'add(1000000, 2000000) returns 3000000');
}

// --- Kill running app ---
console.log('\nKill:');

{
  const sb = new WasmSandbox({});
  const launchPromise = sb.launch('loop-app', INFINITE_LOOP_WASM, [], 'Loop', {
    entryFn: 'run',
    timeoutMs: 10000,
  });
  await new Promise(r => setTimeout(r, 200));
  assert(sb.listApps().length === 1, 'app is running before kill');
  sb.kill('loop-app');
  assertEq(sb.listApps().length, 0, 'killed app removed from list');
  await launchPromise.catch(() => {});
  assert(true, 'kill settles the launch promise');
}

{
  const sb = new WasmSandbox({});
  assert(sb.kill('nonexistent') === false, 'kill nonexistent returns false');
}

// --- Duplicate appId ---
console.log('\nDuplicate appId:');

{
  const sb = new WasmSandbox({});
  const p = sb.launch('dup', INFINITE_LOOP_WASM, [], 'Dup', {
    entryFn: 'run',
    timeoutMs: 5000,
  });
  await new Promise(r => setTimeout(r, 100));
  await assertRejects(
    () => sb.launch('dup', ADD_WASM, [], 'Dup2', { entryFn: 'add', args: [1, 2] }),
    'already running',
    'duplicate appId rejected'
  );
  sb.killAll();
  await p.catch(() => {});
}

// --- Capability enforcement: denied import ---
console.log('\nCapability enforcement — denied:');

{
  const sb = new WasmSandbox({});
  await assertRejects(
    () => sb.launch('nocap', IMPORTS_STORAGE_WASM, [], 'NoCap', { entryFn: 'run' }),
    'storage:local',
    'module importing storage without capability is rejected'
  );
}

// --- Memory limit ---
console.log('\nMemory limits:');

{
  const sb = new WasmSandbox({});
  const result = await sb.launch('memhog', MEMORY_HOG_WASM, [], 'MemHog', {
    entryFn: 'grow',
    memoryPages: 1,
    maxMemoryPages: 16,
  });
  assertEq(result, -1, 'memory.grow beyond maximum returns -1');
}

// --- Unbounded memory rejected ---
console.log('\nUnbounded memory validation:');

{
  const sb = new WasmSandbox({});
  await assertRejects(
    () => sb.launch('unbounded', UNBOUNDED_MEMORY_WASM, [], 'Unbounded', {
      entryFn: 'add',
      args: [1, 2],
    }),
    'unbounded memory',
    'module with unbounded memory is rejected'
  );
}

// --- CPU timeout ---
console.log('\nCPU timeout:');

{
  const sb = new WasmSandbox({});
  const start = Date.now();
  await assertRejects(
    () => sb.launch('timeout-app', INFINITE_LOOP_WASM, [], 'Timeout', {
      entryFn: 'run',
      timeoutMs: 500,
    }),
    'CPU timeout',
    'infinite loop killed after timeout'
  );
  const elapsed = Date.now() - start;
  assert(elapsed >= 400 && elapsed < 3000, `killed in ~500ms (got ${elapsed}ms)`);
}

// --- Multiple app isolation ---
console.log('\nIsolation:');

{
  const sb = new WasmSandbox({});
  const [r1, r2, r3] = await Promise.all([
    sb.launch('iso-1', ADD_WASM, [], 'A', { entryFn: 'add', args: [1, 2] }),
    sb.launch('iso-2', ADD_WASM, [], 'B', { entryFn: 'add', args: [10, 20] }),
    sb.launch('iso-3', ADD_WASM, [], 'C', { entryFn: 'add', args: [100, 200] }),
  ]);
  assertEq(r1, 3, 'iso-1: 1+2=3');
  assertEq(r2, 30, 'iso-2: 10+20=30');
  assertEq(r3, 300, 'iso-3: 100+200=300');
}

// --- listApps / getApp ---
console.log('\nlistApps / getApp:');

{
  const sb = new WasmSandbox({});
  const pending = sb.launch('long', INFINITE_LOOP_WASM, ['storage:local'], 'Long', {
    entryFn: 'run',
    timeoutMs: 10000,
  });
  await new Promise(r => setTimeout(r, 200));

  const apps = sb.listApps();
  assert(apps.length === 1, 'listApps returns 1 running app');
  assertEq(apps[0].id, 'long', 'correct app id');
  assertEq(apps[0].title, 'Long', 'correct title');
  assert(apps[0].capabilities.includes('storage:local'), 'capabilities listed');
  assertEq(apps[0].status, 'running', 'status is running');

  const app = sb.getApp('long');
  assert(app !== undefined, 'getApp returns app');
  assertEq(app.status, 'running', 'getApp status is running');

  assert(sb.getApp('nonexistent') === undefined, 'getApp returns undefined for unknown');

  sb.killAll();
  assertEq(sb.listApps().length, 0, 'killAll clears all apps');
  await pending.catch(() => {});
}

// --- Missing entry function ---
console.log('\nMissing entry function:');

{
  const sb = new WasmSandbox({});
  await assertRejects(
    () => sb.launch('bad-fn', ADD_WASM, [], 'BadFn', { entryFn: 'nonexistent', args: [] }),
    'no exported function',
    'missing entry function rejects'
  );
}

// --- Invalid WASM bytes ---
console.log('\nInvalid WASM:');

{
  const sb = new WasmSandbox({});
  await assertRejects(
    () => sb.launch('bad-wasm', new Uint8Array([0, 1, 2, 3]), [], 'Bad', { entryFn: 'main' }),
    'Invalid WASM magic',
    'invalid WASM binary rejected'
  );
}

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
