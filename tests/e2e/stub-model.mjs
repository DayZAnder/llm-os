// OpenAI-compatible model stub for end-to-end tests of the VM images.
//
// The VM's .env points PRIMARY_PROVIDER=openai at this server, so the full
// pipeline runs — generation, streaming, analyzer, approval, sandbox — with a
// known answer and without API keys or cost.
//
//   node tests/e2e/stub-model.mjs [port] [host]     (default 3999 0.0.0.0)
//
// Any request returns E2E_APP, streamed in small chunks when stream:true.

import { createServer } from 'http';

const PORT = Number(process.argv[2] || 3999);
const HOST = process.argv[3] || '0.0.0.0';

// A small app that exercises the SDK the way real ones do: shared files,
// opening a file in its handler app, and a call it has no permission for.
export const E2E_APP = `<!DOCTYPE html>
<!-- app: {"name": "E2E Notes", "icon": "🧪", "handles": []} -->
<!-- capabilities: ["ui:window", "fs:read", "fs:write"] -->
<html><head><style>
  body { font-family: var(--llmos-font, sans-serif); background: var(--llmos-bg); color: var(--llmos-fg); padding: 16px; }
  button { margin: 4px; padding: 8px 12px; }
  #out { white-space: pre-wrap; margin-top: 12px; }
</style></head><body>
<h1 id="title">E2E Notes</h1>
<button id="save">Save note</button>
<button id="open">Open note</button>
<button id="net">Try network</button>
<div id="out">ready</div>
<script>
  const out = document.getElementById('out');
  const show = (t) => { out.textContent = t; };
  document.getElementById('save').onclick = async () => {
    try {
      await LLMOS.fs.write('/e2e/note.txt', 'written by the e2e app');
      const list = await LLMOS.fs.list('/e2e');
      show('saved: ' + list.map(f => f.name).join(','));
    } catch (e) { show('save failed: ' + e.message); }
  };
  document.getElementById('open').onclick = async () => {
    try { const r = await LLMOS.os.open('/e2e/note.txt'); show('opened: ' + JSON.stringify(r)); }
    catch (e) { show('open failed: ' + e.message); }
  };
  document.getElementById('net').onclick = async () => {
    try { await LLMOS.net.request({ url: 'https://example.com/' }); show('net: allowed'); }
    catch (e) { show('net denied: ' + e.message); }
  };
</script>
</body></html>`;

const requests = [];

createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    if (req.url === '/log') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(requests)); return; }
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch {}
    requests.push({ url: req.url, stream: !!data.stream, at: Date.now() });
    const content = E2E_APP;
    if (!data.stream) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: content.length / 4 | 0 },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < content.length; i += 80) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 80) } }] })}\n\n`);
      await new Promise(r => setTimeout(r, 5));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}).listen(PORT, HOST, () => console.log(`e2e model stub on ${HOST}:${PORT}`));
