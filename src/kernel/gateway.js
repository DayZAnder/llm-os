import { createHash } from 'crypto';
import { config } from './config.js';
import { provider as ollamaProvider } from './providers/ollama.js';
import { provider as claudeProvider } from './providers/claude.js';
import { provider as openaiProvider } from './providers/openai-compatible.js';
import { buildContext } from './knowledge.js';
import { getBestModel, getAvailableModels } from './resource-monitor.js';
import { record as recordUsage, calculateCost, PRICING } from './usage-tracker.js';
import { estimateTokenCount } from './utils/normalize.js';

// Prompt cache — exact match dedup (in-memory, ephemeral)
const promptCache = new Map(); // hash → { result, timestamp }
// "… , opus" must not be answered from another model's cached result
const promptCacheKey = (clean, modelHint) => createHash('sha256').update(`${modelHint?.alias || ''}\n${clean}`).digest('hex').slice(0, 16);

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

const SYSTEM_PROMPT = `You are the application generator for LLM OS, an operating system whose programs are written by AI on demand. You write ONE complete, self-contained program as a single HTML document that runs inside a sandboxed window.

# Output format
Output ONLY the HTML document — no markdown, no code fences, no explanation.
The first two lines MUST be these comments:
<!-- capabilities: ["ui:window", ...] -->
<!-- app: {"name": "Short App Name", "icon": "one emoji", "handles": [".ext", "mime/type"]} -->
"handles" lists file types the app can open (omit or [] if none). Portable apps add "ui": "portable" and continue with a single <script>; other apps continue with <!DOCTYPE html>.

# Sandbox
The window is a sandboxed iframe with a strict CSP: no network, no external scripts, fonts, images or stylesheets, no eval/Function, no parent/top access, no cookies, no localStorage. Everything must be inline. All system services go through the global LLMOS SDK below; every call returns a Promise unless noted, and fails with an Error if the capability was not granted — handle that gracefully (show a message, keep the rest of the app working).

# LLMOS SDK
ui (ui:window — always granted)
  LLMOS.ui.h(tag, props, ...children) → Element   (sync helper; props: className, style object, onClick etc.)
  LLMOS.ui.render(element)                         (sync; replaces #llmos-root content)
  LLMOS.ui.notify(message)                         (shows a system notification)
  LLMOS.ui.confirm(message) → boolean
storage (storage:local) — private key/value store for this app, survives restarts
  LLMOS.storage.get(key) → value|null · set(key, value) · remove(key) · keys() → string[]
fs (fs:read, fs:write) — the user's shared filesystem, visible to every app; paths like "/notes/todo.md"
  LLMOS.fs.list(dir) → [{path, name, type:"file"|"dir", size, mime, modified}]
  LLMOS.fs.read(path) → string · write(path, text) · stat(path) → info|null · mkdir(path) · remove(path)
net (network:http) — HTTP through the kernel proxy (public internet only)
  LLMOS.net.request(url, {method, headers, body}) → {status, headers, body, encoding}
  LLMOS.net.json(url) → parsed JSON (GET)
ai (ai:generate) — ask the OS language model; use it to make the app itself intelligent
  LLMOS.ai.complete(prompt, {system, maxTokens}) → string
clipboard (clipboard:rw)
  LLMOS.clipboard.write(text) · read() → string
os — integration with the rest of the OS (no capability needed)
  LLMOS.os.args → object passed at launch, e.g. {path: "/docs/a.csv"} when the user opened a file with this app
  LLMOS.os.open(path) — open a file in the app that handles its type (the OS may generate one)
  LLMOS.os.setTitle(text) — change the window title
ipc (ipc:bus) — publish/subscribe between running apps
  LLMOS.ipc.publish(topic, data) · LLMOS.ipc.subscribe(topic, (data, fromAppId) => {})
timer (timer:basic)
  LLMOS.timer.setTimeout/setInterval/clearTimeout/clearInterval — same as window versions

Declare every capability the app uses, and no others:
ui:window, storage:local, fs:read, fs:write, network:http, ai:generate, clipboard:rw, ipc:bus, timer:basic

# Portable UI (preferred for most apps)
Build forms, lists, tools and dashboards with LLMOS.ui.app instead of HTML/CSS. Such apps can also run on the OS's native renderer (no browser). A portable app is ONLY header comments plus one <script>, with "ui": "portable" in the app manifest, and never touches document/window/DOM.
  const { column, row, scroll, text, button, input, textarea, checkbox, spacer, divider } = LLMOS.ui.c;
  LLMOS.ui.app({ state: {...}, async init(set) { /* load data, then set({...}) */ }, view(state, set) { return column(...); } });
  set(patch) or set(s => patch) merges into state and re-renders. view must be pure: build the tree from state every time.
Components — c.name(props?, ...children); children are components or strings:
  column/row/scroll: gap, padding (px), align start|center|end|stretch, justify start|center|end|between, grow, width/height (px or "fill"), surface none|panel|card, row: wrap
  text: size sm|md|lg|xl, weight normal|bold, tone normal|muted|accent|danger|success, mono, grow
  button: variant primary|secondary|danger|ghost, disabled, onPress()
  input: value, placeholder, onChange(v), onSubmit(v)   textarea: value, placeholder, height, mono, onChange(v)
  checkbox: checked, label, onChange(checked)   spacer: size (omit to fill)   divider
  Give list items a unique key prop. Scroll long lists with scroll({ grow: 1 }).
Use HTML/CSS/DOM only when the components can't express the app (canvas drawing, games, rich text editing) — then omit "ui".

# Design system
The OS injects CSS custom properties; use them instead of hard-coded colors so every app matches the OS theme:
--llmos-bg, --llmos-surface, --llmos-surface-2, --llmos-fg, --llmos-muted, --llmos-accent, --llmos-accent-fg, --llmos-border, --llmos-danger, --llmos-success, --llmos-radius, --llmos-font, --llmos-mono
Body margin/padding is 0. The window can be any size: use a flexible layout (flex/grid, height: 100%), never 100vh, never fixed pixel widths for the main layout. Keep the UI clean, legible and keyboard-friendly (Enter submits, Escape cancels). Use the app's name as a visible heading only if it helps.

# Quality bar
Write a complete, working program — no placeholders, TODOs or "in a real app" stubs. Persist user data with storage or fs when it makes sense. If the app handles files, read LLMOS.os.args.path on start and open that file. Validate input and show errors in the UI rather than throwing.`;

