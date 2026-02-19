import { config } from './config.js';
import { provider as ollamaProvider } from './providers/ollama.js';
import { provider as claudeProvider } from './providers/claude.js';
import { provider as openaiProvider } from './providers/openai-compatible.js';
import { buildContext } from './knowledge.js';
import { getBestModel } from './resource-monitor.js';

// Provider registry — add new providers here
const providers = new Map();
providers.set('ollama', ollamaProvider);
providers.set('claude', claudeProvider);
providers.set('openai', openaiProvider);

function getProviderConfig(name) {
  return config.providers[name] || {};
}

function getAvailableProviders() {
  const available = [];
  for (const [name, prov] of providers) {
    if (prov.isAvailable(getProviderConfig(name))) {
      available.push(name);
    }
  }
  return available;
}

export function getProviders() {
  const result = {};
  for (const [name, prov] of providers) {
    const cfg = getProviderConfig(name);
    result[name] = {
      available: prov.isAvailable(cfg),
      model: cfg.model || null,
    };
  }
  return result;
}

const SYSTEM_PROMPT = `You are the app generator for LLM OS. Generate a SINGLE self-contained app.

Output ONLY valid HTML with inline <script> and <style> tags. No markdown, no explanation, no code fences.

SDK (available as global LLMOS):
  LLMOS.ui.render(element) — mount your app's root element to the page
  LLMOS.ui.h(tag, props, ...children) — create a DOM element
  LLMOS.storage.get(key) — read from persistent storage (returns Promise)
  LLMOS.storage.set(key, value) — write to persistent storage (returns Promise)
  LLMOS.timer.setInterval(fn, ms) — repeating timer, returns id
  LLMOS.timer.clearInterval(id) — stop a repeating timer
  LLMOS.timer.setTimeout(fn, ms) — one-shot timer, returns id

Rules:
- Output starts with <!DOCTYPE html> or <html>
- Do NOT use fetch(), XMLHttpRequest, WebSocket directly
- Do NOT use eval(), Function(), new Function(), or dynamic imports
- Do NOT access parent, top, window.parent, or document.cookie
- Declare required capabilities as a JSON comment on the FIRST line:
  <!-- capabilities: ["ui:window", "storage:local"] -->
- Available capabilities: ui:window, storage:local, timer:basic, clipboard:rw, network:http
- Keep the app simple, functional, and visually clean
- Use a dark color scheme (dark background, light text)`;

// --- Model Hint Extraction ---
// Parse "use opus", "with claude", "using haiku" etc. from user prompts.
// Returns { provider, model, cleanPrompt } or null if no hint found.

const MODEL_ALIASES = {
  // Claude models
  opus:    { provider: 'claude', model: 'claude-opus-4-6' },
  sonnet:  { provider: 'claude', model: 'claude-sonnet-4-5-20250929' },
  haiku:   { provider: 'claude', model: 'claude-haiku-4-5-20251001' },
  claude:  { provider: 'claude', model: null }, // use configured default
  // OpenAI models
  'gpt-4o':  { provider: 'openai', model: 'gpt-4o' },
  'gpt-4':   { provider: 'openai', model: 'gpt-4o' },
  'o1':      { provider: 'openai', model: 'o1' },
  openai:    { provider: 'openai', model: null },
  // Local
  ollama:  { provider: 'ollama', model: null },
  qwen:    { provider: 'ollama', model: null },
  local:   { provider: 'ollama', model: null },
};

// Patterns: "use opus", "using opus", "with opus", "via claude", "by opus"
// Also at end: "... make a calculator, opus" or "... make a calculator (opus)"
const MODEL_HINT_PATTERNS = [
  // "use/using/with/via/by <model>" anywhere in prompt
  /\b(?:use|using|with|via|by)\s+(opus|sonnet|haiku|claude|openai|ollama|qwen|local|gpt-4o?|o1)\b/i,
  // "... , <model>" at end of prompt
  /,\s*(opus|sonnet|haiku|claude|openai|ollama|qwen|local|gpt-4o?|o1)\s*$/i,
  // "... (<model>)" at end of prompt
  /\(\s*(opus|sonnet|haiku|claude|openai|ollama|qwen|local|gpt-4o?|o1)\s*\)\s*$/i,
  // "<model> model" or "<model>-model"
  /\b(opus|sonnet|haiku)\s*[-]?\s*model\b/i,
];

