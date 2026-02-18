#!/usr/bin/env node
// Seeds the community registry from examples/ and known apps.
// Run: node scripts/seed-registry.js

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const APPS_DIR = resolve(__dirname, '..', 'registry', 'apps');
mkdirSync(APPS_DIR, { recursive: true });

function hash(code) {
  return createHash('sha256').update(code).digest('hex').slice(0, 16);
}

function saveApp(entry) {
  const file = resolve(APPS_DIR, `${entry.hash}.json`);
  writeFileSync(file, JSON.stringify(entry, null, 2));
  console.log(`  ${entry.hash} — ${entry.title}`);
}

console.log('Seeding community registry:\n');

// Example apps
const examples = [
  { file: 'calculator.html', prompt: 'a simple calculator', caps: ['ui:window'], tags: ['math', 'utility'] },
  { file: 'todo.html', prompt: 'a todo list', caps: ['ui:window', 'storage:local'], tags: ['productivity'] },
  { file: 'pomodoro.html', prompt: 'a pomodoro timer with break reminders', caps: ['ui:window', 'timer:basic', 'storage:local'], tags: ['productivity', 'time'] },
  { file: 'password-generator.html', prompt: 'a password generator', caps: ['ui:window'], tags: ['security', 'utility'] },
  { file: 'notepad.html', prompt: 'a notepad with find and replace, line numbers, and file management', caps: ['ui:window', 'storage:local', 'clipboard:rw'], tags: ['productivity', 'editor', 'utility'] },
  { file: 'unit-converter.html', prompt: 'a unit converter for length, weight, temperature, and data size', caps: ['ui:window'], tags: ['utility', 'reference', 'math'] },
  { file: 'regex-tester.html', prompt: 'a regex tester with live match highlighting', caps: ['ui:window'], tags: ['developer', 'utility', 'text'] },
  { file: 'world-clock.html', prompt: 'a world clock showing multiple time zones', caps: ['ui:window', 'storage:local', 'timer:basic'], tags: ['productivity', 'time', 'reference'] },
  { file: 'json-inspector.html', prompt: 'a JSON inspector with validation and formatting', caps: ['ui:window', 'clipboard:rw'], tags: ['developer', 'utility', 'data'] },
  { file: 'markdown-viewer.html', prompt: 'a markdown editor with live preview', caps: ['ui:window', 'storage:local'], tags: ['productivity', 'text', 'editor'] },
  { file: 'color-palette.html', prompt: 'a color palette tool with hex, RGB, and HSL values', caps: ['ui:window', 'storage:local', 'clipboard:rw'], tags: ['creativity', 'design', 'developer'] },
  { file: 'system-dashboard.html', prompt: 'a system dashboard with uptime and storage usage', caps: ['ui:window', 'storage:local', 'timer:basic'], tags: ['system', 'utility', 'monitoring'] },
];

for (const ex of examples) {
  const code = readFileSync(resolve(__dirname, '..', 'examples', ex.file), 'utf-8');
  saveApp({
    hash: hash(code),
    prompt: ex.prompt,
    normalizedPrompt: ex.prompt.replace(/^a /, ''),
    title: ex.prompt.replace(/^a /, '').slice(0, 50),
    type: 'iframe',
    code,
    dockerfile: null,
    capabilities: ex.caps,
    model: 'hand-crafted',
    provider: 'community',
    launches: 0,
    createdAt: Date.now(),
    tags: ex.tags,
  });
}

// NanoClaw template (process app — code is the Dockerfile, not embeddable)
const { NANOCLAW } = await import('../src/apps/nanoclaw.js');
saveApp({
  hash: hash(NANOCLAW.dockerfile),
  prompt: 'run nanoclaw — lightweight Claude AI assistant with WhatsApp integration',
  normalizedPrompt: 'nanoclaw whatsapp claude ai assistant',
  title: 'NanoClaw',
  type: 'process',
  code: '// NanoClaw is a known app — launched from built-in template',
  dockerfile: NANOCLAW.dockerfile,
  capabilities: NANOCLAW.capabilities,
  model: 'template',
  provider: 'community',
  launches: 0,
  createdAt: Date.now(),
  tags: ['bot', 'communication', 'automation', 'ai'],
});

console.log('\nDone. Run: node scripts/build-registry-index.js');
