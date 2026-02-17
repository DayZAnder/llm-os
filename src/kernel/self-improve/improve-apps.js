// Self-Improve Task: Improve Popular Apps
// Rewrites popular registry apps with better UX and features.
// Guardrails: only improves apps with 3+ launches, checks code diff > 20%.

import { generate } from '../gateway.js';
import { analyze } from '../analyzer.js';
import { publishApp, browseApps } from '../registry/store.js';

function codeDiffPercent(a, b) {
  // Simple character-level diff: what % of chars are different
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 0;

  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++;
  }
  return Math.round(((longer.length - matches) / longer.length) * 100);
}

export const definition = {
  id: 'improve-apps',
  name: 'Improve Apps',
  description: 'Rewrite popular registry apps with better UX and features',
  category: 'self-improve',
  requiresLLM: true,
  defaultInterval: 24 * 60 * 60 * 1000, // 24 hours

  async handler(context) {
    const stats = { attempted: 0, improved: 0, blocked: 0, tooSimilar: 0, failed: 0 };

    // Find popular apps (3+ launches, not community/improved already)
    const { apps } = browseApps({ limit: 100 });
    const candidates = apps.filter(app =>
      app.launches >= 3 &&
      app.source !== 'community' &&
      app.type === 'iframe' &&
      !app.title?.startsWith('[Improved]')
    );

    if (candidates.length === 0) {
      return { success: true, stats: { ...stats, skipped_reason: 'no eligible apps' } };
    }

    // Pick 2 random popular apps
    const shuffled = candidates.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 2);

    for (const app of selected) {
      if (context.getBudgetRemaining() <= 0) break;

      stats.attempted++;

      try {
        context.trackLLMCall();

        // Generate improved version
        const improvePrompt = `Improve this app with better UX, more features, and cleaner design. Keep the same core purpose. Original request: ${app.prompt}`;
        const result = await generate(improvePrompt);

        // Security check
        const analysis = analyze(result.code);
        if (analysis.blocked) {
          stats.blocked++;
          continue;
        }

        // Check code diff (must be >20% different)
        const diff = codeDiffPercent(app.code, result.code);
        if (diff < 20) {
          stats.tooSimilar++;
          continue;
        }

        // Publish improved version
        publishApp({
          prompt: `[Improved] ${app.prompt}`,
          code: result.code,
          type: 'iframe',
          capabilities: result.capabilities,
          model: result.model,
          provider: result.provider,
        });
        stats.improved++;
      } catch (err) {
        stats.failed++;
        console.error(`[self-improve:improve] Failed for "${app.title}":`, err.message);
      }
    }

    return { success: true, stats };
  },
};
