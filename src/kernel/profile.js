// OS Profile Loader
// Reads data/profile.yaml and provides the user's identity, preferences,
// and boot-time app list to the kernel.
//
// Phase 5 prep: when the OS becomes ephemeral, this profile is the only
// thing that persists. Everything else is regenerated from it on boot.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const PROFILE_PATH = join(DATA_DIR, 'profile.yaml');
const EXAMPLE_PATH = join(DATA_DIR, 'profile.example.yaml');
const SNAPSHOT_DIR = join(DATA_DIR, 'snapshot');

// Minimal YAML parser — handles the flat/nested structure of profile.yaml
// without requiring a dependency. Supports strings, numbers, booleans, and arrays.
function parseSimpleYaml(text) {
  const result = {};
  let currentSection = null;
  let currentArray = null;

  for (const rawLine of text.split('\n')) {
    // Strip comments (but not inside quoted strings)
    const line = rawLine.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    const trimmed = line.trimEnd();

    if (!trimmed) continue;

    // Array item (  - "value")
    if (/^\s+-\s+/.test(trimmed)) {
      const value = trimmed.replace(/^\s+-\s+/, '').trim();
      if (currentArray && currentSection) {
        result[currentSection][currentArray].push(parseValue(value));
      }
      continue;
    }

    // Indented key (part of a section)
    const indentedMatch = trimmed.match(/^(\s{2,})(\w[\w-]*):\s*(.*)$/);
    if (indentedMatch && currentSection) {
      const [, , key, rawVal] = indentedMatch;
      const val = rawVal.trim();
      if (val === '' || val === '[]') {
        // Empty array
        result[currentSection][key] = [];
        currentArray = key;
      } else {
        result[currentSection][key] = parseValue(val);
        currentArray = null;
      }
      continue;
    }

    // Top-level key
    const topMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (topMatch) {
      const [, key, rawVal] = topMatch;
      const val = rawVal.trim();
      if (val === '' || val === '[]') {
        // Section header or empty array
        result[key] = Array.isArray(result[key]) ? result[key] : {};
        if (val === '[]') result[key] = [];
        currentSection = key;
        currentArray = val === '[]' ? null : null;
      } else {
        result[key] = parseValue(val);
        currentSection = null;
        currentArray = null;
      }
      continue;
    }
  }

  return result;
}

function parseValue(raw) {
  if (!raw) return '';
  // Remove surrounding quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  return raw;
}

// Default profile values
const DEFAULTS = {
  mode: 'ephemeral',  // ephemeral | solidified
  name: '',
  locale: 'en',
  timezone: 'UTC',
  shell: {
    theme: 'dark',
    font: 'monospace',
    layout: 'single',
    greeting: 'What would you like to build?',
  },
  boot_apps: [],
  services: {
    ssh: true,
    ollama: true,
    scheduler: false,
  },
  security: {
    sandbox: 'strict',
    network: 'deny',
    max_capabilities: 5,
  },
  llm: {
    prefer: 'local',
    temperature: 0.7,
  },
  persist: [
    'data/apps/',
    'data/registry.json',
    'data/profile.yaml',
    'data/claude-tasks.json',
  ],
};