export function extractModelHint(prompt) {
  for (const pattern of MODEL_HINT_PATTERNS) {
    const m = prompt.match(pattern);
    if (m) {
      const alias = m[1].toLowerCase();
      const resolved = MODEL_ALIASES[alias];
      if (resolved) {
        // Strip the hint from the prompt
        const cleanPrompt = prompt.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
        return { ...resolved, alias, cleanPrompt };
      }
    }
  }
  return null;
}

// Keywords that suggest a complex app needing a capable model
const COMPLEX_KEYWORDS = [
  'database', 'api', 'auth', 'websocket', 'real-time', 'chart', 'graph',
  'machine learning', 'encrypt', 'oauth', 'multi-page', 'routing',
  'drag and drop', 'canvas', 'webgl', '3d', 'animation',
  'spreadsheet', 'rich text editor', 'code editor', 'ide',
];

// Prompt injection patterns to strip
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /you\s+are\s+now/gi,
  /system\s*:/gi,
  /assistant\s*:/gi,
  /human\s*:/gi,
  /\bdo\s+not\s+follow\b/gi,
  /\bdisregard\b/gi,
  /\boverride\b/gi,
  /\bforget\s+(all|your|previous)\b/gi,
  /```\s*(system|assistant|human)/gi,
  /<\/?(?:system|prompt|instruction)>/gi,
];

export function sanitizePrompt(input) {
  let clean = input;
  const flags = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(clean)) {
      flags.push(pattern.source);
      clean = clean.replace(pattern, '');
    }
    pattern.lastIndex = 0; // reset regex state
  }

  // Strip zero-width characters
  const zwChars = /[\u200B\u200C\u200D\u200E\u200F\uFEFF]/g;
  if (zwChars.test(clean)) {
    flags.push('zero-width-chars');
    clean = clean.replace(zwChars, '');
  }

  return { clean: clean.trim(), flagged: flags.length > 0, flags };
}

// --- Prompt Confidence Scoring ---
// Scores how clear/specific a prompt is before generating.
// Low confidence → return clarification questions instead of generating garbage.

const VAGUE_PATTERNS = [
  /^(?:make|build|create)\s+(?:something|a thing|stuff|an? app)\s*$/i,
  /^(?:do|help|can you)\s/i,
  /^(?:idk|idc|whatever|anything|surprise me)/i,
];

const SPECIFICITY_SIGNALS = [
  // UI elements
  /button|input|form|list|table|grid|card|modal|dropdown|slider|toggle/i,
  // Data types
  /timer|counter|clock|calculator|calendar|chart|graph|todo|note|editor/i,
  // Actions
  /sort|filter|search|drag|resize|animate|save|load|export|import/i,
  // Layout
  /sidebar|header|footer|column|row|tab|panel|split/i,
];

const CAPABILITY_HINTS = [
  /stor(?:age|e|ing)/i,
  /timer|interval|timeout|countdown/i,
  /clipboard|copy|paste/i,
  /network|fetch|api|http/i,
];

export function scoreConfidence(prompt) {
  const words = prompt.trim().split(/\s+/);
  const lower = prompt.toLowerCase();
  const scores = {};

  // 1. Length score (0-1): very short prompts are vague
  if (words.length <= 2) scores.length = 0.2;
  else if (words.length <= 4) scores.length = 0.5;
  else if (words.length <= 8) scores.length = 0.7;
  else scores.length = 1.0;

  // 2. Specificity (0-1): does it mention concrete UI/data elements?
  const specificityHits = SPECIFICITY_SIGNALS.filter(p => p.test(prompt)).length;
  scores.specificity = Math.min(specificityHits / 2, 1.0);

  // 3. Vagueness penalty (0-1): explicitly vague patterns
  const isVague = VAGUE_PATTERNS.some(p => p.test(prompt.trim()));
  scores.clarity = isVague ? 0.1 : 0.8;

  // 4. Capability clarity (0-1): does it hint at what the app needs?
  const capHits = CAPABILITY_HINTS.filter(p => p.test(prompt)).length;
  scores.capabilities = capHits > 0 ? 1.0 : 0.5;

  // Weighted average
  const total = (
    scores.length * 0.25 +
    scores.specificity * 0.35 +
    scores.clarity * 0.25 +
    scores.capabilities * 0.15
  );

  return { score: Math.round(total * 100) / 100, components: scores };
}

export function generateClarifications(prompt) {
  const questions = [];
  const lower = prompt.toLowerCase();
  const words = prompt.trim().split(/\s+/);

  if (words.length <= 3) {
    questions.push('Can you describe what the app should do in more detail?');
  }

  if (!SPECIFICITY_SIGNALS.some(p => p.test(prompt))) {
    questions.push('What kind of interface should it have? (e.g., buttons, lists, forms, charts)');
  }

  if (!/color|theme|dark|light|style/i.test(lower)) {
    // Don't ask about style — we default to dark. Only ask functional questions.
  }

  if (!/save|store|persist|remember/i.test(lower) && !/timer|clock|countdown/i.test(lower)) {
    questions.push('Should it save data between sessions, or is it temporary?');
  }

  // Always provide at least one clarification
  if (questions.length === 0) {
    questions.push('Any specific features or behavior you want to highlight?');
  }

  return questions.slice(0, 3); // max 3 questions
}

export function estimateComplexity(prompt) {
  const lower = prompt.toLowerCase();
  const matchCount = COMPLEX_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const wordCount = prompt.split(/\s+/).length;

  if (matchCount >= 2 || wordCount > 80) return 'complex';
  if (matchCount >= 1 || wordCount > 40) return 'medium';
  return 'simple';
}

export function selectProvider(complexity) {
  // Explicit routing overrides auto-detection
  const primary = config.routing.primary;
  if (primary && providers.has(primary)) {
    const prov = providers.get(primary);
    if (prov.isAvailable(getProviderConfig(primary))) return primary;
  }

  // Auto-detect: use Claude/OpenAI for complex, Ollama for simple
  if (complexity !== 'simple') {
    if (providers.get('claude').isAvailable(getProviderConfig('claude'))) return 'claude';
    if (providers.get('openai').isAvailable(getProviderConfig('openai'))) return 'openai';
  }
  return 'ollama';
}

/**
 * Dynamic provider+model selection using resource monitor.
 * Returns { provider, model } with the best available model for the task.
 * Falls back to static selectProvider() if monitor has no data.
 */
export async function selectBestProvider(complexity) {
  // Explicit routing overrides everything
  const primary = config.routing.primary;
  if (primary && providers.has(primary)) {
    const prov = providers.get(primary);
    if (prov.isAvailable(getProviderConfig(primary))) {
      return { provider: primary, model: null }; // Use configured model
    }
  }

  // Map complexity to resource-monitor task
  const task = complexity === 'complex' ? 'generate-complex'
    : complexity === 'medium' ? 'generate-medium'
    : 'generate-simple';

  const best = await getBestModel(task);
  if (best) {
    // Check if the provider is actually usable
    const prov = providers.get(best.provider);
    if (prov && prov.isAvailable(getProviderConfig(best.provider))) {
      const configuredModel = getProviderConfig(best.provider).model;
      // Only override if the monitor found a better model than configured
      const modelOverride = best.name !== configuredModel ? best.name : null;
      return { provider: best.provider, model: modelOverride };
    }
  }

  // Fallback to static selection
  return { provider: selectProvider(complexity), model: null };
}

function getFallbackProvider(failedProvider) {
  // Explicit fallback
  const fallback = config.routing.fallback;
  if (fallback && fallback !== failedProvider && providers.has(fallback)) {
    const prov = providers.get(fallback);
    if (prov.isAvailable(getProviderConfig(fallback))) return fallback;
  }

  // Auto-detect fallback: try anything that's available and not the failed one
  for (const [name, prov] of providers) {
    if (name !== failedProvider && prov.isAvailable(getProviderConfig(name))) {
      return name;
    }
  }
  return null;
}

async function generateWithProvider(name, messages, options = {}) {
  const prov = providers.get(name);
  if (!prov) throw new Error(`Unknown provider: ${name}`);
  return prov.generate(messages, getProviderConfig(name), options);
}

function extractCapabilities(code) {
  const match = code.match(/<!--\s*capabilities\s*:\s*(\[.*?\])\s*-->/);
  if (match) {
    try { return JSON.parse(match[1]); } catch {}
  }
  return ['ui:window']; // default capability
}

function cleanResponse(raw) {
  let code = raw.trim();

  // Strip markdown code fences if LLM wraps them
  code = code.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  // Find the HTML document
  const htmlStart = code.indexOf('<!DOCTYPE') !== -1
    ? code.indexOf('<!DOCTYPE')
    : code.indexOf('<html') !== -1
      ? code.indexOf('<html')
      : code.indexOf('<!--');

  if (htmlStart > 0) code = code.slice(htmlStart);

  return code.trim();
}

const PROCESS_SYSTEM_PROMPT = `You are the app generator for LLM OS. Generate a PROCESS APP that runs in a Docker container.

