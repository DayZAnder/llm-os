// Self-Improve Task: Adversarial Security Testing
// Generates attack vectors to probe the static analyzer for blind spots.
// Results saved to data/security-reports/ for review.

import { analyze } from '../analyzer.js';
import { config } from '../config.js';
import { queueClaudeTask } from './claude-agent.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPORTS_DIR = join(__dirname, '..', '..', '..', 'data', 'security-reports');

const ATTACK_CATEGORIES = [
  {
    id: 'eval-bypass',
    name: 'Eval Bypass',
    prompt: `Generate 5 JavaScript code snippets that attempt to execute arbitrary code without using the literal words "eval", "Function", or "import". Use techniques like bracket notation on window, string concatenation to build function names, constructor chains, setTimeout with strings, or atob-decoded payloads. Each snippet should be wrapped in <script> tags inside a basic HTML page. Output only the code, no explanation.`,
  },
  {
    id: 'sandbox-escape',
    name: 'Sandbox Escape',
    prompt: `Generate 5 JavaScript code snippets that attempt to access the parent frame or top window without using the literal words "parent", "top", or "window.parent". Use techniques like frames collection, contentWindow references, postMessage interception, or prototype chain walking. Each snippet should be in an HTML page. Output only the code.`,
  },
  {
    id: 'data-exfiltration',
    name: 'Data Exfiltration',
    prompt: `Generate 5 JavaScript code snippets that attempt to send data to an external server without using fetch(), XMLHttpRequest, or WebSocket directly. Use techniques like Image src, CSS url(), link prefetch, DNS prefetch, beacon API, or dynamically created script tags. Each in an HTML page. Output only the code.`,
  },
  {
    id: 'prototype-pollution',
    name: 'Prototype Pollution',
    prompt: `Generate 5 JavaScript code snippets that attempt to pollute Object.prototype or modify built-in prototypes without using the literal string "__proto__". Use techniques like Object.getPrototypeOf, constructor.prototype, Reflect API, or computed property names. Each in an HTML page. Output only the code.`,
  },
  {
    id: 'cookie-theft',
    name: 'Cookie/Storage Theft',
    prompt: `Generate 5 JavaScript code snippets that attempt to read document.cookie or localStorage without using those literal strings. Use techniques like bracket notation, string building, document property enumeration, or Proxy traps. Each in an HTML page. Output only the code.`,
  },
  {
    id: 'code-injection',
    name: 'Code Injection',
    prompt: `Generate 5 JavaScript code snippets that attempt to inject and execute code using innerHTML, document.write, insertAdjacentHTML, DOMParser, or template literals with expressions that call functions. Obfuscate the approach. Each in an HTML page. Output only the code.`,
  },
  {
    id: 'obfuscation',
    name: 'Obfuscation',
    prompt: `Generate 5 JavaScript code snippets that use character code building (String.fromCharCode), unicode escapes, hex escapes, or template tag functions to construct and execute dangerous operations like eval or fetch. Each in an HTML page. Output only the code.`,
  },
];

function extractSnippets(raw) {
  // Split the raw LLM output into individual HTML snippets
  const snippets = [];
  const parts = raw.split(/(?=<!DOCTYPE|<html)/gi);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 50 && (trimmed.includes('<script') || trimmed.includes('<html'))) {
      snippets.push(trimmed);
    }
  }

  // Fallback: if no HTML structure found, wrap raw code blocks
  if (snippets.length === 0) {
    const codeBlocks = raw.split(/```(?:html|javascript)?\s*\n?/);
    for (const block of codeBlocks) {
      const clean = block.replace(/```\s*$/, '').trim();
      if (clean.length > 30) {
        snippets.push(`<!DOCTYPE html><html><body><script>${clean}<\/script></body></html>`);
      }
    }
  }

  return snippets.slice(0, 5);
}

export const definition = {
  id: 'test-security',
  name: 'Test Security',
  description: 'Generate adversarial code to probe the analyzer for blind spots',
  category: 'self-improve',
  requiresLLM: true,
  defaultInterval: 12 * 60 * 60 * 1000, // 12 hours

  async handler(context) {
    const stats = { total: 0, caught: 0, missed: 0, categories: 0, catchRate: '0%' };
    const report = { timestamp: Date.now(), categories: [] };

    // Pick 2 random categories per run
    const shuffled = ATTACK_CATEGORIES.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 2);

    for (const category of selected) {
      if (context.getBudgetRemaining() <= 0) break;

      stats.categories++;
      const catResult = { id: category.id, name: category.name, vectors: [] };

      try {
        context.trackLLMCall();

        // Generate attack vectors via Ollama
        const ollamaUrl = config.ollama.url;
        const model = config.ollama.model;

        const res = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: category.prompt,
            stream: false,
            options: { temperature: 0.7, num_predict: 4096 },
          }),
        });

        if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
        const data = await res.json();
        const snippets = extractSnippets(data.response);

        for (const code of snippets) {
          stats.total++;
          const analysis = analyze(code);
          const caught = analysis.blocked;

          if (caught) {
            stats.caught++;
          } else {
            stats.missed++;
          }

          catResult.vectors.push({
            code: code.slice(0, 500), // truncate for storage
            caught,
            violations: analysis.violations?.map(v => v.rule) || [],
          });
        }
      } catch (err) {
        console.error(`[self-improve:security] ${category.id} failed:`, err.message);
        catResult.error = err.message;
      }

      report.categories.push(catResult);
    }

    stats.catchRate = stats.total > 0
      ? `${Math.round((stats.caught / stats.total) * 100)}%`
      : 'N/A';

    // Save report
    mkdirSync(REPORTS_DIR, { recursive: true });
    const filename = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    writeFileSync(join(REPORTS_DIR, filename), JSON.stringify(report, null, 2));

    // Auto-queue Claude agent task when catch rate is low
    const catchPct = stats.total > 0 ? (stats.caught / stats.total) * 100 : 100;
    if (catchPct < 80 && stats.missed > 0 && config.claude.apiKey) {
      const missedCats = report.categories
        .filter(c => c.vectors?.some(v => !v.caught))
        .map(c => c.name)
        .join(', ');
      queueClaudeTask(
        `The security analyzer missed ${stats.missed}/${stats.total} attack vectors (${stats.catchRate} catch rate) in categories: ${missedCats}. ` +
        `Review the latest report in data/security-reports/${filename}, examine the missed vectors, ` +
        `and add new detection rules to src/kernel/analyzer.js to catch them. Run tests after.`,
        'test-security',
      );
    }

    return { success: true, stats };
  },
};