// --- Model Hint Extraction ---
// Parse "use opus", "with claude", "using haiku" etc. from user prompts.
// Returns { provider, model, cleanPrompt } or null if no hint found.

const MODEL_ALIASES = {
  // Claude models
  fable:     { provider: 'claude', model: 'claude-fable-5-1' },
  'opus-5.5':{ provider: 'claude', model: 'claude-opus-5-5' },
  opus:      { provider: 'claude', model: 'claude-opus-5' },
  sonnet:    { provider: 'claude', model: 'claude-sonnet-5' },
  haiku:     { provider: 'claude', model: 'claude-haiku-4-5' },
  claude:    { provider: 'claude', model: null }, // use configured default
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

// "opus 5.5", "opus-5.5", "opus5.5" all normalize to the 'opus-5.5' alias
function normalizeAlias(raw) {
  const a = raw.toLowerCase().replace(/\s+/g, '');
  return /^opus-?5\.5$/.test(a) ? 'opus-5.5' : a;
}

// Patterns: "use opus", "using opus", "with opus", "via claude", "by opus"
// Also at end: "... make a calculator, opus" or "... make a calculator (opus)"
const MODEL_HINT_PATTERNS = [
  // "use/using/with/via/by <model>" anywhere in prompt
  /\b(?:use|using|with|via|by)\s+(opus[\s-]?5\.5|fable|opus|sonnet|haiku|claude|openai|ollama|qwen|local|gpt-4o?|o1)\b/i,
  // "... , <model>" at end of prompt
  /,\s*(opus[\s-]?5\.5|fable|opus|sonnet|haiku|claude|openai|ollama|qwen|local|gpt-4o?|o1)\s*$/i,
  // "... (<model>)" at end of prompt
  /\(\s*(opus[\s-]?5\.5|fable|opus|sonnet|haiku|claude|openai|ollama|qwen|local|gpt-4o?|o1)\s*\)\s*$/i,
  // "<model> model" or "<model>-model"
  /\b(opus[\s-]?5\.5|fable|opus|sonnet|haiku)\s*[-]?\s*model\b/i,
];

export function extractModelHint(prompt) {
  for (const pattern of MODEL_HINT_PATTERNS) {
    const m = prompt.match(pattern);
    if (m) {
      const alias = normalizeAlias(m[1]);
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

/**
 * Call a provider (optionally with a model override), falling back to another
 * available provider on failure. Truncated output is never retried elsewhere —
 * a smaller model would only truncate sooner.
 * @returns {Promise<{ raw: string, provider: string, model: string, usage: object|null }>}
 *   usage is what the provider reported ({inputTokens, outputTokens, ...}), or null.
 */
async function callWithFallback(providerName, modelOverride, messages, options = {}) {
  const prov = providers.get(providerName);
  const cfg = modelOverride
    ? { ...getProviderConfig(providerName), model: modelOverride }
    : getProviderConfig(providerName);
  let usage = null;
  const opts = { ...options, onUsage: (u) => { usage = u; } };
  try {
    const raw = await prov.generate(messages, cfg, opts);
    return { raw, provider: providerName, model: cfg.model, usage };
  } catch (err) {
    // Cut off or declined: another provider would be billed for the same outcome
    if (err.name === 'TruncatedOutputError' || err.name === 'RefusalError' || err.name === 'AbortError') throw err;
    const fb = getFallbackProvider(providerName);
    if (!fb) throw err;
    console.warn(`[gateway] ${providerName} failed, trying ${fb}:`, err.message);
    options.onReset?.(); // discard partial output already streamed from the failed provider
    usage = null;
    const raw = await generateWithProvider(fb, messages, opts);
    return { raw, provider: fb, model: getProviderConfig(fb).model, usage };
  }
}

/**
 * Token counts for the usage log: the provider's own numbers when it
 * reported them, otherwise an estimate over the WHOLE request (system
 * prompts and app code included), flagged as estimated.
 */
export function usageFor(messages, output, reported) {
  if (reported && (reported.inputTokens || reported.outputTokens)) {
    return {
      inputTokens: reported.inputTokens || 0,
      outputTokens: reported.outputTokens || 0,
      cacheReadTokens: reported.cacheReadTokens || 0,
      cacheWriteTokens: reported.cacheWriteTokens || 0,
      estimated: false,
    };
  }
  const input = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
  return { inputTokens: estimateTokenCount(input), outputTokens: estimateTokenCount(output || ''), estimated: true };
}

/** Resolve provider/model from an explicit hint or dynamic selection. */
async function resolveRoute(modelHint, complexity) {
  if (modelHint) {
    const prov = providers.get(modelHint.provider);
    if (prov && prov.isAvailable(getProviderConfig(modelHint.provider))) {
      console.log(`[gateway] Model hint: "${modelHint.alias}" → ${modelHint.provider}${modelHint.model ? ` (${modelHint.model})` : ''}`);
      return { provider: modelHint.provider, model: modelHint.model };
    }
    console.warn(`[gateway] Requested provider '${modelHint.provider}' (${modelHint.alias}) not available, falling back`);
  }
  return selectBestProvider(complexity);
}

/**
 * Parse the app manifest comment:
 *   <!-- app: {"name": "...", "icon": "...", "handles": [".csv"]} -->
 * Returns a sanitized manifest; never trusts the model for anything but data.
 */
export function extractManifest(code) {
  const m = code.match(/<!--\s*app\s*:\s*(\{[\s\S]*?\})\s*-->/);
  let raw = {};
  if (m) { try { raw = JSON.parse(m[1]); } catch {} }
  const str = (v, max) => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, max) : '');
  const handles = Array.isArray(raw.handles)
    ? raw.handles.filter(h => typeof h === 'string' && /^(\.[a-z0-9]{1,10}|[a-z]+\/[a-z0-9.+-]+)$/i.test(h)).map(h => h.toLowerCase()).slice(0, 20)
    : [];
  return { name: str(raw.name, 40), icon: str(raw.icon, 8), handles, ...(raw.ui === 'portable' ? { ui: 'portable' } : {}) };
}

function extractCapabilities(code) {
  const match = code.match(/<!--\s*capabilities\s*:\s*(\[.*?\])\s*-->/);
  if (match) {
    try { return JSON.parse(match[1]); } catch {}
  }
  return ['ui:window']; // default capability
}

export function cleanResponse(raw) {
  let code = raw.trim();

  // Strip markdown code fences if LLM wraps them
  code = code.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  // Drop any chatter before the document. The header comments
  // (capabilities, app manifest) come BEFORE <!DOCTYPE and must be kept.
  const starts = [/<!--\s*(?:capabilities|app)\s*:/i, /<!DOCTYPE/i, /<html[\s>]/i]
    .map(re => code.search(re))
    .filter(i => i !== -1);
  const htmlStart = starts.length ? Math.min(...starts) : code.indexOf('<!--');

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

  // Process apps are always treated as complex
  const route = await resolveRoute(modelHint, 'complex');
  console.log(`[gateway] Generating process app: provider=${route.provider}${route.model ? ` model=${route.model}` : ''}`);

  const messages = [
    { role: 'system', content: PROCESS_SYSTEM_PROMPT },
    { role: 'user', content: clean },
  ];
  const { raw, provider: usedProvider, model: usedModel } =
    await callWithFallback(route.provider, route.model, messages);

  const { dockerfile, code } = parseProcessResponse(raw);
  const capabilities = extractProcessCapabilities(raw);

  return {
    type: 'process',
    dockerfile,
    code,
    capabilities,
    model: usedModel,
    provider: usedProvider,
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

  // Prompt cache — return cached result for identical prompts within TTL.
  // { fresh: true } skips it: regenerating on purpose must hit the model.
  if (config.cache.enabled && !options.fresh) {
    const cacheKey = promptCacheKey(clean, modelHint);
    const cached = promptCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < config.cache.ttlMs) {
      console.log(`[gateway] Cache hit: ${cacheKey} (${clean.slice(0, 40)}...)`);
      recordUsage({
        prompt: clean,
        provider: cached.result.provider,
        model: cached.result.model,
        inputTokens: estimateTokenCount(clean),
        outputTokens: 0,
        latencyMs: 0,
        cached: true,
        cacheType: 'exact',
      });
      return { ...cached.result, generationTime: 0, fromCache: true };
    }
  }

  const complexity = estimateComplexity(clean);
  const route = await resolveRoute(modelHint, complexity);

  console.log(`[gateway] Generating: confidence=${confidence.score} complexity=${complexity} provider=${route.provider}${route.model ? ` model=${route.model}` : ''}`);

  // Stable system prompt first (cacheable), per-request knowledge context second
  const kbContext = buildContext(clean);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (kbContext) messages.push({ role: 'system', content: kbContext });
  messages.push({ role: 'user', content: clean });

  const { raw, provider: usedProvider, model: usedModel, usage } =
    await callWithFallback(route.provider, route.model, messages, { onText: options.onText, onReset: options.onReset });

  const code = cleanResponse(raw);
  const capabilities = extractCapabilities(code);
  const genTime = Date.now() - start;

  const result = {
    code,
    capabilities,
    manifest: extractManifest(code),
    model: usedModel,
    provider: usedProvider,
    complexity,
    generationTime: genTime,
    sanitization: { flagged, flags },
    modelHint: modelHint ? modelHint.alias : null,
  };

  // Record usage
  recordUsage({
    prompt: clean,
    provider: usedProvider,
    model: usedModel,
    ...usageFor(messages, raw, usage),
    latencyMs: genTime,
    cached: false,
    cacheType: null,
  });

  // Store in prompt cache
  if (config.cache.enabled) {
    const cacheKey = promptCacheKey(clean, modelHint);
    promptCache.set(cacheKey, { result, timestamp: Date.now() });
    // Evict expired entries periodically (every 100 cache writes)
    if (promptCache.size % 100 === 0) {
      const now = Date.now();
      for (const [k, v] of promptCache) {
        if (now - v.timestamp > config.cache.ttlMs) promptCache.delete(k);
      }
    }
  }

  return result;
}

// --- App evolution: modify or repair a running app ---

const EVOLVE_ADDENDUM = `You are now EDITING an existing LLM OS program rather than writing a new one.
You receive the current program, and a change request and/or runtime errors observed while it ran.
Return the COMPLETE updated HTML document (same output format and header comments as above) — never a diff or a fragment.
Preserve everything that already works, the app's name, and the storage keys and file formats it uses, so the user's data keeps working.
When fixing errors, fix the root cause, not just the symptom. Update the capabilities comment if the app now needs more or fewer.`;

const MAX_EVOLVE_ERRORS = 20;

/**
 * Produce a new version of an app from its current code plus an instruction
 * and/or runtime errors (self-healing).
 * @param {{ code: string, instruction?: string, errors?: string[], prompt?: string }} input
 */
export async function evolve({ code, instruction = '', errors = [], prompt = '', target = null }, options = {}) {
  const start = Date.now();
  if (typeof code !== 'string' || !code.trim()) throw new Error('Missing code');

  const modelHint = instruction ? extractModelHint(instruction) : null;
  const { clean, flagged, flags } = sanitizePrompt(modelHint ? modelHint.cleanPrompt : instruction);
  const cleanErrors = (Array.isArray(errors) ? errors : [])
    .filter(e => typeof e === 'string')
    .slice(-MAX_EVOLVE_ERRORS)
    .map(e => sanitizePrompt(e.slice(0, 500)).clean);
  if (!clean && cleanErrors.length === 0) throw new Error('Nothing to change: give an instruction or errors');

  // An explicitly chosen model ("upgrade with a bigger model") must be one we offer
  let route;
  if (target) {
    const offered = await listUpgradeModels();
    const pick = offered.find(m => m.provider === target.provider && m.model === target.model);
    if (!pick) throw new Error(`Model not available: ${target.provider}/${target.model}`);
    route = { provider: pick.provider, model: pick.model };
  } else {
    route = await resolveRoute(modelHint, 'complex');
  }
  console.log(`[gateway] Evolving app: provider=${route.provider}${route.model ? ` model=${route.model}` : ''} errors=${cleanErrors.length}`);

  let request = '';
  if (prompt) request += `The app was originally created from this request: "${sanitizePrompt(prompt).clean}"\n\n`;
  request += `<current_program>\n${code}\n</current_program>\n\n`;
  if (clean) request += `Change request from the user: ${clean}\n\n`;
  if (cleanErrors.length) request += `Runtime errors observed while the app ran:\n${cleanErrors.map(e => `- ${e}`).join('\n')}\n\n`;
  request += 'Return the complete updated program.';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: EVOLVE_ADDENDUM },
    { role: 'user', content: request },
  ];
  const { raw, provider, model, usage } = await callWithFallback(route.provider, route.model, messages, { onText: options.onText, onReset: options.onReset });

  const newCode = cleanResponse(raw);
  const genTime = Date.now() - start;
  recordUsage({
    prompt: `[evolve] ${clean || 'fix errors'}`,
    provider, model,
    ...usageFor(messages, raw, usage),
    latencyMs: genTime,
    cached: false,
    cacheType: null,
  });

  return {
    code: newCode,
    capabilities: extractCapabilities(newCode),
    manifest: extractManifest(newCode),
    model, provider,
    generationTime: genTime,
    sanitization: { flagged, flags },
  };
}

