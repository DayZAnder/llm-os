// Tests for display settings (kernel/display.js) and generateDisplay (fetch mocked)
// Run: node tests/display.test.js

process.env.PRIMARY_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test';
process.env.OPENAI_BASE_URL = 'http://mock';

const { tmpdir } = await import('os');
const { join } = await import('path');
const { existsSync } = await import('fs');
(await import('../src/kernel/usage-tracker.js')).setUsageFile(join(tmpdir(), `llmos-usage-display-${process.pid}.json`));
const { validateDisplay, parseDisplayDirect, loadDisplay, saveDisplay, resetDisplay, setDisplayFile, SCALE_STEPS } = await import('../src/kernel/display.js');
const { generateDisplay } = await import('../src/kernel/gateway.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('\nvalidateDisplay:');
assert(validateDisplay({ scale: 1.5 }).problems.length === 0 && validateDisplay({ scale: 1.5 }).display.scale === 1.5, 'a normal scale passes');
assert(validateDisplay({ scale: 150 }).display.scale === 1.5, 'percentages are understood (150 → 1.5)');
assert(validateDisplay({ scale: 1.234 }).display.scale === 1.25, 'rounded to 5% steps');
let r = validateDisplay({ scale: 9 });
assert(r.problems.length === 1 && r.display.scale === 3, 'out of range: reported and clamped');
assert(validateDisplay({ scale: 'big' }).problems.length === 1, 'non-numbers are reported');
assert(validateDisplay({}).problems.length === 1, 'missing scale is reported');
assert(SCALE_STEPS.every(s => validateDisplay({ scale: s }).problems.length === 0), 'every offered step is valid');

console.log('\nparseDisplayDirect (no model needed):');
assert(parseDisplayDirect('150%').scale === 1.5, '"150%"');
assert(parseDisplayDirect('1.25x').scale === 1.25, '"1.25x"');
assert(parseDisplayDirect('x2').scale === 2, '"x2"');
assert(parseDisplayDirect('reset').scale === 1 && parseDisplayDirect('default').scale === 1, '"reset" / "default"');
assert(parseDisplayDirect('bigger text please') === null, 'words go to the model');

console.log('\npersistence:');
const file = join(tmpdir(), `llmos-display-${process.pid}.json`);
setDisplayFile(file);
assert(loadDisplay().scale === 1, 'no file → 1');
assert(saveDisplay({ scale: 1.75 }).scale === 1.75 && loadDisplay().scale === 1.75, 'saved and loaded back');
assert(saveDisplay({ scale: 50 }).scale === 0.5, 'saving validates too');
assert(resetDisplay().scale === 1 && !existsSync(file), 'reset removes the file');

console.log('\ngenerateDisplay:');
function mockAnswers(answers) {
  let i = 0;
  globalThis.fetch = async () => {
    const content = answers[Math.min(i++, answers.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
  };
  return () => i;
}
let calls = mockAnswers([JSON.stringify({ scale: 1.5, reason: 'Bigger for reading from a distance.' })]);
let d = await generateDisplay('I sit far from the screen', { screen: { width: 1920, height: 1080, dpr: 1 }, current: { scale: 1 } });
assert(d.scale === 1.5 && /distance/.test(d.reason) && calls() === 1, 'model answer accepted when it does what was asked');

calls = mockAnswers([JSON.stringify({ scale: 1, reason: 'Larger.' }), JSON.stringify({ scale: 1.25, reason: 'Larger.' })]);
d = await generateDisplay('bigger text', { current: { scale: 1 } });
assert(d.scale === 1.25 && calls() === 2, 'an answer that does not get bigger is sent back once');

calls = mockAnswers([JSON.stringify({ scale: 2 }), JSON.stringify({ scale: 2 })]);
d = await generateDisplay('fit more on the screen', { current: { scale: 1.5 } });
assert(d.scale === 1.2 && calls() === 2, 'a clear "smaller" is still done when the model keeps getting it wrong');

mockAnswers(['not json', 'still not json']);
let threw = false;
try { await generateDisplay('make it purple', { current: { scale: 1 } }); } catch { threw = true; }
assert(threw, 'no usable answer and no clear direction: an error, nothing saved');

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
