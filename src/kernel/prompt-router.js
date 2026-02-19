// Prompt Router — LLM-powered prompt classification with regex fallback.
// Uses a small model (0.5-1B ideal) to classify prompts into type, template, model, complexity.
// If LLM is unavailable or fails, falls back to keyword/regex matching.

import { config } from './config.js';
import { extractModelHint, estimateComplexity } from './gateway.js';
import { getBestOllamaModel } from './resource-monitor.js';

const ROUTER_PROMPT = `Classify this app request. Output ONLY valid JSON, nothing else.

Fields:
- type: "iframe" (simple HTML/JS app) or "process" (needs Docker: servers, bots, browsers, SSH, scrapers)
- template: null, "ssh", "browser", or "nanoclaw" (match ONLY if user clearly wants one of these exact things)
- model: null, "opus", "sonnet", "haiku", or "local" (extract if user specifies a model/provider)
- complexity: "simple", "medium", or "complex"
- title: short 2-4 word app title

Examples:
"make a calculator" → {"type":"iframe","template":null,"model":null,"complexity":"simple","title":"Calculator"}
"ssh client using opus" → {"type":"process","template":"ssh","model":"opus","complexity":"medium","title":"SSH Client"}
"web browser" → {"type":"process","template":"browser","model":null,"complexity":"complex","title":"Web Browser"}
"build a real-time chat with websockets, sonnet" → {"type":"process","template":null,"model":"sonnet","complexity":"complex","title":"Real-time Chat"}
"a todo list" → {"type":"iframe","template":null,"model":null,"complexity":"simple","title":"Todo List"}
"scrape amazon for prices using playwright" → {"type":"process","template":null,"model":null,"complexity":"complex","title":"Price Scraper"}
"nanoclaw" → {"type":"process","template":"nanoclaw","model":null,"complexity":"complex","title":"NanoClaw"}
"a pomodoro timer" → {"type":"iframe","template":null,"model":null,"complexity":"simple","title":"Pomodoro Timer"}
"node.js api server with express" → {"type":"process","template":null,"model":null,"complexity":"medium","title":"Express API"}

Request: `;

/**
 * Try to classify a prompt using a small LLM via Ollama.
 * Returns classification object or null on failure.
 */
async function llmRoute(prompt) {
  const ollamaUrl = config.providers.ollama.url;
  if (!ollamaUrl) return null;

  // Dynamic model selection: explicit config > best available > configured default
  const routerModel = config.routing?.routerModel
    || await getBestOllamaModel('route')
    || config.providers.ollama.model;

  if (!routerModel) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); // 8s max

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: routerModel,
        prompt: ROUTER_PROMPT + `"${prompt.replace(/"/g, '\\"')}"`,
        stream: false,
        options: { temperature: 0.1, num_predict: 100 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) return null;

    const data = await res.json();
    const text = (data.response || '').trim();

    // Extract JSON from response (model might wrap it in markdown or add text)
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!['iframe', 'process'].includes(parsed.type)) return null;
    if (!['simple', 'medium', 'complex'].includes(parsed.complexity)) return null;
    if (parsed.template && !['ssh', 'browser', 'nanoclaw'].includes(parsed.template)) {
      parsed.template = null; // Unknown template, ignore
    }
    if (parsed.model && !['opus', 'sonnet', 'haiku', 'local', 'claude', 'ollama'].includes(parsed.model)) {
      parsed.model = null;
    }

    return {
      type: parsed.type,
      template: parsed.template || null,
      model: parsed.model || null,
      complexity: parsed.complexity,
      title: parsed.title || null,
      source: 'llm',
      routerModel,
    };
  } catch (err) {
    clearTimeout(timeout);
    console.log(`[router] LLM routing failed: ${err.message}`);
    return null;
  }
}

// --- Regex fallback (mirrors current keyword detection) ---

const PROCESS_KEYWORDS = [
  'nanoclaw',
  'ssh client', 'ssh terminal', 'ssh connect', 'ssh',
  'web browser', 'chromium', 'browser',
  'whatsapp bot', 'telegram bot', 'discord bot',
  'background service', 'daemon', 'long-running',
  'docker', 'container', 'node.js server', 'api server',
  'playwright', 'puppeteer', 'scraper', 'crawler', 'scraping',
  'websocket server', 'http server', 'express', 'fastify',
];

const TEMPLATE_KEYWORDS = {
  ssh: ['ssh client', 'ssh terminal', 'ssh connect', 'ssh'],
  browser: ['web browser', 'chromium', 'browser'],
  nanoclaw: ['nanoclaw'],
};

function regexRoute(prompt) {
  const lower = prompt.toLowerCase().trim();
  const hint = extractModelHint(prompt);
  const cleanPrompt = hint ? hint.cleanPrompt : prompt;
  const cleanLower = cleanPrompt.toLowerCase().trim();

  // Detect iframe vs process
  const isProcess = PROCESS_KEYWORDS.some(kw => cleanLower.includes(kw));

  // Detect template match
  let template = null;
  for (const [name, keywords] of Object.entries(TEMPLATE_KEYWORDS)) {
    if (keywords.some(kw => cleanLower.includes(kw))) {
      template = name;
      break;
    }
  }

  // Complexity
  const complexity = estimateComplexity(cleanPrompt);

  return {
    type: isProcess ? 'process' : 'iframe',
    template,
    model: hint ? hint.alias : null,
    complexity,
    title: null,
    source: 'regex',
  };
}

/**
 * Route a prompt: try LLM classification first, fall back to regex.
 * Returns: { type, template, model, complexity, title, source }
 */
export async function routePrompt(prompt) {
  // Try LLM routing first
  const llmResult = await llmRoute(prompt);
  if (llmResult) {
    console.log(`[router] LLM: type=${llmResult.type} template=${llmResult.template} model=${llmResult.model} complexity=${llmResult.complexity} (${llmResult.routerModel})`);
    return llmResult;
  }

  // Regex fallback
  const result = regexRoute(prompt);
  console.log(`[router] Regex: type=${result.type} template=${result.template} model=${result.model} complexity=${result.complexity}`);
  return result;
}
