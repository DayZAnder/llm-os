// A user's first session, against a running LLM OS (a booted VM image):
//
//   node tests/e2e/shell-journey.mjs http://127.0.0.1:3950 [artifact-dir]
//
// Needs the model stub (tests/e2e/stub-model.mjs) configured as the VM's
// model. Each step prints ✓/✗; screenshots go to the artifact directory.

import { launch, sleep } from './cdp.mjs';
import { join } from 'path';

const base = (process.argv[2] || 'http://127.0.0.1:3950').replace(/\/$/, '');
const out = process.argv[3] || 'e2e-artifacts';

let passed = 0, failed = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
  return cond;
};

const b = await launch({ width: 1600, height: 1000 });
const { evaluate, waitFor, appSession, screenshot } = b;
const shot = (name) => screenshot(join(out, `${name}.png`)).catch(() => {});
const prompt = (t) => evaluate(`(() => { const i = document.getElementById('prompt-input'); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
const modalOpen = `!document.getElementById('cap-modal').classList.contains('hidden')`;
const approve = async () => {
  await waitFor(modalOpen, { timeout: 60000 });
  await sleep(900); // Approve unlocks after a moment, by design
  await evaluate(`document.getElementById('modal-approve').click()`);
};
const windows = () => evaluate(`[...document.querySelectorAll('.app-window')].map(w => w.id.replace('window-', ''))`);

try {
  console.log(`\nshell at ${base}:`);
  await b.goto(base + '/');
  await waitFor(`!!document.getElementById('prompt-input')`, { timeout: 30000 });
  // First boot shows the service list and may wait for "Continue"
  await waitFor(`!document.getElementById('boot-splash') || !!document.querySelector('.boot-continue')`, { timeout: 60000 });
  const rows = await evaluate(`[...document.querySelectorAll('.boot-services .svc')].map(r => r.className.replace('svc svc-', '') + ':' + r.querySelector('.svc-name').textContent)`);
  await shot('01-boot');
  if (await evaluate(`!!document.querySelector('.boot-continue')`)) await evaluate(`document.querySelector('.boot-continue').click()`);
  await waitFor(`!document.getElementById('boot-splash')`, { timeout: 15000 });
  ok(true, 'shell boots and the splash closes');
  ok(!(rows || []).some(r => /^error:(Your data|Apps|Sandbox)/.test(r)), 'no failed core service at boot', JSON.stringify(rows));

  const boot = await evaluate(`fetch('/api/boot').then(r => r.json())`);
  const by = (id) => boot.services.find(s => s.id === id) || {};
  if (process.env.E2E_LOCAL !== '1') ok(/data disk/.test(by('data').detail || ''), 'user data is on the data disk', by('data').detail);
  ok(by('models').status === 'ok', 'the configured model is reachable', by('models').detail);

  console.log('\nwrite an app:');
  await prompt('a note-taking app that saves a note to a file in the shared filesystem and can open it');
  await approve();
  await waitFor(`document.querySelectorAll('.app-window').length >= 1`, { timeout: 30000 });
  const [appId] = await windows();
  const app = await appSession(appId);
  ok(await evaluate(`document.getElementById('title')?.textContent`, app) === 'E2E Notes', 'generated app runs in its sandbox');
  await shot('02-app');

  await evaluate(`document.getElementById('save').click()`, app);
  const saved = await waitFor(`/saved|failed/.test(document.getElementById('out').textContent) && document.getElementById('out').textContent`, { sessionId: app });
  ok(/saved: .*note\.txt/.test(saved), 'app writes to the shared filesystem', saved);

  await evaluate(`document.getElementById('net').click()`, app);
  const net = await waitFor(`/net/.test(document.getElementById('out').textContent) && document.getElementById('out').textContent`, { sessionId: app });
  ok(/net denied/.test(net), 'a call without permission is refused', net);

  console.log('\nopen the file in its app:');
  await evaluate(`document.getElementById('open').click()`, app);
  await approve(); // Notepad asks for file access
  await waitFor(`document.querySelectorAll('.app-window').length >= 2`, { timeout: 30000 });
  const notepadId = (await windows()).find(id => id !== appId);
  const notepad = await appSession(notepadId);
  const text = await waitFor(`(() => { const t = document.querySelector('textarea'); const v = (t && t.value) || document.body.innerText; return /written by the e2e app/.test(v) && v; })()`, { sessionId: notepad, timeout: 15000 }).catch(() => '');
  ok(!!text, 'Notepad opens the file the app wrote');
  await shot('03-notepad');

  console.log('\ndesktop and display:');
  await prompt('/desktop taskbar');
  ok(!!(await waitFor(`document.body.classList.contains('desk-bar-bottom')`).catch(() => false)), 'taskbar layout applies');
  await prompt('/display 125%');
  ok(!!(await waitFor(`getComputedStyle(document.documentElement).zoom === '1.25'`).catch(() => false)), 'display scale applies');
  await shot('04-desktop');
  await prompt('/display reset');
  await waitFor(`getComputedStyle(document.documentElement).zoom === '1'`).catch(() => {});

  const errors = b.consoleLines.filter(l => !/favicon|ERR_|net::/.test(l));
  ok(errors.length === 0, 'no uncaught errors in the shell', errors.slice(0, 3).join(' | '));
} catch (err) {
  ok(false, 'journey finished', err.message);
  await shot('99-failure');
} finally {
  b.close();
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
