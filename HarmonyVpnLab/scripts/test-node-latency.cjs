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
    statSync: p => ({ size: state.statSize ?? files.get(p).byteLength }),
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
  return { api: exports, files, handles, state,
    seed: value => files.set(destination, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))) };
}
function record(api, changes = {}) {
  return Object.assign(new api.NodeLatencyResult('n-example', digest, 'run-example', 'passed', 123.4, '', 100), changes);
}
function envelope(results) { return { schemaVersion: 1, results }; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
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
    const values = ['invalid', null, [], {}, { schemaVersion: 2, results: [] },
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
    assert.equal(f.api.latencyLabel(record(f.api)), 'HTTPS 123 ms');
    assert.equal(f.api.latencyLabel(record(f.api, { durationMs: 60000 })), 'HTTPS 60000 ms');
    assert.equal(f.api.latencyLabel(record(f.api, { durationMs: 0 })), 'HTTPS 0 ms');
    for (const status of ['failed', 'cancelled']) for (const reason of ['dns', 'https', 'timeout', 'network-changed', 'stopped', 'configuration', 'internal']) {
      const label = f.api.latencyLabel(record(f.api, { status, reason, durationMs: 0 }));
      assert(label.startsWith(status === 'failed' ? '失败：' : '已取消：')); assert.equal(label.includes(' ms'), false);
    }
    assert.equal(f.api.latencyLabel(record(f.api, { status: 'failed', reason: 'private message' })), '检测记录无效');
  });
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), synthetic: true,
    testedFile: 'entry/src/main/ets/model/NodeLatency.ets',
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    passed: cases.length, failed: 0, cases };
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/node-latency-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Node latency: ${cases.length}/${cases.length} synthetic cases passed (no network/device/private files).`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
