// App Registry — content-addressed store for vibe-coded apps.
// Apps are saved after generation and can be browsed, searched, and launched.

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizePrompt, trigramSimilarity } from '../utils/normalize.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const REGISTRY_FILE = join(DATA_DIR, 'registry.json');

// Community registry URL (GitHub raw)
const COMMUNITY_URL = 'https://raw.githubusercontent.com/DayZAnder/llm-os/master/registry';
const COMMUNITY_INDEX = `${COMMUNITY_URL}/index.json`;

// In-memory store, persisted to JSON
let apps = new Map(); // hash → AppEntry
let communityHashes = new Set(); // tracks which apps came from community

/**
 * @typedef {Object} AppEntry
 * @property {string} hash - SHA-256 of the code (content address)
 * @property {string} prompt - Original user prompt
 * @property {string} normalizedPrompt - Normalized for search
 * @property {string} title - Short display title
 * @property {string} type - 'iframe' or 'process'
 * @property {string} code - App code (HTML for iframe, source for process)
 * @property {string} [dockerfile] - Dockerfile for process apps
 * @property {string[]} capabilities - Granted capabilities
 * @property {string} model - LLM model used
 * @property {string} provider - 'ollama' or 'claude'
 * @property {number} launches - Times launched from registry
 * @property {number} createdAt - Unix timestamp
 * @property {string[]} tags - Auto-extracted + user tags
 */

function contentHash(code) {
  return createHash('sha256').update(code).digest('hex').slice(0, 16);
}

function extractTitle(prompt) {
  // Take first ~40 chars, clean up
  const clean = prompt.replace(/^(make|create|build|generate|give)\s+(me\s+)?/i, '');
  return clean.slice(0, 50).trim() || 'Untitled App';
}

function extractTags(prompt) {
  const lower = prompt.toLowerCase();
  const tags = [];
  const TAG_KEYWORDS = {
    calculator: ['math', 'utility'],
    todo: ['productivity'],
    timer: ['utility', 'time'],
    pomodoro: ['productivity', 'time'],
    game: ['game', 'fun'],
    chat: ['communication'],
    bot: ['automation', 'bot'],
    whatsapp: ['communication', 'bot'],
    clock: ['utility', 'time'],
    converter: ['utility'],
    password: ['security', 'utility'],
    markdown: ['text', 'utility'],
    color: ['design', 'utility'],
    weather: ['api', 'utility'],
    note: ['productivity'],
    editor: ['text', 'productivity'],
  };

  for (const [keyword, kwTags] of Object.entries(TAG_KEYWORDS)) {
    if (lower.includes(keyword)) tags.push(...kwTags);
  }
  return [...new Set(tags)];
}

// --- Persistence ---

function load() {
  if (!existsSync(REGISTRY_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
    apps = new Map(data.map(entry => [entry.hash, entry]));
    console.log(`[registry] Loaded ${apps.size} apps`);
  } catch (err) {
    console.warn('[registry] Failed to load:', err.message);
  }
}

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  const data = [...apps.values()].sort((a, b) => b.createdAt - a.createdAt);
  writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
}

// --- Public API ---

/**
 * Save an app to the registry.
 * Returns the hash (content address). Deduplicates by code hash.
 */
export function publishApp({ prompt, code, dockerfile, type, capabilities, model, provider }) {
  const hash = contentHash(code);

  if (apps.has(hash)) {
    // Already exists — bump launch count
    const existing = apps.get(hash);
    existing.launches++;
    save();
    return { hash, existing: true, entry: existing };
  }

  const title = extractTitle(prompt);
  const entry = {
    hash,
    prompt,
    normalizedPrompt: normalizePrompt(prompt),
    title,
    type: type || 'iframe',
    code,
    dockerfile: dockerfile || null,
    capabilities: capabilities || [],
    model: model || 'unknown',
    provider: provider || 'unknown',
    launches: 1,
    createdAt: Date.now(),
    tags: extractTags(prompt),
    spec: `# ${title}\n\n${prompt}\n\n## Requirements\n\n- (edit this spec to guide AI improvements)\n`,
  };

  apps.set(hash, entry);
  save();
  console.log(`[registry] Published: "${entry.title}" (${hash})`);
  return { hash, existing: false, entry };
}

