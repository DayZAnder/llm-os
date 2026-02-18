// SSH Client — known app template
// Web-based SSH terminal. Launches as a Docker process app with xterm.js + ssh2.

export const SSH_CLIENT = {
  name: 'SSH Client',
  type: 'process',
  description: 'Web-based SSH terminal client with xterm.js',
  capabilities: [
    'process:network',
  ],
  dockerfile: `FROM node:22-slim

WORKDIR /app

RUN echo '{"private":true,"dependencies":{"ws":"^8","ssh2":"^1","xterm":"4.19.0","xterm-addon-fit":"0.5.0"}}' > package.json \\
    && npm install --production

COPY index.js .

RUN groupadd -r sshclient && useradd -r -g sshclient sshclient \\
    && chown -R sshclient:sshclient /app

USER sshclient

EXPOSE 3001

CMD ["node", "index.js"]`,
  code: `const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');

const PORT = parseInt(process.env.PORT || '3001', 10);

// Resolve xterm assets from node_modules
const XTERM_CSS = path.join(__dirname, 'node_modules/xterm/css/xterm.css');
const XTERM_JS = path.join(__dirname, 'node_modules/xterm/lib/xterm.js');
const FIT_JS = path.join(__dirname, 'node_modules/xterm-addon-fit/lib/xterm-addon-fit.js');

const HTML = \`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>SSH Client</title>
<link rel="stylesheet" href="/xterm.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; height: 100vh; display: flex; flex-direction: column; }
  #connect-panel { padding: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; }
  #connect-panel h1 { font-size: 24px; margin-bottom: 20px; color: #6c63ff; }
  .form-row { display: flex; gap: 8px; margin-bottom: 12px; width: 100%; max-width: 420px; }
  .form-row input { flex: 1; background: #2a2a4a; border: 1px solid #3a3a5a; border-radius: 6px; padding: 10px 14px; color: #e0e0e0; font-size: 14px; }
  .form-row input:focus { outline: none; border-color: #6c63ff; }
  .form-row input::placeholder { color: #666; }
  #connect-btn { background: #6c63ff; color: white; border: none; border-radius: 6px; padding: 12px 32px; font-size: 14px; cursor: pointer; margin-top: 8px; }
  #connect-btn:hover { background: #7b73ff; }
  #connect-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .error { color: #ff4757; margin-top: 12px; font-size: 13px; max-width: 420px; text-align: center; }
  #terminal-panel { display: none; flex: 1; position: relative; }
  #terminal-container { position: absolute; inset: 0; }
  #toolbar { position: absolute; top: 8px; right: 16px; z-index: 10; }
  #toolbar button { background: rgba(42,42,74,0.8); border: 1px solid #3a3a5a; color: #aaa; border-radius: 4px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
  #toolbar button:hover { background: #3a3a5a; color: #fff; }
  .hint { color: #666; font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
<div id="connect-panel">
  <h1>SSH Client</h1>
  <div class="form-row">
    <input id="host" placeholder="Host" autofocus>
    <input id="port" placeholder="Port" value="22" style="max-width:80px">
  </div>
  <div class="form-row">
    <input id="username" placeholder="Username">
  </div>
  <div class="form-row">
    <input id="password" type="password" placeholder="Password">
  </div>
  <button id="connect-btn">Connect</button>
  <div class="error" id="error"></div>
  <div class="hint">Connects via SSH protocol (port 22)</div>
</div>

<div id="terminal-panel">
  <div id="toolbar"><button id="disconnect-btn">Disconnect</button></div>
  <div id="terminal-container"></div>
</div>

<script src="/xterm.js"><\\/script>
<script src="/fit.js"><\\/script>
<script>
let ws, term, fitAddon;

function connect() {
  const host = document.getElementById('host').value.trim();
  const port = parseInt(document.getElementById('port').value) || 22;
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('error');
  const btn = document.getElementById('connect-btn');

  if (!host || !username) { errorEl.textContent = 'Host and username are required'; return; }

  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'connect', host, port, username, password }));
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'ready') {
      showTerminal();
    } else if (msg.type === 'data') {
      term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
    } else if (msg.type === 'error') {
      if (term) { term.write('\\\\r\\\\n\\\\x1b[31m' + msg.message + '\\\\x1b[0m\\\\r\\\\n'); }
      else { errorEl.textContent = msg.message; btn.disabled = false; btn.textContent = 'Connect'; }
    } else if (msg.type === 'close') {
      if (term) term.write('\\\\r\\\\n\\\\x1b[33mConnection closed.\\\\x1b[0m\\\\r\\\\n');
    }
  };

  ws.onclose = () => {
    if (!term) { btn.disabled = false; btn.textContent = 'Connect'; }
  };

  ws.onerror = () => {
    errorEl.textContent = 'WebSocket connection failed';
    btn.disabled = false;
    btn.textContent = 'Connect';
  };
}

function showTerminal() {
  document.getElementById('connect-panel').style.display = 'none';
  const tp = document.getElementById('terminal-panel');
  tp.style.display = 'flex';

  term = new Terminal({
    cursorBlink: true,
    theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#6c63ff' },
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal-container'));
  setTimeout(() => { fitAddon.fit(); }, 50);
  term.focus();

  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));

  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: btoa(data) }));
    }
  });

  window.addEventListener('resize', () => {
    fitAddon.fit();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  });
}

function disconnect() {
  if (ws) ws.close();
  document.getElementById('terminal-panel').style.display = 'none';
  document.getElementById('connect-panel').style.display = 'flex';
  document.getElementById('connect-btn').disabled = false;
  document.getElementById('connect-btn').textContent = 'Connect';
  if (term) { term.dispose(); term = null; fitAddon = null; }
}

// Wire up buttons and Enter key
document.getElementById('connect-btn').onclick = connect;
document.getElementById('disconnect-btn').onclick = disconnect;
document.querySelectorAll('#connect-panel input').forEach(el => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
});
<\\/script>
</body>
</html>\`;

// --- HTTP server ---

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HTML);
  }
  const statics = {
    '/xterm.css': { file: XTERM_CSS, type: 'text/css' },
    '/xterm.js': { file: XTERM_JS, type: 'application/javascript' },
    '/fit.js': { file: FIT_JS, type: 'application/javascript' },
  };
  if (statics[req.url]) {
    const s = statics[req.url];
    try {
      res.writeHead(200, { 'Content-Type': s.type, 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(s.file));
    } catch {
      res.writeHead(404);
      return res.end('Not Found');
    }
  }
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', connections: wss.clients.size }));
  }
  res.writeHead(404);
  res.end('Not Found');
});

// --- WebSocket SSH bridge ---

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let sshClient = null;
  let stream = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'connect' && !sshClient) {
      sshClient = new Client();

      sshClient.on('ready', () => {
        sshClient.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, sh) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
            sshClient.end();
            sshClient = null;
            return;
          }
          stream = sh;
          ws.send(JSON.stringify({ type: 'ready' }));

          stream.on('data', (data) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
          });

          stream.stderr.on('data', (data) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
          });

          stream.on('close', () => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'close' }));
            ws.close();
          });
        });
      });

      sshClient.on('error', (err) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: err.message }));
        sshClient = null;
      });

      sshClient.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        // Auto-respond with password for keyboard-interactive auth
        finish([msg.password || '']);
      });

      sshClient.connect({
        host: msg.host,
        port: msg.port || 22,
        username: msg.username,
        password: msg.password,
        tryKeyboard: true,
        readyTimeout: 10000,
      });
    }

    if (msg.type === 'input' && stream) {
      stream.write(Buffer.from(msg.data, 'base64'));
    }

    if (msg.type === 'resize' && stream) {
      stream.setWindow(msg.rows, msg.cols, 0, 0);
    }
  });

  ws.on('close', () => {
    if (stream) try { stream.close(); } catch {}
    if (sshClient) try { sshClient.end(); } catch {}
    stream = null;
    sshClient = null;
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('SSH Client running on http://0.0.0.0:' + PORT);
});`,
  containerConfig: {
    port: 3001,
    title: 'SSH Client',
    env: [],
  },
  setupInstructions: 'Open the app and enter the SSH host, username, and password to connect.',
};