// --- AI syscall: apps holding ai:generate can ask the OS model ---

const AI_SYSCALL_SYSTEM = `You are the language model service of LLM OS, called by an application on the user's behalf. Answer the request directly and concisely in plain text unless the request asks for a specific format. Do not mention that you are being called by an app.`;
const AI_RATE_PER_MINUTE = 20;
const aiCalls = new Map(); // appId → timestamps (ms) within the last minute

export function checkAiRateLimit(appId, now = Date.now()) {
  const recent = (aiCalls.get(appId) || []).filter(t => now - t < 60000);
  if (recent.length >= AI_RATE_PER_MINUTE) {
    aiCalls.set(appId, recent);
    return false;
  }
  recent.push(now);
  aiCalls.set(appId, recent);
  return true;
}

/**
 * Text completion for apps. Rate-limited per app; prompt is sanitized like
 * any other user input.
 */
export async function complete({ appId, prompt, system = '', maxTokens = 2048 }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Missing prompt');
  if (!checkAiRateLimit(appId)) throw new Error(`AI rate limit: max ${AI_RATE_PER_MINUTE} calls per minute`);

  const start = Date.now();
  const { clean } = sanitizePrompt(prompt.slice(0, 100000));
  const route = await selectBestProvider('medium');
  const messages = [{ role: 'system', content: AI_SYSCALL_SYSTEM }];
  if (typeof system === 'string' && system.trim()) {
    messages.push({ role: 'system', content: `Instructions from the application: ${sanitizePrompt(system.slice(0, 20000)).clean}` });
  }
  messages.push({ role: 'user', content: clean });

  const tokens = Math.max(1, Math.min(8192, parseInt(maxTokens, 10) || 2048));
  let raw, provider, model, usage = null, truncated = false;
  try {
    ({ raw, provider, model, usage } = await callWithFallback(route.provider, route.model, messages, { maxTokens: tokens }));
  } catch (err) {
    if (err.name !== 'TruncatedOutputError') throw err;
    // Hitting the app's own maxTokens is not an error — return what we have
    raw = err.partial || ''; provider = route.provider; model = route.model || getProviderConfig(route.provider).model; truncated = true;
  }

  recordUsage({
    prompt: `[ai:${appId}] ${clean.slice(0, 80)}`,
    provider, model,
    ...usageFor(messages, raw, usage),
    latencyMs: Date.now() - start,
    cached: false,
    cacheType: null,
  });
  return { text: raw.trim(), truncated, model, provider };
}

