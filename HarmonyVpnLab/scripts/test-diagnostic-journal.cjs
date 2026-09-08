'use strict';
// Transpiles the actual ArkTS module using the installed DevEco SDK. Every file,
// clock and UUID below is synthetic; no phone, network or private file is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourceName = 'entry/src/main/ets/model/DiagnosticJournal.ets';
const source = fs.readFileSync(path.join(root, sourceName), 'utf8');
const result = ts.transpileModule(source.replace(/^import[^\n]*\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(result.diagnostics.length, 0, 'SDK transpilation diagnostics');
const directory = '/synthetic-journal';
const journalPath = directory + '/diagnostic-journal.json';
const runId = '1789000000000';
const codes = ['session-start', 'network-change', 'recovery-start', 'recovery-ok', 'recovery-failed',
  'waiting-network', 'protect-stale-before', 'protect-stale-after', 'protect-api-failed',
  'stop-requested', 'session-stopped', 'latency-start', 'latency-ok', 'latency-failed'];
const kinds = ['', 'wifi', 'cellular', 'ethernet', 'other', 'unavailable', 'before', 'after'];
const event = (changes = {}) => ({ at: 1789000000123, runId, code: 'session-start', kind: '', value: 0, ...changes });

function scenario(options = {}) {
  const files = new Map(), handles = new Map(), calls = [];
  let nextFd = 11, uuid = 1;
  const clock = { now: 1789000000123 };
  const faults = { ...options };
  function failure(operation) {
    if (faults.fail === operation) throw new Error('synthetic secret URL must never escape');
  }
  const fakeFs = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    accessSync(name) { failure('access'); return files.has(name); },
    statSync(name) { failure('stat'); return { size: files.get(name).length, isFile: () => !faults.directory }; },
    readTextSync(name, options) {
      failure('read'); calls.push({ op: 'read', limit: options?.length });
      return files.get(name).subarray(0, options?.length).toString('utf8');
    },
    openSync(name, flags) {
      failure('open'); assert.equal(flags, 7); files.set(name, Buffer.alloc(0));
      const fd = nextFd++; handles.set(fd, { name, offset: 0 }); calls.push({ op: 'open', name }); return { fd };
    },
    writeSync(fd, arrayBuffer) {
      failure('write'); const handle = handles.get(fd); assert.ok(handle);
      const bytes = Buffer.from(arrayBuffer);
      if (faults.written !== undefined) return faults.written;
      const n = Math.min(faults.chunk || Infinity, bytes.length);
      files.set(handle.name, Buffer.concat([files.get(handle.name), bytes.subarray(0, n)]));
      handle.offset += n; calls.push({ op: 'write', bytes: n }); return n;
    },
    fsyncSync(fd) { failure('fsync'); assert.ok(handles.has(fd)); calls.push({ op: 'fsync' }); },
    closeSync(file) { handles.delete(file.fd); calls.push({ op: 'close' }); failure('close'); },
    renameSync(from, to) {
      failure('rename'); assert.ok(files.has(from));
      assert.equal(handles.size, 0); files.set(to, files.get(from)); files.delete(from); calls.push({ op: 'rename' });
    },
    unlinkSync(name) { failure('unlink'); files.delete(name); calls.push({ op: 'unlink' }); }
  };
  class FakeDate extends Date { static now() { return clock.now; } }
  const exported = {};
  vm.runInNewContext(result.outputText, { exports: exported, module: { exports: exported }, fs: fakeFs, Date: FakeDate,
    util: { generateRandomUUID: () => { failure('uuid'); return 'synthetic-' + uuid++; },
      TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } } }
  }, { filename: sourceName });
  return { files, handles, calls, faults, clock, api: exported,
    set(value) { files.set(journalPath, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); },
    append(...args) { return exported.appendDiagnosticEvent(directory, ...args); },
    read() { return JSON.parse(JSON.stringify(exported.readDiagnosticEvents(directory))); }
  };
}

