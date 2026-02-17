// Self-Improve Task: Claude Code Agent
// Spawns Claude Code CLI headlessly to debug issues, fix security gaps, and add features.
// Tasks are queued in data/claude-tasks.json and gated by values-check + test suite.
// Changes are committed to self-improve/* branches for human review — never pushed.

import { execFile, execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const QUEUE_FILE = join(DATA_DIR, 'claude-tasks.json');

// --- Queue management ---

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadQueue() {
  ensureDataDir();
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  ensureDataDir();
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

export function queueClaudeTask(prompt, source = 'manual') {
  const queue = loadQueue();
  const task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    prompt,
    source,
    status: 'pending',
    createdAt: new Date().toISOString(),
    result: null,
  };
  queue.push(task);
  saveQueue(queue);
  return task;
}

// --- Shell helpers (sync, for safety gates) ---

function run(cmd, opts = {}) {
  try {
    return {
      ok: true,
      output: execSync(cmd, {
        cwd: PROJECT_ROOT,
        timeout: 60_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...opts,
      }),
    };
  } catch (err) {
    return { ok: false, output: err.stderr || err.stdout || err.message };
  }
}

// --- Claude Code spawn ---

function spawnClaude(prompt) {
  return new Promise((resolve, reject) => {
    const systemContext = [
      'You are running inside LLM OS as an automated self-improvement agent.',
      'Make targeted, minimal changes. Run tests after editing.',
      'Do NOT push to git. Do NOT modify .env files or credentials.',
      'Do NOT add telemetry, tracking, or weaken sandboxing.',
      `Working directory: ${PROJECT_ROOT}`,
    ].join('\n');

    const fullPrompt = `${systemContext}\n\nTask:\n${prompt}`;

    const child = execFile('claude', [
      '-p', fullPrompt,
      '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep',
      '--max-turns', '20',
      '--output-format', 'json',
    ], {
      cwd: PROJECT_ROOT,
      timeout: 5 * 60 * 1000, // 5 minute hard timeout
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.claude.apiKey,
      },
      maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
    }, (err, stdout, stderr) => {
      if (err) {
        // Timeout or process error — still try to parse partial output
        if (err.killed) {
          return resolve({ ok: false, error: 'Timeout (5 min)', output: stdout });
        }
        return resolve({ ok: false, error: err.message, output: stdout });
      }

      try {
        const result = JSON.parse(stdout);
        resolve({ ok: true, result: result.result, usage: result.usage });
      } catch {
        // Non-JSON output — still usable
        resolve({ ok: true, result: stdout });
      }
    });
  });
}

// --- Safety gates ---

function runSafetyGates() {
  // 1. Values check — must have no new CRITICAL findings
  const valuesResult = run('node scripts/values-check.js');
  // values-check exits non-zero on CRITICAL findings; we check output
  const hasCritical = valuesResult.output?.includes('CRITICAL');

  // 2. Test suite — all must pass
  const testResult = run('npm test', { timeout: 120_000 });

  // 3. What changed
  const diffResult = run('git diff --stat');

  return {
    valuesPass: !hasCritical,
    testsPass: testResult.ok,
    diff: diffResult.output || '(no changes)',
    valuesOutput: valuesResult.output?.slice(-500) || '',
    testOutput: testResult.output?.slice(-500) || '',
  };
}

function revertChanges() {
  run('git checkout .');
}

function commitChanges(taskId, prompt) {
  const branchName = `self-improve/${taskId}`;
  run(`git checkout -b ${branchName}`);
  run('git add -A');
  const shortPrompt = prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt;
  run(`git commit -m "self-improve: ${shortPrompt}\n\nAutomated by claude-agent task ${taskId}\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"`);
  // Switch back to master — leave the branch for human review
  run('git checkout master');
}

// --- Task definition ---

export const definition = {
  id: 'claude-agent',
  name: 'Claude Code Agent',
  description: 'Run Claude Code to debug, fix, and improve the OS codebase',
  category: 'self-improve',
  requiresLLM: true,
  defaultInterval: 12 * 60 * 60 * 1000, // 12 hours

  async handler(context) {
    const stats = { attempted: 0, completed: 0, failed: 0, rejected: 0, skipped: 0 };

    // Requires Anthropic API key
    if (!config.claude.apiKey) {
      return { success: true, stats: { ...stats, skipped_reason: 'no ANTHROPIC_API_KEY' } };
    }

    // Check if Claude Code CLI is available
    const claudeCheck = run('claude --version');
    if (!claudeCheck.ok) {
      return { success: true, stats: { ...stats, skipped_reason: 'claude CLI not installed' } };
    }

    // Load queue, find pending tasks
    const queue = loadQueue();
    const pending = queue.filter(t => t.status === 'pending');

    if (pending.length === 0) {
      return { success: true, stats: { ...stats, skipped_reason: 'no pending tasks' } };
    }

    // Process one task per run (conservative — respect budget + time)
    const task = pending[0];
    stats.attempted++;

    // Mark as running
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    saveQueue(queue);

    console.log(`[claude-agent] Running task ${task.id}: ${task.prompt.slice(0, 80)}...`);

    context.trackLLMCall();

    try {
      // Ensure clean working tree
      const statusCheck = run('git status --porcelain');
      if (statusCheck.output?.trim()) {
        task.status = 'failed';
        task.result = { error: 'Working tree not clean — skipping' };
        task.completedAt = new Date().toISOString();
        saveQueue(queue);
        stats.failed++;
        return { success: true, stats };
      }

      // Spawn Claude Code
      const claudeResult = await spawnClaude(task.prompt);

      if (!claudeResult.ok) {
        task.status = 'failed';
        task.result = { error: claudeResult.error };
        task.completedAt = new Date().toISOString();
        saveQueue(queue);
        stats.failed++;
        return { success: true, stats };
      }

      // Check if anything changed
      const diffCheck = run('git diff --stat');
      if (!diffCheck.output?.trim()) {
        task.status = 'completed';
        task.result = { summary: claudeResult.result?.slice?.(0, 500) || 'No changes made', changes: 'none' };
        task.completedAt = new Date().toISOString();
        saveQueue(queue);
        stats.completed++;
        return { success: true, stats };
      }

      // Run safety gates
      const gates = runSafetyGates();

      if (gates.valuesPass && gates.testsPass) {
        // All clear — commit to branch
        commitChanges(task.id, task.prompt);
        task.status = 'completed';
        task.result = {
          summary: claudeResult.result?.slice?.(0, 500) || 'Changes applied',
          diff: gates.diff,
          branch: `self-improve/${task.id}`,
          usage: claudeResult.usage,
        };
        stats.completed++;
        console.log(`[claude-agent] Task ${task.id} completed, branch: self-improve/${task.id}`);
      } else {
        // Safety gates failed — revert
        revertChanges();
        task.status = 'rejected';
        task.result = {
          reason: !gates.valuesPass ? 'values-check failed' : 'tests failed',
          valuesOutput: gates.valuesOutput,
          testOutput: gates.testOutput,
          diff: gates.diff,
        };
        stats.rejected++;
        console.warn(`[claude-agent] Task ${task.id} rejected: ${task.result.reason}`);
      }
    } catch (err) {
      revertChanges();
      task.status = 'failed';
      task.result = { error: err.message };
      stats.failed++;
      console.error(`[claude-agent] Task ${task.id} error:`, err.message);
    }

    task.completedAt = new Date().toISOString();
    saveQueue(queue);

    return { success: true, stats };
  },
};
