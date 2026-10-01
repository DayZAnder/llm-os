// Boot report — what's running, what isn't, and what to do about it.
//
// One list of services for every surface: the shell's boot splash and
// /status, the VM text console (systemd-style lines) and later the native
// renderer. Services are described by what the user can do with them, and
// every problem comes with a concrete fix.
//
// Statuses: ok · warn (works with limits, needs attention) · error (broken)
// · off (unavailable by design in this setup — shown, never alarming).

import { statfsSync, accessSync, constants, readFileSync, existsSync } from 'fs';
import { DATA_DIR } from './paths.js';

/** Run one check, time it, and never let it throw. */
async function timed(id, name, fn) {
  const start = Date.now();
  try {
    const r = await fn();
    return { id, name, ...r, ms: Date.now() - start };
  } catch (err) {
    return { id, name, status: 'error', detail: err.message, ms: Date.now() - start };
  }
}

function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

/** Which mount holds the data directory (Linux only). */
function dataMount() {
  if (!existsSync('/proc/mounts')) return null;
  const mounts = readFileSync('/proc/mounts', 'utf-8').split('\n').map(l => l.split(' ')).filter(p => p.length > 2);
  const best = mounts
    .filter(([, mp]) => DATA_DIR === mp || DATA_DIR.startsWith(mp.endsWith('/') ? mp : mp + '/'))
    .sort((a, b) => b[1].length - a[1].length)[0];
  return best ? { device: best[0], mountpoint: best[1] } : null;
}

export function checkData() {
  accessSync(DATA_DIR, constants.W_OK);
  const st = statfsSync(DATA_DIR);
  const free = st.bavail * st.bsize;
  const m = dataMount();
  const onOwnDisk = m && m.mountpoint === DATA_DIR;
  const where = m ? (onOwnDisk ? `data disk ${m.device}` : 'system disk') : DATA_DIR;
  if (free < 200e6) {
    return { status: 'warn', detail: `${where} · only ${fmtBytes(free)} free`, fix: 'Free up space, or attach a larger data disk (see llmos-data-move).' };
  }
  const result = { status: 'ok', detail: `${where} · ${fmtBytes(free)} free` };
  // On a VM, data on the system disk is lost when the OS disk is replaced
  if (m && !onOwnDisk && DATA_DIR.startsWith('/var/lib/llmos')) {
    result.status = 'warn';
    result.fix = 'Attach llmos-data.qcow2 from the release as a second disk so upgrades keep your data.';
  }
  return result;
}

/** Fold the data-format check (kernel/migrations.js) into the data line. */
export function withDataFormat(result, m) {
  if (!m) return result;
  if (m.status === 'newer') {
    return {
      status: 'warn',
      detail: `${result.detail} · written by a newer LLM OS${m.writtenBy ? ` (${m.writtenBy})` : ''}`,
      fix: 'This version may not understand all of it and won\'t convert it back. Upgrade LLM OS again before making big changes.',
    };
  }
  if (m.status === 'error') {
    return {
      status: 'error',
      detail: `${result.detail} · could not update the data format: ${m.error}`,
      fix: m.backup ? `The files it changed are backed up in ${m.backup}.` : 'Nothing was changed.',
    };
  }
  if (m.status === 'migrated') return { ...result, detail: `${result.detail} · updated to format ${m.to}` };
  return result;
}

/**
 * Build the report.
 * @param {object} deps — injected so the report stays testable:
 *   listModels(), ollamaUrl, cloudConfigured: [names], registryStats(),
 *   dockerEnabled, dockerPing(), schedulerEnabled, tokenKeyReady, theme, desktop
 */
export async function bootReport(deps) {
  const checks = await Promise.all([
    timed('data', 'Your data', () => withDataFormat(checkData(), deps.dataMigration)),

    timed('models', 'AI models', async () => {
      const models = await deps.listModels();
      const local = models.filter(m => m.local);
      const cloud = models.filter(m => !m.local);
      if (models.length === 0) {
        return {
          status: 'warn',
          detail: 'no model reachable — installed apps still run, new ones can’t be written',
          fix: deps.ollamaUrl
            ? `Start Ollama (expected at ${deps.ollamaUrl}) or add ANTHROPIC_API_KEY with llmos-config.`
            : 'Add ANTHROPIC_API_KEY or OLLAMA_URL with llmos-config.',
        };
      }
      const names = [...cloud, ...local].slice(0, 4).map(m => m.label);
      const more = models.length > 4 ? ` +${models.length - 4}` : '';
      return { status: 'ok', detail: names.join(', ') + more };
    }),

    timed('local-models', 'Local models', async () => {
      const local = (await deps.listModels()).filter(m => m.local);
      if (!deps.ollamaUrl) {
        // Not set up — unless Ollama answers at the default address anyway
        return local.length
          ? { status: 'ok', detail: `${local.length} installed via Ollama at ${deps.defaultOllamaUrl || 'the default address'}` }
          : { status: 'off', detail: 'not configured (optional: offline app writing, free)' };
      }
      if (local.length) return { status: 'ok', detail: `${local.length} installed via Ollama` };
      return {
        status: deps.cloudConfigured.length ? 'warn' : 'error',
        detail: `Ollama isn’t answering at ${deps.ollamaUrl}`,
        fix: deps.cloudConfigured.length
          ? 'Start Ollama, or change OLLAMA_URL with llmos-config. Cloud models still work.'
          : 'Start Ollama, or change OLLAMA_URL with llmos-config.',
      };
    }),

    timed('apps', 'Apps', async () => {
      const s = deps.registryStats();
      return { status: 'ok', detail: `${s.totalApps} installed` };
    }),

    timed('sandbox', 'Sandbox & permissions', async () => (deps.tokenKeyReady
      ? { status: 'ok', detail: 'capability signing key ready' }
      : { status: 'error', detail: 'signing key missing — apps can’t be granted permissions', fix: 'Restart LLM OS.' })),

    timed('processes', 'Background apps (bots, servers)', async () => {
      if (!deps.dockerEnabled) return { status: 'off', detail: 'disabled in settings' };
      const ok = await deps.dockerPing().catch(() => false);
      return ok
        ? { status: 'ok', detail: 'Docker ready' }
        : { status: 'off', detail: 'Docker not available here — use the Server or Desktop image for these' };
    }),

    timed('scheduler', 'Self-improvement', async () => (deps.schedulerEnabled
      ? { status: 'ok', detail: 'runs when you’re idle' }
      : { status: 'off', detail: 'off (enable in Settings)' })),

    timed('look', 'Theme & desktop', async () => ({ status: 'ok', detail: `${deps.theme} · ${deps.desktop}` })),
  ]);

  const worst = checks.some(c => c.status === 'error') ? 'error' : checks.some(c => c.status === 'warn') ? 'warn' : 'ok';
  return { status: worst, services: checks, at: Date.now() };
}

/** systemd-style text for the VM console: `[  OK  ] Your data — …`. */
export function formatText(report) {
  const tag = { ok: '  OK  ', warn: ' WARN ', error: 'FAILED', off: '  --  ' };
  return report.services.map(s => {
    let line = `[${tag[s.status] || '  ??  '}] ${s.name} — ${s.detail || ''}`;
    if (s.fix) line += `\n         → ${s.fix}`;
    return line;
  }).join('\n') + '\n';
}