// --- System theme generation ---

const THEME_SYSTEM = `You are the theme designer for LLM OS. Turn the user's description into a color theme for the whole operating system.

Output ONLY a JSON object, no markdown, no explanation:
{"name": "Short Theme Name", "vars": {
  "--llmos-bg": "#rrggbb",         page background
  "--llmos-surface": "#rrggbb",    panels, toolbars
  "--llmos-surface-2": "#rrggbb",  inputs, hovered items
  "--llmos-fg": "#rrggbb",         main text
  "--llmos-muted": "#rrggbb",      secondary text
  "--llmos-accent": "#rrggbb",     primary buttons, selection, links
  "--llmos-accent-fg": "#rrggbb",  text on accent
  "--llmos-border": "#rrggbb",
  "--llmos-danger": "#rrggbb",
  "--llmos-success": "#rrggbb",
  "--llmos-radius": "0px"-"20px",
  "--llmos-font": "font stack",    system fonts only, letters/quotes/commas/hyphens
  "--llmos-mono": "font stack"
}}

Colors must be #rrggbb. Text must be comfortably readable: fg on bg at least 7:1, fg on surface 4.5:1, muted on bg 3:1, accent-fg on accent 3:1, accent on bg 3:1. Keep surfaces close to the background so the UI stays calm; let the accent carry the character of the description.`;

