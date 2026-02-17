// Tests for kernel utility functions
// Run: node tests/utils.test.js

import { normalizePrompt, trigramSimilarity, estimateTokenCount } from '../src/kernel/utils/normalize.js';

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

console.log('\nnormalizePrompt:');
assert(normalizePrompt('Make me a calculator') === 'calculator', 'strips filler words');
assert(normalizePrompt('Please create a simple todo list app') === 'todo list app', 'strips please/create/simple/a');
assert(normalizePrompt('  Build   me   the   best  timer  ') === 'best timer', 'collapses whitespace');
assert(normalizePrompt('I want a Markdown Editor!!!') === 'markdown editor', 'lowercases and strips punctuation');
assert(normalizePrompt('Can you generate something like a pomodoro timer?') === 'pomodoro timer', 'handles question format');
assert(normalizePrompt('calculator') === 'calculator', 'single word unchanged');
assert(normalizePrompt('UNIT CONVERTER') === 'unit converter', 'handles all caps');
assert(normalizePrompt('Give me an app that shows the weather') === 'app shows weather', 'strips articles and filler');

console.log('\ntrigramSimilarity:');
assert(trigramSimilarity('calculator', 'calculator') === 1, 'identical strings = 1.0');
assert(trigramSimilarity('calculator', 'calc') > 0.2, 'partial match > 0.2');
assert(trigramSimilarity('todo list', 'todo app') > 0.3, 'similar prompts > 0.3');
assert(trigramSimilarity('calculator', 'weather forecast') < 0.2, 'unrelated < 0.2');
assert(trigramSimilarity('timer', 'pomodoro timer') > 0.3, 'subset match > 0.3');
assert(trigramSimilarity('ab', 'cd') === 0, 'very short unrelated = 0');
assert(trigramSimilarity('', '') === 1, 'empty strings = 1');

console.log('\nestimateTokenCount:');
assert(estimateTokenCount('hello world') === 2, 'two short words = 2 tokens');
assert(estimateTokenCount('Make me a calculator app') === 5, 'five short words = 5 tokens');
assert(estimateTokenCount('internationalization') === 5, 'long word = ceil(20/4) = 5 tokens');
assert(estimateTokenCount('a') >= 1, 'minimum 1 token');
assert(estimateTokenCount('The quick brown fox jumps over the lazy dog') === 9, '9 short words = 9 tokens');

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
