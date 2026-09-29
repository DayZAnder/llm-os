// Shell Improvement — generates improved shell UI via LLM.
// Uses the capable provider (Claude/OpenAI) since the shell is complex.

import { selectProvider, sanitizePrompt } from '../gateway.js';
import { config } from '../config.js';
import { provider as ollamaProvider } from '../providers/ollama.js';
import { provider as claudeProvider } from '../providers/claude.js';
import { provider as openaiProvider } from '../providers/openai-compatible.js';
import { analyze } from '../analyzer.js';
import { saveVersion, getCurrentId, setCurrentId, readCurrentShell } from './store.js';

// Longest rewrite we will ask for (the whole shell comes back as output)
const MAX_SHELL_OUTPUT_TOKENS = 64000;

const providers = new Map();
providers.set('ollama', ollamaProvider);
providers.set('claude', claudeProvider);
providers.set('openai', openaiProvider);

function getProviderConfig(name) {
  return config.providers[name] || {};
}

const SHELL_SYSTEM_PROMPT = `You are improving the shell UI of LLM OS, a web-based operating system.

You will be given the complete shell HTML file (index.html) and an improvement request.

Output ONLY the complete, valid HTML file with the improvement applied.

CRITICAL — you MUST preserve ALL of these:
- SandboxManager class import from './sandbox.js'
- SDK loading via /sdk/sdk.js
- All postMessage communication with iframes
- The capability approval modal (capModal / cap-modal)
- All API calls to /api/* endpoints (generate, registry, scheduler, etc.)
- All existing DOM IDs that JavaScript references
- The window management system (addAppWindow, closeApp, addProcessWindow)
- The prompt bar and generation flow
- The registry panel (browse, search, launch)
- The settings/self-improvement panel
- The log panel and taskbar

Style constraints:
- Keep the dark color scheme (background: #0d0d1a, accent: #6c63ff)
- Maintain responsive layout

Output starts with <!DOCTYPE html>. No markdown, no code fences, no explanation.`;

// Structural checks — must all pass or the version is rejected
const REQUIRED_PATTERNS = [
  [/SandboxManager/, 'Missing SandboxManager reference'],
  [/sandbox\.js/, 'Missing sandbox.js import'],
  [/\/sdk\/sdk\.js/, 'Missing SDK load path'],
  [/\/api\/generate/, 'Missing /api/generate call'],
  [/postMessage|message.*event|addEventListener.*message/, 'Missing postMessage handler'],
  [/cap-modal|capModal|capability.*modal/i, 'Missing capability modal'],
  [/<\/html>\s*$/, 'Missing closing </html> tag'],
  [/generateApp|generateBtn|generate-btn/i, 'Missing generate app function/button'],
  [/registry|browse.*app/i, 'Missing registry/browse functionality'],
];

/**
 * Validate that generated shell HTML preserves critical structure.
 */
export function validateShellOutput(html) {
  const failures = REQUIRED_PATTERNS
    .filter(([re]) => !re.test(html))
    .map(([, msg]) => msg);
  return { valid: failures.length === 0, failures };
}

/**
 * Simple character-level diff percentage.
 * Same algorithm as improve-apps.js.
 */
export function codeDiffPercent(a, b) {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 0;

  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++;
  }
  return Math.round(((longer.length - matches) / longer.length) * 100);
}

/**
 * Generate an improved shell HTML.
 * @param {string} currentHtml - Current shell source
 * @param {string|null} prompt - User request, or null for autonomous improvement
 * @returns {Promise<string>} - Improved HTML
 */
