#!/usr/bin/env node
// Batch-generate example apps via local Ollama and publish to the registry.
// Run: node scripts/generate-apps.mjs
//
// Uses the same system prompt as the kernel gateway.
// Each app is analyzed, and only clean apps get published.

import { analyze } from '../src/kernel/analyzer.js';
import { publishApp } from '../src/kernel/registry/store.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

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
- Use a dark color scheme (dark background #1a1a2e, light text #e0e0f0, accent #6c63ff)`;

// Apps to generate — diverse set that showcases the OS
const APP_PROMPTS = [
  'make a unit converter (length, weight, temperature)',
  'make a color picker with hex, rgb, and hsl values',
  'make a markdown previewer with live editing',
  'build a habit tracker where I can check off daily habits',
  'make a simple expense tracker with categories and totals',
  'build a flashcard study app with flip-to-reveal',
  'make a dice roller for tabletop RPGs with multiple dice types',
  'make a typing speed test that measures WPM',
  'build a simple kanban board with three columns: todo, doing, done',
  'make a countdown timer to a specific date and time',
  'build a simple drawing/sketch pad with color picker',
  'make a BMI calculator with visual health range indicator',
  'build a morse code translator (text to morse and back)',
  'make a random quote generator with copy to clipboard',
  'build a simple music metronome with adjustable BPM',
  'make a tip calculator for splitting bills',
  'build a json formatter/validator with syntax highlighting',
  'make a simple emoji picker with search',
  'build a binary/decimal/hex converter',
  'make a simple piano keyboard that plays notes',
];

function cleanResponse(raw) {
  let code = raw.trim();
  code = code.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  const htmlStart = code.indexOf('<!DOCTYPE') !== -1
    ? code.indexOf('<!DOCTYPE')
    : code.indexOf('<html') !== -1
      ? code.indexOf('<html')
      : code.indexOf('<!--');

  if (htmlStart > 0) code = code.slice(htmlStart);
  return code.trim();
}

function extractCapabilities(code) {
  const match = code.match(/<!--\s*capabilities\s*:\s*(\[.*?\])\s*-->/);
  if (match) {
    try { return JSON.parse(match[1]); } catch {}
  }
  return ['ui:window'];
}

async function generateApp(prompt) {
  const start = Date.now();

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: `${SYSTEM_PROMPT}\n\nUser request: ${prompt}`,
      stream: false,
      options: { temperature: 0.4, num_predict: 4096 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  return { raw: data.response, elapsed };
}

async function main() {
  console.log(`\nLLM OS — Batch App Generator`);
  console.log(`Ollama: ${OLLAMA_URL} (${MODEL})`);
  console.log(`Apps to generate: ${APP_PROMPTS.length}\n`);

  // Check Ollama is reachable
  try {
    const ping = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!ping.ok) throw new Error('not ok');
  } catch {
    console.error(`Cannot reach Ollama at ${OLLAMA_URL}. Is it running?`);
    process.exit(1);
  }

  let generated = 0, published = 0, blocked = 0, failed = 0;

  for (let i = 0; i < APP_PROMPTS.length; i++) {
    const prompt = APP_PROMPTS[i];
    const label = `[${i + 1}/${APP_PROMPTS.length}]`;

    process.stdout.write(`${label} "${prompt}" ... `);

    try {
      const { raw, elapsed } = await generateApp(prompt);
      const code = cleanResponse(raw);
      generated++;

      // Analyze
      const analysis = analyze(code);

      if (!analysis.passed) {
        console.log(`BLOCKED (${analysis.criticalCount} critical) ${elapsed}s`);
        for (const f of analysis.findings.filter(f => f.severity === 'CRITICAL')) {
          console.log(`  - ${f.rule}: ${f.snippet}`);
        }
        blocked++;
        continue;
      }

      // Publish to registry
      const capabilities = extractCapabilities(code);
      const result = publishApp({
        prompt,
        code,
        type: 'iframe',
        capabilities,
        model: MODEL,
        provider: 'ollama',
      });

      console.log(`OK (${analysis.warningCount}w) ${elapsed}s → ${result.hash}${result.existing ? ' (duplicate)' : ''}`);
      published++;

    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n--- Results ---`);
  console.log(`Generated: ${generated}`);
  console.log(`Published: ${published}`);
  console.log(`Blocked:   ${blocked}`);
  console.log(`Failed:    ${failed}`);
  console.log();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
