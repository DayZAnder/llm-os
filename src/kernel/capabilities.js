// Simple capability system — whitelist per app instance
// Phase 1: no crypto tokens, just in-memory maps

const CAPABILITY_TYPES = [
  'ui:window',
  'storage:local',
  'timer:basic',
  'clipboard:rw',
  'network:http',
];

// Keyword → capability mapping for auto-proposal
const KEYWORD_MAP = {
  'storage:local': ['save', 'store', 'persist', 'remember', 'todo', 'list', 'note', 'bookmark', 'favorite', 'history', 'data'],
  'timer:basic': ['timer', 'countdown', 'stopwatch', 'clock', 'pomodoro', 'interval', 'animation', 'tick', 'alarm', 'reminder'],
  'clipboard:rw': ['clipboard', 'copy', 'paste', 'share'],
  'network:http': ['fetch', 'api', 'download', 'upload', 'weather', 'news', 'feed', 'rss', 'search online'],
};

// Active app capabilities: Map<appId, Set<capability>>
const appCaps = new Map();

// App storage: Map<appId, Map<key, value>>
const appStorage = new Map();

export function proposeCapabilities(prompt) {
  const lower = prompt.toLowerCase();
  const proposed = new Set(['ui:window']); // Always needed

  for (const [cap, keywords] of Object.entries(KEYWORD_MAP)) {
    if (keywords.some(kw => lower.includes(kw))) {
      proposed.add(cap);
    }
  }

  return [...proposed];
}

export function grantCapabilities(appId, capabilities) {
  const valid = capabilities.filter(c => CAPABILITY_TYPES.includes(c));
  appCaps.set(appId, new Set(valid));
  if (!appStorage.has(appId)) appStorage.set(appId, new Map());
  return valid;
}

export function checkCapability(appId, capability) {
  const caps = appCaps.get(appId);
  return caps ? caps.has(capability) : false;
}

export function revokeAll(appId) {
  appCaps.delete(appId);
  // Keep storage around for now — app might restart
}

export function getAppStorage(appId) {
  if (!appStorage.has(appId)) appStorage.set(appId, new Map());
  return appStorage.get(appId);
}

export function clearAppStorage(appId) {
  appStorage.delete(appId);
}

export function listCapabilityTypes() {
  return [...CAPABILITY_TYPES];
}
