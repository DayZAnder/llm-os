// Tests for theme validation and model-generated themes (fetch is mocked)
// Run: node tests/theme.test.js

// Route every call to the OpenAI-compatible provider, which we mock below.
process.env.PRIMARY_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test';
process.env.OPENAI_BASE_URL = 'http://mock';

const { tmpdir } = await import('os');
const { join } = await import('path');
// Theme generation logs usage — keep it out of the user's real history
(await import('../src/kernel/usage-tracker.js')).setUsageFile(join(tmpdir(), `llmos-usage-theme-${process.pid}.json`));

const { validateTheme, contrast, DEFAULT_THEME, THEME_KEYS } = await import('../src/kernel/theme.js');
const { generateTheme } = await import('../src/kernel/gateway.js');

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

console.log('\ncontrast:');
assert(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01, 'black on white is 21:1');
assert(Math.abs(contrast('#777777', '#777777') - 1) < 0.01, 'same color is 1:1');
assert(contrast('#fff', '#000') === contrast('#000', '#fff'), 'order does not matter');

console.log('\nvalidateTheme:');
assert(validateTheme(DEFAULT_THEME).ok, 'default theme passes');
assert(THEME_KEYS.every(k => k in validateTheme({}).vars), 'missing keys fall back to defaults');
let r = validateTheme({ '--llmos-bg': 'red; } body { display:none' });
assert(!r.ok && r.vars['--llmos-bg'] === DEFAULT_THEME['--llmos-bg'], 'CSS injection in a color is rejected');
r = validateTheme({ '--llmos-font': 'x; background:url(//evil)' });
assert(!r.ok && r.vars['--llmos-font'] === DEFAULT_THEME['--llmos-font'], 'CSS injection in a font is rejected');
r = validateTheme({ '--llmos-radius': '999px' });
assert(!r.ok, 'absurd radius rejected');
r = validateTheme({ '--llmos-evil': '#fff' });
assert(!('--llmos-evil' in r.vars), 'unknown keys dropped');
r = validateTheme({ '--llmos-fg': '#20202a' });
assert(!r.ok && r.problems.some(p => p.includes('--llmos-fg on --llmos-bg')), 'unreadable text rejected with contrast problem');

console.log('\ngenerateTheme:');
const good = { name: 'Test Night', vars: { ...DEFAULT_THEME, '--llmos-accent': '#5fd4a8', '--llmos-accent-fg': '#06221a' } };
const bad = { name: 'Too Dark', vars: { ...DEFAULT_THEME, '--llmos-fg': '#2a2a33' } };
const requests = [];
function mockAnswers(answers) {
  let i = 0;
  globalThis.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    const content = answers[Math.min(i++, answers.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
  };
}

mockAnswers([JSON.stringify(good)]);
let theme = await generateTheme('nordic winter night');
assert(theme.name === 'Test Night' && theme.vars['--llmos-accent'] === '#5fd4a8', 'valid answer accepted');
assert(theme.attempts === 1, 'no correction round needed');

requests.length = 0;
mockAnswers(['```json\n' + JSON.stringify(bad) + '\n```', JSON.stringify(good)]);
theme = await generateTheme('something dark');
assert(theme.attempts === 2 && theme.name === 'Test Night', 'bad contrast triggers one correction round');
const feedback = requests[1].messages.at(-1).content;
assert(/--llmos-fg on --llmos-bg/.test(feedback), 'validator findings are sent back to the model');
assert(requests[1].messages.some(m => m.role === 'assistant'), 'model sees its previous answer');

mockAnswers(['not json at all', 'still not json']);
try {
  await generateTheme('anything');
  assert(false, 'gives up after two invalid answers');
} catch (err) {
  assert(/rejected after 2 attempts/.test(err.message), 'gives up after two invalid answers');
}

try {
  await generateTheme('   ');
  assert(false, 'empty description rejected');
} catch {
  assert(true, 'empty description rejected');
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
