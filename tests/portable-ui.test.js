// Tests for the portable UI core (src/sdk/ui.js) — renderer-independent parts
// Run: node tests/portable-ui.test.js

import { readFileSync } from 'fs';
import vm from 'vm';

const ctx = {};
vm.runInNewContext(readFileSync(new URL('../src/sdk/ui.js', import.meta.url), 'utf-8'), ctx);
const { normalize, snapshot, c, createApp, COMPONENTS } = ctx.__LLMOS_UI__;

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
const json = (x) => JSON.stringify(x);

console.log('\nbuilders:');
let n = c.column({ gap: 8 }, c.text('Hi'), c.button({ onPress: () => {} }, 'Go'));
assert(n.t === 'column' && n.props.gap === 8 && n.children.length === 2, 'column with props and children');
n = c.text('Just text');
assert(n.t === 'text' && json(n.props) === '{}' && n.children[0] === 'Just text', 'props may be omitted');
n = c.row(c.text('a'), c.text('b'));
assert(n.children.length === 2 && n.children[0].t === 'text', 'first arg may be a node');
assert(Object.keys(COMPONENTS).every(t => typeof c[t] === 'function'), 'a builder for every component');

console.log('\nnormalize:');
n = normalize(c.column({ gap: 8, color: 'red', onclick: 'alert(1)', align: 'center' }, 'x'));
assert(json(n.props) === '{"gap":8,"align":"center"}', 'unknown props dropped');
n = normalize(c.text({ size: 'huge', tone: 'accent' }, 'x'));
assert(n.props.size === undefined && n.props.tone === 'accent', 'invalid enum values dropped');
n = normalize(c.column({ gap: 1e9, padding: -5, width: 'fill' }));
assert(n.props.gap === 200 && n.props.padding === 0 && n.props.width === 'fill', 'numbers clamped, fill allowed');
n = normalize(c.button({ onPress: 'alert(1)' }, 'x'));
assert(!('onPress' in n.props), 'string handlers rejected');
n = normalize({ t: 'iframe', props: {}, children: [] });
assert(n.t === 'text' && n.props.tone === 'danger' && /unknown component/.test(n.children[0]), 'unknown component renders as visible error');
n = normalize(c.column(null, false, 'a', 3, [c.text('b'), [c.text('c')]]));
assert(n.children.length === 4 && n.children[1] === '3' && n.children[3].t === 'text', 'null/false skipped, numbers stringified, nested arrays flattened');
n = normalize(c.spacer({ size: 12 }));
assert(n.props.size === 12, 'spacer takes a pixel size');
n = normalize(c.text({ size: 40 }, 'x'));
assert(n.props.size === 40, 'text takes a pixel size');
n = normalize(c.text({ size: 'giant' }, 'x'));
assert(n.props.size === undefined, 'unknown named size dropped');
n = normalize(c.logo({ size: 48, onPress: () => {} }));
assert(n.t === 'logo' && n.props.size === 48 && !('onPress' in n.props), 'logo takes a size and nothing else');
assert(typeof ctx.__LLMOS_UI__.LOGO_SPARK === 'string', 'launcher mark geometry is exported for other renderers');
n = normalize(c.column({ key: 42 }));
assert(n.props.key === '42', 'keys are strings');

console.log('\nsnapshot:');
const handler = () => {};
const snap = snapshot(normalize(c.column({ gap: 4 }, c.button({ onPress: handler, variant: 'primary' }, 'Save'), c.input({ value: 'v', onChange: handler }))));
assert(json(snap) === json(JSON.parse(json(snap))), 'snapshot is JSON-safe');
assert(snap.children[0].props.onPress === true && snap.children[1].props.onChange === true, 'handlers become true');
assert(snap.children[0].children[0] === 'Save' && snap.children[1].props.value === 'v', 'content preserved');

console.log('\ncreateApp:');
const trees = [];
const fake = { render: (t) => trees.push(normalize(t)) };
const app = createApp({
  state: { count: 0 },
  view: (s, set) => c.column(c.text(`Count: ${s.count}`), c.button({ onPress: () => set({ count: s.count + 1 }) }, '+')),
}, fake);
assert(trees.length === 1 && trees[0].children[0].children[0] === 'Count: 0', 'renders initial state synchronously');
trees[0].children[1].props.onPress();
app.set((s) => ({ count: s.count + 10 }));
assert(trees.length === 1, 'updates are batched (not rendered synchronously)');
await Promise.resolve();
await Promise.resolve();
assert(trees.length === 2 && trees[1].children[0].children[0] === 'Count: 11', 'two updates → one render with both applied');

let initRan = false;
const loaded = [];
createApp({
  state: { items: [] },
  view: (s) => c.column(s.items.map(i => c.text({ key: i }, i))),
  async init(set) { initRan = true; set({ items: ['a', 'b'] }); },
}, { render: (t) => loaded.push(normalize(t)) });
await new Promise(r => setTimeout(r, 0));
assert(initRan && loaded.at(-1).children.length === 2, 'async init can set state');

const errors = [];
createApp({ view: () => { throw new Error('boom'); } }, fake, (e) => errors.push(e.message));
assert(errors[0] === 'boom', 'view errors go to the error handler, not the page');

try {
  createApp({}, fake);
  assert(false, 'missing view rejected');
} catch {
  assert(true, 'missing view rejected');
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
