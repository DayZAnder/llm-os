// Tests for cryptographic capability tokens — HMAC-SHA256 signing, verification, revocation
// Run: node tests/capabilities.test.js

import {
  initTokenKey,
  grantCapabilities,
  checkCapability,
  verifyToken,
  revokeToken,
  revokeAll,
  proposeCapabilities,
  listCapabilityTypes,
  inferAppType,
  _signTokenWithExpiry,
} from '../src/kernel/capabilities.js';

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}`);
  }
}

function assertEq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name} — expected ${b}, got ${a}`);
  }
}

// =====================================================================
// Tests
// =====================================================================

// --- initTokenKey ---
console.log('\ninitTokenKey:');

await initTokenKey();
assert(true, 'initTokenKey resolves without error');

// --- grantCapabilities (async) ---
console.log('\ngrantCapabilities:');

{
  const result = await grantCapabilities('test-app-1', ['storage:local', 'ui:window', 'invalid:cap']);
  assertEq(result.capabilities, ['storage:local', 'ui:window'], 'filters invalid caps');
  assert(typeof result.tokens === 'object', 'returns tokens object');
  assert('storage:local' in result.tokens, 'token issued for storage:local');
  assert('ui:window' in result.tokens, 'token issued for ui:window');
  assert(!('invalid:cap' in result.tokens), 'no token for invalid cap');
  assert(typeof result.tokens['storage:local'] === 'string', 'token is a string');
  assert(result.tokens['storage:local'].split('.').length === 3, 'token has 3 parts (header.payload.sig)');
}

// --- checkCapability still works sync ---
console.log('\ncheckCapability (sync, backward compat):');

{
  assert(checkCapability('test-app-1', 'storage:local'), 'granted cap returns true');
  assert(checkCapability('test-app-1', 'ui:window'), 'second granted cap returns true');
  assert(!checkCapability('test-app-1', 'network:http'), 'unganted cap returns false');
  assert(!checkCapability('nonexistent-app', 'ui:window'), 'unknown app returns false');
}

// --- verifyToken: valid ---
console.log('\nverifyToken — valid token:');

{
  const result = await grantCapabilities('test-verify', ['storage:local', 'timer:basic']);
  const token = result.tokens['storage:local'];
  const v = await verifyToken(token);

  assert(v.valid, 'valid token verifies');
  assertEq(v.payload.appId, 'test-verify', 'payload has correct appId');
  assertEq(v.payload.cap, 'storage:local', 'payload has correct capability');
  assert(typeof v.payload.nonce === 'string', 'payload has nonce');
  assert(v.payload.nonce.length === 32, 'nonce is 32 hex chars (16 bytes)');
  assert(typeof v.payload.exp === 'number', 'payload has expiry');
  assert(v.payload.exp > Math.floor(Date.now() / 1000), 'expiry is in the future');
}

// --- verifyToken: tampered payload ---
console.log('\nverifyToken — tampered payload:');

