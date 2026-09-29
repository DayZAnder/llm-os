// System theme — the --llmos-* design tokens shared by the shell and every app.
//
// A theme can be written by the model from a description ("nordic winter
// night"), but the model only proposes values. Everything here is
// deterministic: allowed keys, value syntax, and WCAG contrast are checked
// before a theme is accepted, so a bad or injected answer can't produce
// unreadable UI or smuggle CSS into every app.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// Single source for the defaults: the sandbox injects the same tokens.
import { DEFAULT_THEME } from '../shell/sandbox.js';
import { dataPath } from './paths.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let themeFile = dataPath('theme.json');

export { DEFAULT_THEME };

export const COLOR_KEYS = [
  '--llmos-bg', '--llmos-surface', '--llmos-surface-2', '--llmos-fg', '--llmos-muted',
  '--llmos-accent', '--llmos-accent-fg', '--llmos-border', '--llmos-danger', '--llmos-success',
];
const OTHER_KEYS = ['--llmos-radius', '--llmos-font', '--llmos-mono'];
export const THEME_KEYS = [...COLOR_KEYS, ...OTHER_KEYS];

// Minimum contrast ratios [foreground, background, minimum]
const CONTRAST_RULES = [
  ['--llmos-fg', '--llmos-bg', 7],
  ['--llmos-fg', '--llmos-surface', 4.5],
  ['--llmos-muted', '--llmos-bg', 3],
  ['--llmos-accent-fg', '--llmos-accent', 3],
  ['--llmos-accent', '--llmos-bg', 3],
  ['--llmos-danger', '--llmos-bg', 3],
];

/** Use a different file (tests). */
export function setThemeFile(path) { themeFile = path; }

function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

function luminance([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two #hex colors. */
export function contrast(a, b) {
  const [la, lb] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}

/**
 * Validate a proposed theme. Unknown keys are dropped, missing keys fall
 * back to the defaults, bad values and weak contrast are reported.
 * @returns {{ ok: boolean, vars: object, problems: string[] }}
 */
export function validateTheme(input) {
  const problems = [];
  const vars = { ...DEFAULT_THEME };
  const src = input && typeof input === 'object' ? input : {};

  for (const key of THEME_KEYS) {
    if (!(key in src)) continue;
    const v = String(src[key]).trim();
    if (COLOR_KEYS.includes(key)) {
      if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { problems.push(`${key}: "${v}" is not a #rgb or #rrggbb color`); continue; }
    } else if (key === '--llmos-radius') {
      if (!/^(?:[0-9]|1[0-9]|20)px$/.test(v)) { problems.push(`${key}: "${v}" must be 0px–20px`); continue; }
    } else if (!/^[A-Za-z0-9 "',.-]{1,160}$/.test(v)) {
      problems.push(`${key}: font stack contains characters that are not allowed`);
      continue;
    }
    vars[key] = v;
  }

  for (const [fg, bg, min] of CONTRAST_RULES) {
    const ratio = contrast(vars[fg], vars[bg]);
    if (ratio < min) problems.push(`${fg} on ${bg} has contrast ${ratio.toFixed(2)}:1, needs at least ${min}:1`);
  }

  return { ok: problems.length === 0, vars, problems };
}

export function loadTheme() {
  if (!existsSync(themeFile)) return { name: 'Default', description: '', vars: { ...DEFAULT_THEME } };
  try {
    const data = JSON.parse(readFileSync(themeFile, 'utf-8'));
    const { vars } = validateTheme(data.vars); // re-validate: the file may have been edited
    return { name: String(data.name || 'Custom').slice(0, 60), description: String(data.description || '').slice(0, 300), vars };
  } catch {
    return { name: 'Default', description: '', vars: { ...DEFAULT_THEME } };
  }
}

export function saveTheme({ name, description, vars }) {
  mkdirSync(dirname(themeFile), { recursive: true });
  writeFileSync(themeFile, JSON.stringify({ name, description, vars, savedAt: Date.now() }, null, 2));
}

export function resetTheme() {
  if (existsSync(themeFile)) unlinkSync(themeFile);
  return loadTheme();
}
