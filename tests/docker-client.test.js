// Tests for Docker client and process manager
// Run: node tests/docker-client.test.js
// Note: requires Docker to be running for integration tests

import { dockerPing } from '../src/kernel/docker/client.js';
import { analyzeDockerfile } from '../src/kernel/analyzer.js';
import { inferAppType } from '../src/kernel/capabilities.js';

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

console.log('\ninferAppType:');
assert(inferAppType('make me a calculator') === 'iframe', 'calculator → iframe');
assert(inferAppType('run nanoclaw') === 'process', 'run nanoclaw → process');
assert(inferAppType('build a whatsapp bot') === 'process', 'whatsapp bot → process');
assert(inferAppType('create a background service') === 'process', 'background service → process');
assert(inferAppType('a simple todo list') === 'iframe', 'todo list → iframe');
assert(inferAppType('deploy a docker container') === 'process', 'docker → process');
assert(inferAppType('a pomodoro timer') === 'iframe', 'pomodoro → iframe');
assert(inferAppType('an agent that monitors prices') === 'process', 'agent → process');

console.log('\nanalyzeDockerfile:');
const safe = analyzeDockerfile('FROM node:22-slim\nWORKDIR /app\nCOPY . .\nCMD ["node", "index.js"]');
assert(safe.passed === true, 'clean Dockerfile passes');
assert(safe.criticalCount === 0, 'no critical findings');

const privileged = analyzeDockerfile('FROM node:22\nRUN docker run --privileged something');
assert(privileged.passed === false, '--privileged is blocked');
assert(privileged.criticalCount >= 1, 'privileged found as critical');

const hostNet = analyzeDockerfile('FROM alpine\nRUN curl --network host http://evil.com');
assert(hostNet.passed === false, '--network host is blocked');

const latest = analyzeDockerfile('FROM node:latest\nCMD ["node", "app.js"]');
assert(latest.warningCount >= 1, ':latest triggers warning');
assert(latest.passed === true, ':latest is warning not critical');

const commented = analyzeDockerfile('# --privileged is bad\nFROM node:22-slim');
assert(commented.passed === true, 'comments with dangerous patterns are skipped');

console.log('\ndockerPing:');
const dockerAvailable = await dockerPing();
console.log(`  Docker available: ${dockerAvailable}`);
// Don't fail test if Docker isn't running — it's optional
assert(typeof dockerAvailable === 'boolean', 'dockerPing returns boolean');

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
