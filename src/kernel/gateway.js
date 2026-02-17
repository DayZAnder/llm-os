import { config } from './config.js';
import { provider as ollamaProvider } from './providers/ollama.js';
import { provider as claudeProvider } from './providers/claude.js';
import { provider as openaiProvider } from './providers/openai-compatible.js';

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
  const { clean, flagged, flags } = sanitizePrompt(prompt);
  if (flagged) console.warn('[gateway] Injection patterns detected:', flags);

  const complexity = estimateComplexity(clean);
  // Process apps prefer capable models
  const providerName = selectProvider('complex');

  console.log(`[gateway] Generating process app: provider=${providerName}`);

  const messages = [
    { role: 'system', content: PROCESS_SYSTEM_PROMPT },
    { role: 'user', content: clean },
  ];

  let raw;
  try {
    raw = await generateWithProvider(providerName, messages);
  } catch (err) {
    const fb = getFallbackProvider(providerName);
    if (fb) {
      console.warn(`[gateway] ${providerName} failed, trying ${fb}:`, err.message);
      raw = await generateWithProvider(fb, messages);
    } else {
      throw err;
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
    model: cfg.model,
    provider: providerName,
    complexity,
    generationTime: Date.now() - start,
    sanitization: { flagged, flags },
  };
}

export async function generate(prompt) {
  const start = Date.now();

  // Sanitize input
  const { clean, flagged, flags } = sanitizePrompt(prompt);
  if (flagged) {
    console.warn('[gateway] Injection patterns detected:', flags);
  }

  // Route to provider
  const complexity = estimateComplexity(clean);
  const providerName = selectProvider(complexity);

  console.log(`[gateway] Generating: complexity=${complexity} provider=${providerName}`);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: clean },
  ];

  let raw;
  try {
    raw = await generateWithProvider(providerName, messages);
  } catch (err) {
    // Fallback: try another available provider
    const fb = getFallbackProvider(providerName);
    if (fb) {
      console.warn(`[gateway] ${providerName} failed, trying ${fb}:`, err.message);
      raw = await generateWithProvider(fb, messages);
    } else {
      throw err;
    }
  }

  const code = cleanResponse(raw);
  const capabilities = extractCapabilities(code);
  const cfg = getProviderConfig(providerName);

  return {
    code,
    capabilities,
    model: cfg.model,
    provider: providerName,
    complexity,
    generationTime: Date.now() - start,
    sanitization: { flagged, flags },
  };
}
