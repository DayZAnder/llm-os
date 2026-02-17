// Self-Improve Task: Quality Check Registry Apps
// Re-analyzes all registry apps against current rules, scores quality.
// No LLM needed — pure deterministic analysis.

import { analyze } from '../analyzer.js';
import { browseApps } from '../registry/store.js';

function scoreApp(code, analysis) {
  let score = 0;

  // SDK usage: uses LLMOS.* APIs (+30)
  if (code.includes('LLMOS.')) score += 30;

  // No security violations (+30)
  if (!analysis.blocked && (!analysis.violations || analysis.violations.length === 0)) {
    score += 30;
  } else if (!analysis.blocked) {
    // Has warnings but not blocked
    score += 15;
  }

  // Clean HTML structure (+20)
  const hasHtml = /<html/i.test(code);
  const hasBody = /<body/i.test(code);
  const hasScript = /<script/i.test(code);
  if (hasHtml && hasBody && hasScript) score += 20;
  else if (hasScript) score += 10;

  // Has capabilities declaration (+20)
  if (/<!--\s*capabilities\s*:/.test(code)) score += 20;

  return score;
}

export const definition = {
  id: 'qc-apps',
  name: 'Quality Check',
  description: 'Re-analyze registry apps, score quality, flag broken ones',
  category: 'self-improve',
  requiresLLM: false,
  defaultInterval: 48 * 60 * 60 * 1000, // 48 hours

  async handler(_context) {
    const stats = { checked: 0, clean: 0, flagged: 0, nowBlocked: 0, avgScore: 0 };
    const flagged = [];
    let totalScore = 0;

    // Check all apps in registry
    const { apps } = browseApps({ limit: 1000 });

    for (const app of apps) {
      if (app.type !== 'iframe') continue; // only QC iframe apps

      stats.checked++;
      const analysis = analyze(app.code);
      const score = scoreApp(app.code, analysis);
      totalScore += score;

      if (analysis.blocked) {
        stats.nowBlocked++;
        stats.flagged++;
        flagged.push({
          hash: app.hash,
          title: app.title,
          reason: 'now-blocked',
          violations: analysis.violations?.map(v => v.rule) || [],
          score,
        });
      } else if (score < 40) {
        stats.flagged++;
        flagged.push({
          hash: app.hash,
          title: app.title,
          reason: 'low-quality',
          score,
        });
      } else {
        stats.clean++;
      }
    }

    stats.avgScore = stats.checked > 0 ? Math.round(totalScore / stats.checked) : 0;

    return { success: true, stats, flagged };
  },
};
