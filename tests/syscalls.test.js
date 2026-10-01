// Tests for the OS syscall layer: HTTP guard, VFS, network proxy guards,
// sandbox capability enforcement, and gateway helpers.
// Run: node tests/syscalls.test.js

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkApiRequest, allowedHosts } from '../src/kernel/http-guard.js';
import * as vfs from '../src/kernel/vfs.js';
import { isPrivateAddress, validateUrl, request as netRequest } from '../src/kernel/net.js';
import { checkSyscall, SYSCALL_CAPS } from '../src/shell/sandbox.js';
import { extractManifest, extractModelHint, checkAiRateLimit, cleanResponse } from '../src/kernel/gateway.js';
import { listCapabilityTypes } from '../src/kernel/capabilities.js';

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

function throws(fn, name) {
  try { fn(); assert(false, name); } catch { assert(true, name); }
}

async function rejects(promise, name) {
  try { await promise; assert(false, name); } catch { assert(true, name); }
}

// --- HTTP guard ---
console.log('\nhttp-guard:');
const hosts = allowedHosts({});
const req = (headers, method = 'GET') => ({ method, headers });
assert(checkApiRequest(req({ host: 'localhost:3000' }), hosts).ok, 'same-host GET allowed');
assert(checkApiRequest(req({ host: '127.0.0.1:3000' }), hosts).ok, '127.0.0.1 allowed');
assert(!checkApiRequest(req({ host: 'evil.example:3000' }), hosts).ok, 'rebound hostname rejected');
assert(!checkApiRequest(req({}), hosts).ok, 'missing Host rejected');
assert(checkApiRequest(req({ host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json', 'content-length': '10' }, 'POST'), hosts).ok, 'same-origin JSON POST allowed');
assert(!checkApiRequest(req({ host: 'localhost:3000', origin: 'https://evil.example', 'content-type': 'application/json', 'content-length': '10' }, 'POST'), hosts).ok, 'cross-origin POST rejected');
assert(!checkApiRequest(req({ host: 'localhost:3000', origin: 'null' }, 'POST'), hosts).ok, 'sandboxed (null origin) rejected');
assert(!checkApiRequest(req({ host: 'localhost:3000', origin: 'http://localhost:5100' }, 'POST'), hosts).ok, 'process app on other port rejected');
assert(!checkApiRequest(req({ host: 'localhost:3000', 'content-type': 'text/plain', 'content-length': '5' }, 'POST'), hosts).ok, 'text/plain body rejected (CSRF simple request)');
assert(checkApiRequest(req({ host: 'localhost:3000' }, 'POST'), hosts).ok, 'bodyless POST allowed');
assert(checkApiRequest(req({ host: '192.168.1.50:3000' }), allowedHosts({ LLMOS_ALLOWED_HOSTS: '192.168.1.50' })).ok, 'LLMOS_ALLOWED_HOSTS extends list');
assert(checkApiRequest(req({ host: 'anything:3000' }), allowedHosts({ LLMOS_ALLOWED_HOSTS: '*' })).ok, 'wildcard disables host check');
assert(!checkApiRequest(req({ host: 'anything:3000', origin: 'http://other:3000' }), allowedHosts({ LLMOS_ALLOWED_HOSTS: '*' })).ok, 'wildcard still checks origin');

// --- VFS ---
console.log('\nvfs:');
const tmp = mkdtempSync(join(tmpdir(), 'llmos-vfs-'));
vfs.setRoot(tmp);
assert(vfs.normalizePath('/a//b/./c') === '/a/b/c', 'normalizes slashes and dots');
throws(() => vfs.normalizePath('/a/../../etc/passwd'), 'rejects ..');
throws(() => vfs.normalizePath('C:/Windows'), 'rejects drive letters');
throws(() => vfs.normalizePath('/a\\b'), 'rejects backslashes');
throws(() => vfs.normalizePath('/a\0b'), 'rejects NUL');
throws(() => vfs.normalizePath('/a\nb'), 'rejects control characters');
if (process.platform === 'win32') {
  throws(() => vfs.normalizePath('/a.txt:hidden'), 'rejects NTFS alternate data streams');
  throws(() => vfs.normalizePath('/docs/CON'), 'rejects reserved device names');
}
vfs.write('/notes/todo.md', '# hi');
assert(vfs.read('/notes/todo.md') === '# hi', 'write then read');
assert(vfs.stat('/notes/todo.md').mime === 'text/markdown', 'stat reports mime');
assert(vfs.stat('/nope') === null, 'stat of missing file is null');
const listing = vfs.list('/');
assert(listing.length === 1 && listing[0].type === 'dir' && listing[0].path === '/notes', 'list shows directory');
assert(vfs.list('/notes')[0].name === 'todo.md', 'list shows file');
vfs.write('/notes/todo.md', 'v2');
assert(vfs.read('/notes/todo.md') === 'v2', 'overwrite works');
throws(() => vfs.write('/', 'x'), 'cannot write root');
throws(() => vfs.remove('/'), 'cannot remove root');
assert(vfs.remove('/notes') === true, 'remove directory');
assert(!existsSync(join(tmp, 'notes')), 'directory gone from disk');
throws(() => vfs.read('/missing.txt'), 'read missing throws');
rmSync(tmp, { recursive: true, force: true });

// --- Network guards ---
console.log('\nnet:');
for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101', '::ffff:a9fe:a9fe', '::7f00:1', '2002:7f00:1::1', '2001::1', 'fec0::1']) {
  assert(isPrivateAddress(ip), `${ip} is private`);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808', '2002:808:808::1']) {
  assert(!isPrivateAddress(ip), `${ip} is public`);
}
throws(() => validateUrl('file:///etc/passwd'), 'file:// rejected');
throws(() => validateUrl('http://127.0.0.1/'), 'loopback literal rejected');
throws(() => validateUrl('http://[::1]:3000/'), 'IPv6 loopback literal rejected');
throws(() => validateUrl('http://[::ffff:127.0.0.1]:11434/api/tags'), 'IPv4-mapped loopback rejected (URL parser rewrites it to hex)');
throws(() => validateUrl('http://localhost:3000/api/grant'), 'localhost name rejected');
throws(() => validateUrl('https://user:pw@example.com/'), 'credentials in URL rejected');
assert(validateUrl('https://example.com/a?b=1').hostname === 'example.com', 'public URL accepted');
await rejects(netRequest({ url: 'http://169.254.169.254/latest/meta-data' }), 'metadata endpoint blocked');
await rejects(netRequest({ url: 'https://example.com', method: 'CONNECT' }), 'CONNECT method blocked');

// --- Sandbox capability enforcement ---
console.log('\nsandbox syscalls:');
assert(checkSyscall('storage:get', ['ui:window']) !== null, 'storage denied without storage:local');
assert(checkSyscall('storage:get', ['storage:local']) === null, 'storage allowed with storage:local');
assert(checkSyscall('fs:write', ['fs:read']) !== null, 'fs:write denied with only fs:read');
assert(checkSyscall('fs:read', ['fs:read']) === null, 'fs:read allowed');
assert(checkSyscall('net:request', []) !== null, 'net denied by default');
assert(checkSyscall('ai:complete', ['ai:generate']) === null, 'ai allowed with ai:generate');
assert(checkSyscall('notify', []) === null, 'notify always allowed');
assert(checkSyscall('os:open', []) !== null && checkSyscall('os:open', ['fs:read']) === null, 'os:open needs fs:read (opening a file means reading it)');
assert(checkSyscall('__proto__', ['ui:window']) !== null, 'prototype keys are unknown calls');
assert(checkSyscall('kernel:shutdown', ['ui:window']) !== null, 'unknown call rejected');
const known = new Set(listCapabilityTypes());
assert(Object.values(SYSCALL_CAPS).filter(Boolean).every(c => known.has(c)), 'every syscall capability is a grantable capability type');

// --- Gateway helpers ---
console.log('\ngateway helpers:');
const m = extractManifest('<!-- capabilities: ["ui:window"] -->\n<!-- app: {"name": "CSV Viewer", "icon": "📊", "handles": [".CSV", "text/csv", "bad handle!", 5]} -->');
assert(m.name === 'CSV Viewer' && m.icon === '📊', 'manifest name/icon parsed');
assert(m.handles.length === 2 && m.handles[0] === '.csv' && m.handles[1] === 'text/csv', 'manifest handles sanitized + lowercased');
assert(extractManifest('<html></html>').name === '', 'missing manifest → empty');
assert(extractManifest('<!-- app: {"name": "<script>x</script>"} -->').name.includes('<') === false, 'manifest strips angle brackets');
assert(extractModelHint('make a notes app using opus 5.5')?.model === 'claude-opus-5-5', '"opus 5.5" hint → claude-opus-5-5');
assert(extractModelHint('make a notes app with fable')?.model === 'claude-fable-5-1', '"fable" hint → claude-fable-5-1');
assert(extractModelHint('make a notes app using opus')?.model === 'claude-opus-5', '"opus" hint → claude-opus-5');
const doc = '<!-- capabilities: ["ui:window", "fs:read"] -->\n<!-- app: {"name": "X"} -->\n<!DOCTYPE html><html><body>x</body></html>';
assert(cleanResponse(doc) === doc, 'cleanResponse keeps header comments before <!DOCTYPE');
assert(cleanResponse('Here is your app:\n' + doc) === doc, 'cleanResponse strips chatter but keeps headers');
assert(cleanResponse('```html\n' + doc + '\n```') === doc, 'cleanResponse strips code fences');
assert(cleanResponse('Sure!\n<!DOCTYPE html><html></html>') === '<!DOCTYPE html><html></html>', 'cleanResponse without headers starts at doctype');
let allowed = 0;
for (let i = 0; i < 25; i++) if (checkAiRateLimit('rate-test', 1000 + i)) allowed++;
assert(allowed === 20, 'AI syscall rate limit caps at 20/min');
assert(checkAiRateLimit('rate-test', 1000 + 61000), 'rate limit window slides');
assert(checkAiRateLimit('other-app', 1000), 'rate limit is per app');

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
