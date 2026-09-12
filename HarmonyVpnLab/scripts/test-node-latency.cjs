'use strict';
// Authored ArkTS, transpiled with the installed SDK; synthetic SDK/file adapter.
// No HDC, real application files, node configuration or network is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourcePath = path.join(root, 'entry/src/main/ets/model/NodeLatency.ets');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(compiled.diagnostics.length, 0, 'SDK transpilation');
const protocolSourcePath = path.join(root, 'entry/src/main/ets/model/LatencyProtocol.ets');
const protocolSource = fs.readFileSync(protocolSourcePath, 'utf8');
const protocolCompiled = ts.transpileModule(protocolSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(protocolCompiled.diagnostics.length, 0, 'protocol SDK transpilation');
const dir = '/synthetic-private';
const destination = `${dir}/node-latency.json`;
const readError = '延迟记录损坏或无法读取，已保留原文件。';
const saveError = '延迟记录保存失败，原有记录未替换。';
const fingerprintError = '无法识别节点配置，未记录检测结果。';
const digest = 'a'.repeat(64);

function fixture() {
  const files = new Map();
  const handles = new Map();
  const state = { nextFd: 1, maxWrite: Infinity, fail: '', forcedWrite: undefined, cryptoFail: false,
    digestLength: 32, statSize: undefined, events: [], cryptoCalls: [] };
  const fileIo = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    accessSync: p => files.has(p),
    statSync: p => ({ size: state.statSize ?? files.get(p).byteLength, isFile: () => true }),
    readTextSync: p => files.get(p).toString('utf8'),
    openSync: p => {
      if (state.fail === 'open') throw Error('sensitive synthetic path');
      files.set(p, Buffer.alloc(0));
      const file = { fd: state.nextFd++ };
      handles.set(file.fd, p);
      state.events.push(['open', p]);
      return file;
    },
    writeSync: (fd, bytes) => {
      if (state.fail === 'write') throw Error('sensitive synthetic write');
      if (state.forcedWrite !== undefined) return state.forcedWrite;
      const p = handles.get(fd);
      const part = Buffer.from(bytes).subarray(0, state.maxWrite);
      files.set(p, Buffer.concat([files.get(p), part]));
      state.events.push(['write', part.length]);
      return part.length;
    },
    fsyncSync: fd => {
      state.events.push(['fsync', fd]);
      if (state.fail === 'fsync') throw Error('sensitive synthetic fsync');
    },
    closeSync: f => { handles.delete(f.fd); state.events.push(['close', f.fd]); },
    renameSync: (from, to) => {
      if (state.fail === 'rename') throw Error('sensitive synthetic rename');
      assert(files.has(from));
      files.set(to, files.get(from)); files.delete(from);
      state.events.push(['rename', from, to]);
    },
    unlinkSync: p => { files.delete(p); state.events.push(['unlink', p]); }
  };
  const exports = {};
  vm.runInNewContext(compiled.outputText, {
    exports, require: name => {
      if (name === '@kit.CoreFileKit') return { fileIo };
      if (name === '@kit.ArkTS') return { util: { generateRandomUUID: crypto.randomUUID,
        TextEncoder: class { encodeInto(value) { return new Uint8Array(Buffer.from(value, 'utf8')); } } } };
      if (name === '@kit.CryptoArchitectureKit') return { cryptoFramework: {
        createMd: algorithm => {
          state.cryptoCalls.push(algorithm); assert.equal(algorithm, 'SHA256');
          const hash = crypto.createHash('sha256');
          return {
            update: async ({ data }) => {
              if (state.cryptoFail) throw Error('sensitive synthetic crypto error');
              hash.update(data);
            },
            digest: async () => ({ data: new Uint8Array(hash.digest().subarray(0, state.digestLength)) })
          };
        }
      } };
      throw Error(`Unexpected import ${name}`);
    }, Uint8Array, Set, Map, Date, Number, Object, Array, JSON, Math, Error
  }, { filename: sourcePath });
  const protocol = {};
  vm.runInNewContext(protocolCompiled.outputText, {
    exports: protocol, require: name => {
      if (name === '@kit.CoreFileKit') return { fileIo };
      if (name === '@kit.ArkTS') return { util: { generateRandomUUID: crypto.randomUUID,
        TextEncoder: class { encodeInto(value) { return new Uint8Array(Buffer.from(value, 'utf8')); } } } };
      throw Error(`Unexpected protocol import ${name}`);
    }, Uint8Array, Set, Map, Date, Number, Object, Array, JSON, Math, Error
  }, { filename: protocolSourcePath });
  return { api: exports, protocol, files, handles, state,
    seed: value => files.set(destination, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))) };
}
function record(api, changes = {}) {
  return Object.assign(new api.NodeLatencyResult('n-example', digest, 'run-example', 'passed', 123.4, '', 100), changes);
}
function envelope(results, schemaVersion = 2) { return { schemaVersion, results }; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function legacy(value) {
  const result = plain(value);
  for (const field of ['measurementVersion', 'secondStatus', 'secondDurationMs', 'secondReason', 'secondConnection']) delete result[field];
  return result;
}
function paired(api, changes = {}) {
  return record(api, { measurementVersion: 2, secondStatus: 'passed', secondDurationMs: 321.5,
    secondReason: '', secondConnection: 'new', ...changes });
}
function proof(api, changes = {}) {
  return Object.assign(new api.LatencyProof('1789000000000', 'n-example', digest, 'passed', 123.4, '', 100,
    2, 'passed', 321.5, '', 'new'), changes);
}
function onlyDestination(f) { assert.deepEqual([...f.files.keys()], [destination]); assert.equal(f.handles.size, 0); }
const cases = [];
async function test(name, body) { await body(); cases.push({ name, passed: true }); }

(async () => {
  await test('SHA-256 known UTF-8 vectors and exact configuration identity', async () => {
    const f = fixture();
    assert.equal(await f.api.fingerprintOutbound('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(await f.api.fingerprintOutbound('节点'), crypto.createHash('sha256').update('节点').digest('hex'));
    assert.notEqual(await f.api.fingerprintOutbound('{"a":1}'), await f.api.fingerprintOutbound('{ "a":1}'));
    assert.notEqual(await f.api.fingerprintOutbound('{"a":1}'), await f.api.fingerprintOutbound('{"a":2}'));
    assert.equal(f.files.size, 0);
  });
  await test('Fingerprint rejects empty, non-string and UTF-8 byte overflow without disclosure', async () => {
    const f = fixture();
    for (const value of ['', undefined, null, 123, 'a'.repeat(65537), '中'.repeat(22000)]) {
      await assert.rejects(f.api.fingerprintOutbound(value), e => e.message === fingerprintError);
    }
    assert.equal((await f.api.fingerprintOutbound('a'.repeat(65536))).length, 64);
    f.state.cryptoFail = true;
    await assert.rejects(f.api.fingerprintOutbound('synthetic'), e => e.message === fingerprintError);
    f.state.cryptoFail = false; f.state.digestLength = 31;
    await assert.rejects(f.api.fingerprintOutbound('synthetic'), e => e.message === fingerprintError);
  });
  await test('Missing file is empty; record round trip stores only fixed non-secret fields', () => {
    const f = fixture(); assert.deepEqual(plain(f.api.readNodeLatencies(dir)), []);
    f.api.saveNodeLatency(dir, record(f.api)); onlyDestination(f);
    assert.deepEqual(plain(f.api.readNodeLatencies(dir)), [plain(record(f.api))]);
    const text = f.files.get(destination).toString();
    assert.equal(text.includes('outboundJson'), false); assert.equal(text.includes('password'), false);
    assert.equal(text.includes('https://'), false);
  });
  await test('Each node keeps its newest result; out-of-order completion cannot overwrite it', () => {
    const f = fixture();
    f.api.saveNodeLatency(dir, record(f.api, { checkedAt: 200, durationMs: 300 }));
    const before = f.files.get(destination);
    f.api.saveNodeLatency(dir, record(f.api, { checkedAt: 100, durationMs: 1 }));
    assert.equal(f.files.get(destination), before);
    f.api.saveNodeLatency(dir, record(f.api, { checkedAt: 300, status: 'failed', reason: 'https', durationMs: 0 }));
    assert.equal(f.api.readNodeLatencies(dir).length, 1);
    assert.equal(f.api.readNodeLatencies(dir)[0].status, 'failed');
    f.api.saveNodeLatency(dir, record(f.api, { nodeId: 'n-second', checkedAt: 400 }));
    assert.deepEqual(plain(f.api.readNodeLatencies(dir).map(x => x.nodeId)), ['n-second', 'n-example']);
  });
  await test('Bounded history evicts oldest after 500 distinct nodes', () => {
    const f = fixture();
    f.seed(envelope(Array.from({ length: 500 }, (_, index) => record(f.api, { nodeId: `n-${index}`, checkedAt: index }))));
    f.api.saveNodeLatency(dir, record(f.api, { nodeId: 'n-new', checkedAt: 501 }));
    const values = f.api.readNodeLatencies(dir);
    assert.equal(values.length, 500); assert.equal(values[0].nodeId, 'n-new');
    assert.equal(values.some(x => x.nodeId === 'n-0'), false);
    assert(f.files.get(destination).length <= 256 * 1024);
  });
  await test('Partial writes complete before fsync, close and atomic rename; temporary paths are unique', () => {
    const f = fixture(); f.state.maxWrite = 7;
    f.api.saveNodeLatency(dir, record(f.api)); onlyDestination(f);
    assert.deepEqual(plain(f.api.readNodeLatencies(dir)), [plain(record(f.api))]);
    const order = f.state.events.map(x => x[0]);
    assert(order.filter(x => x === 'write').length > 10);
    assert(order.lastIndexOf('write') < order.indexOf('fsync'));
    assert(order.indexOf('fsync') < order.indexOf('close'));
    assert(order.indexOf('close') < order.indexOf('rename'));
    f.api.saveNodeLatency(dir, record(f.api, { checkedAt: 101 }));
    const names = f.state.events.filter(x => x[0] === 'open').map(x => x[1]);
    assert.equal(new Set(names).size, 2); onlyDestination(f);
  });
  await test('Open, write, fsync and rename failure preserve committed snapshot and hide native error', () => {
    for (const operation of ['open', 'write', 'fsync', 'rename']) {
      const f = fixture(); f.api.saveNodeLatency(dir, record(f.api));
      const before = f.files.get(destination).toString(); f.state.fail = operation;
      assert.throws(() => f.api.saveNodeLatency(dir, record(f.api, { checkedAt: 101 })), e => e.message === saveError);
      assert.equal(f.files.get(destination).toString(), before); onlyDestination(f);
    }
  });
  await test('Invalid partial-write return does not loop or replace committed snapshot', () => {
    for (const value of [0, -1, 0.5, NaN, Infinity, 999999]) {
      const f = fixture(); f.api.saveNodeLatency(dir, record(f.api));
      const before = f.files.get(destination).toString(); f.state.forcedWrite = value;
      assert.throws(() => f.api.saveNodeLatency(dir, record(f.api, { checkedAt: 101 })), e => e.message === saveError);
      assert.equal(f.files.get(destination).toString(), before); onlyDestination(f);
    }
  });
  await test('Invalid record fields, status/reason, fingerprint, duration and extra keys are rejected', () => {
    const changes = [
      { nodeId: '../secret' }, { nodeId: '' }, { nodeId: 'a'.repeat(97) }, { runId: 'https://sensitive' },
      { outboundFingerprint: 'A'.repeat(64) }, { outboundFingerprint: '0'.repeat(63) },
      { checkedAt: -1 }, { checkedAt: NaN }, { checkedAt: 1.5 }, { checkedAt: Number.MAX_SAFE_INTEGER + 1 },
      { status: 'pending' }, { status: 'failed' }, { reason: 'https://private' }, { reason: 'dns' },
      { durationMs: -1 }, { durationMs: 60001 }, { durationMs: Infinity }, { durationMs: '123' },
      { password: 'synthetic-secret' }
    ];
    for (const change of changes) {
      const f = fixture(); const value = record(f.api, change);
      assert.throws(() => f.api.saveNodeLatency(dir, value), e => e.message === saveError);
      assert.equal(f.files.size, 0);
      f.seed(envelope([value]));
      assert.throws(() => f.api.readNodeLatencies(dir), e => e.message === readError);
    }
  });
  await test('Corrupt, duplicate, unsupported and oversized files fail closed and are never overwritten', () => {
    const f = fixture();
    const values = ['invalid', null, [], {}, { schemaVersion: 3, results: [] },
      { schemaVersion: 1, results: [], extra: 'private' }, envelope([record(f.api), record(f.api)]),
      envelope(Array.from({ length: 501 }, (_, i) => record(f.api, { nodeId: `n-${i}` }))),
      ' '.repeat(256 * 1024 + 1)];
    for (const value of values) {
      f.seed(value); const before = f.files.get(destination).toString();
      assert.throws(() => f.api.readNodeLatencies(dir), e => e.message === readError);
      assert.throws(() => f.api.saveNodeLatency(dir, record(f.api)), e => e.message === saveError);
      assert.equal(f.files.get(destination).toString(), before); onlyDestination(f);
    }
  });
  await test('Reader bounds both stat size and actual UTF-8 bytes', () => {
    for (const size of [-1, 1.5, NaN, Infinity, 256 * 1024 + 1]) {
      const f = fixture(); f.seed(envelope([])); f.state.statSize = size;
      assert.throws(() => f.api.readNodeLatencies(dir), e => e.message === readError);
    }
    const f = fixture(); f.seed('中'.repeat(90000)); f.state.statSize = 1;
    assert.throws(() => f.api.readNodeLatencies(dir), e => e.message === readError);
  });
  await test('Labels distinguish untested, success, failure and cancellation; failure is never 0 ms', () => {
    const f = fixture(); assert.equal(f.api.latencyLabel(), '未检测');
    assert.equal(f.api.latencyLabel(record(f.api)), '首次 HTTPS 123 ms');
    assert.equal(f.api.latencyLabel(record(f.api, { durationMs: 60000 })), '首次 HTTPS 60000 ms');
    assert.equal(f.api.latencyLabel(record(f.api, { durationMs: 0 })), '首次 HTTPS 0 ms');
    for (const status of ['failed', 'cancelled']) for (const reason of ['dns', 'https', 'timeout', 'network-changed', 'stopped', 'configuration', 'internal']) {
      const label = f.api.latencyLabel(record(f.api, { status, reason, durationMs: 0 }));
      assert(label.startsWith(status === 'failed' ? '失败：' : '已取消：')); assert.equal(label.includes(' ms'), false);
    }
    assert.equal(f.api.latencyLabel(record(f.api, { status: 'failed', reason: 'private message' })), '检测记录无效');
  });
  await test('Old schema1 records normalize only in memory without inventing a second request', () => {
    const f = fixture(); const old = legacy(record(f.api)); f.seed(envelope([old], 1));
    const before = f.files.get(destination), events = f.state.events.length;
    const a = f.api.readNodeLatencies(dir), b = f.api.readNodeLatencies(dir);
    assert.deepEqual(plain(a), [plain(record(f.api))]); assert.deepEqual(plain(b), plain(a));
    assert.equal(a[0].durationMs, old.durationMs); assert.equal(a[0].checkedAt, old.checkedAt);
    assert.equal(a[0].measurementVersion, 1); assert.equal(a[0].secondStatus, 'not-tested');
    assert.equal(a[0].secondConnection, 'unknown'); assert.equal(Object.keys(a[0]).length, 12);
    assert.equal(f.files.get(destination), before); assert.equal(f.state.events.length, events);
    assert.equal(f.api.latencySecondaryLabel(a[0]), '复用延迟 未检测（旧记录）');
  });
  await test('Outdated completion cannot write even when existing history needs in-memory migration', () => {
    const f = fixture(); f.seed(envelope([legacy(record(f.api, { checkedAt: 500 }))], 1));
    const before = f.files.get(destination);
    f.api.saveNodeLatency(dir, paired(f.api, { checkedAt: 100 }));
    assert.equal(f.files.get(destination), before); assert.equal(f.state.events.length, 0);
    assert.equal(JSON.parse(before).schemaVersion, 1);
  });
  await test('Next actual save atomically upgrades schema1 and retains untouched legacy measurements', () => {
    const f = fixture(); const old = legacy(record(f.api)); f.seed(envelope([old], 1)); f.state.maxWrite = 7;
    f.api.saveNodeLatency(dir, paired(f.api, { nodeId: 'n-new', checkedAt: 200 })); onlyDestination(f);
    const raw = JSON.parse(f.files.get(destination)); assert.equal(raw.schemaVersion, 2);
    assert(raw.results.every(r => Object.keys(r).length === 12));
    const saved = f.api.readNodeLatencies(dir);
    assert.deepEqual(plain(saved[0]), plain(paired(f.api, { nodeId: 'n-new', checkedAt: 200 })));
    assert.deepEqual(legacy(saved[1]), old); assert.equal(saved[1].measurementVersion, 1);
    assert.equal(saved[1].secondConnection, 'unknown');
  });
  await test('Storage schema and measurement version are separate; mixed old/new shapes fail closed', () => {
    const f = fixture(); const modern = record(f.api), old = legacy(modern);
    for (const value of [envelope([modern], 1), envelope([old], 2), envelope([old, paired(f.api)], 1),
      envelope([{ ...old, measurementVersion: 1 }], 1), envelope([{ ...old, secondStatus: 'not-tested' }], 2)]) {
      f.seed(value); const before = f.files.get(destination);
      assert.throws(() => f.api.readNodeLatencies(dir), e => e.message === readError);
      assert.throws(() => f.api.saveNodeLatency(dir, paired(f.api)), e => e.message === saveError);
      assert.equal(f.files.get(destination), before); onlyDestination(f);
    }
    f.seed(envelope([modern], 2)); assert.equal(f.api.readNodeLatencies(dir)[0].measurementVersion, 1);
  });
  await test('V2 preserves both timings including slower second requests and all connection kinds', () => {
    for (const duration of [0, 0.25, 321.5, 60000]) for (const connection of ['reused', 'new', 'unknown']) {
      const f = fixture(), value = paired(f.api, { secondDurationMs: duration, secondConnection: connection });
      f.api.saveNodeLatency(dir, value); assert.deepEqual(plain(f.api.readNodeLatencies(dir)[0]), plain(value));
      assert.equal(f.api.readNodeLatencies(dir)[0].durationMs, 123.4);
      const p = proof(f.protocol, { secondDurationMs: duration, secondConnection: connection });
      f.protocol.writeLatencyProof(dir, p);
      assert.deepEqual(plain(f.protocol.readLatencyProof(dir)), plain(p));
      assert.equal(Object.keys(JSON.parse(f.files.get(`${dir}/latency-proof.json`))).length, 12);
    }
  });
  await test('Second failure keeps a valid first result and writes explicit timeout or HTTPS failure', () => {
    for (const reason of ['https', 'timeout']) {
      const f = fixture(), value = paired(f.api, { secondStatus: 'failed', secondDurationMs: 0,
        secondReason: reason, secondConnection: 'unknown' });
      f.api.saveNodeLatency(dir, value); assert.deepEqual(plain(f.api.readNodeLatencies(dir)[0]), plain(value));
      const p = proof(f.protocol, { secondStatus: 'failed', secondDurationMs: 0,
        secondReason: reason, secondConnection: 'unknown' });
      f.protocol.writeLatencyProof(dir, p); assert.deepEqual(plain(f.protocol.readLatencyProof(dir)), plain(p));
    }
  });
  await test('Non-successful overall results permit only default untested second fields in either version', () => {
    for (const version of [1, 2]) for (const status of ['failed', 'cancelled']) {
      const f = fixture(), value = record(f.api, { measurementVersion: version, status, reason: 'stopped', durationMs: 0 });
      f.api.saveNodeLatency(dir, value); assert.deepEqual(plain(f.api.readNodeLatencies(dir)[0]), plain(value));
      const p = proof(f.protocol, { measurementVersion: version, status, reason: 'stopped', durationMs: 0,
        secondStatus: 'not-tested', secondDurationMs: 0, secondReason: '', secondConnection: 'unknown' });
      f.protocol.writeLatencyProof(dir, p); assert.deepEqual(plain(f.protocol.readLatencyProof(dir)), plain(p));
    }
  });
  await test('Invalid secondary field types and cross-field combinations are rejected identically by both stores', () => {
    const changes = [
      ...[0, 3, '2', true, null, undefined, NaN].map(value => ({ measurementVersion: value })),
      { measurementVersion: 1 }, { secondStatus: 'not-tested', secondDurationMs: 0, secondConnection: 'unknown' },
      ...['cancelled', 'pending', '', null, undefined].map(value => ({ secondStatus: value })),
      ...[-1, 60001, Infinity, NaN, '12', null, undefined].map(value => ({ secondDurationMs: value })),
      ...['https', 'timeout', null, undefined].map(value => ({ secondReason: value })),
      ...['reuse', 'direct', '', true, null, undefined].map(value => ({ secondConnection: value })),
      { secondStatus: 'failed', secondDurationMs: 1, secondReason: 'https', secondConnection: 'unknown' },
      { secondStatus: 'failed', secondDurationMs: 0, secondReason: '', secondConnection: 'unknown' },
      { secondStatus: 'failed', secondDurationMs: 0, secondReason: 'dns', secondConnection: 'unknown' },
      { secondStatus: 'failed', secondDurationMs: 0, secondReason: 'timeout', secondConnection: 'reused' },
      { status: 'failed', reason: 'https' }, { status: 'cancelled', reason: 'stopped' },
      { secret: 'synthetic-private' }
    ];
    for (const change of changes) {
      const f = fixture(), bad = paired(f.api, change), p = proof(f.protocol, change);
      assert.throws(() => f.api.saveNodeLatency(dir, bad), e => e.message === saveError);
      assert.throws(() => f.protocol.writeLatencyProof(dir, p), e => e.message === 'LATENCY_PROTOCOL_WRITE_FAILED');
      assert.equal(f.files.size, 0);
      f.seed(envelope([bad])); const before = f.files.get(destination);
      assert.throws(() => f.api.readNodeLatencies(dir), e => e.message === readError); assert.equal(f.files.get(destination), before);
      f.files.set(`${dir}/latency-proof.json`, Buffer.from(JSON.stringify(p)));
      assert.throws(() => f.protocol.readLatencyProof(dir), e => e.message === 'LATENCY_PROTOCOL_READ_FAILED');
    }
  });
  await test('V1 rejects each non-default secondary field instead of pretending it was measured', () => {
    for (const change of [{ secondStatus: 'passed' }, { secondDurationMs: 1 }, { secondReason: 'timeout' }, { secondConnection: 'reused' }]) {
      const f = fixture(), value = record(f.api, change);
      assert.throws(() => f.api.saveNodeLatency(dir, value), e => e.message === saveError);
      const p = new f.protocol.LatencyProof('1789000000000', 'n-example', digest, 'passed', 123, '', 100);
      Object.assign(p, change);
      assert.throws(() => f.protocol.writeLatencyProof(dir, p), e => e.message === 'LATENCY_PROTOCOL_WRITE_FAILED');
      assert.equal(f.files.size, 0);
    }
  });
  await test('Protocol old seven-key proof reads as v1 without writing and new twelve-key proof round trips', () => {
    const f = fixture(), p = new f.protocol.LatencyProof('1789000000000', 'n-example', digest, 'passed', 2345, '', 100);
    const target = `${dir}/latency-proof.json`, old = legacy(p), bytes = Buffer.from(JSON.stringify(old));
    f.files.set(target, bytes); const restored = f.protocol.readLatencyProof(dir);
    assert.deepEqual(plain(restored), plain(p)); assert.equal(f.files.get(target), bytes); assert.equal(f.state.events.length, 0);
    assert.throws(() => f.protocol.writeLatencyProof(dir, old), e => e.message === 'LATENCY_PROTOCOL_WRITE_FAILED');
    f.protocol.writeLatencyProof(dir, restored); assert.equal(Object.keys(JSON.parse(f.files.get(target))).length, 12);
    const partial = { ...old, measurementVersion: 1 }; f.files.set(target, Buffer.from(JSON.stringify(partial)));
    assert.throws(() => f.protocol.readLatencyProof(dir), e => e.message === 'LATENCY_PROTOCOL_READ_FAILED');
  });
  await test('Protocol identity, fixed-field copying and atomic failure remain intact with both measurements', () => {
    const target = `${dir}/latency-proof.json`;
    for (const failure of ['open', 'write', 'fsync', 'rename']) {
      const f = fixture(); f.protocol.writeLatencyProof(dir, proof(f.protocol));
      const bytes = f.files.get(target); f.state.fail = failure;
      assert.throws(() => f.protocol.writeLatencyProof(dir, proof(f.protocol, { checkedAt: 101, secondDurationMs: 4 })),
        e => e.message === 'LATENCY_PROTOCOL_WRITE_FAILED');
      assert.equal(f.files.get(target), bytes); assert.equal(f.handles.size, 0);
      assert.equal([...f.files.keys()].filter(name => name.endsWith('.tmp')).length, 0);
    }
    const f = fixture();
    for (const change of [{ runId: 'run-example' }, { nodeId: '../escape' }, { outboundFingerprint: 'A'.repeat(64) }]) {
      assert.throws(() => f.protocol.writeLatencyProof(dir, proof(f.protocol, change)), e => e.message === 'LATENCY_PROTOCOL_WRITE_FAILED');
    }
    const value = paired(f.api); Object.setPrototypeOf(value, { toJSON: () => ({ private: 'synthetic-secret' }) });
    f.api.saveNodeLatency(dir, value); assert.equal(f.files.get(destination).toString().includes('synthetic-secret'), false);
    const p = proof(f.protocol); Object.setPrototypeOf(p, { toJSON: () => ({ private: 'synthetic-secret' }) });
    f.protocol.writeLatencyProof(dir, p); assert.equal(f.files.get(target).toString().includes('synthetic-secret'), false);
    assert.equal(f.protocol.readLatencyProof(dir).secondDurationMs, 321.5);
  });
  await test('Atomic upgrade failure keeps old seven-field history rather than partially migrating it', () => {
    for (const failure of ['open', 'write', 'fsync', 'rename']) {
      const f = fixture(); f.seed(envelope([legacy(record(f.api))], 1)); const before = f.files.get(destination);
      f.state.fail = failure;
      assert.throws(() => f.api.saveNodeLatency(dir, paired(f.api, { checkedAt: 101 })), e => e.message === saveError);
      assert.equal(f.files.get(destination), before); assert.equal(JSON.parse(before).schemaVersion, 1); onlyDestination(f);
    }
  });
  await test('Secondary labels distinguish measured reuse, new or unconfirmed connection, old data and failure', () => {
    const f = fixture(); assert.equal(f.api.latencySecondaryLabel(), '');
    assert.equal(f.api.latencySecondaryLabel(record(f.api)), '复用延迟 未检测（旧记录）');
    assert.equal(f.api.latencySecondaryLabel(paired(f.api, { secondConnection: 'reused' })), '复用延迟 322 ms');
    assert.equal(f.api.latencySecondaryLabel(paired(f.api, { secondConnection: 'new' })), '再次 HTTPS 322 ms（新建连接）');
    assert.equal(f.api.latencySecondaryLabel(paired(f.api, { secondConnection: 'unknown' })), '再次 HTTPS 322 ms（复用未确认）');
    assert.equal(f.api.latencySecondaryLabel(paired(f.api, { secondDurationMs: 0, secondConnection: 'reused' })), '复用延迟 0 ms');
    for (const [reason, text] of [['timeout', '复用检测超时'], ['https', '复用检测未通过']]) {
      assert.equal(f.api.latencySecondaryLabel(paired(f.api, { secondStatus: 'failed', secondDurationMs: 0,
        secondReason: reason, secondConnection: 'unknown' })), text);
    }
    assert.equal(f.api.latencySecondaryLabel(record(f.api, { status: 'failed', reason: 'https' })), '');
    assert.equal(f.api.latencySecondaryLabel(paired(f.api, { secondReason: 'private error' })), '');
  });
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), synthetic: true,
    testedFile: 'entry/src/main/ets/model/NodeLatency.ets',
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    protocolSourceSha256: crypto.createHash('sha256').update(protocolSource).digest('hex'),
    passed: cases.length, failed: 0, cases };
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/node-latency-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Node latency: ${cases.length}/${cases.length} synthetic cases passed (no network/device/private files).`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
