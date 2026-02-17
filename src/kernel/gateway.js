import { config } from './config.js';

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

// Keywords that suggest a complex app needing Claude
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

function sanitizePrompt(input) {
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

function estimateComplexity(prompt) {
  const lower = prompt.toLowerCase();
  const matchCount = COMPLEX_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const wordCount = prompt.split(/\s+/).length;

  // Complex if: multiple complex keywords, or very long prompt, or explicit complexity
  if (matchCount >= 2 || wordCount > 80) return 'complex';
  if (matchCount >= 1 || wordCount > 40) return 'medium';
  return 'simple';
}

function selectProvider(complexity) {
  // Use Claude for complex apps if API key is available
  if (complexity === 'complex' && config.claude.apiKey) return 'claude';
  if (complexity === 'medium' && config.claude.apiKey) return 'claude';
  return 'ollama';
}

async function generateWithOllama(prompt) {
  const res = await fetch(`${config.ollama.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      prompt: `${SYSTEM_PROMPT}\n\nUser request: ${prompt}`,
      stream: false,
      options: { temperature: 0.4, num_predict: 4096 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.response;
}

async function generateWithClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.claude.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.claude.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
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
  // Process apps always use Claude if available (more complex)
  const provider = config.claude.apiKey ? 'claude' : 'ollama';

  console.log(`[gateway] Generating process app: provider=${provider}`);

  let raw;
  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.claude.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.claude.model,
        max_tokens: 4096,
        system: PROCESS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: clean }],
      }),
    });
    if (!res.ok) throw new Error(`Claude error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    raw = data.content[0].text;
  } else {
    const res = await fetch(`${config.ollama.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.model,
        prompt: `${PROCESS_SYSTEM_PROMPT}\n\nUser request: ${clean}`,
        stream: false,
        options: { temperature: 0.4, num_predict: 4096 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    raw = data.response;
  }

  const { dockerfile, code } = parseProcessResponse(raw);
  const capabilities = extractProcessCapabilities(raw);

  return {
    type: 'process',
    dockerfile,
    code,
    capabilities,
    model: provider === 'claude' ? config.claude.model : config.ollama.model,
    provider,
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
  const provider = selectProvider(complexity);

  console.log(`[gateway] Generating: complexity=${complexity} provider=${provider}`);

  let raw;
  try {
    raw = provider === 'claude'
      ? await generateWithClaude(clean)
      : await generateWithOllama(clean);
  } catch (err) {
    // Fallback: if Claude fails, try Ollama (and vice versa)
    console.warn(`[gateway] ${provider} failed, trying fallback:`, err.message);
    raw = provider === 'claude'
      ? await generateWithOllama(clean)
      : config.claude.apiKey
        ? await generateWithClaude(clean)
        : null;
    if (!raw) throw err;
  }

  const code = cleanResponse(raw);
  const capabilities = extractCapabilities(code);

  return {
    code,
    capabilities,
    model: provider === 'claude' ? config.claude.model : config.ollama.model,
    provider,
    complexity,
    generationTime: Date.now() - start,
    sanitization: { flagged, flags },
  };
}
