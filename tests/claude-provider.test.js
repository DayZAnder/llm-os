// Tests for the Claude provider's streaming parser (fetch is mocked — no network)
// Run: node tests/claude-provider.test.js

import { provider, TruncatedOutputError } from '../src/kernel/providers/claude.js';

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

// Build an SSE body from events, split into awkward chunks to exercise buffering
function sseBody(events) {
  const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
  return (async function* () { for (const c of chunks) yield c; })();
}

let lastRequest = null;
function mockFetch(events, status = 200) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, init, body: JSON.parse(init.body) };
    if (status !== 200) return { ok: false, status, text: async () => 'boom' };
    return { ok: true, status, body: sseBody(events) };
  };
}

const delta = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const stop = (reason, extra = {}) => ({ type: 'message_delta', delta: { stop_reason: reason, ...extra }, usage: { output_tokens: 5 } });
const cfg = { apiKey: 'k', model: 'claude-opus-5' };
const messages = [
  { role: 'system', content: 'STABLE' },
  { role: 'system', content: 'VOLATILE' },
  { role: 'user', content: 'make a clock' },
];

console.log('\nclaude provider:');

mockFetch([{ type: 'message_start', message: { usage: { input_tokens: 10 } } }, delta('<html>'), delta('</html>'), stop('end_turn'), { type: 'message_stop' }]);
let streamed = '';
const out = await provider.generate(messages, cfg, { onText: (t) => { streamed += t; } });
assert(out === '<html></html>', 'accumulates text deltas across chunk boundaries');
assert(streamed === out, 'onText receives every delta');
assert(lastRequest.body.stream === true, 'requests streaming');
assert(lastRequest.body.max_tokens === 64000, 'default max_tokens is 64000');
assert(lastRequest.body.system[0].cache_control?.type === 'ephemeral', 'first system block is cacheable');
assert(lastRequest.body.system[1].text === 'VOLATILE' && !lastRequest.body.system[1].cache_control, 'second system block follows uncached');
assert(lastRequest.body.messages.length === 1 && lastRequest.body.messages[0].role === 'user', 'system messages lifted out of messages');
assert(lastRequest.body.fallbacks === 'default', 'opus-5 opts into refusal fallbacks');
assert(lastRequest.init.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01', 'fallback beta header sent');
assert(!('temperature' in lastRequest.body), 'no sampling params (rejected on current models)');

mockFetch([delta('ok'), stop('end_turn'), { type: 'message_stop' }]);
await provider.generate(messages, { apiKey: 'k', model: 'claude-haiku-4-5', effort: '' });
assert(!('fallbacks' in lastRequest.body) && !lastRequest.init.headers['anthropic-beta'], 'no fallbacks for models without support');
assert(!('output_config' in lastRequest.body), 'no effort unless configured');

mockFetch([delta('ok'), stop('end_turn'), { type: 'message_stop' }]);
await provider.generate(messages, { ...cfg, effort: 'xhigh' });
assert(lastRequest.body.output_config?.effort === 'xhigh', 'effort from config goes into output_config');

mockFetch([delta('refused partial'), { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } } }, delta('<html>ok</html>'), stop('end_turn'), { type: 'message_stop' }]);
assert(await provider.generate(messages, cfg) === '<html>ok</html>', 'fallback block discards the declined partial output');

mockFetch([delta('<html><body>half'), stop('max_tokens')]);
try {
  await provider.generate(messages, cfg);
  assert(false, 'max_tokens throws');
} catch (err) {
  assert(err instanceof TruncatedOutputError, 'max_tokens throws TruncatedOutputError');
  assert(err.partial === '<html><body>half', 'truncation error carries partial output');
}

mockFetch([stop('refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' } })]);
try {
  await provider.generate(messages, cfg);
  assert(false, 'refusal throws');
} catch (err) {
  assert(/declined/.test(err.message) && /nope/.test(err.message), 'refusal surfaces explanation');
}

mockFetch([], 529);
try {
  await provider.generate(messages, cfg);
  assert(false, 'HTTP error throws');
} catch (err) {
  assert(/529/.test(err.message), 'HTTP errors include status');
}

mockFetch([delta('x'), { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]);
try {
  await provider.generate(messages, cfg);
  assert(false, 'stream error throws');
} catch (err) {
  assert(/overloaded_error/.test(err.message), 'mid-stream error events throw');
}

// Connection closed cleanly mid-answer: no message_delta / message_stop
mockFetch([delta('<html><body>half an app')]);
try {
  await provider.generate(messages, cfg);
  assert(false, 'early end throws');
} catch (err) {
  assert(/ended before/.test(err.message), 'a stream that ends early is not returned as a finished answer');
}

// Last event without the trailing blank line is still read
globalThis.fetch = async () => ({ ok: true, status: 200, body: (async function* () {
  yield new TextEncoder().encode(`data: ${JSON.stringify(delta('done'))}\n\ndata: ${JSON.stringify(stop('end_turn'))}\n\ndata: {"type":"message_stop"}`);
})() });
assert(await provider.generate(messages, cfg) === 'done', 'final SSE event without a trailing blank line is processed');

// The declined partial output is withdrawn from the live view too
let resets = 0;
mockFetch([delta('refused'), { type: 'content_block_start', index: 1, content_block: { type: 'fallback' } }, delta('ok'), stop('end_turn'), { type: 'message_stop' }]);
await provider.generate(messages, cfg, { onText: () => {}, onReset: () => resets++ });
assert(resets === 1, 'fallback block resets the live view');

mockFetch([stop('refusal', { stop_details: { explanation: 'no' } }), { type: 'message_stop' }]);
try { await provider.generate(messages, cfg); } catch (err) { assert(err.name === 'RefusalError', 'refusals have their own error type (not retried elsewhere)'); }

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
