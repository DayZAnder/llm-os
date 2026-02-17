#!/usr/bin/env node

// LLM OS Values Check
// Deterministic scan of code changes against core values.
// Runs locally (node scripts/values-check.js) and in CI.
//
// Core Values:
// 1. Protect the user first (privacy, no telemetry, sandbox everything)
// 2. Empower the user (no artificial limits)
// 3. Take a piece, leave a piece (don't break the core)
// 4. Nothing is perfect (but never violate core intent)

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, extname } from 'path';

// === VALUE 1: Protect the user first ===

const TELEMETRY_PATTERNS = [
  { pattern: /google[\s-]?analytics|gtag|ga\s*\(/i, rule: 'NO_GOOGLE_ANALYTICS', description: 'Google Analytics detected' },
  { pattern: /mixpanel|amplitude|segment\.(?:com|io)|posthog/i, rule: 'NO_ANALYTICS_SERVICE', description: 'Analytics/tracking service detected' },
  { pattern: /sentry\.io|bugsnag|rollbar|datadog/i, rule: 'NO_ERROR_TRACKING', description: 'Error tracking service detected (use local logging)' },
  { pattern: /beacon\s*\(|navigator\.sendBeacon/i, rule: 'NO_BEACON', description: 'sendBeacon used (silent data exfiltration risk)' },
  { pattern: /\.track\s*\(|\.identify\s*\(|\.page\s*\(/i, rule: 'NO_TRACKING_CALLS', description: 'Tracking method calls detected (.track, .identify, .page)' },
  { pattern: /fingerprint(?:js|2|pro)(?!ing)/i, rule: 'NO_FINGERPRINTING', description: 'Browser fingerprinting library detected' },
  { pattern: /hotjar|fullstory|logrocket|mouseflow|clarity/i, rule: 'NO_SESSION_RECORDING', description: 'Session recording service detected' },
];

const PRIVACY_PATTERNS = [
  { pattern: /document\.cookie(?!\s*$)/i, rule: 'NO_COOKIE_ACCESS', description: 'Direct cookie access (use capability system)' },
  { pattern: /localStorage\.|sessionStorage\./i, rule: 'NO_DIRECT_STORAGE', description: 'Direct browser storage access outside SDK (use LLMOS.storage)' },
  { pattern: /navigator\.geolocation/i, rule: 'NO_GEOLOCATION', description: 'Geolocation access without capability system' },
  { pattern: /navigator\.(?:mediaDevices|getUserMedia)/i, rule: 'NO_MEDIA_DEVICES', description: 'Camera/mic access without capability system' },
];

const SANDBOX_WEAKENING_PATTERNS = [
  { pattern: /sandbox\s*=\s*["'][^"']*allow-same-origin/i, rule: 'NO_SAME_ORIGIN', description: 'allow-same-origin breaks iframe sandbox isolation' },
  { pattern: /sandbox\s*=\s*["'][^"']*allow-top-navigation/i, rule: 'NO_TOP_NAV', description: 'allow-top-navigation lets iframe redirect parent' },
  { pattern: /sandbox\s*=\s*["'][^"']*allow-popups(?!-to-escape)/i, rule: 'NO_POPUPS', description: 'allow-popups enables sandbox escape via popup' },
  { pattern: /Content-Security-Policy[^;]*unsafe-eval/i, rule: 'NO_UNSAFE_EVAL_CSP', description: 'unsafe-eval in CSP defeats code analysis' },
  { pattern: /\.contentWindow\b(?!\.postMessage)/i, rule: 'NO_CONTENT_WINDOW', description: 'Direct contentWindow access (use postMessage)' },
];

// === VALUE 2: Empower the user ===

const RESTRICTION_PATTERNS = [
  { pattern: /(?:premium|pro|paid|subscription|license[_-]?key).*(?:feature|access|unlock)/i, rule: 'NO_PAYWALLS', description: 'Paywall or premium feature gating detected' },
  { pattern: /(?:disable|block|prevent).*(?:feature|function|capability).*(?:free|basic)/i, rule: 'NO_ARTIFICIAL_LIMITS', description: 'Artificial feature limitation detected' },
];

// === VALUE 3: Take a piece, leave a piece ===

const INTEGRITY_PATTERNS = [
  { pattern: /(?:rm\s+-rf|rimraf|del\s+\/[sfq])\s+(?:\/|\\|\.\.|src|kernel)/i, rule: 'NO_DESTRUCTIVE_OPS', description: 'Destructive file operation on core directories' },
  { pattern: /process\.exit\s*\(\s*[^0)]/i, rule: 'NO_FORCE_EXIT', description: 'Forced non-zero exit (may disrupt core process)' },
];

// Files/patterns that should never be in a PR
const FORBIDDEN_FILES = [
  { pattern: /\.env$/, rule: 'NO_ENV_FILE', description: '.env file contains secrets — use .env.example' },
  { pattern: /credentials|secrets?\.json/i, rule: 'NO_CREDENTIALS', description: 'Credentials file detected' },
  { pattern: /\.pem$|\.key$/i, rule: 'NO_PRIVATE_KEYS', description: 'Private key file detected' },
];

// Dependency additions that need justification
const SUSPICIOUS_DEPS = [
  'analytics', 'tracking', 'telemetry', 'sentry', 'bugsnag', 'mixpanel',
  'amplitude', 'segment', 'posthog', 'hotjar', 'fullstory', 'logrocket',
  'datadog', 'newrelic', 'rollbar', 'fingerprint',
];

// ============================================================

const SEVERITY = { CRITICAL: 'CRITICAL', WARNING: 'WARNING', INFO: 'INFO' };

// Files that legitimately contain security patterns (analyzer rules, test vectors, this script)
const EXEMPT_FILES = [
  /^src\/kernel\/analyzer\.js$/,
  /^tests\/.*\.test\.js$/,
  /^src\/kernel\/self-improve\//,
  /^scripts\/values-check\.js$/,
];

function isExempt(filePath) {
  return EXEMPT_FILES.some(re => re.test(filePath.replace(/\\/g, '/')));
}

function getChangedFiles() {
  try {
    // In CI: diff against base branch
    const base = process.env.GITHUB_BASE_REF || 'master';
    const diff = execSync(`git diff --name-only ${base}...HEAD 2>/dev/null || git diff --name-only HEAD~1`, { encoding: 'utf-8' });
    return diff.trim().split('\n').filter(Boolean);
  } catch {
    // Fallback: check all tracked files
    try {
      const all = execSync('git diff --name-only --cached', { encoding: 'utf-8' });
      return all.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

function scanFile(filePath, patterns, severity = SEVERITY.CRITICAL) {
  const findings = [];
  const absPath = resolve(process.cwd(), filePath);

  if (!existsSync(absPath)) return findings;

  const ext = extname(filePath);
  // Only scan code files
  if (!['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.mjs', '.cjs', '.json'].includes(ext)) return findings;

  const content = readFileSync(absPath, 'utf-8');
  const lines = content.split('\n');

  for (const { pattern, rule, description } of patterns) {
    for (let i = 0; i < lines.length; i++) {
      // Reset regex state
      if (pattern.global) pattern.lastIndex = 0;

      if (pattern.test(lines[i])) {
        // Skip if inside a comment describing the rule (e.g., "we block analytics because...")
        const line = lines[i].trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('#')) {
          // Only skip if it's genuinely a comment about the pattern, not code
          if (line.includes('detect') || line.includes('block') || line.includes('prevent') || line.includes('pattern') || line.includes('rule')) {
            continue;
          }
        }

        findings.push({
          file: filePath,
          line: i + 1,
          rule,
          severity,
          description,
          snippet: lines[i].trim().slice(0, 120),
        });
      }

      if (pattern.global) pattern.lastIndex = 0;
    }
  }

  return findings;
}

function checkForbiddenFiles(files) {
  const findings = [];
  for (const file of files) {
    for (const { pattern, rule, description } of FORBIDDEN_FILES) {
      if (pattern.test(file)) {
        findings.push({
          file,
          line: 0,
          rule,
          severity: SEVERITY.CRITICAL,
          description,
          snippet: file,
        });
      }
    }
  }
  return findings;
}

function checkNewDependencies(files) {
  const findings = [];

  if (!files.includes('package.json')) return findings;

  try {
    const diff = execSync('git diff HEAD~1 -- package.json 2>/dev/null || echo ""', { encoding: 'utf-8' });
    for (const dep of SUSPICIOUS_DEPS) {
      if (diff.includes(dep)) {
        findings.push({
          file: 'package.json',
          line: 0,
          rule: 'SUSPICIOUS_DEPENDENCY',
          severity: SEVERITY.CRITICAL,
          description: `Suspicious dependency added: "${dep}" — may violate user privacy`,
          snippet: dep,
        });
      }
    }
  } catch {}

  return findings;
}

// Run all checks
function run() {
  const files = getChangedFiles();

  if (files.length === 0) {
    console.log('No changed files to check.');
    process.exit(0);
  }

  console.log(`\n  LLM OS Values Check\n  Scanning ${files.length} file(s)...\n`);

  const allFindings = [];

  // Check forbidden files
  allFindings.push(...checkForbiddenFiles(files));

  // Check new dependencies
  allFindings.push(...checkNewDependencies(files));

  // Scan each file
  for (const file of files) {
    // Skip files that legitimately contain security patterns (analyzer rules, test vectors)
    if (isExempt(file)) continue;

    // Value 1: Protect the user
    allFindings.push(...scanFile(file, TELEMETRY_PATTERNS, SEVERITY.CRITICAL));
    allFindings.push(...scanFile(file, PRIVACY_PATTERNS, SEVERITY.WARNING));
    allFindings.push(...scanFile(file, SANDBOX_WEAKENING_PATTERNS, SEVERITY.CRITICAL));

    // Value 2: Empower the user
    allFindings.push(...scanFile(file, RESTRICTION_PATTERNS, SEVERITY.WARNING));

    // Value 3: Don't break the core
    allFindings.push(...scanFile(file, INTEGRITY_PATTERNS, SEVERITY.WARNING));
  }

  // Report
  const criticals = allFindings.filter(f => f.severity === SEVERITY.CRITICAL);
  const warnings = allFindings.filter(f => f.severity === SEVERITY.WARNING);

  if (allFindings.length === 0) {
    console.log('  ✓ All checks passed. No value violations detected.\n');
    process.exit(0);
  }

  if (criticals.length > 0) {
    console.log(`  CRITICAL — ${criticals.length} violation(s) found:\n`);
    for (const f of criticals) {
      console.log(`    ✗ [${f.rule}] ${f.file}:${f.line}`);
      console.log(`      ${f.description}`);
      console.log(`      ${f.snippet}\n`);
    }
  }

  if (warnings.length > 0) {
    console.log(`  WARNING — ${warnings.length} issue(s) to review:\n`);
    for (const f of warnings) {
      console.log(`    ! [${f.rule}] ${f.file}:${f.line}`);
      console.log(`      ${f.description}`);
      console.log(`      ${f.snippet}\n`);
    }
  }

  console.log(`  Summary: ${criticals.length} critical, ${warnings.length} warnings`);

  if (criticals.length > 0) {
    console.log('\n  ✗ Values check FAILED. Fix critical issues before merging.\n');
    process.exit(1);
  } else {
    console.log('\n  ! Values check passed with warnings. Review before merging.\n');
    process.exit(0);
  }
}

run();