const tests = [];
function test(name, body) { tests.push({ name, body }); }
function exactError(fn, expected) {
  assert.throws(fn, error => error.message === expected && !String(error).includes('secret'));
}
test('missing journal is empty and does not create files', () => {
  const s = scenario(); assert.deepEqual(s.read(), []); assert.equal(s.files.size, 0);
});
test('defaults, supplied fields and current clock round-trip with exact five fields', () => {
  const s = scenario(); s.append(runId, 'session-start'); s.clock.now++;
  s.append(runId, 'network-change', 'cellular', 3);
  assert.deepEqual(s.read(), [event(), event({ at: s.clock.now, code: 'network-change', kind: 'cellular', value: 3 })]);
  assert.equal(s.calls.find(c => c.op === 'read').limit, 65537);
});
test('every fixed code and kind is accepted', () => {
  const s = scenario();
  for (const code of codes) for (const kind of kinds) s.append(runId, code, kind, 5);
  assert.equal(s.read().length, codes.length * kinds.length);
});
test('invalid codes, kinds, run ids and values cannot write or include raw input in errors', () => {
  const inputs = [
    [runId, 'https://secret.example.test/token'], [runId, 'session-start', '192.0.2.1'],
    ['178900000000', 'session-start'], ['17890000000000', 'session-start'], ['abcdefghijklm', 'session-start'],
    ['1789000000000\n', 'session-start'], [1789000000000, 'session-start'],
    [runId, 'session-start', '', -1], [runId, 'session-start', '', NaN],
    [runId, 'session-start', '', Infinity], [runId, 'session-start', '', 1.5],
    [runId, 'session-start', '', '42'], [runId, 'session-start', null], [runId, null]
  ];
  for (const input of inputs) {
    const s = scenario(); exactError(() => s.append(...input), 'DIAGNOSTIC_JOURNAL_INVALID_EVENT');
    assert.equal(s.files.size, 0); assert.equal(s.calls.length, 0);
  }
});
test('invalid current clock fails before filesystem mutation', () => {
  for (const now of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const s = scenario(); s.clock.now = now;
    exactError(() => s.append(runId, 'session-start'), 'DIAGNOSTIC_JOURNAL_INVALID_EVENT'); assert.equal(s.files.size, 0);
  }
});
test('only the most recent 200 events remain, oldest first, within 64 KiB', () => {
  const s = scenario();
  for (let n = 0; n < 231; n++) { s.clock.now++; s.append(runId, 'protect-stale-before', 'before', n); }
  const read = s.read(); assert.equal(read.length, 200); assert.equal(read[0].value, 31); assert.equal(read[199].value, 230);
  assert.ok(s.files.get(journalPath).length <= 65536); assert.equal(s.files.size, 1);
});
test('byte ceiling rejects an oversized file before text is read', () => {
  const s = scenario(); s.set(' '.repeat(65537)); assert.deepEqual(s.read(), []); assert.equal(s.calls.length, 0);
  s.append(runId, 'session-start'); assert.deepEqual(s.read(), [event()]);
});
test('malformed roots, invalid records, additional fields and excessive entries are empty', () => {
  const malformed = ['', '{', 'null', '{}', '1', '"text"', '[null]', '[[]]',
    [event({ code: 'arbitrary-host.example.test' })], [event({ value: -1 })],
    [event({ arbitrarySecret: 'synthetic-never-persist' })], [event({ at: '1789000000123' })],
    [event({ kind: null })], [event({ runId: 'invalid' })], Array.from({ length: 201 }, () => event()),
    '[{"at":1789000000123,"runId":"1789000000000","code":"session-start","kind":"","value":0,"__proto__":{}}]'];
  const withoutField = event(); delete withoutField.kind; malformed.push([withoutField]);
  for (const data of malformed) { const s = scenario(); s.set(data); assert.deepEqual(s.read(), []); }
});
test('a non-file path is not read', () => {
  const s = scenario({ directory: true }); s.set([event()]); assert.deepEqual(s.read(), []); assert.equal(s.calls.length, 0);
});
test('an invalid record invalidates the whole snapshot and append replaces malformed content safely', () => {
  const s = scenario(); s.set([event(), event({ secret: 'synthetic-private' })]); assert.deepEqual(s.read(), []);
  s.append(runId, 'session-start'); assert.deepEqual(s.read(), [event()]);
  assert.ok(!s.files.get(journalPath).toString().includes('synthetic-private'));
});
test('returned events do not share mutable state with persisted records', () => {
  const s = scenario(); s.set([event()]);
  s.api.readDiagnosticEvents(directory)[0].code = 'arbitrary-secret'; assert.deepEqual(s.read(), [event()]);
});
test('partial writes complete and fsync precedes close and atomic rename', () => {
  const s = scenario({ chunk: 7 }); s.append(runId, 'latency-ok', '', 321);
  assert.deepEqual(s.read(), [event({ code: 'latency-ok', value: 321 })]);
  const ops = s.calls.map(c => c.op); assert.ok(ops.filter(op => op === 'write').length > 2);
  assert.ok(ops.indexOf('fsync') < ops.indexOf('close')); assert.ok(ops.indexOf('close') < ops.indexOf('rename'));
  assert.equal(s.handles.size, 0); assert.equal(s.files.size, 1);
});
test('separate writes use unique temporary names and retain no temporary file', () => {
  const s = scenario(); s.append(runId, 'session-start'); s.append(runId, 'session-stopped');
  const names = s.calls.filter(c => c.op === 'open').map(c => c.name); assert.equal(new Set(names).size, 2);
  assert.ok(names.every(name => name.endsWith('.tmp'))); assert.equal(s.files.size, 1);
});
test('zero, negative, excessive and fractional write lengths cannot commit truncated content', () => {
  for (const written of [0, -1, 999999, 0.5, NaN]) {
    const s = scenario({ written }); s.set([event()]); const old = Buffer.from(s.files.get(journalPath));
    exactError(() => s.append(runId, 'session-stopped'), 'DIAGNOSTIC_JOURNAL_WRITE_FAILED');
    assert.deepEqual(s.files.get(journalPath), old); assert.equal(s.files.size, 1); assert.equal(s.handles.size, 0);
  }
});
test('read I/O failures have fixed errors and cannot overwrite existing evidence', () => {
  for (const fail of ['access', 'stat', 'read']) {
    const s = scenario({ fail }); s.set([event()]); const old = Buffer.from(s.files.get(journalPath));
    exactError(() => s.read(), 'DIAGNOSTIC_JOURNAL_READ_FAILED');
    exactError(() => s.append(runId, 'session-stopped'), 'DIAGNOSTIC_JOURNAL_READ_FAILED');
    assert.deepEqual(s.files.get(journalPath), old); assert.equal(s.files.size, 1);
  }
});
test('open, write, fsync, close, rename and UUID failures preserve the previous snapshot', () => {
  for (const fail of ['open', 'write', 'fsync', 'close', 'rename', 'uuid']) {
    const s = scenario({ fail }); s.set([event()]); const old = Buffer.from(s.files.get(journalPath));
    exactError(() => s.append(runId, 'session-stopped'), 'DIAGNOSTIC_JOURNAL_WRITE_FAILED');
    assert.deepEqual(s.files.get(journalPath), old); assert.equal(s.files.size, 1); assert.equal(s.handles.size, 0);
  }
});
test('readers see only the old or complete new snapshot across atomic rename', () => {
  const s = scenario({ chunk: 1 }); s.set([event()]); const old = s.files.get(journalPath).toString();
  const originalSet = s.files.set.bind(s.files); let observed = 0;
  s.files.set = (name, value) => {
    if (name !== journalPath) { assert.equal(s.files.get(journalPath).toString(), old); observed++; }
    return originalSet(name, value);
  };
  s.append(runId, 'session-stopped'); assert.ok(observed > 1); assert.equal(s.read().length, 2);
});

const results = tests.map(({ name, body }) => {
  try { body(); return { name, passed: true }; }
  catch (error) { return { name, passed: false, detail: String(error.message) }; }
});
const passed = results.filter(item => item.passed).length;
const report = { checkedAt: new Date().toISOString(), passed, failed: results.length - passed, total: results.length,
  scope: 'Actual DiagnosticJournal ArkTS module transpiled by DevEco SDK; synthetic in-memory filesystem, UUID and clock. No phone/network/private files.',
  limitations: ['Single synchronous VPN service writer is a required contract; atomic rename does not coordinate competing writers.',
    'Mock filesystem verifies API ordering and error handling, not device crash durability or SDK filesystem implementation.'],
  sourceSHA256: { [sourceName]: crypto.createHash('sha256').update(source).digest('hex') }, results };
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/diagnostic-journal-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed, failed: report.failed, total: results.length,
  failedCases: results.filter(item => !item.passed), scope: report.scope }));
if (report.failed) process.exitCode = 1;