export async function generateShellImprovement(currentHtml, prompt) {
  // The model rewrites the whole file, so the answer is as long as the shell.
  // Size the output for it — and refuse up front when it can't fit, rather
  // than paying for a rewrite that is certain to be cut off.
  const neededTokens = Math.ceil(currentHtml.length / 3) + 2000;
  if (neededTokens > MAX_SHELL_OUTPUT_TOKENS) {
    throw new Error(`The shell is too large for a full rewrite (~${Math.round(neededTokens / 1000)}k tokens of output, limit ${MAX_SHELL_OUTPUT_TOKENS / 1000}k)`);
  }

  // Sanitize the user prompt portion
  let request = null;
  if (prompt) {
    const { clean, flagged, flags } = sanitizePrompt(prompt);
    if (flagged) console.warn('[shell-improve] Injection patterns stripped:', flags);
    request = clean;
  }
  const userContent = request
    ? `Improvement request: ${request}\n\nCurrent shell:\n${currentHtml}`
    : `Autonomously improve the shell UI with better UX, clearer layout, or missing polish. Keep changes focused and minimal.\n\nCurrent shell:\n${currentHtml}`;

  const messages = [
    { role: 'system', content: SHELL_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  // Always use capable provider for shell — too complex for small local models
  const providerName = selectProvider('complex');
  console.log(`[shell-improve] Using provider: ${providerName}`);

  const prov = providers.get(providerName);
  if (!prov || !prov.isAvailable(getProviderConfig(providerName))) {
    throw new Error(`No capable provider available for shell improvement`);
  }

  const raw = await prov.generate(messages, getProviderConfig(providerName), { maxTokens: neededTokens });

  // Clean response — strip markdown fences if present
  let code = raw.trim();
  code = code.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  const htmlStart = code.indexOf('<!DOCTYPE');
  if (htmlStart > 0) code = code.slice(htmlStart);

  return code.trim();
}

// SSE clients for hot-reload notifications
const sseClients = new Set();

export function addSseClient(res) {
  sseClients.add(res);
}

export function removeSseClient(res) {
  sseClients.delete(res);
}

/**
 * Notify all connected browsers to reload the shell.
 */
export function notifyShellReload(versionId) {
  const payload = `data: ${JSON.stringify({ type: 'reload', versionId })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

/**
 * Full improvement pipeline: generate → validate → save → apply → notify.
 * @param {string|null} prompt - User request or null
 * @param {string} source - 'user' or 'scheduler'
 * @returns {Object} - { id, diff, analysis, validation }
 */
export async function improveShell(prompt, source = 'user') {
  const currentHtml = readCurrentShell();
  const newHtml = await generateShellImprovement(currentHtml, prompt);

  // Security analysis. The shell legitimately does things apps may not
  // (it creates iframes), so it can't be held to "no critical findings" —
  // but the model's version may not add any the current shell doesn't have.
  const analysis = analyze(newHtml);
  const criticalByRule = (a) => a.findings.filter(f => f.severity === 'CRITICAL')
    .reduce((m, f) => m.set(f.rule, (m.get(f.rule) || 0) + 1), new Map());
  const before = criticalByRule(analyze(currentHtml));
  const added = [...criticalByRule(analysis)].filter(([rule, n]) => n > (before.get(rule) || 0)).map(([rule]) => rule);
  if (added.length) {
    return { error: `Security analysis blocked the improved shell (new: ${added.join(', ')})`, analysis };
  }

  // Structural validation
  const validation = validateShellOutput(newHtml);
  if (!validation.valid) {
    return { error: 'Shell structural validation failed', failures: validation.failures };
  }

  // Diff check
  const diff = codeDiffPercent(currentHtml, newHtml);
  if (diff < 3) {
    return { error: `Diff too small (${diff}%) — no meaningful changes` };
  }
  if (diff > 60) {
    return { error: `Diff too large (${diff}%) — likely a full rewrite, rejecting for safety` };
  }

  // Save and apply
  const id = `sv_${Date.now()}`;
  const parentId = getCurrentId();
  const meta = saveVersion({ id, html: newHtml, source, prompt, diff, parentId });
  // The shell holds every permission; a version nobody asked for is only
  // offered (Settings → Shell Versions), never switched to on its own.
  if (source === 'scheduler') {
    console.log(`[shell-improve] Proposed version ${id} (diff=${diff}%) — waiting for the user to activate it`);
    return { id, diff, analysis, validation, meta, proposed: true };
  }
  setCurrentId(id);
  notifyShellReload(id);

  console.log(`[shell-improve] Applied version ${id} (diff=${diff}%, source=${source})`);
  return { id, diff, analysis, validation, meta };
}
