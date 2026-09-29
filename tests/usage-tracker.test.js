// Tests for usage tracker
// Run: node tests/usage-tracker.test.js

import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  record, getStats, getByModel, getByProvider, getRecent,
  clear, getEntries, calculateCost, PRICING, PROVIDER_PRICING, setUsageFile,
} from '../src/kernel/usage-tracker.js';
import { usageFor } from '../src/kernel/gateway.js';

// Never touch the user's real data/usage.json
const USAGE_FILE = join(tmpdir(), `llmos-usage-test-${process.pid}.json`);
setUsageFile(USAGE_FILE);

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

function assertClose(actual, expected, tolerance, name) {
  const close = Math.abs(actual - expected) <= tolerance;
  if (!close) {
    console.log(`    expected: ~${expected} (±${tolerance})`);
    console.log(`    actual:   ${actual}`);
  }
  assert(close, name);
}

// --- Start fresh ---
console.log('\nUsage Tracker Tests');
console.log('===================\n');

clear();

// --- Empty state ---
console.log('Empty state:');
{
  const stats = getStats();
  assertEq(stats.totalGenerations, 0, 'empty: totalGenerations = 0');
  assertEq(stats.totalCost, 0, 'empty: totalCost = 0');
  assertEq(stats.cacheHits, 0, 'empty: cacheHits = 0');
  assertEq(stats.avgLatencyMs, 0, 'empty: avgLatencyMs = 0');
  assertEq(getByModel().length, 0, 'empty: getByModel returns empty');
  assertEq(getByProvider().length, 0, 'empty: getByProvider returns empty');
  assertEq(getRecent().length, 0, 'empty: getRecent returns empty');
}

// --- Record entries ---
console.log('\nRecording entries:');
{
  record({
    prompt: 'calculator app',
    provider: 'ollama',
    model: 'qwen2.5:14b',
    inputTokens: 100,
    outputTokens: 500,
    latencyMs: 340,
    cached: false,
    cacheType: null,
  });

  record({
    prompt: 'todo list',
    provider: 'claude',
    model: 'claude-sonnet-4-5-20250929',
    inputTokens: 200,
    outputTokens: 1000,
    latencyMs: 2100,
    cached: false,
    cacheType: null,
  });

  record({
    prompt: 'calculator app',
    provider: 'ollama',
    model: 'qwen2.5:14b',
    inputTokens: 100,
    outputTokens: 500,
    latencyMs: 0,
    cached: true,
    cacheType: 'exact',
  });

  const entries = getEntries();
  assertEq(entries.length, 3, 'recorded 3 entries');
  assert(entries[0].prompt === 'calculator app', 'first entry prompt correct');
  assert(entries[2].cached === true, 'third entry is cached');
  assert(entries[2].cost === 0, 'cached entry has $0 cost');
}

// --- getStats ---
console.log('\ngetStats:');
{
  const stats = getStats();
  assertEq(stats.totalGenerations, 3, 'stats: 3 total generations');
  assertEq(stats.totalInputTokens, 400, 'stats: 400 input tokens');
  assertEq(stats.totalOutputTokens, 2000, 'stats: 2000 output tokens');
  assertEq(stats.cacheHits, 1, 'stats: 1 cache hit');
  assertEq(stats.cacheMisses, 2, 'stats: 2 cache misses');
  assertEq(stats.cacheHitRate, 33, 'stats: 33% cache hit rate');
  // Avg latency: (340 + 2100 + 0) / 3 = 813.33 → 813
  assertEq(stats.avgLatencyMs, 813, 'stats: avg latency ~813ms');
}

// --- Cost calculation ---
console.log('\nCost calculation:');
{
  // Ollama should be free
  assertEq(calculateCost('qwen2.5:14b', 'ollama', 1000, 1000), 0, 'ollama cost = $0');

  // Claude Sonnet: 200 input * $3/M + 1000 output * $15/M
  const sonnetCost = calculateCost('claude-sonnet-4-5-20250929', 'claude', 200, 1000);
  assertClose(sonnetCost, 0.0156, 0.0001, 'sonnet cost = ~$0.0156');

  // GPT-4o: 1000 input * $2.50/M + 1000 output * $10/M
  const gpt4oCost = calculateCost('gpt-4o', 'openai', 1000, 1000);
  assertClose(gpt4oCost, 0.0125, 0.0001, 'gpt-4o cost = ~$0.0125');

  // Unknown model falls back to provider pricing
  const unknownCost = calculateCost('some-custom-model', 'claude', 1000, 1000);
  const [ir, or] = PROVIDER_PRICING.claude;
  const expected = (1000 * ir + 1000 * or) / 1_000_000;
  assertClose(unknownCost, expected, 0.0001, 'unknown model uses provider fallback pricing');

  // Unknown provider = $0
  assertEq(calculateCost('mystery', 'mystery-provider', 1000, 1000), 0, 'unknown provider = $0');
}

// --- getByModel ---
console.log('\ngetByModel:');
{
  const models = getByModel();
  assertEq(models.length, 2, 'byModel: 2 models');
  const qwen = models.find(m => m.model === 'qwen2.5:14b');
  const sonnet = models.find(m => m.model === 'claude-sonnet-4-5-20250929');
  assert(qwen, 'byModel: qwen found');
  assert(sonnet, 'byModel: sonnet found');
  assertEq(qwen.generations, 2, 'byModel: qwen has 2 generations');
  assertEq(sonnet.generations, 1, 'byModel: sonnet has 1 generation');
  assertEq(qwen.cost, 0, 'byModel: qwen cost = $0');
  assert(sonnet.cost > 0, 'byModel: sonnet cost > $0');
}

