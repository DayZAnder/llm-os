// Tests for static analyzer
// Run: node tests/analyzer.test.js

import { analyze, analyzeDockerfile } from '../src/kernel/analyzer.js';

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

function assertBlocked(code, ruleId, name) {
  const result = analyze(code);
  const found = result.findings.some(f => f.rule === ruleId);
  if (!found) {
    console.log(`    expected rule ${ruleId} to fire`);
    console.log(`    findings: ${result.findings.map(f => f.rule).join(', ') || '(none)'}`);
  }
  assert(found, name);
}

function assertClean(code, name) {
  const result = analyze(code);
  assert(result.passed, name + (result.passed ? '' : ` (blocked by: ${result.findings.map(f => f.rule).join(', ')})`));
}

// --- Original rules still work ---
console.log('\nOriginal rules:');

assertBlocked('eval("alert(1)")', 'EVAL_USAGE', 'blocks eval()');
assertBlocked('new Function("return 1")', 'EVAL_USAGE', 'blocks Function()');
assertBlocked('import("./malicious")', 'DYNAMIC_IMPORT', 'blocks dynamic import');
assertBlocked('window.parent.postMessage()', 'PARENT_ACCESS', 'blocks parent access');
assertBlocked('document.cookie', 'DOCUMENT_COOKIE', 'blocks cookie access');
assertBlocked('setTimeout("alert(1)", 100)', 'SETTIMEOUT_STRING', 'blocks setTimeout with string');
assertBlocked('atob("base64")', 'ENCODED_PAYLOAD', 'blocks atob');
assertBlocked('obj.__proto__.x = 1', 'PROTOTYPE_POLLUTION', 'blocks __proto__');
assertBlocked('globalThis.eval', 'GLOBAL_OVERRIDE', 'blocks globalThis access');
assertBlocked('navigator.serviceWorker.register("sw.js")', 'SERVICE_WORKER', 'blocks service worker');

// --- Phase 2: bracket notation eval ---
console.log('\nBracket notation attacks:');

assertBlocked('window["eval"]("code")', 'BRACKET_EVAL', 'blocks window["eval"]');
assertBlocked('this["Function"]("return 1")', 'BRACKET_EVAL', 'blocks this["Function"]');
assertBlocked('obj["constructor"]', 'BRACKET_EVAL', 'blocks obj["constructor"]');
assertBlocked("x['__proto__']", 'BRACKET_EVAL', "blocks x['__proto__']");

// --- Phase 2: computed property access ---
console.log('\nComputed property access:');

assertBlocked('window[varName]()', 'COMPUTED_PROPERTY_EXEC', 'blocks window[var]');
assertBlocked('document[method]()', 'COMPUTED_PROPERTY_EXEC', 'blocks document[var]');

// --- Phase 2: string concat obfuscation ---
console.log('\nString concatenation obfuscation:');

assertBlocked('"ev"+"al"', 'STRING_CONCAT_EVAL', 'blocks "ev"+"al"');
assertBlocked("'Func'+'tion'", 'STRING_CONCAT_EVAL', "blocks 'Func'+'tion'");

// --- Phase 2: document.write ---
console.log('\ndocument.write:');

assertBlocked('document.write("<script>alert(1)</script>")', 'DOCUMENT_WRITE', 'blocks document.write');
assertBlocked('document.writeln("test")', 'DOCUMENT_WRITE', 'blocks document.writeln');

// --- Phase 2: innerHTML ---
console.log('\ninnerHTML:');

assertBlocked('el.innerHTML = userInput', 'INNER_HTML_ASSIGN', 'blocks innerHTML assignment');
assertBlocked('div.outerHTML += "<script>"', 'INNER_HTML_ASSIGN', 'blocks outerHTML concat');

// --- Phase 2: Blob URLs ---
console.log('\nBlob URLs:');

assertBlocked('URL.createObjectURL(new Blob(["code"]))', 'BLOB_URL', 'blocks Blob URL creation');

// --- Phase 2: SharedArrayBuffer ---
console.log('\nSharedArrayBuffer:');

assertBlocked('new SharedArrayBuffer(1024)', 'SHARED_ARRAY_BUFFER', 'blocks SharedArrayBuffer');

// --- Phase 2: WebRTC ---
console.log('\nWebRTC:');

assertBlocked('new RTCPeerConnection()', 'WEB_RTC', 'blocks RTCPeerConnection');

// --- Phase 2: importScripts ---
console.log('\nimportScripts:');

assertBlocked('importScripts("evil.js")', 'IMPORT_SCRIPTS', 'blocks importScripts');

// --- Phase 2: location redirect ---
console.log('\nLocation redirect:');

assertBlocked('location.href = "https://evil.com"', 'LOCATION_ASSIGN', 'blocks location.href =');
assertBlocked('location.assign("evil")', 'LOCATION_ASSIGN', 'blocks location.assign');
assertBlocked('location.replace("evil")', 'LOCATION_ASSIGN', 'blocks location.replace');
assertBlocked("location = 'evil'", 'LOCATION_ASSIGN', 'blocks location = string');

// --- Phase 2: postMessage wildcard ---
console.log('\npostMessage wildcard:');

assertBlocked('window.postMessage(data, "*")', 'POSTMESSAGE_WILDCARD', 'blocks postMessage with *');

// --- Phase 2: MutationObserver ---
console.log('\nMutationObserver:');

assertBlocked('new MutationObserver(callback)', 'MUTATION_OBSERVER_ABUSE', 'blocks MutationObserver');

// --- Safe code should pass ---
console.log('\nSafe code (no false positives):');

assertClean('const x = 1 + 2;\nconsole.log(x);', 'basic arithmetic');
assertClean('document.getElementById("app")', 'getElementById');
assertClean('el.textContent = "hello"', 'textContent assignment');
assertClean('LLMOS.storage.get("key")', 'SDK storage call');
assertClean('LLMOS.timer.setTimeout(fn, 1000)', 'SDK timer call');
assertClean('el.addEventListener("click", handler)', 'addEventListener');
assertClean('const btn = document.createElement("button")', 'createElement button');
assertClean('el.style.top = "10px"', 'style.top (not top.something)');
assertClean('JSON.parse(text)', 'JSON.parse');

// --- Dockerfile rules ---
console.log('\nDockerfile rules:');

const dfResult1 = analyzeDockerfile('FROM node:22-slim\nRUN npm install');
assert(dfResult1.passed, 'clean Dockerfile passes');

const dfResult2 = analyzeDockerfile('FROM node:22-slim\nRUN docker run --privileged');
assert(!dfResult2.passed, 'blocks --privileged');
assert(dfResult2.findings.some(f => f.rule === 'DOCKERFILE_PRIVILEGED'), 'finds PRIVILEGED rule');

const dfResult3 = analyzeDockerfile('FROM node:latest');
assert(dfResult3.findings.some(f => f.rule === 'DOCKERFILE_LATEST_TAG'), 'warns on :latest');

const dfResult4 = analyzeDockerfile('FROM node:22-slim\n# --privileged is just a comment');
assert(dfResult4.passed, 'ignores comments in Dockerfile');

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