/**
 * Ask the model for a theme, validate it deterministically, and give the
 * model one chance to correct contrast/format problems.
 */
export async function generateTheme(description, options = {}) {
  const { clean } = sanitizePrompt(String(description || '').slice(0, 500));
  if (!clean) throw new Error('Describe the theme you want');
  const { validateTheme } = await import('./theme.js');

  const route = await selectBestProvider('simple');
  const messages = [
    { role: 'system', content: THEME_SYSTEM },
    { role: 'user', content: clean },
  ];

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    const { raw, provider, model, usage } = await callWithFallback(route.provider, route.model, messages, { maxTokens: 2000, onText: options.onText, onReset: options.onReset });
    recordUsage({
      prompt: `[theme] ${clean.slice(0, 80)}`,
      provider, model,
      ...usageFor(messages, raw, usage),
      latencyMs: Date.now() - started,
      cached: false,
      cacheType: null,
    });
    let parsed = null;
    try {
      const json = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      parsed = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1));
    } catch {}
    const check = validateTheme(parsed?.vars);
    const name = typeof parsed?.name === 'string' ? parsed.name.replace(/[<>]/g, '').slice(0, 60) : 'Custom';
    last = { name, description: clean, vars: check.vars, problems: check.problems, provider, model, attempts: attempt };
    if (parsed && check.ok) return last;

    // Feed the deterministic findings back once
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: parsed
      ? `The theme was rejected by the validator:\n- ${check.problems.join('\n- ')}\nReturn the corrected JSON object only.`
      : 'That was not a valid JSON object. Return only the JSON object.' });
    options.onReset?.();
  }
  const err = new Error(`Theme rejected after 2 attempts: ${last.problems.join('; ') || 'invalid JSON'}`);
  err.theme = last;
  throw err;
}