// Deep merge: defaults ← loaded
function merge(defaults, loaded) {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(loaded)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      result[key] = merge(defaults[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

let _profile = null;

export function loadProfile() {
  if (_profile) return _profile;

  let raw = null;
  if (existsSync(PROFILE_PATH)) {
    raw = readFileSync(PROFILE_PATH, 'utf-8');
  } else if (existsSync(EXAMPLE_PATH)) {
    // Fall back to example profile (all defaults)
    raw = readFileSync(EXAMPLE_PATH, 'utf-8');
  }

  if (raw) {
    const parsed = parseSimpleYaml(raw);
    _profile = merge(DEFAULTS, parsed);
  } else {
    _profile = { ...DEFAULTS };
  }

  return _profile;
}

// Force reload (useful after profile edit)
export function reloadProfile() {
  _profile = null;
  return loadProfile();
}

// Get a specific profile section
export function getProfile(section) {
  const profile = loadProfile();
  return section ? profile[section] : profile;
}

// Get boot apps (prompts to generate on startup)
export function getBootApps() {
  return loadProfile().boot_apps || [];
}

// Check if a service should be enabled per profile
export function isServiceEnabled(name) {
  const services = loadProfile().services || {};
  return services[name] === true;
}

// --- Snapshot / Solidify ---
// Solidify: freeze current generated state so it's reused on next boot.
// Ephemeral: discard snapshot, regenerate everything on next boot.

// Save an app's generated code to the snapshot
export function snapshotApp(appId, code, prompt) {
  mkdirSync(join(SNAPSHOT_DIR, 'apps'), { recursive: true });
  writeFileSync(
    join(SNAPSHOT_DIR, 'apps', `${appId}.json`),
    JSON.stringify({ appId, prompt, code, snapshotAt: new Date().toISOString() }, null, 2),
  );
}

// Save the shell UI to the snapshot
export function snapshotShell(html) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(join(SNAPSHOT_DIR, 'shell.html'), html);
}

// Load a snapshotted app (returns null if not solidified or no snapshot)
export function loadSnapshotApp(appId) {
  const profile = loadProfile();
  if (profile.mode !== 'solidified') return null;
  const path = join(SNAPSHOT_DIR, 'apps', `${appId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// Load the snapshotted shell (returns null if not solidified or no snapshot)
export function loadSnapshotShell() {
  const profile = loadProfile();
  if (profile.mode !== 'solidified') return null;
  const path = join(SNAPSHOT_DIR, 'shell.html');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

// Solidify: switch profile mode to solidified
export function solidify() {
  const profile = loadProfile();
  if (!existsSync(SNAPSHOT_DIR)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
  // Write snapshot metadata
  writeFileSync(
    join(SNAPSHOT_DIR, 'meta.json'),
    JSON.stringify({
      solidifiedAt: new Date().toISOString(),
      profile: { name: profile.name, locale: profile.locale, shell: profile.shell },
      bootApps: profile.boot_apps || [],
    }, null, 2),
  );
  // Update mode in profile
  setProfileMode('solidified');
  return { mode: 'solidified', snapshotDir: SNAPSHOT_DIR };
}

// Go ephemeral: switch back and optionally clear snapshot
export function goEphemeral(clearSnapshot = false) {
  if (clearSnapshot && existsSync(SNAPSHOT_DIR)) {
    rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  }
  setProfileMode('ephemeral');
  return { mode: 'ephemeral', snapshotCleared: clearSnapshot };
}

// Check if we're in solidified mode with a valid snapshot
export function isSolidified() {
  const profile = loadProfile();
  return profile.mode === 'solidified' && existsSync(join(SNAPSHOT_DIR, 'meta.json'));
}

// Get snapshot metadata
export function getSnapshotInfo() {
  const metaPath = join(SNAPSHOT_DIR, 'meta.json');
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, 'utf-8'));
}

// Internal: update the mode field in profile.yaml
function setProfileMode(mode) {
  if (existsSync(PROFILE_PATH)) {
    let content = readFileSync(PROFILE_PATH, 'utf-8');
    if (/^mode:\s*.+$/m.test(content)) {
      content = content.replace(/^mode:\s*.+$/m, `mode: ${mode}`);
    } else {
      // Add mode at the top (after comments)
      const lines = content.split('\n');
      const firstNonComment = lines.findIndex(l => l.trim() && !l.trim().startsWith('#'));
      if (firstNonComment >= 0) {
        lines.splice(firstNonComment, 0, `mode: ${mode}`);
      } else {
        lines.push(`mode: ${mode}`);
      }
      content = lines.join('\n');
    }
    writeFileSync(PROFILE_PATH, content);
  }
  // Reload cached profile
  _profile = null;
  loadProfile();
}
