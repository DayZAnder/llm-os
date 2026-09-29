// Tests for desktop layouts (kernel/desktop.js) and generateDesktop (fetch mocked)
// Run: node tests/desktop.test.js

process.env.PRIMARY_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test';
process.env.OPENAI_BASE_URL = 'http://mock';

const { tmpdir } = await import('os');
const { join } = await import('path');
const { existsSync, rmSync } = await import('fs');
(await import('../src/kernel/usage-tracker.js')).setUsageFile(join(tmpdir(), `llmos-usage-desktop-${process.pid}.json`));
const desktop = await import('../src/kernel/desktop.js');
const { validateLayout, PRESETS, loadLayout, saveLayout, resetLayout, setLayoutFile, resolvePreset } = desktop;
const { generateDesktop } = await import('../src/kernel/gateway.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('\npresets:');
for (const [name, preset] of Object.entries(PRESETS)) {
  const { problems } = validateLayout(preset, preset);
  assert(problems.length === 0, `preset "${name}" validates cleanly`);
}
assert(PRESETS.dock.windows.controls === 'left' && PRESETS.dock.dock.position === 'bottom', 'mac: controls left, dock bottom');
assert(PRESETS.taskbar.bar.position === 'bottom' && PRESETS.taskbar.bar.launcher.label === 'Prompt', 'windows: bottom bar with a Prompt launcher');

console.log('\nvalidateLayout:');
let r = validateLayout({ bar: { position: 'sideways', height: 999, launcher: { label: '<img src=x onerror=alert(1)>' } } }, PRESETS.taskbar);
assert(r.problems.some(p => p.startsWith('bar.position')), 'bad enum reported');
assert(r.layout.bar.position === 'bottom', 'bad enum falls back to preset');
assert(r.layout.bar.height === 64, 'height clamped to 64');
assert(!/[<>]/.test(r.layout.bar.launcher.label) && r.layout.bar.launcher.label.length <= 16, 'launcher label stripped of markup and length-limited');
r = validateLayout({ dock: { position: 'left', iconSize: 5, pinned: ['Files', 42, 'x'.repeat(100), '', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] } }, PRESETS.dock);
assert(r.layout.dock.iconSize === 24, 'icon size clamped');
assert(r.layout.dock.pinned.length === 12 && r.layout.dock.pinned.every(p => typeof p === 'string' && p.length <= 30 && p), 'pinned list cleaned and capped at 12');
r = validateLayout({ bar: { position: 'none' }, dock: { position: 'none' }, promptBar: 'hidden' }, PRESETS.classic);
assert(r.layout.promptBar === 'visible', 'prompt bar forced visible when nothing else can launch apps');
assert(r.problems.some(p => p.startsWith('promptBar')), 'and the model is told why');
r = validateLayout({ wallpaper: { type: 'gradient', from: 'url(//evil)', to: '#123456' } }, PRESETS.taskbar);
assert(r.layout.wallpaper.from === '#0d0d1a' && r.layout.wallpaper.to === '#123456', 'wallpaper colors must be #rrggbb');
r = validateLayout({ bar: { position: 'top' }, evil: true, windows: { controls: 'left', extra: 1 } }, PRESETS.taskbar);
assert(!('evil' in r.layout) && !('extra' in r.layout.windows), 'unknown fields dropped');
assert(r.layout.bar.position === 'top' && r.layout.windows.controls === 'left', 'valid overrides applied on top of the preset');

console.log('\npersistence:');
const file = join(tmpdir(), `llmos-desktop-${process.pid}.json`);
setLayoutFile(file);
assert(loadLayout().preset === 'classic', 'no file → classic');
saveLayout({ ...validateLayout(PRESETS.dock, PRESETS.dock).layout, preset: 'mac', name: 'Mac style' });
assert(loadLayout().dock.position === 'bottom', 'saved layout loads back');
assert(loadLayout().preset === 'dock' && loadLayout().name === 'Menu bar + dock', 'layout saved under the old name "mac" maps to "dock"');
saveLayout({ ...validateLayout(PRESETS.dock, PRESETS.dock).layout, preset: 'mac', name: 'My studio' });
assert(loadLayout().name === 'My studio', 'a custom name survives the alias mapping');
assert(resolvePreset('windows') === 'taskbar' && resolvePreset('MAC') === 'dock' && resolvePreset('dock') === 'dock', 'aliases resolve');
assert(resolvePreset('__proto__') === null && resolvePreset('toString') === null && resolvePreset(undefined) === null, 'no prototype keys as presets');
assert(resetLayout().preset === 'classic' && !existsSync(file), 'reset removes the file');

console.log('\ngenerateDesktop:');
function mockAnswers(answers) {
  let i = 0;
  globalThis.fetch = async (url, init) => {
    const content = answers[Math.min(i++, answers.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
  };
}
mockAnswers([JSON.stringify({ base: 'mac', name: 'Studio', dock: { position: 'left', pinned: ['Files', 'Writer'] } })]);
let layout = await generateDesktop('mac style with the dock on the left');
assert(layout.name === 'Studio' && layout.dock.position === 'left' && layout.bar.style === 'menubar', 'model answer merged onto the mac preset');
assert(layout.attempts === 1, 'valid answer needs no correction');

mockAnswers([
  JSON.stringify({ base: 'windows', bar: { position: 'diagonal' } }),
  JSON.stringify({ base: 'windows', bar: { position: 'top' } }),
]);
layout = await generateDesktop('windows but the bar on top');
assert(layout.attempts === 2 && layout.bar.position === 'top', 'invalid value triggers one correction round');

mockAnswers([JSON.stringify({ base: 'windows', bar: { position: 'diagonal' } }), JSON.stringify({ base: 'windows', bar: { position: 'upside-down' } })]);
layout = await generateDesktop('something odd');
assert(layout.bar.position === 'bottom' && layout.problems.length > 0, 'still-invalid second answer is used with the bad field replaced');

mockAnswers(['no json', 'still no json']);
try { await generateDesktop('x'); assert(false, 'gives up on non-JSON'); }
catch (err) { assert(/valid JSON/.test(err.message), 'gives up on non-JSON'); }

console.log('\nupgrade with a chosen model:');
process.env.OLLAMA_URL = 'http://127.0.0.1:1'; // no local models in this test
const { listUpgradeModels, evolve } = await import('../src/kernel/gateway.js');
const offered = await listUpgradeModels();
assert(offered.some(m => m.provider === 'openai') && !offered.some(m => m.provider === 'claude'), 'only configured providers are offered');
assert(offered.every((m, i) => i === 0 || offered[i - 1].tier >= m.tier), 'strongest models first');
try {
  await evolve({ code: '<html></html>', instruction: 'x', target: { provider: 'claude', model: 'claude-opus-5-5' } });
  assert(false, 'unoffered model rejected');
} catch (err) {
  assert(/not available/.test(err.message), 'unoffered model rejected');
}
mockAnswers(['<!-- capabilities: ["ui:window"] -->\n<!DOCTYPE html><html><body>v2</body></html>']);
const pick = offered.find(m => m.provider === 'openai');
const upgraded = await evolve({ code: '<html></html>', instruction: 'improve', target: { provider: pick.provider, model: pick.model } });
assert(upgraded.provider === 'openai' && upgraded.model === pick.model && upgraded.code.includes('v2'), 'chosen model does the rewrite');

if (existsSync(file)) rmSync(file);
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