Output TWO sections separated by markers:

---DOCKERFILE---
Write a complete Dockerfile. Use official base images (node:22-slim, python:3.12-slim, etc.).
Include all dependencies. Expose a port if the app has a web UI.
Do NOT use --privileged. Do NOT use host network mode. Use a non-root user.

---CODE---
Write the application code (e.g., index.js, app.py). Keep it self-contained.
The app receives these environment variables from the kernel:
  LLMOS_APP_ID — unique app identifier
  LLMOS_CAPABILITIES — comma-separated capability list
  ANTHROPIC_API_KEY — (if api:anthropic capability granted)

---END---

Declare capabilities as a comment on line 1:
# capabilities: ["process:background", "process:network"]

Available: process:background, process:network, process:volume, api:anthropic

Keep the app minimal and functional.`;

function parseProcessResponse(raw) {
  const dockerfileMatch = raw.match(/---DOCKERFILE---([\s\S]*?)---CODE---/);
  const codeMatch = raw.match(/---CODE---([\s\S]*?)---END---/);

  if (!dockerfileMatch || !codeMatch) {
    throw new Error('LLM did not produce valid process app format');
  }

  return {
    dockerfile: dockerfileMatch[1].trim(),
    code: codeMatch[1].trim(),
  };
}

function extractProcessCapabilities(text) {
  const match = text.match(/^#\s*capabilities\s*:\s*(\[.*?\])/m);
  if (match) {
    try { return JSON.parse(match[1]); } catch {}
  }
  return ['process:background'];
}

export async function generateProcess(prompt) {
  const start = Date.now();

  // Extract model hint before sanitization
  const modelHint = extractModelHint(prompt);
  const effectivePrompt = modelHint ? modelHint.cleanPrompt : prompt;

  const { clean, flagged, flags } = sanitizePrompt(effectivePrompt);
  if (flagged) console.warn('[gateway] Injection patterns detected:', flags);

  // Model hint overrides default routing; otherwise use dynamic selection
  let providerName, modelOverride;
  if (modelHint) {
    providerName = modelHint.provider;
    modelOverride = modelHint.model;
    const prov = providers.get(providerName);
    if (!prov || !prov.isAvailable(getProviderConfig(providerName))) {
      console.warn(`[gateway] Requested provider '${providerName}' not available, falling back`);
      const best = await selectBestProvider('complex');
      providerName = best.provider;
      modelOverride = best.model;
    } else {
      console.log(`[gateway] Model hint: "${modelHint.alias}" → ${providerName}${modelOverride ? ` (${modelOverride})` : ''}`);
    }
  } else {
    // Dynamic: pick best available for process apps (always complex)
    const best = await selectBestProvider('complex');
    providerName = best.provider;
    modelOverride = best.model;
  }

  console.log(`[gateway] Generating process app: provider=${providerName}${modelOverride ? ` model=${modelOverride}` : ''}`);

  const messages = [
    { role: 'system', content: PROCESS_SYSTEM_PROMPT },
    { role: 'user', content: clean },
  ];

  let raw;
  if (modelOverride) {
    const origCfg = getProviderConfig(providerName);
    const overrideCfg = { ...origCfg, model: modelOverride };
    const prov = providers.get(providerName);
    try {
      raw = await prov.generate(messages, overrideCfg);
    } catch (err) {
      const fb = getFallbackProvider(providerName);
      if (fb) {
        console.warn(`[gateway] ${providerName} failed, trying ${fb}:`, err.message);
        raw = await generateWithProvider(fb, messages);
        providerName = fb;
        modelOverride = null;
      } else { throw err; }
    }
  } else {
    try {
      raw = await generateWithProvider(providerName, messages);
    } catch (err) {
      const fb = getFallbackProvider(providerName);
      if (fb) {
        console.warn(`[gateway] ${providerName} failed, trying ${fb}:`, err.message);
        raw = await generateWithProvider(fb, messages);
        providerName = fb;
      } else { throw err; }
    }
  }

  const { dockerfile, code } = parseProcessResponse(raw);
  const capabilities = extractProcessCapabilities(raw);
  const cfg = getProviderConfig(providerName);

  return {
    type: 'process',
    dockerfile,
    code,
    capabilities,
    model: modelOverride || cfg.model,
    provider: providerName,
    complexity: estimateComplexity(clean),
    generationTime: Date.now() - start,
    sanitization: { flagged, flags },
    modelHint: modelHint ? modelHint.alias : null,
  };
}

export async function generate(prompt, options = {}) {
  const start = Date.now();

  // Extract model hint before sanitization (e.g. "use opus")
  const modelHint = extractModelHint(prompt);
  const effectivePrompt = modelHint ? modelHint.cleanPrompt : prompt;

  // Sanitize input
  const { clean, flagged, flags } = sanitizePrompt(effectivePrompt);
  if (flagged) {
    console.warn('[gateway] Injection patterns detected:', flags);
  }

  // Confidence check — return clarification if prompt is too vague
  const confidence = scoreConfidence(clean);
  const skipClarification = options.force === true;
  if (confidence.score < 0.45 && !skipClarification) {
    const questions = generateClarifications(clean);
    console.log(`[gateway] Low confidence (${confidence.score}), asking for clarification`);
    return {
      needsClarification: true,
      confidence,
      questions,
      originalPrompt: clean,
      sanitization: { flagged, flags },
    };
  }

  // Route to provider — model hint overrides complexity-based routing
  const complexity = estimateComplexity(clean);
  let providerName, modelOverride;
  if (modelHint) {
    providerName = modelHint.provider;
    modelOverride = modelHint.model;
    // Check if provider is available, fall back to auto if not
    const prov = providers.get(providerName);
    if (!prov || !prov.isAvailable(getProviderConfig(providerName))) {
      console.warn(`[gateway] Requested provider '${providerName}' (${modelHint.alias}) not available, falling back`);
      const best = await selectBestProvider(complexity);
      providerName = best.provider;
      modelOverride = best.model;
    } else {
      console.log(`[gateway] Model hint: "${modelHint.alias}" → ${providerName}${modelOverride ? ` (${modelOverride})` : ''}`);
    }
  } else {
    // Dynamic: pick best available for this complexity level
    const best = await selectBestProvider(complexity);
    providerName = best.provider;
    modelOverride = best.model;
  }

  console.log(`[gateway] Generating: confidence=${confidence.score} complexity=${complexity} provider=${providerName}${modelOverride ? ` model=${modelOverride}` : ''}`);

  // Inject knowledge base context if relevant past generations exist
  const kbContext = buildContext(clean);
  const systemContent = kbContext
    ? `${SYSTEM_PROMPT}\n\n${kbContext}`
    : SYSTEM_PROMPT;

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: clean },
  ];

  // Build provider config, applying model override if specified
  const genOptions = {};
  let effectiveConfig = providerName;
  if (modelOverride) {
    // Temporarily override the model in provider config
    const origCfg = getProviderConfig(providerName);
    const overrideCfg = { ...origCfg, model: modelOverride };
    // Use direct provider call with overridden config
    const prov = providers.get(providerName);
    try {
      var raw = await prov.generate(messages, overrideCfg, genOptions);
    } catch (err) {
      const fb = getFallbackProvider(providerName);
      if (fb) {
        console.warn(`[gateway] ${providerName} failed, trying ${fb}:`, err.message);
        raw = await generateWithProvider(fb, messages);
        effectiveConfig = fb;
        modelOverride = null;
      } else {
        throw err;
      }
    }
  } else {
    try {
      var raw = await generateWithProvider(providerName, messages);
    } catch (err) {
      const fb = getFallbackProvider(providerName);
      if (fb) {
        console.warn(`[gateway] ${providerName} failed, trying ${fb}:`, err.message);
        raw = await generateWithProvider(fb, messages);
        effectiveConfig = fb;
      } else {
        throw err;
      }
    }
  }

  const code = cleanResponse(raw);
  const capabilities = extractCapabilities(code);
  const usedProvider = typeof effectiveConfig === 'string' ? effectiveConfig : providerName;
  const cfg = getProviderConfig(usedProvider);

  return {
    code,
    capabilities,
    model: modelOverride || cfg.model,
    provider: usedProvider,
    complexity,
    generationTime: Date.now() - start,
    sanitization: { flagged, flags },
    modelHint: modelHint ? modelHint.alias : null,
  };
}