// --- Desktop layout generation ---

const DESKTOP_SYSTEM = `You are the desktop designer for LLM OS. Turn the user's description into a desktop layout.

Output ONLY a JSON object, no markdown:
{"base": "taskbar" | "dock" | "classic",     the closest preset; anything you leave out comes from it
                                             (taskbar: one bar at the bottom with launcher, open windows and clock;
                                              dock: thin menu bar on top plus an app dock; classic: prompt bar only)
 "name": "Short Layout Name",
 "bar": {"position": "top"|"bottom"|"none", "style": "taskbar"|"menubar"|"minimal", "height": 24-64,
         "launcher": {"label": "up to 16 chars", "icon": "logo" (the OS launcher mark, recommended) or up to 4 chars, "position": "left"|"center"|"right"},
         "clock": {"show": true, "format": "24h"|"12h", "seconds": false, "date": true, "position": "left"|"center"|"right"},
         "showWindows": true, "tray": true},
 "dock": {"position": "bottom"|"left"|"right"|"none", "iconSize": 24-80, "labels": false, "pinned": ["App Name", ...]},
 "windows": {"controls": "left"|"right"},
 "promptBar": "visible"|"hidden",
 "wallpaper": {"type": "solid"|"gradient", "from": "#rrggbb", "to": "#rrggbb"}}

The launcher is the button that opens the prompt, where the user describes apps; never call it Start and never use a vendor logo. Pinned apps are app names; the built-in ones are Files, Notepad, Writer, Reader, Terminal, Tasks — other names are generated when first clicked. Keep wallpapers dark and calm; the system theme draws the windows.`;