{
  const result = await grantCapabilities('test-tamper', ['ui:window']);
  const token = result.tokens['ui:window'];
  const [h, , s] = token.split('.');

  // Build a fake payload claiming a different capability
  const fakePayload = btoa(JSON.stringify({ appId: 'test-tamper', cap: 'api:anthropic', exp: 9999999999, nonce: 'fake' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tampered = `${h}.${fakePayload}.${s}`;
  const v = await verifyToken(tampered);

  assert(!v.valid, 'tampered payload rejected');
  assertEq(v.error, 'invalid_signature', 'error is invalid_signature');
}

// --- verifyToken: tampered signature ---
console.log('\nverifyToken — tampered signature:');

{
  const result = await grantCapabilities('test-sig', ['ui:window']);
  const token = result.tokens['ui:window'];
  // Flip last 4 characters of signature
  const tampered = token.slice(0, -4) + 'AAAA';
  const v = await verifyToken(tampered);

  assert(!v.valid, 'tampered signature rejected');
  assertEq(v.error, 'invalid_signature', 'error is invalid_signature');
}

// --- verifyToken: expired ---
console.log('\nverifyToken — expired token:');

{
  // Sign a token with expiry 1 second in the past
  const token = await _signTokenWithExpiry('test-expired', 'ui:window', Math.floor(Date.now() / 1000) - 1);
  const v = await verifyToken(token);

  assert(!v.valid, 'expired token rejected');
  assertEq(v.error, 'expired', 'error is expired');
}

// --- revokeToken ---
console.log('\nrevokeToken:');

{
  const result = await grantCapabilities('test-revoke', ['storage:local', 'timer:basic']);
  const storageToken = result.tokens['storage:local'];
  const timerToken = result.tokens['timer:basic'];

  // Revoke only the storage token
  revokeToken(storageToken);

  const v1 = await verifyToken(storageToken);
  assert(!v1.valid, 'revoked token is rejected');
  assertEq(v1.error, 'revoked', 'error is revoked');

  // Timer token should still be valid
  const v2 = await verifyToken(timerToken);
  assert(v2.valid, 'non-revoked sibling token still valid');
}

// --- revokeAll ---
console.log('\nrevokeAll:');

{
  const result = await grantCapabilities('test-revoke-all', ['ui:window', 'timer:basic']);
  const token1 = result.tokens['ui:window'];
  const token2 = result.tokens['timer:basic'];

  revokeAll('test-revoke-all');

  assert(!checkCapability('test-revoke-all', 'ui:window'), 'checkCapability false after revokeAll');
  assert(!checkCapability('test-revoke-all', 'timer:basic'), 'second cap also revoked');

  const v1 = await verifyToken(token1);
  assert(!v1.valid, 'first token invalid after revokeAll');

  const v2 = await verifyToken(token2);
  assert(!v2.valid, 'second token invalid after revokeAll');
}

// --- forgery: arbitrary token ---
console.log('\nForgery resistance:');

{
  const fakeHeader = btoa('{"alg":"HS256","typ":"LLMOS-CAP"}').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fakePayload = btoa('{"appId":"evil","cap":"api:anthropic","exp":9999999999,"nonce":"forged123456789a"}').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fakeSig = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const forged = `${fakeHeader}.${fakePayload}.${fakeSig}`;

  const v = await verifyToken(forged);
  assert(!v.valid, 'forged token rejected');
  assertEq(v.error, 'invalid_signature', 'error is invalid_signature');
}

// --- malformed tokens ---
console.log('\nMalformed tokens:');

{
  const v1 = await verifyToken('not-a-token');
  assert(!v1.valid, 'single-part string rejected');
  assertEq(v1.error, 'malformed', 'error is malformed');

  const v2 = await verifyToken('a.b.c.d');
  assert(!v2.valid, 'four-part string rejected');
  assertEq(v2.error, 'malformed', 'error is malformed');

  const v3 = await verifyToken('');
  assert(!v3.valid, 'empty string rejected');

  const v4 = await verifyToken(null);
  assert(!v4.valid, 'null rejected');

  const v5 = await verifyToken(undefined);
  assert(!v5.valid, 'undefined rejected');

  const v6 = await verifyToken(42);
  assert(!v6.valid, 'number rejected');
}

// --- unique nonces ---
console.log('\nNonce uniqueness:');

{
  const result = await grantCapabilities('test-nonces', ['ui:window', 'storage:local']);
  const t1 = result.tokens['ui:window'];
  const t2 = result.tokens['storage:local'];

  const v1 = await verifyToken(t1);
  const v2 = await verifyToken(t2);

  assert(v1.payload.nonce !== v2.payload.nonce, 'different capabilities get different nonces');

  // Same app, second grant
  const result2 = await grantCapabilities('test-nonces-2', ['ui:window']);
  const t3 = result2.tokens['ui:window'];
  const v3 = await verifyToken(t3);

  assert(v1.payload.nonce !== v3.payload.nonce, 'different apps get different nonces');
}

// --- backward compat: other exports unchanged ---
console.log('\nBackward compatibility:');

{
  const proposed = proposeCapabilities('make me a timer app that can save data');
  assert(proposed.includes('timer:basic'), 'proposeCapabilities detects timer');
  assert(proposed.includes('storage:local'), 'proposeCapabilities detects storage');
  assert(proposed.includes('ui:window'), 'proposeCapabilities always includes ui:window');

  const types = listCapabilityTypes();
  assert(types.includes('storage:local'), 'listCapabilityTypes includes storage:local');
  assert(types.includes('network:http'), 'listCapabilityTypes includes network:http');

  assertEq(inferAppType('run nanoclaw agent'), 'process', 'inferAppType detects process');
  assertEq(inferAppType('make me a calculator'), 'iframe', 'inferAppType defaults to iframe');
}

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
