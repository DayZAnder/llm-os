// Desktop layout — the shell's chrome as data: bar, launcher, clock, dock,
// window controls, wallpaper.
//
// Like themes, a layout can be written by the model from a description
// ("mac style with a dock on the left"), but the model only proposes: every
// field is checked and clamped here, deterministically, before the shell
// sees it. Unknown fields are dropped; missing ones come from the preset the
// model started from.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let layoutFile = join(__dirname, '..', '..', 'data', 'desktop.json');

export function setLayoutFile(path) { layoutFile = path; }

// The built-in layouts. "classic" is the original shell (no bar or dock).
export const PRESETS = {
  classic: {
    name: 'Classic',
    bar: { position: 'none' },
    dock: { position: 'none' },
    windows: { controls: 'right' },
    promptBar: 'visible',
  },
  windows: {
    name: 'Windows style',
    bar: {
      position: 'bottom', style: 'taskbar', height: 44,
      launcher: { label: 'Prompt', icon: '›_', position: 'left' },
      clock: { show: true, format: '24h', seconds: false, date: true, position: 'right' },
      showWindows: true, tray: true,
    },
    dock: { position: 'none' },
    windows: { controls: 'right' },
    promptBar: 'hidden',
    wallpaper: { type: 'gradient', from: '#0d0d1a', to: '#1b1640' },
  },
  mac: {
    name: 'Mac style',
    bar: {
      position: 'top', style: 'menubar', height: 30,
      launcher: { label: 'LLM OS', icon: '›_', position: 'left' },
      clock: { show: true, format: '24h', seconds: false, date: true, position: 'right' },
      showWindows: false, tray: true,
    },
    dock: { position: 'bottom', iconSize: 48, labels: false, pinned: ['Files', 'Notepad', 'Writer', 'Reader', 'Terminal', 'Tasks'] },
    windows: { controls: 'left' },
    promptBar: 'hidden',
    wallpaper: { type: 'gradient', from: '#101024', to: '#2a1b4a' },
  },
};

const POSITIONS = {
  bar: ['top', 'bottom', 'none'],
  barStyle: ['taskbar', 'menubar', 'minimal'],
  slot: ['left', 'center', 'right'],
  dock: ['bottom', 'left', 'right', 'none'],
  controls: ['left', 'right'],
  promptBar: ['visible', 'hidden'],
  clockFormat: ['24h', '12h'],
  wallpaper: ['solid', 'gradient'],
};

const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const clampInt = (v, min, max, fallback) => (Number.isFinite(+v) ? Math.round(Math.max(min, Math.min(max, +v))) : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const label = (v, max, fallback) => (typeof v === 'string' ? v.replace(/[<>{};]/g, '').trim().slice(0, max) || fallback : fallback);
const color = (v, fallback) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : fallback);

/**
 * Validate a proposed layout on top of a base preset.
 * @returns {{ layout: object, problems: string[] }}
 */
export function validateLayout(input, base = PRESETS.windows) {
  const src = input && typeof input === 'object' ? input : {};
  const problems = [];
  const note = (path, v) => problems.push(`${path}: ${JSON.stringify(v)} is not allowed`);
  const pick = (path, v, list, fallback) => {
    if (v !== undefined && !list.includes(v)) note(path, v);
    return oneOf(v, list, fallback);
  };

  const b = src.bar || {};
  const bb = base.bar || {};
  const barPos = pick('bar.position', b.position, POSITIONS.bar, bb.position || 'none');
  const bar = { position: barPos };
  if (barPos !== 'none') {
    const l = b.launcher || {}, bl = bb.launcher || {};
    const c = b.clock || {}, bc = bb.clock || {};
    Object.assign(bar, {
      style: pick('bar.style', b.style, POSITIONS.barStyle, bb.style || 'taskbar'),
      height: clampInt(b.height, 24, 64, bb.height || 40),
      launcher: {
        label: label(l.label, 16, bl.label || 'Prompt'),
        icon: label(l.icon, 4, bl.icon || '›_'),
        position: pick('bar.launcher.position', l.position, POSITIONS.slot, bl.position || 'left'),
      },
      clock: {
        show: bool(c.show, bc.show !== false),
        format: pick('bar.clock.format', c.format, POSITIONS.clockFormat, bc.format || '24h'),
        seconds: bool(c.seconds, !!bc.seconds),
        date: bool(c.date, bc.date !== false),
        position: pick('bar.clock.position', c.position, POSITIONS.slot, bc.position || 'right'),
      },
      showWindows: bool(b.showWindows, bb.showWindows !== false),
      tray: bool(b.tray, bb.tray !== false),
    });
  }

  const d = src.dock || {};
  const bd = base.dock || {};
  const dockPos = pick('dock.position', d.position, POSITIONS.dock, bd.position || 'none');
  const dock = { position: dockPos };
  if (dockPos !== 'none') {
    const pinned = Array.isArray(d.pinned) ? d.pinned : (bd.pinned || []);
    Object.assign(dock, {
      iconSize: clampInt(d.iconSize, 24, 80, bd.iconSize || 48),
      labels: bool(d.labels, !!bd.labels),
      pinned: pinned.filter(p => typeof p === 'string').map(p => label(p, 30, '')).filter(Boolean).slice(0, 12),
    });
  }
  if (barPos === 'none' && dockPos === 'none' && (src.promptBar || base.promptBar) === 'hidden') {
    problems.push('promptBar: cannot hide the prompt bar when there is neither a bar nor a dock — nothing could launch apps');
  }

  const w = src.windows || {};
  const layout = {
    name: label(src.name, 40, base.name || 'Custom'),
    bar,
    dock,
    windows: { controls: pick('windows.controls', w.controls, POSITIONS.controls, (base.windows || {}).controls || 'right') },
    promptBar: pick('promptBar', src.promptBar, POSITIONS.promptBar, base.promptBar || 'visible'),
  };
  if (barPos === 'none' && dockPos === 'none') layout.promptBar = 'visible';

  const wp = src.wallpaper || base.wallpaper;
  if (wp) {
    layout.wallpaper = {
      type: oneOf(wp.type, POSITIONS.wallpaper, 'solid'),
      from: color(wp.from, '#0d0d1a'),
      to: color(wp.to, color(wp.from, '#0d0d1a')),
    };
  }
  return { layout, problems };
}

export function loadLayout() {
  if (!existsSync(layoutFile)) return { ...PRESETS.classic, preset: 'classic' };
  try {
    const data = JSON.parse(readFileSync(layoutFile, 'utf-8'));
    const base = PRESETS[data.preset] || PRESETS.windows;
    return { ...validateLayout(data, base).layout, preset: data.preset || null, description: String(data.description || '').slice(0, 300) };
  } catch {
    return { ...PRESETS.classic, preset: 'classic' };
  }
}

export function saveLayout(layout) {
  mkdirSync(dirname(layoutFile), { recursive: true });
  writeFileSync(layoutFile, JSON.stringify({ ...layout, savedAt: Date.now() }, null, 2));
}

export function resetLayout() {
  if (existsSync(layoutFile)) unlinkSync(layoutFile);
  return loadLayout();
}
