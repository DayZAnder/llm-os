// Tests for the task scheduler
// Run: node tests/scheduler.test.js

import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Clean up persisted state before importing (so tests start fresh)
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const stateFile = join(__dirname, '..', 'data', 'scheduler.json');
if (existsSync(stateFile)) unlinkSync(stateFile);

const {
  registerTask, enableTask, disableTask, runNow,
  getAllTasks, getHistory, recordActivity, pause, resume,
  resetCircuitBreaker, checkBudget, getAggregateStats, isRunning,
} = await import('../src/kernel/scheduler.js');

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

// --- registerTask ---
console.log('\nregisterTask:');

let dummyRunCount = 0;
registerTask({
  id: 'test-dummy',
  name: 'Test Dummy',
  description: 'A test task',
  category: 'test',
  requiresLLM: false,
  defaultInterval: 60000,
  async handler() {
    dummyRunCount++;
    return { success: true, stats: { ran: true } };
  },
});

const allTasks = getAllTasks();
const testTask = allTasks.find(t => t.id === 'test-dummy');
assert(testTask !== undefined, 'task is registered');
assert(testTask.name === 'Test Dummy', 'task has correct name');
assert(testTask.category === 'test', 'task has correct category');
assert(testTask.state.enabled === false, 'task starts disabled');
assert(testTask.state.runCount === 0, 'task starts with 0 runs');

// --- enableTask / disableTask ---
console.log('\nenableTask / disableTask:');

const enableResult = enableTask('test-dummy');
assert(enableResult.enabled === true, 'enableTask sets enabled=true');
assert(enableResult.consecutiveErrors === 0, 'enableTask resets circuit breaker');

const afterEnable = getAllTasks().find(t => t.id === 'test-dummy');
assert(afterEnable.state.enabled === true, 'task is enabled after enableTask');

const disableResult = disableTask('test-dummy');
assert(disableResult.enabled === false, 'disableTask sets enabled=false');

// --- enableTask with custom interval ---
console.log('\ncustom interval:');

enableTask('test-dummy', 300000);
const customInterval = getAllTasks().find(t => t.id === 'test-dummy');
assert(customInterval.state.interval === 300000, 'custom interval is set');
disableTask('test-dummy');

// --- runNow ---
console.log('\nrunNow:');

const runResult = await runNow('test-dummy');
assert(runResult.success === true, 'runNow returns success');
assert(dummyRunCount === 1, 'handler was executed');

const afterRun = getAllTasks().find(t => t.id === 'test-dummy');
assert(afterRun.state.runCount === 1, 'runCount incremented');
assert(afterRun.state.successCount === 1, 'successCount incremented');
assert(afterRun.state.lastRun > 0, 'lastRun is set');
assert(afterRun.state.lastResult?.stats?.ran === true, 'lastResult saved');
assert(afterRun.state.consecutiveErrors === 0, 'consecutiveErrors stays 0 on success');

// --- history ---
console.log('\nhistory:');

const history = getHistory('test-dummy');
assert(Array.isArray(history), 'history is an array');
assert(history.length === 1, 'history has 1 entry after 1 run');
assert(history[0].success === true, 'history entry shows success');
assert(history[0].duration >= 0, 'history entry has duration');

// --- circuit breaker ---
console.log('\ncircuit breaker:');

let failCount = 0;
registerTask({
  id: 'test-failing',
  name: 'Test Failing',
  description: 'Always fails',
  category: 'test',
  requiresLLM: false,
  defaultInterval: 60000,
  async handler() {
    failCount++;
    throw new Error(`Deliberate failure #${failCount}`);
  },
});

// Enable it first so circuit breaker can auto-disable
enableTask('test-failing');

await runNow('test-failing');
let failState = getAllTasks().find(t => t.id === 'test-failing').state;
assert(failState.consecutiveErrors === 1, 'consecutive errors = 1 after first failure');
assert(failState.errorCount === 1, 'errorCount = 1');
assert(failState.lastError?.message.includes('Deliberate'), 'lastError saved');

