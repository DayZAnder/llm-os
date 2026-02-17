// Tests for the app registry
// Run: node tests/registry.test.js

import { publishApp, getApp, searchApps, browseApps, getTags, getStats, recordLaunch, deleteApp, findSimilar } from '../src/kernel/registry/store.js';

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}`);
  }
}

// --- publishApp ---
console.log('\npublishApp:');

const result1 = publishApp({
  prompt: 'make me a calculator',
  code: '<html><body><h1>Calculator</h1></body></html>',
  type: 'iframe',
  capabilities: ['ui:window'],
  model: 'qwen2.5:14b',
  provider: 'ollama',
});
assert(result1.hash && result1.hash.length === 16, 'returns 16-char hash');
assert(result1.existing === false, 'first publish is not existing');
assert(result1.entry.title.length > 0, 'extracts title from prompt');
assert(result1.entry.tags.includes('math'), 'auto-tags calculator as math');
assert(result1.entry.tags.includes('utility'), 'auto-tags calculator as utility');
assert(result1.entry.launches === 1, 'initial launch count is 1');

// Duplicate publish
const result1b = publishApp({
  prompt: 'make me a calculator',
  code: '<html><body><h1>Calculator</h1></body></html>',
  type: 'iframe',
  capabilities: ['ui:window'],
  model: 'qwen2.5:14b',
  provider: 'ollama',
});
assert(result1b.existing === true, 'duplicate code is detected');
assert(result1b.entry.launches === 2, 'launch count incremented on duplicate');
assert(result1b.hash === result1.hash, 'same hash for same code');

// Different app
const result2 = publishApp({
  prompt: 'a todo list with categories',
  code: '<html><body><h1>Todo</h1><script>console.log("todo")</script></body></html>',
  type: 'iframe',
  capabilities: ['ui:window', 'storage:local'],
  model: 'claude-sonnet-4-5-20250929',
  provider: 'claude',
});
assert(result2.hash !== result1.hash, 'different code → different hash');
assert(result2.entry.tags.includes('productivity'), 'auto-tags todo as productivity');

// Process app
const result3 = publishApp({
  prompt: 'a whatsapp bot',
  code: 'const app = require("express")();',
  dockerfile: 'FROM node:22-slim\nCMD ["node", "index.js"]',
  type: 'process',
  capabilities: ['process:background', 'process:network'],
  model: 'claude-sonnet-4-5-20250929',
  provider: 'claude',
});
assert(result3.entry.type === 'process', 'process app stored as process');
assert(result3.entry.dockerfile !== null, 'dockerfile stored');
assert(result3.entry.tags.includes('communication'), 'auto-tags whatsapp as communication');
assert(result3.entry.tags.includes('bot'), 'auto-tags whatsapp as bot');

// --- getApp ---
console.log('\ngetApp:');
const fetched = getApp(result1.hash);
assert(fetched !== null, 'fetches existing app');
assert(fetched.prompt === 'make me a calculator', 'correct prompt');
assert(getApp('0000000000000000') === null, 'null for nonexistent hash');

// --- recordLaunch ---
console.log('\nrecordLaunch:');
const beforeLaunches = getApp(result2.hash).launches;
recordLaunch(result2.hash);
assert(getApp(result2.hash).launches === beforeLaunches + 1, 'launch count incremented');

// --- searchApps ---
console.log('\nsearchApps:');
const calcResults = searchApps('calculator');
assert(calcResults.length >= 1, 'finds calculator app');
assert(calcResults[0].hash === result1.hash, 'calculator is top result');

const todoResults = searchApps('todo list');
assert(todoResults.length >= 1, 'finds todo app');
assert(todoResults[0].hash === result2.hash, 'todo is top result');

const noResults = searchApps('x');
assert(noResults.length === 0, 'too short query returns empty');

// --- findSimilar ---
console.log('\nfindSimilar:');
const similar = findSimilar('build a calculator app');
assert(similar.length >= 1, 'finds similar to calculator');
assert(similar[0].similarity > 0.3, 'similarity above threshold');

// --- browseApps ---
console.log('\nbrowseApps:');
const all = browseApps();
assert(all.total === 3, 'total count is 3');
assert(all.apps.length === 3, 'returns all 3 apps');
assert(all.apps[0].createdAt >= all.apps[1].createdAt, 'sorted newest first');

const tagged = browseApps({ tag: 'productivity' });
assert(tagged.total === 1, 'tag filter works');
assert(tagged.apps[0].hash === result2.hash, 'correct tagged app');

const typed = browseApps({ type: 'process' });
assert(typed.total === 1, 'type filter works');
assert(typed.apps[0].type === 'process', 'correct type');

const paginated = browseApps({ offset: 1, limit: 1 });
assert(paginated.apps.length === 1, 'pagination limit works');
assert(paginated.total === 3, 'total unaffected by pagination');

// --- getTags ---
console.log('\ngetTags:');
const tags = getTags();
assert(tags.length > 0, 'returns tags');
assert(tags[0].count >= 1, 'tags have counts');
const utilityTag = tags.find(t => t.tag === 'utility');
assert(utilityTag && utilityTag.count >= 1, 'utility tag exists');

// --- getStats ---
console.log('\ngetStats:');
const stats = getStats();
assert(stats.totalApps === 3, 'total apps correct');
assert(stats.iframeApps === 2, 'iframe count correct');
assert(stats.processApps === 1, 'process count correct');
assert(stats.totalLaunches >= 3, 'total launches >= 3');

// --- deleteApp ---
console.log('\ndeleteApp:');
assert(deleteApp(result3.hash) === true, 'delete returns true for existing');
assert(getApp(result3.hash) === null, 'deleted app is gone');
assert(deleteApp(result3.hash) === false, 'delete returns false for missing');
assert(browseApps().total === 2, 'total reduced after delete');

// Cleanup remaining test data
deleteApp(result1.hash);
deleteApp(result2.hash);

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
