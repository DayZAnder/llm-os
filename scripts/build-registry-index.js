#!/usr/bin/env node
// Builds registry/index.json from individual app files in registry/apps/
// Run: node scripts/build-registry-index.js

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const APPS_DIR = resolve(__dirname, '..', 'registry', 'apps');
const INDEX_FILE = resolve(__dirname, '..', 'registry', 'index.json');

const files = readdirSync(APPS_DIR).filter(f => f.endsWith('.json'));
const apps = [];

for (const file of files) {
  try {
    const data = JSON.parse(readFileSync(join(APPS_DIR, file), 'utf-8'));
    apps.push({
      hash: data.hash,
      title: data.title,
      prompt: data.prompt,
      type: data.type,
      capabilities: data.capabilities,
      model: data.model,
      tags: data.tags,
      createdAt: data.createdAt,
    });
  } catch (err) {
    console.warn(`Skipping ${file}: ${err.message}`);
  }
}

apps.sort((a, b) => b.createdAt - a.createdAt);

const index = {
  version: 1,
  updatedAt: Date.now(),
  count: apps.length,
  apps,
};

writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
console.log(`Built index: ${apps.length} apps`);
