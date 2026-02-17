// OS Profile Loader
// Reads data/profile.yaml and provides the user's identity, preferences,
// and boot-time app list to the kernel.
//
// Phase 5 prep: when the OS becomes ephemeral, this profile is the only
// thing that persists. Everything else is regenerated from it on boot.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const PROFILE_PATH = join(DATA_DIR, 'profile.yaml');
const EXAMPLE_PATH = join(DATA_DIR, 'profile.example.yaml');

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