/**
 * Ask the model for a desktop layout, validate it, and allow one
 * correction round with the validator's findings.
 */
export async function generateDesktop(description, options = {}) {
  const { clean } = sanitizePrompt(String(description || '').slice(0, 500));
  if (!clean) throw new Error('Describe the desktop you want');
  const { validateLayout, PRESETS, resolvePreset } = await import('./desktop.js');

  const route = await selectBestProvider('simple');
  const messages = [
    { role: 'system', content: DESKTOP_SYSTEM },
    { role: 'user', content: clean },
  ];

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    const { raw, provider, model, usage } = await callWithFallback(route.provider, route.model, messages, { maxTokens: 2000, onText: options.onText, onReset: options.onReset });
    recordUsage({
      prompt: `[desktop] ${clean.slice(0, 80)}`,
      provider, model,
      ...usageFor(messages, raw, usage),
      latencyMs: Date.now() - started,
      cached: false,
      cacheType: null,
    });
    let parsed = null;
    try {
      const json = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      parsed = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1));
    } catch {}
    const preset = (parsed && resolvePreset(parsed.base)) || 'taskbar';
    const check = validateLayout(parsed, PRESETS[preset]);
    last = { ...check.layout, preset, description: clean, problems: check.problems, provider, model, attempts: attempt };
    if (parsed && check.problems.length === 0) return last;
    Object.defineProperty(last, 'parsed', { value: !!parsed, enumerable: false, configurable: true });

    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: parsed
      ? `The layout was rejected by the validator:\n- ${check.problems.join('\n- ')}\nReturn the corrected JSON object only.`
      : 'That was not a valid JSON object. Return only the JSON object.' });
    options.onReset?.();
  }
  // Second answer still has problems: the validator already replaced every
  // bad field with the preset's value, so the result is safe to use.
  if (last && last.parsed) { delete last.parsed; return last; }
  throw new Error('Desktop layout rejected after 2 attempts: the model did not return valid JSON');
}

// --- Models offered for "upgrade with a bigger model" ---

// Current Claude models, strongest first (tier: rough capability, higher = stronger)
const CLAUDE_UPGRADE_MODELS = [
  { model: 'claude-fable-5-1', label: 'Claude Fable 5.1', tier: 10 },
  { model: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 10 },
  { model: 'claude-opus-5', label: 'Claude Opus 5', tier: 9 },
  { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 8 },
  { model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 6 },
];

/**
 * Every model the user can pick to rewrite an app: local Ollama models that
 * are installed, plus the cloud models whose provider is configured.
 * @returns {Promise<Array<{provider, model, label, tier, local, price: [in, out]|null}>>}
 */
export async function listUpgradeModels() {
  const out = [];
  const price = (m) => PRICING[m] || null;
  let local = [];
  try { local = (await getAvailableModels()).filter(m => m.provider === 'ollama'); } catch {}
  for (const m of local) {
    out.push({ provider: 'ollama', model: m.name, label: m.name, tier: m.tier || 4, local: true, price: [0, 0] });
  }
  if (providers.get('claude').isAvailable(getProviderConfig('claude'))) {
    for (const c of CLAUDE_UPGRADE_MODELS) out.push({ provider: 'claude', ...c, local: false, price: price(c.model) });
  }
  const oa = getProviderConfig('openai');
  if (providers.get('openai').isAvailable(oa) && oa.model) {
    out.push({ provider: 'openai', model: oa.model, label: oa.model, tier: 7, local: false, price: price(oa.model) });
  }
  return out.sort((a, b) => b.tier - a.tier);
}
