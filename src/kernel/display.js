// Display settings — how big everything is drawn.
//
// One rule for every OS setting: it can be set by pointing and clicking
// (Settings → Display) or by saying what you want (`/display bigger text`),
// and both go through the same deterministic validation here. The model only
// proposes; it never decides what gets saved.
//
// Today this is the UI scale, which works everywhere (any browser, the kiosk
// VM). Screen resolution in the kiosk VM comes later on the same path.

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { dataPath } from './paths.js';
import { writeFileAtomic } from './fsutil.js';

let displayFile = dataPath('display.json');
export function setDisplayFile(path) { displayFile = path; }

export const SCALE_MIN = 0.5;
export const SCALE_MAX = 3;
/** The steps offered as buttons; any value in range is allowed. */
export const SCALE_STEPS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const DEFAULT_DISPLAY = { scale: 1 };

/**
 * Validate a proposed display setting.
 * @returns {{ display: { scale: number }, problems: string[] }}
 */
export function validateDisplay(input) {
  const problems = [];
  const src = input && typeof input === 'object' ? input : {};
  let scale = DEFAULT_DISPLAY.scale;
  const n = typeof src.scale === 'string' ? parseFloat(src.scale) : src.scale;
  if (src.scale === undefined) {
    problems.push('scale: missing');
  } else if (!Number.isFinite(n)) {
    problems.push(`scale: ${JSON.stringify(src.scale)} is not a number`);
  } else {
    // Percentages are a common way to say it: 150 means 1.5
    const v = n > 10 ? n / 100 : n;
    if (v < SCALE_MIN || v > SCALE_MAX) problems.push(`scale: ${v} is outside ${SCALE_MIN}–${SCALE_MAX}`);
    scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) * 20) / 20; // 5% steps
  }
  return { display: { scale }, problems };
}

/**
 * Settings that need no model: "150%", "1.5x", "x1.25", "125 %", "default".
 * Returns a display object, or null when the text needs to be understood.
 */
export function parseDisplayDirect(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(reset|default|normal|100\s*%)$/.test(t)) return { ...DEFAULT_DISPLAY };
  let m = t.match(/^(\d{2,3})\s*%$/);
  if (m) return validateDisplay({ scale: Number(m[1]) / 100 }).display;
  m = t.match(/^(?:x\s*)?(\d(?:\.\d+)?)\s*x?$/);
  if (m) return validateDisplay({ scale: Number(m[1]) }).display;
  return null;
}

export function loadDisplay() {
  if (!existsSync(displayFile)) return { ...DEFAULT_DISPLAY };
  try {
    return validateDisplay(JSON.parse(readFileSync(displayFile, 'utf-8'))).display;
  } catch {
    return { ...DEFAULT_DISPLAY };
  }
}

export function saveDisplay(display) {
  const { display: clean } = validateDisplay(display);
  writeFileAtomic(displayFile, JSON.stringify({ ...clean, savedAt: Date.now() }, null, 2));
  return clean;
}

export function resetDisplay() {
  if (existsSync(displayFile)) unlinkSync(displayFile);
  return loadDisplay();
}
