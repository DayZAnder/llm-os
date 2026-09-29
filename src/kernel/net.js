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

/** Eight 16-bit groups of an IPv6 literal (handles :: and a dotted IPv4 tail), or null. */
function expandIPv6(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = s.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split('::');
  const parse = part => (part ? part.split(':').map(x => parseInt(x, 16)) : []);
  const hi = parse(head), lo = parse(tail);
  const groups = s.includes('::') ? [...hi, ...Array(8 - hi.length - lo.length).fill(0), ...lo] : hi;
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

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
    const h = expandIPv6(ip);
    if (!h) return true;
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    // Forms that embed an IPv4 address — check the embedded one. The URL
    // parser turns [::ffff:127.0.0.1] into [::ffff:7f00:1], so the dotted
    // form can't be relied on.
    if (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff) return isPrivateAddress(v4(h[6], h[7]));   // ::ffff:0:0/96 mapped
    if (h.slice(0, 6).every(x => x === 0)) return true;                                                  // ::, ::1, ::/96 compatible
    if (h[0] === 0x2002) return isPrivateAddress(v4(h[1], h[2]));                                        // 6to4
    if (h[0] === 0x2001 && h[1] === 0) return true;                                                      // Teredo
    if (h[0] === 0x64 && h[1] === 0xff9b) return true;                                                   // NAT64
    if (h[0] === 0x2001 && h[1] === 0xdb8) return true;                                                  // documentation
    return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 || (h[0] >> 8) === 0xff;
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
    // `timeout` only fires on idle sockets; a server trickling a byte every
    // few seconds would hold the request forever without an overall deadline.
    const deadline = setTimeout(() => req.destroy(new Error('Request timed out')), TIMEOUT_MS * 2);
    req.on('close', () => clearTimeout(deadline));
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
      const next = validateUrl(new URL(res.headers.location, url).toString());
      // Credentials the app meant for one site don't follow it to another
      if (next.origin !== url.origin) { delete cleanHeaders.authorization; delete cleanHeaders.cookie; }
      url = next;
      if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
        method = 'GET'; body = null; delete cleanHeaders['content-type'];
      }
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
