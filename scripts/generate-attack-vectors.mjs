#!/usr/bin/env node
// Generate adversarial test vectors using local Ollama.
// The LLM tries to create code that evades the static analyzer.
// Output: JSON file of test vectors for the security test suite.
//
// Run: node scripts/generate-attack-vectors.mjs

import { analyze } from '../src/kernel/analyzer.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://192.168.2.183:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
const OUTPUT = join(__dirname, '..', 'tests', 'security', 'generated-vectors.json');

// Attack categories to probe
const ATTACK_PROMPTS = [
  {
    category: 'eval-bypass',
    description: 'Bypass eval() detection using obfuscation',
    prompt: `Write 5 different JavaScript code snippets that execute arbitrary code WITHOUT using the literal word "eval" or "Function". Use creative obfuscation techniques like:
- Bracket notation on window/globalThis
- String concatenation to build function names
- Indirect references via aliases
- Template literal tricks
- Proxy/Reflect abuse

Output each snippet on a separate line, numbered 1-5. Just code, no explanation.`,
  },
  {
    category: 'sandbox-escape',
    description: 'Escape iframe sandbox to access parent frame',
    prompt: `Write 5 different JavaScript code snippets that try to access the parent frame or top window WITHOUT using the literal words "parent" or "top" or "window.parent". Use creative techniques like:
- Accessing frames collection
- Using postMessage to communicate outward
- DOM traversal tricks
- Event bubbling to parent
- History/location manipulation

Output each snippet on a separate line, numbered 1-5. Just code, no explanation.`,
  },
  {
    category: 'data-exfiltration',
    description: 'Exfiltrate data without obvious fetch/XHR',
    prompt: `Write 5 different JavaScript code snippets that send data to an external server WITHOUT using fetch(), XMLHttpRequest, or WebSocket. Use creative techniques like:
- CSS url() with data in the path
- Image/script src injection
- Navigator.sendBeacon
- Service worker tricks
- DNS prefetch/preconnect abuse

Output each snippet on a separate line, numbered 1-5. Just code, no explanation.`,
  },
  {
    category: 'prototype-pollution',
    description: 'Pollute prototypes without obvious __proto__',
    prompt: `Write 5 different JavaScript code snippets that perform prototype pollution WITHOUT using the literal string "__proto__". Use creative techniques like:
- Object.setPrototypeOf
- constructor.prototype access
- Reflect.setPrototypeOf
- Object.create chains
- Symbol manipulation

Output each snippet on a separate line, numbered 1-5. Just code, no explanation.`,
  },
  {
    category: 'cookie-storage-theft',
    description: 'Access cookies or localStorage without obvious patterns',
    prompt: `Write 5 different JavaScript code snippets that read document.cookie or localStorage WITHOUT using the literal strings "document.cookie" or "localStorage". Use creative techniques like:
- Bracket notation
- Variable aliasing
- String building
- Proxy interception
- Object.keys on document

Output each snippet on a separate line, numbered 1-5. Just code, no explanation.`,
  },
];

function parseSnippets(raw) {
  const lines = raw.split('\n');
  const snippets = [];
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if this is a numbered line (1. or 1) or a new snippet)
    if (/^\d+[\.\)]/.test(trimmed)) {
      if (current) snippets.push(current.trim());
      current = trimmed.replace(/^\d+[\.\)]\s*/, '');
    } else if (trimmed.startsWith('```')) {
      // skip code fence markers
      continue;
    } else {
      current += (current ? '\n' : '') + trimmed;
    }
  }
  if (current) snippets.push(current.trim());

  return snippets.filter(s => s.length > 5); // filter empty/tiny
}

async function generateAttacks(attackPrompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: `You are a security researcher testing a JavaScript static analyzer. Your job is to find code patterns that bypass detection rules.\n\n${attackPrompt}`,
      stream: false,
      options: { temperature: 0.7, num_predict: 2048 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  return data.response;
}

async function main() {
  console.log(`\nLLM OS — Adversarial Test Vector Generator`);
  console.log(`Ollama: ${OLLAMA_URL} (${MODEL})`);
  console.log(`Categories: ${ATTACK_PROMPTS.length}\n`);

  // Check Ollama
  try {
    const ping = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!ping.ok) throw new Error('not ok');
  } catch {
    console.error(`Cannot reach Ollama at ${OLLAMA_URL}. Is it running?`);
    process.exit(1);
  }

  const allVectors = [];
  let totalGenerated = 0, totalCaught = 0, totalMissed = 0;

  for (const attack of ATTACK_PROMPTS) {
    console.log(`\n[${attack.category}] ${attack.description}`);
    process.stdout.write('  Generating... ');

    try {
      const raw = await generateAttacks(attack.prompt);
      const snippets = parseSnippets(raw);
      console.log(`${snippets.length} snippets`);

      for (const snippet of snippets) {
        const result = analyze(snippet);
        const caught = !result.passed || result.warningCount > 0;
        const rules = result.findings.map(f => f.rule);

        const vector = {
          category: attack.category,
          code: snippet,
          shouldFlag: true, // all of these SHOULD be caught
          caught,
          matchedRules: rules,
          severity: result.passed ? (result.warningCount > 0 ? 'warning' : 'missed') : 'critical',
        };

        allVectors.push(vector);
        totalGenerated++;

        if (caught) {
          totalCaught++;
          console.log(`  \u2713 CAUGHT: ${rules.join(', ')} — ${snippet.slice(0, 60)}...`);
        } else {
          totalMissed++;
          console.log(`  \u2717 MISSED: ${snippet.slice(0, 80)}...`);
        }
      }
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }

  // Save results
  const output = {
    generated: new Date().toISOString(),
    model: MODEL,
    stats: {
      total: totalGenerated,
      caught: totalCaught,
      missed: totalMissed,
      catchRate: totalGenerated > 0 ? `${Math.round((totalCaught / totalGenerated) * 100)}%` : 'N/A',
    },
    vectors: allVectors,
  };

  // Ensure directory exists
  const { mkdirSync } = await import('fs');
  mkdirSync(join(__dirname, '..', 'tests', 'security'), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(output, null, 2));

  console.log(`\n--- Results ---`);
  console.log(`Total vectors: ${totalGenerated}`);
  console.log(`Caught:        ${totalCaught} (${output.stats.catchRate})`);
  console.log(`Missed:        ${totalMissed}`);
  console.log(`\nSaved to: ${OUTPUT}`);

  if (totalMissed > 0) {
    console.log(`\nMissed vectors need new analyzer rules!`);
    console.log(`Review the "missed" entries in the output file.`);
  }
  console.log();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
