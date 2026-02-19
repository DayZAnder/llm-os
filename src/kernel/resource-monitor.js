// Resource Monitor — probes available models and ranks them by capability.
// Periodically checks Ollama (local models) and cloud providers (API keys).
// Exposes getBestModel(task) for dynamic model selection.

import { config } from './config.js';

// Known model tiers (higher = more capable)
const MODEL_TIERS = {
  // Ollama / local models (by param count)
  'smollm2:360m': 1,
  'qwen2.5:0.5b': 1,
  'tinyllama:1.1b': 1,
  'llama3.2:1b': 1,
  'qwen2.5:1.5b': 2,
  'phi-3:3.8b': 3,
  'llama3.2:3b': 3,
  'qwen2.5:3b': 3,
  'qwen2.5:7b': 4,
  'llama3.1:8b': 4,
  'mistral:7b': 4,
  'deepseek-coder-v2:16b': 5,
  'qwen2.5:14b': 5,
  'codellama:34b': 6,
  'qwen2.5:32b': 6,
  'llama3.1:70b': 7,
  'qwen2.5:72b': 7,

  // Claude
  'claude-haiku-4-5-20251001': 5,
  'claude-sonnet-4-5-20250929': 7,
  'claude-sonnet-4-6': 7,
  'claude-opus-4-6': 9,

  // OpenAI
  'gpt-4o-mini': 5,
  'gpt-4o': 7,
  'o1': 9,
};

// Minimum tier needed for each task
const TASK_MIN_TIER = {
  route: 1,              // Routing: any model works, prefer smallest
  'generate-simple': 3,  // Simple apps: mid-tier OK
  'generate-medium': 4,  // Medium apps: decent model
  'generate-complex': 5, // Complex apps: strong model
  generate: 4,           // Default
};

let availableModels = [];
let lastProbe = 0;
const PROBE_INTERVAL = 60000; // Re-probe every 60s

/**
 * Estimate tier from model size when not in known list.
 */
function estimateTier(name, sizeBytes) {
  const gb = (sizeBytes || 0) / 1e9;
  if (gb < 1) return 1;
  if (gb < 3) return 2;
  if (gb < 6) return 3;
  if (gb < 10) return 4;
  if (gb < 20) return 5;
  if (gb < 40) return 6;
  return 7;
}

/**
 * Probe Ollama for available models.
 */
async function probeOllama() {
  const url = config.providers.ollama.url;
  if (!url) return [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const data = await res.json();

    return (data.models || []).map(m => ({
      name: m.name,
      provider: 'ollama',
      size: m.size || 0,
      tier: MODEL_TIERS[m.name] || estimateTier(m.name, m.size),
      parameterSize: m.details?.parameter_size || null,
      quantization: m.details?.quantization_level || null,
    }));
  } catch {
    return [];
  }
}

/**
 * Check cloud providers (just config-based, no API call).
 */
function probeCloud() {
  const models = [];

  const claude = config.providers.claude;
  if (claude.apiKey) {
    models.push({
      name: claude.model,
      provider: 'claude',
      size: 0,
      tier: MODEL_TIERS[claude.model] || 7,
    });
    // Also add higher-tier Claude models that the key can access
    if (!claude.model.includes('opus')) {
      models.push({
        name: 'claude-opus-4-6',
        provider: 'claude',
        size: 0,
        tier: 9,
        requiresOverride: true, // Not the default, but available
      });
    }
    if (!claude.model.includes('haiku')) {
      models.push({
        name: 'claude-haiku-4-5-20251001',
        provider: 'claude',
        size: 0,
        tier: 5,
        requiresOverride: true,
      });
    }
  }

  const openai = config.providers.openai;
  if (openai.apiKey) {
    models.push({
      name: openai.model,
      provider: 'openai',
      size: 0,
      tier: MODEL_TIERS[openai.model] || 7,
    });
  }

  return models;
}

/**
 * Probe all providers and update the available models list.
 */
export async function probe() {
  const [ollamaModels, cloudModels] = await Promise.all([
    probeOllama(),
    Promise.resolve(probeCloud()),
  ]);

  availableModels = [...ollamaModels, ...cloudModels]
    .sort((a, b) => b.tier - a.tier); // Best first

  lastProbe = Date.now();

  if (availableModels.length > 0) {
    const summary = availableModels.map(m => `${m.name}(t${m.tier})`).join(', ');
    console.log(`[resources] ${availableModels.length} model(s): ${summary}`);
  } else {
    console.log('[resources] No models available');
  }

  return availableModels;
}

/**
 * Get current available models (re-probes if stale).
 */
export async function getAvailableModels() {
  if (Date.now() - lastProbe > PROBE_INTERVAL) {
    await probe();
  }
  return availableModels;
}

/**
 * Get the best model for a given task.
 * Tasks: 'route', 'generate-simple', 'generate-medium', 'generate-complex', 'generate'
 *
 * For 'route': returns the smallest adequate model (save resources).
 * For generation: returns the strongest available model meeting the minimum tier.
 */
export async function getBestModel(task = 'generate') {
  const models = await getAvailableModels();
  if (models.length === 0) return null;

  const minTier = TASK_MIN_TIER[task] || 4;

  if (task === 'route') {
    // For routing, pick the smallest model that meets minimum tier
    // Prefer Ollama (local, no cost) over cloud
    const localModels = models.filter(m => m.provider === 'ollama');
    if (localModels.length > 0) {
      // Smallest local model (last in tier-sorted list)
      return localModels[localModels.length - 1];
    }
    // Fall back to any model
    return models[models.length - 1];
  }

  // For generation, pick the strongest model that's >= minTier
  // Prefer non-override models (configured defaults)
  const adequate = models.filter(m => m.tier >= minTier && !m.requiresOverride);
  if (adequate.length > 0) return adequate[0]; // Strongest adequate

  // Include override models if no configured default meets the tier
  const withOverrides = models.filter(m => m.tier >= minTier);
  if (withOverrides.length > 0) return withOverrides[0];

  // Nothing meets the tier — return the best we have
  return models[0];
}

/**
 * Get the best Ollama model specifically (for local generation).
 * Returns model name string or null.
 */
export async function getBestOllamaModel(task = 'generate') {
  const models = await getAvailableModels();
  const local = models.filter(m => m.provider === 'ollama');
  if (local.length === 0) return null;

  if (task === 'route') {
    return local[local.length - 1].name; // Smallest
  }
  return local[0].name; // Strongest
}

/**
 * Summary for API/UI display.
 */
export function getResourceSummary() {
  return {
    models: availableModels.map(m => ({
      name: m.name,
      provider: m.provider,
      tier: m.tier,
      parameterSize: m.parameterSize || null,
    })),
    bestRoute: availableModels.length > 0
      ? availableModels.filter(m => m.provider === 'ollama').slice(-1)[0]?.name || availableModels.slice(-1)[0]?.name
      : null,
    bestGenerate: availableModels.length > 0 ? availableModels[0].name : null,
    modelCount: availableModels.length,
    lastProbe,
    probeAge: Date.now() - lastProbe,
  };
}
