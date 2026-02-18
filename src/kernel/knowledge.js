// Knowledge Base
// Stores past generation prompts and results for context-aware future generation.
// Uses simple text similarity (trigram matching) — no vector DB needed.
//
// The knowledge base remembers what users have asked for before, so the LLM can:
// - Reference successful past generations
// - Avoid repeating failures
// - Build on existing patterns

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const KB_PATH = join(DATA_DIR, 'knowledge.json');
const MAX_ENTRIES = 200;

let _entries = null;

function load() {
  if (_entries) return _entries;
  if (existsSync(KB_PATH)) {
    try {
      _entries = JSON.parse(readFileSync(KB_PATH, 'utf-8'));
    } catch {
      _entries = [];
    }
  } else {
    _entries = [];
  }
  return _entries;
}

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(KB_PATH, JSON.stringify(_entries, null, 2));
}

// Trigram-based text similarity (no dependencies needed)
function trigrams(text) {
  const s = text.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const set = new Set();
  for (let i = 0; i <= s.length - 3; i++) {
    set.add(s.slice(i, i + 3));
  }
  return set;
}

function similarity(a, b) {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  return intersection / Math.max(ta.size, tb.size);
}

// Record a successful generation
export function recordGeneration(prompt, result) {
  const entries = load();
  entries.push({
    prompt,
    provider: result.provider,
    model: result.model,
    complexity: result.complexity,
    generationTime: result.generationTime,
    capabilities: result.capabilities,
    timestamp: new Date().toISOString(),
  });

  // Trim to max size (remove oldest)
  while (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  save();
}

// Find past generations similar to a given prompt
export function findSimilar(prompt, limit = 3, minSimilarity = 0.25) {
  const entries = load();
  const scored = entries
    .map(entry => ({
      ...entry,
      similarity: similarity(prompt, entry.prompt),
    }))
    .filter(e => e.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

// Build context string from similar past generations for the LLM
export function buildContext(prompt) {
  const similar = findSimilar(prompt);
  if (similar.length === 0) return null;

  const lines = similar.map(s =>
    `- "${s.prompt}" (${s.complexity}, ${s.capabilities.join(', ')})`
  );

  return `The user has previously requested similar apps:\n${lines.join('\n')}\nBuild on this context when generating.`;
}

// Get all entries (for API)
export function getEntries() {
  return load();
}

// Get knowledge base stats
export function getStats() {
  const entries = load();
  return {
    totalEntries: entries.length,
    maxEntries: MAX_ENTRIES,
    providers: [...new Set(entries.map(e => e.provider))],
    avgGenerationTime: entries.length > 0
      ? Math.round(entries.reduce((sum, e) => sum + (e.generationTime || 0), 0) / entries.length)
      : 0,
  };
}

// Clear the knowledge base
export function clear() {
  _entries = [];
  save();
}
