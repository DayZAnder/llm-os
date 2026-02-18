// Capability system — per-app whitelist + HMAC-SHA256 signed tokens
// Tokens are unforgeable proof that the kernel granted a specific capability.
// Key rotates each session; tokens expire after 4 hours.

import { timingSafeEqual, randomBytes } from 'crypto';

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

// --- Crypto token state ---
let _hmacKey = null;                    // CryptoKey (HMAC-SHA256)
const revocationSet = new Set();        // revoked nonces
const appTokenMap = new Map();          // appId → tokenString[]

const TOKEN_TTL_SECONDS = 4 * 60 * 60; // 4 hours

// Pre-computed header (constant, same for all tokens)
const HEADER_B64 = base64url(JSON.stringify({ alg: 'HS256', typ: 'LLMOS-CAP' }));

// --- Base64url helpers ---

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const padded = str + '==='.slice((str.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// --- Token key lifecycle ---

/**
 * Generate the session HMAC key. Must be called once at startup
 * before any grantCapabilities() call.
 */
export async function initTokenKey() {
  _hmacKey = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false, // not extractable
    ['sign', 'verify']
  );
}

// --- Token signing (internal) ---

async function signToken(appId, cap, expOverride) {
  if (!_hmacKey) throw new Error('Token key not initialized. Call initTokenKey() at startup.');

  const nonce = randomBytes(16).toString('hex');
  const exp = expOverride ?? (Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS);
  const payload = { appId, cap, scope: {}, exp, nonce };

  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${HEADER_B64}.${payloadB64}`;

  const sigBytes = await crypto.subtle.sign(
    'HMAC',
    _hmacKey,
    Buffer.from(signingInput)
  );

  return `${signingInput}.${base64url(Buffer.from(sigBytes))}`;
}

// Exposed for testing expired tokens only
export async function _signTokenWithExpiry(appId, cap, exp) {
  return signToken(appId, cap, exp);
}

// --- Token verification ---

/**
 * Verify a capability token. Constant-time signature comparison.
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
export async function verifyToken(tokenStr) {
  if (!_hmacKey) return { valid: false, error: 'no_key' };
  if (typeof tokenStr !== 'string') return { valid: false, error: 'malformed' };

  const parts = tokenStr.split('.');
  if (parts.length !== 3) return { valid: false, error: 'malformed' };

  const [headerB64, payloadB64, sigB64] = parts;

  // Recompute HMAC over header.payload
  const signingInput = `${headerB64}.${payloadB64}`;
  let expectedSig;
  try {
    expectedSig = Buffer.from(await crypto.subtle.sign('HMAC', _hmacKey, Buffer.from(signingInput)));
  } catch {
    return { valid: false, error: 'sign_failed' };
  }

  let actualSig;
  try {
    actualSig = Buffer.from(base64urlDecode(sigB64));
  } catch {
    return { valid: false, error: 'invalid_signature' };
  }

  // Constant-time comparison
  if (actualSig.length !== expectedSig.length) {
    return { valid: false, error: 'invalid_signature' };
  }
  if (!timingSafeEqual(actualSig, expectedSig)) {
    return { valid: false, error: 'invalid_signature' };
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));
  } catch {
    return { valid: false, error: 'invalid_payload' };
  }

  // Check expiry
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    return { valid: false, error: 'expired' };
  }

  // Check revocation
  if (revocationSet.has(payload.nonce)) {
    return { valid: false, error: 'revoked' };
  }

  return { valid: true, payload };
}

// --- Token revocation ---

/**
 * Revoke a single token by extracting its nonce.
 */
export function revokeToken(tokenStr) {
  try {
    const [, payloadB64] = tokenStr.split('.');
    const payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));
    if (payload.nonce) revocationSet.add(payload.nonce);
  } catch { /* best-effort */ }
}

// --- Existing API (preserved) ---

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

/**
 * Grant capabilities to an app and sign tokens for each.
 * @returns {{ capabilities: string[], tokens: Object<string, string> }}
 */
export async function grantCapabilities(appId, capabilities) {
  const valid = capabilities.filter(c => CAPABILITY_TYPES.includes(c));
  appCaps.set(appId, new Set(valid));
  if (!appStorage.has(appId)) appStorage.set(appId, new Map());

  // Sign a token for each valid capability
  const tokens = {};
  const tokenList = [];
  for (const cap of valid) {
    const token = await signToken(appId, cap);
    tokens[cap] = token;
    tokenList.push(token);
  }
  appTokenMap.set(appId, tokenList);

  return { capabilities: valid, tokens };
}

export function checkCapability(appId, capability) {
  const caps = appCaps.get(appId);
  return caps ? caps.has(capability) : false;
}

export function revokeAll(appId) {
  appCaps.delete(appId);
  // Revoke all issued tokens for this app
  const tokens = appTokenMap.get(appId) || [];
  for (const tokenStr of tokens) {
    revokeToken(tokenStr);
  }
  appTokenMap.delete(appId);
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
