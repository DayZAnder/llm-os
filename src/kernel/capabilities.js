// Simple capability system — whitelist per app instance
// Phase 1: no crypto tokens, just in-memory maps

const CAPABILITY_TYPES = [
  // Iframe app capabilities
  'ui:window',
  'storage:local',
  'timer:basic',
  'clipboard:rw',
  'network:http',
  // Process app capabilities
  'process:background',
  'process:network',
  'process:volume',
  'api:anthropic',
];

// Keyword → capability mapping for auto-proposal
const KEYWORD_MAP = {
  'storage:local': ['save', 'store', 'persist', 'remember', 'todo', 'list', 'note', 'bookmark', 'favorite', 'history', 'data'],
  'timer:basic': ['timer', 'countdown', 'stopwatch', 'clock', 'pomodoro', 'interval', 'animation', 'tick', 'alarm', 'reminder'],
  'clipboard:rw': ['clipboard', 'copy', 'paste', 'share'],
  'network:http': ['fetch', 'api', 'download', 'upload', 'weather', 'news', 'feed', 'rss', 'search online'],
  'process:background': ['bot', 'daemon', 'service', 'worker', 'agent', 'background', 'long-running', 'server'],
  'process:network': ['whatsapp', 'telegram', 'discord', 'webhook', 'connect to', 'api call'],
  'process:volume': ['persist', 'database', 'sqlite', 'save files', 'data storage'],
  'api:anthropic': ['claude', 'anthropic', 'nanoclaw', 'ai agent', 'llm agent'],
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

// Process app keywords — if matched, route to Docker instead of iframe
const PROCESS_KEYWORDS = [
  'nanoclaw', 'run nanoclaw',
  'whatsapp bot', 'telegram bot', 'discord bot', 'slack bot',
  'background service', 'daemon', 'long-running',
  'docker', 'container', 'node.js server', 'api server',
  'webhook server', 'cron job', 'agent',
];

/**
 * Detect whether a prompt should produce a process app or iframe app.
 * @returns {'process'|'iframe'}
 */
export function inferAppType(prompt) {
  const lower = prompt.toLowerCase();
  if (PROCESS_KEYWORDS.some(kw => lower.includes(kw))) return 'process';
  return 'iframe';
}
