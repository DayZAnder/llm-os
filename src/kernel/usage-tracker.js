// Usage Tracker
// Records per-generation metrics (tokens, cost, latency, cache hits).
// In-memory store with JSON persistence, follows knowledge.js pattern.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { estimateTokenCount } from './utils/normalize.js';
import { dataPath } from './paths.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let usagePath = dataPath('usage.json');
const MAX_ENTRIES = 2000;

// Prompt-cache pricing relative to the input rate (Anthropic)
const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

/** Use a different file (tests must not touch the user's real history). */
export function setUsageFile(path) {
  usagePath = path;
  _entries = null;
}

// Pricing per million tokens [input, output] in USD
const PRICING = {
  // Ollama (local) — free
  'qwen2.5:14b':       [0, 0],
  'qwen2.5:7b':        [0, 0],
  'qwen2.5:0.5b':      [0, 0],
  'deepseek-coder-v2:16b': [0, 0],
  // Claude
  'claude-fable-5-1':  [10, 50],
  'claude-opus-5-5':   [4, 20],
  'claude-opus-5':     [5, 25],
  'claude-sonnet-5':   [2, 10],
  'claude-haiku-4-5':  [1, 5],
  'claude-opus-4-6':   [5, 25],
  'claude-sonnet-4-5-20250929': [3, 15],
  'claude-haiku-4-5-20251001':  [1, 5],
  // OpenAI
  'gpt-4o':            [2.50, 10],
  'gpt-4o-mini':       [0.15, 0.60],
};

// Fallback pricing by provider (when model not in table)
const PROVIDER_PRICING = {
  ollama:  [0, 0],
  claude:  [5, 25],   // assume Opus-level (the default model)
  openai:  [2.50, 10], // assume GPT-4o-level
};

let _entries = null;

function load() {
  if (_entries) return _entries;
  if (existsSync(usagePath)) {
    try {
      _entries = JSON.parse(readFileSync(usagePath, 'utf-8'));
    } catch {
      _entries = [];
    }
  } else {
    _entries = [];
  }
  return _entries;
}

function save() {
  mkdirSync(dirname(usagePath), { recursive: true });
  writeFileSync(usagePath, JSON.stringify(_entries, null, 2));
}

function getPricing(model, provider) {
  return PRICING[model] || PROVIDER_PRICING[provider] || [0, 0];
}

export function calculateCost(model, provider, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const [inputRate, outputRate] = getPricing(model, provider);
  return (
    inputTokens * inputRate +
    outputTokens * outputRate +
    cacheReadTokens * inputRate * CACHE_READ_FACTOR +
    cacheWriteTokens * inputRate * CACHE_WRITE_FACTOR
  ) / 1_000_000;
}

// Record a generation event. `estimated` marks token counts that were not
// reported by the provider (word-count estimate instead).
export function record({ prompt, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, estimated, latencyMs, cached, cacheType }) {
  const entries = load();
  const cost = cached ? 0 : calculateCost(model, provider, inputTokens || 0, outputTokens || 0, cacheReadTokens || 0, cacheWriteTokens || 0);

  entries.push({
    prompt: (prompt || '').slice(0, 100),
    provider: provider || 'unknown',
    model: model || 'unknown',
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    cacheReadTokens: cacheReadTokens || 0,
    cacheWriteTokens: cacheWriteTokens || 0,
    estimated: !!estimated,
    cost,
    latencyMs: latencyMs || 0,
    cached: !!cached,
    cacheType: cacheType || null,
    timestamp: new Date().toISOString(),
  });

  while (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  save();
}

// Aggregate stats
export function getStats() {
  const entries = load();
  if (entries.length === 0) {
    return {
      totalGenerations: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      avgLatencyMs: 0,
    };
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let cacheHits = 0;
  let totalLatency = 0;

  for (const e of entries) {
    totalInputTokens += e.inputTokens || 0;
    totalOutputTokens += e.outputTokens || 0;
    totalCost += e.cost || 0;
    if (e.cached) cacheHits++;
    totalLatency += e.latencyMs || 0;
  }

  const cacheMisses = entries.length - cacheHits;

  return {
    totalGenerations: entries.length,
    totalInputTokens,
    totalOutputTokens,
    totalCost: Math.round(totalCost * 10000) / 10000, // 4 decimal places
    cacheHits,
    cacheMisses,
    cacheHitRate: entries.length > 0 ? Math.round((cacheHits / entries.length) * 100) : 0,
    avgLatencyMs: Math.round(totalLatency / entries.length),
  };
}

// Group by model
export function getByModel() {
  const entries = load();
  const groups = {};

  for (const e of entries) {
    const key = e.model || 'unknown';
    if (!groups[key]) {
      groups[key] = { model: key, generations: 0, inputTokens: 0, outputTokens: 0, cost: 0, totalLatency: 0 };
    }
    const g = groups[key];
    g.generations++;
    g.inputTokens += e.inputTokens || 0;
    g.outputTokens += e.outputTokens || 0;
    g.cost += e.cost || 0;
    g.totalLatency += e.latencyMs || 0;
  }

  return Object.values(groups).map(g => ({
    model: g.model,
    generations: g.generations,
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    cost: Math.round(g.cost * 10000) / 10000,
    avgLatencyMs: Math.round(g.totalLatency / g.generations),
  })).sort((a, b) => b.generations - a.generations);
}

// Group by provider
export function getByProvider() {
  const entries = load();
  const groups = {};

  for (const e of entries) {
    const key = e.provider || 'unknown';
    if (!groups[key]) {
      groups[key] = { provider: key, generations: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    }
    const g = groups[key];
    g.generations++;
    g.inputTokens += e.inputTokens || 0;
    g.outputTokens += e.outputTokens || 0;
    g.cost += e.cost || 0;
  }

  return Object.values(groups).map(g => ({
    ...g,
    cost: Math.round(g.cost * 10000) / 10000,
  })).sort((a, b) => b.generations - a.generations);
}

// Get N most recent entries
export function getRecent(n = 20) {
  const entries = load();
  return entries.slice(-n).reverse();
}

// Clear all usage data
export function clear() {
  _entries = [];
  save();
}

// Get all entries (for export)
export function getEntries() {
  return load();
}

// Expose for testing
export { estimateTokenCount, PRICING, PROVIDER_PRICING };
