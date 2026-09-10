#!/usr/bin/env node
'use strict';

// Runs the real offline analyzer against tiny synthetic files in an isolated
// temporary directory. Never opens real captures or contacts an emulator.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const tool = path.join(__dirname, 'analyze-emulator-heaps.cjs');
const prefix = 'harmony-heap-analysis-test-';
const tempRoot = fs.realpathSync(os.tmpdir());
const work = fs.mkdtempSync(path.join(tempRoot, prefix));
const sentinel = 'SYNTHETIC_PRIVATE_METADATA_AND_HEAP_SENTINEL';
const fields = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness', 'native_size'];
const base = {
  snapshot: { node_count: 5, edge_count: 4, meta: {
    node_fields: fields, node_types: [['synthetic', 'object', 'closure', 'string'], 'string', 'number'],
    edge_fields: ['type', 'name_or_index', 'to_node'], edge_types: [['property', 'shortcut'], 'string_or_number', 'node'],
    privateMetadata: sentinel
  } },
  nodes: [0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 3, 640, 1, 0, 0, 7, 1, 1, 5, 72, 1, 0, 0, 0,
    2, 2, 7, 144, 1, 0, 0, 0, 3, 3, 9, 24, 0, 0, 0, 0],
  edges: [1, 4, 8, 0, 5, 16, 0, 6, 24, 0, 7, 16],
  strings: ['root', sentinel, `[Home] ${sentinel}`, sentinel, sentinel, '__proto__', 'constructor', 'prototype']
};
let sequence = 0;
let activeCheck = 'setup';
const passed = [];
function check(condition) { if (!condition) throw new Error('CHECK_FAILED'); }
function test(name, action) { activeCheck = name; action(); passed.push(name); }
function fixture(editHeap = () => {}, editReceipt = () => {}) {
  const number = ++sequence;
  const directory = path.join(work, String(number)); fs.mkdirSync(directory);
  const heap = structuredClone(base); editHeap(heap);
  const bytes = Buffer.from(JSON.stringify(heap));
  const stamp = offset => new Date(Date.UTC(2026, 8, 10) + number * 1000 + offset).toISOString();
  const receipt = {
    state: 'complete', heapPrivate: true, startedAt: stamp(0), finishedAt: stamp(900),
    identity: { pid: 20, mainTid: 20, startTimeTicks: 100, artifactSHA256: 'a'.repeat(64),
      target: sentinel, versionName: sentinel, versionCode: 1, privateExtra: sentinel },
    apiReceipt: { state: 'completed', api: 'legacy', needClean: false, gcMode: 'platform-default', requestedNeedGC: true,
      requestNumber: number, requestedAt: stamp(100), finishedAt: stamp(800), privateExtra: sentinel },
    converted: { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      nodeCount: 5, edgeCount: 4 }
  };
  editReceipt(receipt);
  fs.writeFileSync(path.join(directory, 'snapshot.heapsnapshot'), bytes);
  fs.writeFileSync(path.join(directory, 'capture.json'), JSON.stringify(receipt));
  return directory;
}
function run(a, b, extra = []) {
  const result = spawnSync(process.execPath, [tool, a, b, ...extra], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true
  });
  check(!result.error && typeof result.stdout === 'string' && typeof result.stderr === 'string');
  check(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel));
  return result;
}
function rejected(a, b, code, extra = []) {
  const result = run(a, b, extra);
  check(result.status === 1 && JSON.parse(result.stderr).code === code);
}
try {
  const good = fixture(), later = fixture(), output = path.join(work, 'report.json');
  test('sanitized-output-and-structural-classification', () => {
    check(run(good, later, ['--out', output]).status === 0);
    const text = fs.readFileSync(output, 'utf8'); check(!text.includes(sentinel));
    const report = JSON.parse(text), group = report.captures[0].byClass.Home;
    check(report.rawStringsOmitted === true && report.captureSequenceValidated === true);
    check(group.instanceViaPrototypeConstructor.count === 1 && group.instanceViaPrototypeConstructor.nativeBytes === 7);
    check(group.prototype.count === 1 && group.constructorLike.count === 1);
    check(report.comparisons[0].totalNonString.selfBytes === 0);
  });
  for (const [name, editHeap, editReceipt, code] of [
    ['node-type-whitelist', h => { h.snapshot.meta.node_types[0][0] = sentinel; }, () => {}, 'NODE_TYPE_ENUM_UNSUPPORTED'],
    ['edge-type-whitelist', h => { h.snapshot.meta.edge_types[0][0] = sentinel; }, () => {}, 'EDGE_TYPE_ENUM_UNSUPPORTED'],
    ['artifact-hash-validation', () => {}, r => { r.identity.artifactSHA256 = sentinel; }, 'ARTIFACT_HASH_INVALID'],
    ['api-whitelist', () => {}, r => { r.apiReceipt.api = sentinel; }, 'RECEIPT_INVALID'],
    ['gc-mode-whitelist', () => {}, r => { r.apiReceipt.gcMode = sentinel; }, 'GC_RECEIPT_INVALID'],
    ['gc-boolean-type', () => {}, r => { r.apiReceipt.requestedNeedGC = sentinel; }, 'GC_RECEIPT_INVALID']
  ]) test(name, () => rejected(good, fixture(editHeap, editReceipt), code));
  test('capture-overwrite-rejection', () => {
    const file = path.join(good, 'capture.json'), original = fs.readFileSync(file);
    rejected(good, later, 'OUTPUT_MUST_NOT_OVERWRITE_CAPTURE', ['--out', file]);
    check(fs.readFileSync(file).equals(original));
  });
  test('reversed-capture-order', () => rejected(later, good, 'CAPTURE_SEQUENCE_NOT_STRICTLY_INCREASING'));
  test('duplicate-request-number', () => rejected(good, fixture(() => {}, r => {
    r.apiReceipt.requestNumber = 1;
  }), 'CAPTURE_SEQUENCE_NOT_STRICTLY_INCREASING'));
  test('invalid-internal-time-order', () => rejected(good, fixture(() => {}, r => {
    r.apiReceipt.finishedAt = r.startedAt;
  }), 'CAPTURE_TIME_ORDER_INVALID'));
} catch (_) {
  // Even failed tests must not echo raw analyzer output, fixture data, or paths.
  console.error(JSON.stringify({ passed: passed.length, failed: 1, failedCheck: activeCheck }));
  process.exitCode = 1;
} finally {
  try {
    const resolved = fs.realpathSync(work);
    check(path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith(prefix));
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (_) {
    console.error(JSON.stringify({ cleanupFailed: true })); process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(JSON.stringify({ passed: passed.length, failed: 0,
  originalStringsEmitted: false, checks: passed }, null, 2));