await runNow('test-failing');
failState = getAllTasks().find(t => t.id === 'test-failing').state;
assert(failState.consecutiveErrors === 2, 'consecutive errors = 2 after second failure');

await runNow('test-failing');
failState = getAllTasks().find(t => t.id === 'test-failing').state;
assert(failState.consecutiveErrors === 3, 'consecutive errors = 3 after third failure');
assert(failState.enabled === false, 'circuit breaker disabled the task');
assert(failState.disabledReason === 'circuit-breaker', 'disabled reason is circuit-breaker');

// Reset circuit breaker
const resetResult = resetCircuitBreaker('test-failing');
assert(resetResult.consecutiveErrors === 0, 'reset clears consecutiveErrors');
assert(resetResult.disabledReason === null, 'reset clears disabledReason');

// --- concurrency lock ---
console.log('\nconcurrency lock:');

let slowResolve;
registerTask({
  id: 'test-slow',
  name: 'Test Slow',
  description: 'Takes a while',
  category: 'test',
  requiresLLM: false,
  defaultInterval: 60000,
  handler() {
    return new Promise(resolve => { slowResolve = resolve; });
  },
});

// Start slow task
const slowPromise = runNow('test-slow');
assert(isRunning(), 'isRunning returns true while task runs');

// Try to run another task while slow is running
const concurrentResult = await runNow('test-dummy');
assert(concurrentResult.success === false, 'concurrent run blocked');
assert(concurrentResult.error?.includes('Another task'), 'error mentions another task running');

// Let slow task finish
slowResolve({ success: true, stats: {} });
await slowPromise;
assert(!isRunning(), 'isRunning returns false after task completes');

// --- budget check ---
console.log('\nbudget check:');

registerTask({
  id: 'test-budget',
  name: 'Test Budget',
  description: 'LLM task',
  category: 'test',
  requiresLLM: true,
  defaultInterval: 60000,
  async handler(ctx) {
    // Simulate 50 LLM calls (way over budget)
    for (let i = 0; i < 50; i++) ctx.trackLLMCall();
    return { success: true, stats: { calls: 50 } };
  },
});

// First run — should succeed (budget not yet hit before task starts)
await runNow('test-budget');
const budget1 = checkBudget('test-budget');
assert(budget1.used === 50, 'budget shows 50 calls used');
assert(budget1.remaining === 0 || budget1.used >= budget1.dailyLimit, 'budget exhausted');

// Second run — should be blocked by budget
const budgetBlocked = await runNow('test-budget');
assert(budgetBlocked.success === false, 'second run blocked by budget');
assert(budgetBlocked.error?.includes('budget'), 'error mentions budget');

// --- pause / resume ---
console.log('\npause / resume:');

pause();
const statsWhilePaused = getAggregateStats();
assert(statsWhilePaused.paused === true, 'paused flag is true');

resume();
const statsAfterResume = getAggregateStats();
assert(statsAfterResume.paused === false, 'paused flag is false after resume');

// --- recordActivity ---
console.log('\nrecordActivity:');

recordActivity();
// Just verify it doesn't throw
assert(true, 'recordActivity succeeds');

// --- aggregateStats ---
console.log('\naggregateStats:');

const aggStats = getAggregateStats();
assert(typeof aggStats.totalGenerated === 'number', 'totalGenerated is a number');
assert(typeof aggStats.totalImproved === 'number', 'totalImproved is a number');

// --- unknown task errors ---
console.log('\nerror handling:');

try {
  enableTask('nonexistent');
  assert(false, 'enableTask throws for unknown task');
} catch (err) {
  assert(err.message.includes('Unknown task'), 'enableTask throws Unknown task error');
}

try {
  disableTask('nonexistent');
  assert(false, 'disableTask throws for unknown task');
} catch (err) {
  assert(err.message.includes('Unknown task'), 'disableTask throws Unknown task error');
}

const unknownRun = await runNow('nonexistent');
assert(unknownRun.success === false, 'runNow returns failure for unknown task');

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
