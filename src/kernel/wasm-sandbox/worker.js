// WASM Sandbox Worker — runs inside a worker_threads Worker.
// Compiles, validates, and executes a WASM module with capability-gated host functions.
// Communicates with main thread via SharedArrayBuffer + Atomics for synchronous host calls.

import { workerData, parentPort } from 'worker_threads';

// SharedArrayBuffer layout (matches index.js)
const STATE_IDLE = 0;
const STATE_PENDING = 1;
const STATE_READY = 2;
const SAB_DATA_START = 12;

// Host call types
const CALL = {
  STORAGE_GET: 1,
  STORAGE_SET: 2,
  STORAGE_REMOVE: 3,
  STORAGE_KEYS: 4,
  NOTIFY: 5,
  CAP_REQUEST: 6,
};

// --- LEB128 unsigned integer decoder ---

function readLEB128U(buf, offset) {
  let result = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7F) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: result, bytesRead: pos - offset };
}

// --- WASM bytecode memory section validator ---
// Scans the binary for section ID 5 (Memory) and rejects modules with
// unbounded memory or maximum pages exceeding the configured limit.

export function validateMemorySection(bytes, maxPagesAllowed) {
  const buf = new Uint8Array(bytes);

  // WASM magic: \0asm
  if (buf.length < 8 || buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6D) {
    throw new Error('Invalid WASM magic bytes');
  }

  let offset = 8; // skip magic + version
  while (offset < buf.length) {
    const sectionId = buf[offset++];
    const sectionLen = readLEB128U(buf, offset);
    offset += sectionLen.bytesRead;
    const sectionEnd = offset + sectionLen.value;

    if (sectionId === 5) { // Memory section
      const count = readLEB128U(buf, offset);
      let pos = offset + count.bytesRead;
      for (let i = 0; i < count.value; i++) {
        const flags = buf[pos++];
        const initial = readLEB128U(buf, pos);
        pos += initial.bytesRead;
        if (flags & 0x01) {
          const maximum = readLEB128U(buf, pos);
          pos += maximum.bytesRead;
          if (maximum.value > maxPagesAllowed) {
            throw new Error(
              `WASM declares memory maximum ${maximum.value} pages, limit is ${maxPagesAllowed}`
            );
          }
        } else {
          throw new Error('WASM module declares unbounded memory (no maximum). Rejected for safety.');
        }
      }
    }

    offset = sectionEnd;
  }
}

// --- Import-to-capability mapping ---

function importToCap(importName) {
  if (importName.startsWith('storage_')) return 'storage:local';
  if (importName === 'fetch') return 'network:http';
  // notify and cap_request are always allowed
  return null;
}

// --- Synchronous host call via SharedArrayBuffer ---

function makeHostCall(sharedBuffer, callType, payload) {
  const i32 = new Int32Array(sharedBuffer);
  const u8 = new Uint8Array(sharedBuffer);

  const json = JSON.stringify(payload);
  const bytes = Buffer.from(json, 'utf-8');
  if (bytes.length > 65524) throw new Error('Host call payload too large');

  // Write request
  u8.set(bytes, SAB_DATA_START);
  Atomics.store(i32, 2, bytes.length);   // DATA_LEN
  Atomics.store(i32, 1, callType);       // CALL_TYPE
  Atomics.store(i32, 0, STATE_PENDING);  // STATE

  // Signal main thread
  parentPort.postMessage({ type: 'host-call' });

  // Block until main thread writes result
  Atomics.wait(i32, 0, STATE_PENDING);

  // Read response
  const respLen = Atomics.load(i32, 2);
  const respStr = Buffer.from(u8.slice(SAB_DATA_START, SAB_DATA_START + respLen)).toString('utf-8');
  const resp = JSON.parse(respStr);

  // Reset state
  Atomics.store(i32, 0, STATE_IDLE);

  if (resp.error) throw new Error(resp.error);
  return resp.value;
}

// --- Build host function imports based on capabilities ---

function buildImports(capabilities, sharedBuffer, memory) {
  const llmos = {};

  // Helper: read a string from WASM linear memory
  function readString(ptr, len) {
    const mem = new Uint8Array(memory.buffer);
    return Buffer.from(mem.slice(ptr, ptr + len)).toString('utf-8');
  }

  // Helper: write a string to WASM linear memory, returns byte length
  function writeString(str, ptr) {
    const bytes = Buffer.from(str, 'utf-8');
    const mem = new Uint8Array(memory.buffer);
    mem.set(bytes, ptr);
    return bytes.length;
  }

  if (capabilities.includes('storage:local')) {
    llmos.storage_get = (keyPtr, keyLen, outPtr) => {
      const key = readString(keyPtr, keyLen);
      const value = makeHostCall(sharedBuffer, CALL.STORAGE_GET, { key });
      if (value === null || value === undefined) return 0;
      return writeString(JSON.stringify(value), outPtr);
    };

    llmos.storage_set = (keyPtr, keyLen, valPtr, valLen) => {
      const key = readString(keyPtr, keyLen);
      const val = readString(valPtr, valLen);
      makeHostCall(sharedBuffer, CALL.STORAGE_SET, { key, value: val });
      return 1;
    };

    llmos.storage_remove = (keyPtr, keyLen) => {
      const key = readString(keyPtr, keyLen);
      makeHostCall(sharedBuffer, CALL.STORAGE_REMOVE, { key });
      return 1;
    };

    llmos.storage_keys = (outPtr) => {
      const keys = makeHostCall(sharedBuffer, CALL.STORAGE_KEYS, {});
      return writeString(JSON.stringify(keys), outPtr);
    };
  }

  llmos.notify = (msgPtr, msgLen) => {
    const message = readString(msgPtr, msgLen);
    makeHostCall(sharedBuffer, CALL.NOTIFY, { message });
    return 1;
  };

  llmos.cap_request = (capPtr, capLen) => {
    const capability = readString(capPtr, capLen);
    return makeHostCall(sharedBuffer, CALL.CAP_REQUEST, { capability }) ? 1 : 0;
  };

  return { env: { memory }, llmos };
}

// --- Main worker execution ---

async function run() {
  const { wasmBytes, capabilities, memoryPages, maxMemoryPages, entryFn, args, sharedBuffer } = workerData;

  try {
    // 1. Validate memory section
    validateMemorySection(wasmBytes, maxMemoryPages);

    // 2. Compile
    const module = await WebAssembly.compile(Buffer.from(wasmBytes));

    // 3. Check imports against capabilities
    const requiredImports = WebAssembly.Module.imports(module);
    for (const imp of requiredImports) {
      if (imp.module === 'llmos') {
        const capNeeded = importToCap(imp.name);
        if (capNeeded && !capabilities.includes(capNeeded)) {
          throw new Error(`Module imports llmos.${imp.name} but capability '${capNeeded}' not granted`);
        }
      }
    }

    // 4. Create bounded memory
    const memory = new WebAssembly.Memory({
      initial: memoryPages,
      maximum: maxMemoryPages,
    });

    // 5. Build capability-gated imports
    const imports = buildImports(capabilities, sharedBuffer, memory);

    // 6. Instantiate
    const instance = await WebAssembly.instantiate(module, imports);

    // 7. Call entry function
    if (typeof instance.exports[entryFn] !== 'function') {
      throw new Error(`WASM module has no exported function: '${entryFn}'`);
    }

    const result = instance.exports[entryFn](...args);
    parentPort.postMessage({ type: 'result', value: result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err.message });
  }
}

run();
