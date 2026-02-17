// Zero-dependency Docker Engine REST API client.
// Uses Node.js http module over Unix socket (Linux) or TCP (Windows).

import { request } from 'http';
import { existsSync } from 'fs';
import { platform } from 'os';

const UNIX_SOCKET = '/var/run/docker.sock';

function getConnectionOptions() {
  // Linux/Mac: Unix socket (default Docker)
  if (platform() !== 'win32' && existsSync(UNIX_SOCKET)) {
    return { socketPath: UNIX_SOCKET };
  }
  // Windows or custom: TCP via DOCKER_HOST env var
  const host = process.env.DOCKER_HOST || 'localhost:2375';
  const [hostname, port] = host.replace(/^tcp:\/\//, '').split(':');
  return { hostname, port: parseInt(port || '2375', 10) };
}

/**
 * Make a request to Docker Engine REST API.
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g., /containers/json)
 * @param {object|null} body - Request body (JSON-serialized)
 * @returns {Promise<any>} Parsed JSON response or raw string
 */
export function dockerRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const conn = getConnectionOptions();
    const options = {
      ...conn,
      method,
      path: `/v1.43${path}`,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    };

    const req = request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          reject(new Error(`Docker ${method} ${path}: ${res.statusCode} ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Docker connection failed: ${err.message}`));
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error('Docker request timed out'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Get a raw HTTP response stream from Docker (for logs).
 * @param {string} path - API path
 * @returns {Promise<import('http').IncomingMessage>}
 */
export function dockerStream(path) {
  return new Promise((resolve, reject) => {
    const conn = getConnectionOptions();
    const options = { ...conn, method: 'GET', path: `/v1.43${path}` };

    const req = request(options, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error(`Docker stream ${path}: ${res.statusCode}`)));
      } else {
        resolve(res);
      }
    });

    req.on('error', reject);
    req.end();
  });
}

/** Check if Docker daemon is reachable. */
export async function dockerPing() {
  try {
    const result = await dockerRequest('GET', '/_ping');
    return result === 'OK' || result === true;
  } catch {
    return false;
  }
}