/**
 * Find apps with similar prompts. Returns top matches above threshold.
 */
export function findSimilar(prompt, { threshold = 0.3, limit = 8 } = {}) {
  const normalized = normalizePrompt(prompt);
  const results = [];

  for (const entry of apps.values()) {
    const similarity = trigramSimilarity(normalized, entry.normalizedPrompt);
    if (similarity >= threshold) {
      results.push({ ...entry, similarity });
    }
  }

  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Get a specific app by hash.
 */
export function getApp(hash) {
  return apps.get(hash) || null;
}

/**
 * Record a launch (when user launches from registry).
 */
export function recordLaunch(hash) {
  const entry = apps.get(hash);
  if (entry) {
    entry.launches++;
    save();
  }
}

/**
 * Browse all apps, newest first. Supports pagination and tag filter.
 */
export function browseApps({ offset = 0, limit = 20, tag = null, type = null } = {}) {
  let entries = [...apps.values()];

  if (tag) entries = entries.filter(e => e.tags.includes(tag));
  if (type) entries = entries.filter(e => e.type === type);

  entries.sort((a, b) => b.createdAt - a.createdAt);

  return {
    apps: entries.slice(offset, offset + limit),
    total: entries.length,
    offset,
  };
}

/**
 * Search apps by prompt text (trigram similarity).
 */
export function searchApps(query, { limit = 10 } = {}) {
  if (!query || query.trim().length < 2) return [];
  return findSimilar(query, { threshold: 0.2, limit });
}

/**
 * Get all unique tags with counts.
 */
export function getTags() {
  const tagCounts = new Map();
  for (const entry of apps.values()) {
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  return [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get registry stats.
 */
export function getStats() {
  const entries = [...apps.values()];
  return {
    totalApps: entries.length,
    iframeApps: entries.filter(e => e.type === 'iframe').length,
    processApps: entries.filter(e => e.type === 'process').length,
    totalLaunches: entries.reduce((sum, e) => sum + e.launches, 0),
    tags: getTags(),
  };
}

/**
 * Update an app's spec (markdown). Returns the updated spec or null if not found.
 */
export function updateSpec(hash, spec) {
  const entry = apps.get(hash);
  if (!entry) return null;
  entry.spec = spec;
  save();
  return entry.spec;
}

/**
 * Rate an app (thumbs up/down). rating: 1 or -1.
 */
export function rateApp(hash, rating) {
  const entry = apps.get(hash);
  if (!entry) return null;
  if (!entry.rating) entry.rating = { up: 0, down: 0 };
  if (rating > 0) entry.rating.up++;
  else entry.rating.down++;
  save();
  return entry.rating;
}

/**
 * Delete an app by hash.
 */
export function deleteApp(hash) {
  const existed = apps.delete(hash);
  if (existed) save();
  return existed;
}

/**
 * Sync community registry from GitHub.
 * Fetches the index, then fetches full app data for new apps.
 * Non-blocking — failures are silently ignored.
 */
export async function syncCommunity() {
  try {
    const indexRes = await fetch(COMMUNITY_INDEX, { signal: AbortSignal.timeout(8000) });
    if (!indexRes.ok) return;
    const index = await indexRes.json();

    let added = 0;
    for (const meta of index.apps) {
      if (apps.has(meta.hash)) continue; // already have it

      // Fetch full app data
      try {
        const appRes = await fetch(`${COMMUNITY_URL}/apps/${meta.hash}.json`, { signal: AbortSignal.timeout(5000) });
        if (!appRes.ok) continue;
        const entry = await appRes.json();
        entry.source = 'community';
        entry.launches = apps.get(meta.hash)?.launches || 0; // preserve local launch count
        apps.set(entry.hash, entry);
        communityHashes.add(entry.hash);
        added++;
      } catch {}
    }

    if (added > 0) {
      save();
      console.log(`[registry] Synced ${added} community app(s)`);
    }
  } catch (err) {
    // Network error — no problem, community sync is optional
  }
}

/**
 * Check if an app is from the community registry.
 */
export function isCommunityApp(hash) {
  const entry = apps.get(hash);
  return entry?.source === 'community' || communityHashes.has(hash);
}

// Load on import
load();

// Async community sync (non-blocking)
syncCommunity().catch(() => {});
