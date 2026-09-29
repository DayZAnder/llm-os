// HTTP request guard — protects the kernel API from other origins.
//
// The kernel listens on localhost, but any web page the user visits can still
// send requests to http://localhost:3000 (CSRF), and a hostile DNS name can be
// rebound to 127.0.0.1 (DNS rebinding). Without this guard, a random website
// could build and launch Docker containers through /api/process/*.
//
// Rules:
//   1. The Host header must name an allowed host (blocks DNS rebinding).
//   2. If an Origin header is present it must match the Host (blocks CSRF).
//      Sandboxed apps have origin "null" and are rejected too — they talk to
//      the kernel only through the shell's postMessage bridge.
//   3. Requests with a body must be application/json, which forces a CORS
//      preflight that we never answer (blocks "simple request" CSRF).

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

export function allowedHosts(env = process.env) {
  const extra = (env.LLMOS_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const bind = (env.HOST || '').toLowerCase();
  const hosts = new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
  // Binding to a concrete address implies that address is a legitimate Host
  if (bind && bind !== '0.0.0.0' && bind !== '::') hosts.add(bind);
  return hosts;
}

/**
 * Decide whether an API request may proceed.
 * @param {{ method: string, headers: object }} req
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkApiRequest(req, hosts = allowedHosts()) {
  const headers = req.headers || {};
  const host = headers.host || '';
  const hostname = hostnameOf(host);

  // "*" in LLMOS_ALLOWED_HOSTS disables the Host check (e.g. a VM reached by
  // LAN IP). The Origin and content-type checks below still apply.
  if (!hosts.has('*') && !hosts.has(hostname)) {
    return { ok: false, reason: `host not allowed: ${hostname || '(none)'}` };
  }

  const origin = headers.origin;
  if (origin !== undefined) {
    let originHost;
    try { originHost = new URL(origin).host.toLowerCase(); } catch { originHost = null; }
    if (!originHost || originHost !== host.toLowerCase()) {
      return { ok: false, reason: `cross-origin request from ${origin}` };
    }
  }

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const len = parseInt(headers['content-length'] || '0', 10);
    const hasBody = len > 0 || headers['transfer-encoding'];
    const ctype = (headers['content-type'] || '').toLowerCase();
    if (hasBody && !ctype.startsWith('application/json')) {
      return { ok: false, reason: 'request body must be application/json' };
    }
  }

  return { ok: true };
}