// --- getByProvider ---
console.log('\ngetByProvider:');
{
  const providers = getByProvider();
  assertEq(providers.length, 2, 'byProvider: 2 providers');
  const ollama = providers.find(p => p.provider === 'ollama');
  const claude = providers.find(p => p.provider === 'claude');
  assert(ollama, 'byProvider: ollama found');
  assert(claude, 'byProvider: claude found');
  assertEq(ollama.generations, 2, 'byProvider: ollama has 2 generations');
  assertEq(claude.generations, 1, 'byProvider: claude has 1 generation');
}

// --- getRecent ---
console.log('\ngetRecent:');
{
  const recent = getRecent(2);
  assertEq(recent.length, 2, 'getRecent(2) returns 2 entries');
  assert(recent[0].cached === true, 'most recent entry is the cached one');
  assert(recent[1].prompt === 'todo list', 'second most recent is todo list');

  const all = getRecent(100);
  assertEq(all.length, 3, 'getRecent(100) returns all 3 entries');
}

// --- FIFO eviction ---
console.log('\nFIFO eviction:');
{
  clear();
  // Record MAX+10 entries
  for (let i = 0; i < 2010; i++) {
    record({
      prompt: `app-${i}`,
      provider: 'ollama',
      model: 'qwen2.5:14b',
      inputTokens: 10,
      outputTokens: 10,
      latencyMs: 10,
      cached: false,
    });
  }
  const entries = getEntries();
  assertEq(entries.length, 2000, 'FIFO: capped at 2000 entries');
  assert(entries[0].prompt === 'app-10', 'FIFO: oldest kept is app-10 (first 10 evicted)');
  assert(entries[entries.length - 1].prompt === 'app-2009', 'FIFO: newest is app-2009');
}

// --- Clear ---
console.log('\nClear:');
{
  clear();
  assertEq(getEntries().length, 0, 'clear: entries empty');
  assertEq(getStats().totalGenerations, 0, 'clear: stats reset');
}

// --- Pricing table sanity ---
console.log('\nPricing table:');
{
  assert(Object.keys(PRICING).length >= 5, 'pricing table has >= 5 models');
  for (const [model, rates] of Object.entries(PRICING)) {
    assert(Array.isArray(rates) && rates.length === 2, `pricing: ${model} has [input, output] rates`);
    assert(rates[0] >= 0 && rates[1] >= 0, `pricing: ${model} rates are non-negative`);
  }
  for (const [provider, rates] of Object.entries(PROVIDER_PRICING)) {
    assert(Array.isArray(rates) && rates.length === 2, `provider pricing: ${provider} has [input, output] rates`);
  }
}

// --- Edge cases ---
console.log('\nEdge cases:');
{
  clear();

  // Record with missing fields
  record({ prompt: 'minimal' });
  const entries = getEntries();
  assertEq(entries.length, 1, 'edge: record with minimal fields works');
  assertEq(entries[0].provider, 'unknown', 'edge: missing provider defaults to unknown');
  assertEq(entries[0].inputTokens, 0, 'edge: missing tokens default to 0');
  assertEq(entries[0].cached, false, 'edge: missing cached defaults to false');

  // Long prompt gets truncated
  record({ prompt: 'x'.repeat(200), provider: 'ollama', model: 'qwen2.5:14b' });
  const entries2 = getEntries();
  assertEq(entries2[1].prompt.length, 100, 'edge: long prompt truncated to 100 chars');

  clear();
}

// --- Prompt-cache pricing ---
console.log('\nCache pricing:');
{
  // Opus 5: $5 in / $25 out per MTok; cache read 0.1x, cache write 1.25x
  assertClose(calculateCost('claude-opus-5', 'claude', 1_000_000, 0), 5, 1e-9, 'cache: plain input at full rate');
  assertClose(calculateCost('claude-opus-5', 'claude', 0, 0, 1_000_000, 0), 0.5, 1e-9, 'cache: reads cost 10% of input');
  assertClose(calculateCost('claude-opus-5', 'claude', 0, 0, 0, 1_000_000), 6.25, 1e-9, 'cache: writes cost 125% of input');
  clear();
  record({ prompt: 'x', provider: 'claude', model: 'claude-opus-5', inputTokens: 100, outputTokens: 1000, cacheReadTokens: 4000, latencyMs: 1 });
  const e = getEntries()[0];
  assertEq(e.cacheReadTokens, 4000, 'cache: read tokens stored');
  assertClose(e.cost, (100 * 5 + 1000 * 25 + 4000 * 0.5) / 1e6, 1e-12, 'cache: entry cost includes discounted reads');
  clear();
}

// --- Reported vs estimated tokens ---
console.log('\nusageFor:');
{
  const messages = [
    { role: 'system', content: 'word '.repeat(1000) },
    { role: 'user', content: 'make a clock' },
  ];
  const est = usageFor(messages, '<html></html>', null);
  assert(est.estimated === true, 'usageFor: no provider numbers → estimated');
  assert(est.inputTokens >= 1000, 'usageFor: estimate counts the system prompt, not just the user prompt');
  const real = usageFor(messages, 'x', { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 7 });
  assertEq([real.inputTokens, real.outputTokens, real.cacheReadTokens, real.estimated], [1234, 56, 7, false], 'usageFor: provider numbers win');
  assert(usageFor(messages, 'x', { inputTokens: 0, outputTokens: 0 }).estimated, 'usageFor: all-zero report falls back to estimate');
}

if (existsSync(USAGE_FILE)) rmSync(USAGE_FILE);

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
