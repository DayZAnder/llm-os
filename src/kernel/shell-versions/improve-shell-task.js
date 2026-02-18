// Self-Improve Task: Improve Shell UI
// Autonomously improves the shell UI with AI-generated enhancements.
// Conservative: 7-day interval, 3%-60% diff band, structural validation.

import { improveShell } from './improve.js';

export const definition = {
  id: 'improve-shell',
  name: 'Improve Shell UI',
  description: 'Autonomously improve the shell UI with AI-generated enhancements',
  category: 'self-improve',
  requiresLLM: true,
  defaultInterval: 7 * 24 * 60 * 60 * 1000, // 7 days

  async handler(context) {
    const stats = { attempted: 1, applied: 0, blocked: 0, tooSimilar: 0, invalidStructure: 0, tooLarge: 0, failed: 0 };

    if (context.getBudgetRemaining() <= 0) {
      return { success: true, stats: { ...stats, attempted: 0, skipped_reason: 'budget exhausted' } };
    }

    context.trackLLMCall();

    try {
      const result = await improveShell(null, 'scheduler');

      if (result.error) {
        if (result.error.includes('too small')) stats.tooSimilar++;
        else if (result.error.includes('too large')) stats.tooLarge++;
        else if (result.error.includes('structural')) stats.invalidStructure++;
        else if (result.error.includes('Security')) stats.blocked++;
        else stats.failed++;
        console.warn(`[improve-shell] Rejected: ${result.error}`);
        return { success: true, stats };
      }

      stats.applied++;
      return { success: true, stats };
    } catch (err) {
      stats.failed++;
      console.error('[improve-shell] Failed:', err.message);
      return { success: false, stats, error: err.message };
    }
  },
};
