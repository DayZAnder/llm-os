// Tests for the boot/service report (kernel/boot.js)
// Run: node tests/boot.test.js

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'llmos-boot-'));
process.env.LLMOS_DATA_DIR = dir;
const { bootReport, formatText, checkData } = await import('../src/kernel/boot.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const base = {
  listModels: async () => [
    { provider: 'claude', model: 'claude-opus-5', label: 'Claude Opus 5', local: false },
    { provider: 'ollama', model: 'qwen2.5:14b', label: 'qwen2.5:14b', local: true },
  ],
  ollamaUrl: 'http://localhost:11434',
  cloudConfigured: ['claude'],
  registryStats: () => ({ totalApps: 12 }),
  dockerEnabled: true,
  dockerPing: async () => true,
  schedulerEnabled: false,
  tokenKeyReady: true,
  theme: 'Default',
  desktop: 'Menu bar + dock',
};
const by = (report, id) => report.services.find(s => s.id === id);

console.log('\nbootReport:');
let r = await bootReport(base);
assert(r.status === 'ok' || r.status === 'warn', 'healthy setup has no errors');
assert(by(r, 'models').status === 'ok' && /Claude Opus 5/.test(by(r, 'models').detail), 'models listed, cloud first');
assert(by(r, 'apps').detail === '12 installed', 'app count');
assert(by(r, 'scheduler').status === 'off', 'disabled features are "off", not warnings');
assert(r.services.every(s => typeof s.ms === 'number'), 'every check is timed');

r = await bootReport({ ...base, listModels: async () => [], cloudConfigured: [] });
assert(by(r, 'models').status === 'warn' && /Start Ollama/.test(by(r, 'models').fix), 'no model: warning with a concrete fix');
assert(by(r, 'local-models').status === 'error', 'Ollama configured but down, and no cloud: error');
assert(!/Cloud models still work/.test(by(r, 'local-models').fix), 'does not claim cloud models work when none are configured');

r = await bootReport({ ...base, listModels: async () => [base.listModels && { provider: 'claude', model: 'x', label: 'X', local: false }] });
assert(by(r, 'local-models').status === 'warn' && /Cloud models still work/.test(by(r, 'local-models').fix), 'Ollama down but cloud works: warning, not error');

r = await bootReport({ ...base, ollamaUrl: '', listModels: async () => [{ provider: 'claude', model: 'x', label: 'X', local: false }] });
assert(by(r, 'local-models').status === 'off', 'Ollama not configured and not running: off (a fresh VM is not an error)');
r = await bootReport({ ...base, ollamaUrl: '', defaultOllamaUrl: 'http://localhost:11434' });
assert(by(r, 'local-models').status === 'ok' && /default|localhost/.test(by(r, 'local-models').detail), 'not configured but answering at the default address: ok');

r = await bootReport({ ...base, dockerPing: async () => { throw new Error('no socket'); } });
assert(by(r, 'processes').status === 'off' && /Server or Desktop image/.test(by(r, 'processes').detail), 'no Docker: off, says where it exists');

r = await bootReport({ ...base, tokenKeyReady: false });
assert(r.status === 'error' && by(r, 'sandbox').status === 'error', 'missing signing key is an error');

r = await bootReport({ ...base, registryStats: () => { throw new Error('boom'); } });
assert(by(r, 'apps').status === 'error' && by(r, 'apps').detail === 'boom', 'a throwing check becomes an error row, not a crash');

console.log('\ncheckData:');
const d = checkData();
assert(['ok', 'warn'].includes(d.status) && /free/.test(d.detail), 'data dir writable, free space reported');

console.log('\nformatText:');
const text = formatText(await bootReport({ ...base, listModels: async () => [], cloudConfigured: [] }));
assert(/^\[  OK  \] Your data/m.test(text), 'systemd-style OK line');
assert(/^\[ WARN \] AI models/m.test(text), 'WARN line');
assert(/^\[FAILED\] Local models/m.test(text), 'FAILED line');
assert(/^\[  --  \] Self-improvement/m.test(text), 'off line');
assert(/^         → /m.test(text), 'fix indented under its line');

rmSync(dir, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
