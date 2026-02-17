// Task Scheduler — runs self-improvement tasks on a schedule.
// Guardrails: circuit breaker, dedup, daily budget, activity defer, Ollama-only default.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const STATE_FILE = join(DATA_DIR, 'scheduler.json');
const MAX_HISTORY = 20;
const CIRCUIT_BREAKER_THRESHOLD = 3;

// --- In-memory state ---

const tasks = new Map();       // id → { definition, timer }
const state = { tasks: {}, paused: false };
let lastActivity = 0;          // timestamp of last API call
let running = false;           // concurrency lock
let runningTaskId = null;

// --- Persistence ---

function loadState() {
  if (!existsSync(STATE_FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (saved.tasks) {
      for (const [id, taskState] of Object.entries(saved.tasks)) {
        state.tasks[id] = taskState;
      }
    }
    state.paused = saved.paused || false;
    console.log('[scheduler] Loaded state');
  } catch (err) {
    console.warn('[scheduler] Failed to load state:', err.message);
  }
}

function persist() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Task state helpers ---

function getTaskState(id) {
  if (!state.tasks[id]) {
    state.tasks[id] = {
      enabled: false,
      interval: tasks.get(id)?.definition.defaultInterval || 21600000,
      lastRun: null,
      nextRun: null,
      runCount: 0,
      successCount: 0,
      errorCount: 0,
      consecutiveErrors: 0,
      disabledReason: null,
      llmCallsToday: 0,
      llmCallsDate: today(),
      lastResult: null,
      lastError: null,
      history: [],
    };
  }
  return state.tasks[id];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyBudget(taskState) {
  const now = today();
  if (taskState.llmCallsDate !== now) {
    taskState.llmCallsToday = 0;
    taskState.llmCallsDate = now;
  }
}

// --- Core scheduling ---

function startTimer(id) {
  const entry = tasks.get(id);
  if (!entry) return;

  // Clear existing timer
  if (entry.timer) clearInterval(entry.timer);

  const taskState = getTaskState(id);
  const interval = taskState.interval;

  entry.timer = setInterval(() => tick(id), Math.max(interval, 60000)); // min 1 minute
  taskState.nextRun = Date.now() + interval;
  console.log(`[scheduler] Timer started for ${id} (every ${Math.round(interval / 60000)}min)`);
}

function stopTimer(id) {
  const entry = tasks.get(id);
  if (!entry) return;
  if (entry.timer) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
  const taskState = getTaskState(id);
  taskState.nextRun = null;
}

async function tick(id) {
  const entry = tasks.get(id);
  if (!entry) return;
  const taskState = getTaskState(id);

  // Guard: global pause
  if (state.paused) return;

  // Guard: task disabled
  if (!taskState.enabled) return;

  // Guard: activity defer
  if (Date.now() - lastActivity < config.scheduler.deferMs) return;

  // Guard: concurrency lock
  if (running) return;

  // Guard: circuit breaker
  if (taskState.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) return;

  // Guard: daily budget
  resetDailyBudget(taskState);
  if (entry.definition.requiresLLM && taskState.llmCallsToday >= config.scheduler.dailyBudget) return;

  await executeTask(id);
}

async function executeTask(id) {
  const entry = tasks.get(id);
  if (!entry) return { success: false, error: 'Task not found' };
  const taskState = getTaskState(id);

  running = true;
  runningTaskId = id;
  const startTime = Date.now();

  try {
    // Build context for the task handler
    const context = {
      config: config,
      provider: config.scheduler.provider,
      trackLLMCall: () => {
        resetDailyBudget(taskState);
        taskState.llmCallsToday++;
      },
      getBudgetRemaining: () => {
        resetDailyBudget(taskState);
        return Math.max(0, config.scheduler.dailyBudget - taskState.llmCallsToday);
      },
    };

    const result = await entry.definition.handler(context);

    // Success
    taskState.consecutiveErrors = 0;
    taskState.successCount++;
    taskState.lastResult = result;
    taskState.lastError = null;

    // Add to history
    taskState.history.unshift({
      success: true,
      stats: result.stats || {},
      at: Date.now(),
      duration: Date.now() - startTime,
    });
    if (taskState.history.length > MAX_HISTORY) taskState.history.pop();

    console.log(`[scheduler] ${id} completed:`, result.stats || 'ok');
    return result;
  } catch (err) {
    // Failure
    taskState.consecutiveErrors++;
    taskState.errorCount++;
    taskState.lastError = { message: err.message, at: Date.now() };
    taskState.lastResult = null;

    taskState.history.unshift({
      success: false,
      error: err.message,
      at: Date.now(),
      duration: Date.now() - startTime,
    });
    if (taskState.history.length > MAX_HISTORY) taskState.history.pop();

    // Circuit breaker
    if (taskState.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
      taskState.enabled = false;
      taskState.disabledReason = 'circuit-breaker';
      stopTimer(id);
      console.warn(`[scheduler] ${id} auto-disabled after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`);
    }

    console.error(`[scheduler] ${id} failed (${taskState.consecutiveErrors}/${CIRCUIT_BREAKER_THRESHOLD}):`, err.message);
    return { success: false, error: err.message };
  } finally {
    running = false;
    runningTaskId = null;
    taskState.runCount++;
    taskState.lastRun = Date.now();
    taskState.nextRun = taskState.enabled ? Date.now() + taskState.interval : null;
    persist();
  }
}

// --- Public API ---

export function registerTask(definition) {
  if (!definition.id || !definition.handler) {
    throw new Error('Task must have id and handler');
  }
  tasks.set(definition.id, { definition, timer: null });

  // Initialize state if not loaded
  getTaskState(definition.id);

  // Restore timer if was enabled
  const taskState = state.tasks[definition.id];
  if (taskState?.enabled && !state.paused) {
    startTimer(definition.id);
  }

  console.log(`[scheduler] Registered task: ${definition.id}`);
}

export function enableTask(id, interval) {
  const entry = tasks.get(id);
  if (!entry) throw new Error(`Unknown task: ${id}`);

  const taskState = getTaskState(id);
  taskState.enabled = true;
  taskState.consecutiveErrors = 0;
  taskState.disabledReason = null;
  if (interval) taskState.interval = interval;

  startTimer(id);
  persist();
  return taskState;
}

export function disableTask(id) {
  const entry = tasks.get(id);
  if (!entry) throw new Error(`Unknown task: ${id}`);

  const taskState = getTaskState(id);
  taskState.enabled = false;
  stopTimer(id);
  persist();
  return taskState;
}

export async function runNow(id) {
  const entry = tasks.get(id);
  if (!entry) return { success: false, error: `Unknown task: ${id}` };

  if (running) {
    return { success: false, error: `Another task is running (${runningTaskId})` };
  }

  // Budget check (but allow manual run if task doesn't need LLM)
  const taskState = getTaskState(id);
  resetDailyBudget(taskState);
  if (entry.definition.requiresLLM && taskState.llmCallsToday >= config.scheduler.dailyBudget) {
    return { success: false, error: `Daily budget exhausted (${taskState.llmCallsToday}/${config.scheduler.dailyBudget})` };
  }

  return executeTask(id);
}

export function getAllTasks() {
  const result = [];
  for (const [id, entry] of tasks) {
    result.push({
      id,
      name: entry.definition.name,
      description: entry.definition.description,
      category: entry.definition.category || 'general',
      requiresLLM: entry.definition.requiresLLM || false,
      defaultInterval: entry.definition.defaultInterval,
      state: getTaskState(id),
    });
  }
  return result;
}

export function getHistory(id) {
  const taskState = state.tasks[id];
  return taskState?.history || [];
}

export function recordActivity() {
  lastActivity = Date.now();
}

export function pause() {
  state.paused = true;
  for (const id of tasks.keys()) stopTimer(id);
  persist();
}

export function resume() {
  state.paused = false;
  for (const [id] of tasks) {
    const taskState = getTaskState(id);
    if (taskState.enabled) startTimer(id);
  }
  persist();
}

export function resetCircuitBreaker(id) {
  const taskState = getTaskState(id);
  taskState.consecutiveErrors = 0;
  taskState.disabledReason = null;
  persist();
  return taskState;
}

export function checkBudget(id) {
  const taskState = getTaskState(id);
  resetDailyBudget(taskState);
  return {
    allowed: taskState.llmCallsToday < config.scheduler.dailyBudget,
    remaining: Math.max(0, config.scheduler.dailyBudget - taskState.llmCallsToday),
    dailyLimit: config.scheduler.dailyBudget,
    used: taskState.llmCallsToday,
  };
}

export function getAggregateStats() {
  let totalGenerated = 0;
  let totalImproved = 0;
  let lastCatchRate = null;
  let lastQcScore = null;

  for (const taskState of Object.values(state.tasks)) {
    if (!taskState.lastResult?.stats) continue;
    const s = taskState.lastResult.stats;
    if (s.published !== undefined) totalGenerated += s.published;
    if (s.improved !== undefined) totalImproved += s.improved;
    if (s.catchRate !== undefined) lastCatchRate = s.catchRate;
    if (s.avgScore !== undefined) lastQcScore = s.avgScore;
  }

  return { totalGenerated, totalImproved, lastCatchRate, lastQcScore, paused: state.paused };
}

export function isRunning() {
  return running;
}

export function getRunningTask() {
  return runningTaskId;
}

// Load persisted state on import
loadState();
