// Network proxy for apps holding the network:http capability.
//
// Sandboxed apps cannot reach the network directly (CSP connect-src 'none').
// This proxy is their only way out, and it refuses to become an SSRF tool:
// every resolved address is checked *at connect time* (via a custom DNS
// lookup), so neither a hostile DNS answer nor a redirect can steer a request
// into localhost, the LAN, or cloud metadata endpoints.

import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
// Headers an app may set. Cookies/auth to arbitrary hosts are fine (the app
// supplies them itself), but hop-by-hop and host-steering headers are not.
const BLOCKED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization']);

/** True if an IP literal is loopback, private, link-local, CGNAT, multicast or otherwise non-public. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||     // CGNAT
      (a === 169 && b === 254) ||               // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||                 // 192.0.0.0/24, 192.0.2.0/24
      (a === 198 && (b === 18 || b === 19)) ||  // benchmarking
      a >= 224;                                 // multicast + reserved
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower) || lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8');
  }
  return true; // not an IP at all → refuse
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const bad = list.find(a => isPrivateAddress(a.address));
    if (bad) return callback(new Error(`Blocked: ${hostname} resolves to non-public address ${bad.address}`));
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export function validateUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in URL are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`Blocked: ${host} is a non-public address`);
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error(`Blocked host: ${host}`);
  return url;
}

function once(url, { method, headers, body }) {
  return new Promise((resolvePromise, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method, headers, lookup: safeLookup, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolvePromise({ res, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Perform an HTTP request on behalf of an app.
 * @param {{ url: string, method?: string, headers?: object, body?: string }} opts
 * @returns {Promise<{ status, statusText, headers, url, body, encoding }>}
 */
export async function request({ url: rawUrl, method = 'GET', headers = {}, body = null }) {
  method = String(method).toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new Error(`Method not allowed: ${method}`);
  if (body != null && typeof body !== 'string') body = JSON.stringify(body);

  const cleanHeaders = { 'user-agent': 'LLM-OS/1.0' };
  for (const [k, v] of Object.entries(headers || {})) {
    if (!BLOCKED_REQUEST_HEADERS.has(k.toLowerCase())) cleanHeaders[k.toLowerCase()] = String(v);
  }

  let url = validateUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { res, buf } = await once(url, { method, headers: cleanHeaders, body });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      url = validateUrl(new URL(res.headers.location, url).toString());
      if (res.statusCode === 303) { method = 'GET'; body = null; }
      continue;
    }
    const ctype = res.headers['content-type'] || '';
    const isText = /^(text\/|application\/(json|xml|javascript|rss\+xml|atom\+xml|.*\+json))/i.test(ctype) || ctype === '';
    return {
      status: res.statusCode,
      statusText: res.statusMessage,
      headers: { 'content-type': ctype, 'last-modified': res.headers['last-modified'] || null },
      url: url.toString(),
      body: isText ? buf.toString('utf-8') : buf.toString('base64'),
      encoding: isText ? 'utf-8' : 'base64',
    };
  }
  throw new Error('Too many redirects');
}
