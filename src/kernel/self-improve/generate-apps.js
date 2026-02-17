// Self-Improve Task: Generate Apps
// Generates diverse apps for the registry using the LLM gateway.
// Guardrails: dedup via findSimilar, daily budget, max registry size.

import { generate } from '../gateway.js';
import { analyze } from '../analyzer.js';
import { publishApp, findSimilar, getStats } from '../registry/store.js';
import { config } from '../config.js';

// 80+ prompts across 8 categories
const PROMPT_BANK = [
  // Utility
  'make a unit converter for length, weight, and temperature',
  'build a tip calculator that splits bills between friends',
  'make a BMI calculator with a health range chart',
  'build a binary, decimal, and hex number converter',
  'make a color picker showing hex, rgb, and hsl values',
  'build a password generator with strength meter',
  'make a QR code generator from text input',
  'build a URL shortener bookmark manager',
  'make a base64 encoder and decoder',
  'build a character and word counter for text',
  // Productivity
  'make a pomodoro timer with break reminders and session log',
  'build a kanban board with todo, doing, and done columns',
  'make a daily habit tracker with streak counting',
  'build a simple expense tracker with categories and monthly totals',
  'make a weekly meal planner with a shopping list',
  'build a note-taking app with search',
  'make a reading list tracker with progress bars',
  'build a goal tracker with milestones',
  'make a simple time tracker for projects',
  'build a daily journal with date entries',
  // Games
  'make a dice roller for tabletop RPGs with multiple dice types',
  'build a memory card matching game',
  'make a simple snake game',
  'build a tic-tac-toe game against the computer',
  'make a number guessing game with hints',
  'build a simple whack-a-mole game',
  'make a trivia quiz app with multiple categories',
  'build a rock paper scissors game with score tracking',
  'make a simple breakout/brick breaker game',
  'build a hangman word guessing game',
  // Creative
  'make a drawing pad with color picker and brush sizes',
  'build a pixel art editor on a grid',
  'make a drum machine with 8 pads and different sounds',
  'build a simple piano keyboard that plays notes',
  'make a music metronome with adjustable BPM and time signatures',
  'build a color palette generator with harmonies',
  'make an ASCII art generator from text',
  'build a simple animation timeline with keyframes',
  'make a gradient generator with CSS output',
  'build a mandala drawing tool with symmetry',
  // Text
  'make a markdown editor with live preview',
  'build a JSON formatter and validator with syntax highlighting',
  'make a regex tester with match highlighting',
  'build a lorem ipsum generator with paragraph count',
  'make a text diff viewer that highlights changes',
  'build a morse code translator',
  'make a case converter (upper, lower, title, camel, snake)',
  'build a simple code syntax highlighter',
  'make a csv to table viewer',
  'build a text encryption tool using simple ciphers',
  // Data
  'make a bar chart builder from manual data entry',
  'build a simple spreadsheet with formulas',
  'make a countdown timer to a specific date',
  'build a world clock showing multiple time zones',
  'make a loan payment calculator with amortization',
  'build a grade calculator with weighted averages',
  'make a savings goal tracker with progress visualization',
  'build a simple poll creator and voter',
  'make a statistics calculator (mean, median, mode, stddev)',
  'build a unit price comparison tool',
  // Education
  'make a flashcard study app with flip to reveal',
  'build a typing speed test that measures WPM',
  'make a periodic table viewer with element details',
  'build a math quiz generator for kids',
  'make a vocabulary builder with spaced repetition',
  'build a multiplication table explorer',
  'make a fraction calculator with visual representation',
  'build a simple geography quiz with country flags',
  'make a roman numeral converter',
  'build a phonetic alphabet reference chart',
  // Health & Lifestyle
  'make a water intake tracker with daily goal',
  'build a simple workout timer with exercise intervals',
  'make a sleep tracker with quality rating',
  'build a mood journal with emoji ratings',
  'make a breathing exercise timer with animations',
  'build a calorie counter with a food database',
  'make a stretching routine timer',
  'build a meditation timer with ambient sounds',
];

export const definition = {
  id: 'generate-apps',
  name: 'Generate Apps',
  description: 'Generate diverse apps for the registry using local LLM',
  category: 'self-improve',
  requiresLLM: true,
  defaultInterval: 6 * 60 * 60 * 1000, // 6 hours

  async handler(context) {
    const stats = { attempted: 0, generated: 0, published: 0, skipped: 0, blocked: 0, failed: 0 };

    // Guard: max registry size
    const registryStats = getStats();
    if (registryStats.totalApps >= config.scheduler.maxRegistryApps) {
      return { success: true, stats: { ...stats, skipped_reason: 'registry full' } };
    }

    // Pick 5 random prompts
    const shuffled = PROMPT_BANK.sort(() => Math.random() - 0.5);
    const batch = shuffled.slice(0, 5);

    for (const prompt of batch) {
      // Budget check
      if (context.getBudgetRemaining() <= 0) break;

      stats.attempted++;

      // Dedup: skip if similar app exists
      const similar = findSimilar(prompt, { threshold: 0.5, limit: 1 });
      if (similar.length > 0) {
        stats.skipped++;
        continue;
      }

      try {
        context.trackLLMCall();
        const result = await generate(prompt);

        // Security check
        const analysis = analyze(result.code);
        if (analysis.blocked) {
          stats.blocked++;
          continue;
        }

        // Publish
        publishApp({
          prompt,
          code: result.code,
          type: 'iframe',
          capabilities: result.capabilities,
          model: result.model,
          provider: result.provider,
        });
        stats.published++;
        stats.generated++;
      } catch (err) {
        stats.failed++;
        console.error(`[self-improve:generate] Failed for "${prompt.slice(0, 40)}":`, err.message);
      }
    }

    return { success: true, stats };
  },
};
