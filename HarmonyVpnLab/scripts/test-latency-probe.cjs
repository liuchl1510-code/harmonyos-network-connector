'use strict';
// Executes actual authored ArkTS protocol/probe modules through the DevEco SDK
// transpiler. All HTTP responses, files, clocks and timers are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const names = ['model/LatencyProtocol.ets', 'model/LatencyProbe.ets'];
const sources = new Map(names.map(name => [name, fs.readFileSync(path.join(root, 'entry/src/main/ets', name), 'utf8')]));
const scripts = new Map([...sources].map(([name, text]) => {
  const result = ts.transpileModule(text.replace(/^import[^\n]*\n/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
  });
  assert.equal(result.diagnostics.length, 0, 'SDK transpilation: ' + name); return [name, result.outputText];
}));
const runId = '1789000000000', nodeId = 'synthetic-node_01', fingerprint = 'a'.repeat(64);
const privateText = 'synthetic-never-export-this';
const goodResponse = () => ({ responseCode: 200,
  result: 'fl=synthetic\nh=www.cloudflare.com\nip=192.0.2.123\nvisit_scheme=https\n' });
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function flush() { for (let count = 0; count < 12; count++) await Promise.resolve(); }

function scenario(options = {}) {
  const files = new Map(), handles = new Map(), timers = new Map();
  let nextFd = 50, uuid = 1, nextTimer = 1;
  const clock = { now: 1789000000500, uptime: 10000, current: true };
  const faults = { ...options };
  const calls = { create: 0, request: [], destroy: 0, fs: [], timerCreated: 0, timerCleared: [] };
  const pending = deferred();
  const pendingRequests = [pending];
  function fail(op) { if (faults.fail === op) throw new Error(privateText); }
  const fakeFs = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    accessSync(name) { fail('access'); return files.has(name); },
    statSync(name) { fail('stat'); return { size: files.get(name).length, isFile: () => true }; },
    readTextSync(name, opts) { fail('read'); calls.fs.push({ op: 'read', length: opts.length }); return files.get(name).subarray(0, opts.length).toString(); },
    openSync(name, flags) { fail('open'); assert.equal(flags, 7); files.set(name, Buffer.alloc(0)); const fd = nextFd++;
      handles.set(fd, name); calls.fs.push({ op: 'open', name }); return { fd }; },
    writeSync(fd, data) { fail('write'); const name = handles.get(fd); assert.ok(name); const bytes = Buffer.from(data);
      if (faults.written !== undefined) return faults.written;
      const length = Math.min(7, bytes.length); files.set(name, Buffer.concat([files.get(name), bytes.subarray(0, length)]));
      calls.fs.push({ op: 'write' }); return length; },
    fsyncSync(fd) { fail('fsync'); assert.ok(handles.has(fd)); calls.fs.push({ op: 'fsync' }); },
    closeSync(file) { handles.delete(file.fd); calls.fs.push({ op: 'close' }); fail('close'); },
    renameSync(from, to) { fail('rename'); assert.equal(handles.size, 0); files.set(to, files.get(from)); files.delete(from); calls.fs.push({ op: 'rename' }); },
    unlinkSync(name) { files.delete(name); }
  };
  class FakeDate extends Date { static now() { return clock.now; } }
  const shared = { fs: fakeFs, Date: FakeDate,
    util: { generateRandomUUID: () => 'synthetic-' + uuid++, TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } } },
    systemDateTime: { TimeType: { STARTUP: 0 }, getUptime(type, nanoseconds) {
      assert.equal(type, 0); assert.equal(nanoseconds, false); fail('clock'); return clock.uptime;
    } },
    setTimeout(fn, ms) { calls.timerCreated++; fail('setTimeout');
      if (faults.failTimerAt === calls.timerCreated) throw new Error(privateText);
      const id = nextTimer++; timers.set(id, { fn, ms, repeat: false }); return id; },
    clearTimeout(id) { calls.timerCleared.push(id); fail('clearTimeout-retains'); timers.delete(id);
      if (faults.advanceAfterClearAt === calls.timerCleared.length) clock.uptime += faults.advanceAfterClearMs;
      if (faults.cancelAfterClearAt === calls.timerCleared.length) clock.current = false;
      fail('clearTimeout'); },
    setInterval(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms, repeat: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    http: { RequestMethod: { GET: 0 }, HttpDataType: { STRING: 1 }, createHttp() {
      calls.create++; fail('create'); return {
        request(url, opts) { const index = calls.request.length; calls.request.push({ url, opts }); fail('request');
          if (faults.failRequestAt === index + 1) throw new Error(privateText);
          pendingRequests[index] ??= deferred(); return pendingRequests[index].promise; },
        destroy() { calls.destroy++; fail('destroy'); if (faults.destroyAlsoThrows) throw new Error(privateText); }
      };
    } }
  };
  function load(name) { const exported = {};
    vm.runInNewContext(scripts.get(name), { ...shared, exports: exported, module: { exports: exported } }, { filename: name });
    Object.assign(shared, exported); return exported;
  }
  const protocol = load(names[0]), probe = load(names[1]);
  const request = new protocol.LatencyRequest(runId, nodeId, fingerprint);
  return { files, handles, timers, clock, faults, calls, pending, pendingRequests, protocol, probe, request,
    measure(current = () => clock.current) { return probe.measureNodeLatency(request, current); },
    fire(ms) { const found = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(found, 'timer ' + ms);
      if (!found[1].repeat) timers.delete(found[0]); found[1].fn(); },
    writeRaw(name, value) { files.set('/synthetic/' + name, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); }
  };
}

function safeError(fn, message) { assert.throws(fn, error => error.message === message && !String(error).includes(privateText)); }
function cleaned(s) { assert.equal(s.calls.destroy, s.calls.create); assert.equal(s.timers.size, 0); }
function failedProof(s, proof, reason) {
  assert.equal(proof.status, 'failed'); assert.equal(proof.reason, reason);
  assert.equal(proof.measurementVersion, 2); assert.equal(proof.secondStatus, 'not-tested');
  assert.equal(proof.secondDurationMs, 0); assert.equal(proof.secondReason, ''); assert.equal(proof.secondConnection, 'unknown');
  assert.equal(proof.runId, runId); assert.equal(proof.nodeId, nodeId); assert.equal(proof.outboundFingerprint, fingerprint);
  assert.ok(!JSON.stringify(proof).includes(privateText)); cleaned(s);
}
const tests = [];
function test(name, body) { tests.push({ name, body }); }
async function secondResponse(s, response = goodResponse(), elapsed = 23) {
  await flush(); assert.equal(s.calls.request.length, 2, 'second request must follow a valid first response');
  s.clock.uptime += elapsed; s.pendingRequests[1].resolve(response);
}
function dualProof(s, proof, firstMs, secondStatus, secondMs, secondReason = '', connection = 'unknown') {
  assert.equal(proof.status, 'passed'); assert.equal(proof.reason, ''); assert.equal(proof.measurementVersion, 2);
  assert.equal(proof.durationMs, firstMs); assert.equal(proof.secondStatus, secondStatus);
  assert.equal(proof.secondDurationMs, secondMs); assert.equal(proof.secondReason, secondReason);
  assert.equal(proof.secondConnection, connection); assert.equal(s.calls.create, 1); cleaned(s);
  assert(!JSON.stringify(proof).includes(privateText)); assert(!JSON.stringify(proof).includes('192.0.2.123'));
}

test('protocol missing files return undefined', () => {
  const s = scenario(); assert.equal(s.protocol.readLatencyRequest('/synthetic'), undefined);
  assert.equal(s.protocol.readLatencyProof('/synthetic'), undefined); assert.equal(s.files.size, 0);
});
test('request and proof retain only exact identities, status, duration and timestamps', () => {
  const s = scenario(); s.protocol.writeLatencyRequest('/synthetic', s.request);
  const proof = new s.protocol.LatencyProof(runId, nodeId, fingerprint, 'passed', 12.5, '');
  s.protocol.writeLatencyProof('/synthetic', proof);
  assert.deepEqual(plain(s.protocol.readLatencyRequest('/synthetic')), plain(s.request));
  assert.deepEqual(plain(s.protocol.readLatencyProof('/synthetic')), plain(proof));
  assert.equal(s.calls.fs.find(call => call.op === 'read').length, 8193); assert.equal(s.files.size, 2);
  for (const bytes of s.files.values()) assert.ok(bytes.length <= 8192);
  const ops = s.calls.fs.map(call => call.op); assert.ok(ops.filter(op => op === 'write').length > 2);
  assert.ok(ops.indexOf('fsync') < ops.indexOf('close')); assert.ok(ops.indexOf('close') < ops.indexOf('rename'));
});
test('request rejects extra fields, wrong IDs, hashes and timestamps without writing', () => {
  const variants = [{ extra: privateText }, { runId: '1789000000000\n' }, { runId: 'old-run' },
    { nodeId: 'https://secret.example.test' }, { nodeId: '' }, { nodeId: 'x'.repeat(97) },
    { outboundFingerprint: 'A'.repeat(64) }, { outboundFingerprint: 'a'.repeat(63) },
    { createdAt: NaN }, { createdAt: -1 }, { createdAt: 1.2 }, { createdAt: '123' }];
  for (const variant of variants) {
    const s = scenario(); Object.assign(s.request, variant);
    safeError(() => s.protocol.writeLatencyRequest('/synthetic', s.request), 'LATENCY_PROTOCOL_WRITE_FAILED'); assert.equal(s.files.size, 0);
  }
});
test('proof validates status/reason consistency and rejects arbitrary fields or raw errors', () => {
  const variants = [{ extra: privateText }, { status: 'passed', reason: 'https' }, { status: 'failed', reason: '' },
    { status: 'unknown' }, { reason: privateText }, { durationMs: Infinity }, { durationMs: -1 },
    { durationMs: 60001 }, { checkedAt: NaN }, { nodeId: '../private' }, { outboundFingerprint: privateText }];
  for (const variant of variants) {
    const s = scenario(); const proof = new s.protocol.LatencyProof(runId, nodeId, fingerprint, 'failed', 100, 'https');
    Object.assign(proof, variant);
    safeError(() => s.protocol.writeLatencyProof('/synthetic', proof), 'LATENCY_PROTOCOL_WRITE_FAILED'); assert.equal(s.files.size, 0);
  }
  for (const reason of ['dns', 'https', 'timeout', 'network-changed', 'stopped', 'configuration', 'internal']) {
    const s = scenario(); const proof = new s.protocol.LatencyProof(runId, nodeId, fingerprint, 'cancelled', 0, reason);
    s.protocol.writeLatencyProof('/synthetic', proof); assert.equal(s.protocol.readLatencyProof('/synthetic').reason, reason);
  }
});
test('protocol rejects corrupt roots, extra fields and oversized files with fixed safe errors', () => {
  for (const data of ['null', '[1]', '{', '{}', ' '.repeat(8193)]) {
    const s = scenario(); s.writeRaw('latency-request.json', data); s.writeRaw('latency-proof.json', data);
    safeError(() => s.protocol.readLatencyRequest('/synthetic'), 'LATENCY_PROTOCOL_READ_FAILED');
    safeError(() => s.protocol.readLatencyProof('/synthetic'), 'LATENCY_PROTOCOL_READ_FAILED');
    if (data.length > 8192) assert.equal(s.calls.fs.length, 0);
  }
  const s = scenario(); s.writeRaw('latency-request.json', { ...s.request, secret: privateText });
  safeError(() => s.protocol.readLatencyRequest('/synthetic'), 'LATENCY_PROTOCOL_READ_FAILED');
});
test('protocol write faults and short-write anomalies preserve the previous complete file', () => {
  for (const variant of [{ fail: 'open' }, { fail: 'write' }, { fail: 'fsync' }, { fail: 'close' },
    { fail: 'rename' }, { written: 0 }, { written: -1 }, { written: 100000 }, { written: 0.5 }]) {
    const s = scenario(variant); s.writeRaw('latency-request.json', 'old-complete-file');
    safeError(() => s.protocol.writeLatencyRequest('/synthetic', s.request), 'LATENCY_PROTOCOL_WRITE_FAILED');
    assert.equal(s.files.get('/synthetic/latency-request.json').toString(), 'old-complete-file');
    assert.equal(s.files.size, 1); assert.equal(s.handles.size, 0);
  }
});
test('protocol read I/O failures emit no native error details', () => {
  for (const fail of ['access', 'stat', 'read']) {
    const s = scenario({ fail }); s.writeRaw('latency-request.json', s.request);
    safeError(() => s.protocol.readLatencyRequest('/synthetic'), 'LATENCY_PROTOCOL_READ_FAILED');
  }
});
test('two complete HTTPS responses preserve independent monotonic durations instead of a minimum', async () => {
  const s = scenario(); s.request.createdAt -= 20000;
  const pending = s.measure(); assert.equal(s.calls.request.length, 1);
  s.clock.uptime += 245; s.clock.now -= 500000; s.pending.resolve(goodResponse());
  await secondResponse(s, { ...goodResponse(), connectionExtraInfo: { isReusedConnection: true } }, 23);
  const proof = await pending; assert.equal(proof.status, 'passed'); assert.equal(proof.reason, '');
  assert.equal(proof.durationMs, 245); assert.equal(proof.checkedAt, s.clock.now); cleaned(s);
  dualProof(s, proof, 245, 'passed', 23, '', 'reused');
  assert.deepEqual(Object.keys(proof).sort(), ['runId', 'nodeId', 'outboundFingerprint', 'status', 'durationMs', 'reason', 'checkedAt',
    'measurementVersion', 'secondStatus', 'secondDurationMs', 'secondReason', 'secondConnection'].sort());
  s.protocol.writeLatencyProof('/synthetic', proof); assert.deepEqual(plain(s.protocol.readLatencyProof('/synthetic')), plain(proof));
  assert.ok(!JSON.stringify(proof).includes('192.0.2.123'));
});
test('request uses fixed HTTPS destination, secure TLS defaults, no redirects or caching and bounded body', async () => {
  const s = scenario(); const pending = s.measure(); const call = s.calls.request[0];
  assert.equal(call.url, 'https://www.cloudflare.com/cdn-cgi/trace?latency=' + runId);
  assert.equal(call.opts.usingCache, false); assert.equal(call.opts.maxRedirects, 0); assert.equal(call.opts.maxLimit, 4096);
  assert.equal(call.opts.expectDataType, 1); assert.equal(call.opts.connectTimeout, 8000); assert.equal(call.opts.readTimeout, 8000);
  assert.deepEqual(Object.keys(call.opts).sort(), ['method', 'header', 'expectDataType', 'usingCache', 'maxRedirects', 'maxLimit', 'connectTimeout', 'readTimeout'].sort());
  assert.ok(!call.url.includes(nodeId)); assert.ok(!call.url.includes(fingerprint));
  s.pending.resolve(goodResponse()); await secondResponse(s);
  assert.equal(s.calls.request[1].url, call.url); assert.deepEqual(s.calls.request[1].opts, call.opts);
  assert.equal(s.calls.create, 1); await pending; cleaned(s);
});
test('wrong HTTP status, result type, host, scheme, empty IP and duplicate trace fields fail', async () => {
  const responses = [{ ...goodResponse(), responseCode: 302 }, { ...goodResponse(), responseCode: 500 },
    { responseCode: 200, result: new ArrayBuffer(5) }, { responseCode: 200, result: { secret: privateText } },
    { responseCode: 200, result: 'h=www.cloudflare.com.evil.test\nip=192.0.2.1\nvisit_scheme=https\n' },
    { responseCode: 200, result: 'h=www.cloudflare.com\nip=\nvisit_scheme=https\n' },
    { responseCode: 200, result: 'h=www.cloudflare.com\nip=192.0.2.1\nvisit_scheme=http\n' },
    { responseCode: 200, result: 'h=www.cloudflare.com\nip=192.0.2.1\n' },
    { responseCode: 200, result: goodResponse().result + 'h=www.cloudflare.com\n' },
    { responseCode: 200, result: goodResponse().result + 'ip=192.0.2.2\n' },
    { responseCode: 200, result: goodResponse().result + 'visit_scheme=https\n' },
    { responseCode: 200, result: privateText }];
  for (const response of responses) {
    const s = scenario(); const pending = s.measure(); s.clock.uptime += 50; s.pending.resolve(response);
    failedProof(s, await pending, 'https');
  }
});
test('body byte limit rejects long ASCII and multibyte text', async () => {
  for (const suffix of ['a'.repeat(4096), '汉'.repeat(1500)]) {
    const s = scenario(); const pending = s.measure(); s.pending.resolve({ responseCode: 200, result: goodResponse().result + suffix });
    failedProof(s, await pending, 'https');
  }
});
test('CRLF trace and IPv6 text remain acceptable without returning the address', async () => {
  const s = scenario(); const pending = s.measure();
  s.pending.resolve({ responseCode: 200, result: 'h=www.cloudflare.com\r\nip=2001:db8::1\r\nvisit_scheme=https\r\n' });
  await secondResponse(s);
  const proof = await pending; assert.equal(proof.status, 'passed'); assert.ok(!JSON.stringify(proof).includes('2001:db8')); cleaned(s);
});
test('deadline returns timeout, destroys request and safely consumes a late rejection', async () => {
  const s = scenario(); const pending = s.measure(); s.clock.uptime += 8000; s.fire(8000);
  const proof = await pending; failedProof(s, proof, 'timeout'); assert.equal(proof.durationMs, 8000);
  s.pending.reject(new Error(privateText)); await flush(); assert.equal(s.calls.destroy, 1);
});
test('a response or error after deadline is timeout even before delayed timer dispatch', async () => {
  for (const reject of [false, true]) {
    const s = scenario(); const pending = s.measure(); s.clock.uptime += 9000;
    if (reject) s.pending.reject(new Error(privateText)); else s.pending.resolve(goodResponse());
    failedProof(s, await pending, 'timeout');
  }
});
test('cancelled or invalid requests never create an HTTP request', async () => {
  const s = scenario(); s.clock.current = false; assert.equal(await s.measure(), undefined); assert.equal(s.calls.create, 0);
  s.clock.current = true; s.request.runId = 'arbitrary-private-value';
  assert.equal(await s.measure(), undefined); assert.equal(s.calls.create, 0); assert.equal(s.timers.size, 0);
});
test('cancellation polling settles promptly and a late response cannot become a proof', async () => {
  const s = scenario(); const pending = s.measure(); s.clock.current = false; s.fire(100);
  assert.equal(await pending, undefined); cleaned(s);
  s.clock.current = true; s.pending.resolve(goodResponse()); await flush(); assert.equal(s.calls.destroy, 1);
});
test('generation change at response time or a throwing guard suppresses evidence', async () => {
  const s = scenario(); const pending = s.measure(); s.clock.current = false; s.pending.resolve(goodResponse());
  assert.equal(await pending, undefined); cleaned(s);
  const before = scenario(); assert.equal(await before.measure(() => { throw new Error(privateText); }), undefined);
  assert.equal(before.calls.create, 0);
});
test('caller mutation cannot relabel a response for a different node or run', async () => {
  const s = scenario(); const pending = s.measure();
  s.request.nodeId = 'different-node'; s.request.outboundFingerprint = 'b'.repeat(64); s.request.runId = '1789000000001';
  s.pending.resolve(goodResponse()); await secondResponse(s); const proof = await pending;
  assert.equal(proof.runId, runId); assert.equal(proof.nodeId, nodeId); assert.equal(proof.outboundFingerprint, fingerprint); cleaned(s);
});
test('native HTTP errors become fixed https results without body or raw error text', async () => {
  const s = scenario(); const pending = s.measure(); s.pending.reject(new Error(privateText));
  failedProof(s, await pending, 'https');
  for (const fail of ['request', 'destroy', 'clock']) {
    const fault = scenario({ fail }); const task = fault.measure();
    if (fail === 'destroy') { fault.pending.resolve(goodResponse()); await secondResponse(fault); }
    failedProof(fault, await task, 'https');
  }
  const create = scenario({ fail: 'create' }); const proof = await create.measure();
  assert.equal(proof.reason, 'https'); assert.equal(create.calls.destroy, 0); assert.equal(create.timers.size, 0);
});
test('nonmonotonic or invalid uptime fails safely and destroys native request', async () => {
  for (const uptime of [9999, NaN, Infinity, -1]) {
    const s = scenario(); const pending = s.measure(); s.clock.uptime = uptime; s.pending.resolve(goodResponse());
    failedProof(s, await pending, 'https');
  }
});
test('late successful response after timeout remains inert and no response is written by probe', async () => {
  const s = scenario(); const pending = s.measure(); s.clock.uptime += 8000; s.fire(8000);
  const proof = await pending; s.pending.resolve(goodResponse()); await flush();
  assert.equal(proof.reason, 'timeout'); assert.equal(s.files.size, 0); assert.equal(s.calls.destroy, 1);
});

test('second response reports only an exact native boolean reuse flag', async () => {
  for (const [flag, expected] of [[true, 'reused'], [false, 'new'], [undefined, 'unknown'], [null, 'unknown'],
    [0, 'unknown'], [1, 'unknown'], ['true', 'unknown'], ['false', 'unknown'], [[], 'unknown'], [{}, 'unknown']]) {
    const s = scenario(), task = s.measure(); s.clock.uptime += 245; s.pending.resolve(goodResponse());
    await secondResponse(s, { ...goodResponse(), connectionExtraInfo: { isReusedConnection: flag } });
    dualProof(s, await task, 245, 'passed', 23, '', expected);
  }
});

test('missing or throwing connection metadata preserves successful second timing as unknown', async () => {
  for (const kind of ['missing', 'null', 'connection-getter', 'reuse-getter']) {
    const response = goodResponse();
    if (kind === 'null') response.connectionExtraInfo = null;
    if (kind === 'connection-getter') Object.defineProperty(response, 'connectionExtraInfo', { get() { throw new Error(privateText); } });
    if (kind === 'reuse-getter') response.connectionExtraInfo = Object.defineProperty({}, 'isReusedConnection', { get() { throw new Error(privateText); } });
    const s = scenario(), task = s.measure(); s.clock.uptime += 100; s.pending.resolve(goodResponse());
    await secondResponse(s, response, 40); dualProof(s, await task, 100, 'passed', 40);
  }
});

test('a slower second request is retained rather than replacing or averaging the first', async () => {
  const s = scenario(), task = s.measure(); s.clock.uptime += 20; s.pending.resolve(goodResponse());
  await secondResponse(s, { ...goodResponse(), connectionExtraInfo: { isReusedConnection: false } }, 330);
  dualProof(s, await task, 20, 'passed', 330, '', 'new');
});

test('both attempts keep bounded trace verification and discard all extra response metadata', async () => {
  const s = scenario(), task = s.measure(); s.clock.uptime += 120; s.pending.resolve(goodResponse());
  const response = { ...goodResponse(), cookies: privateText, header: { secret: privateText },
    connectionExtraInfo: { isReusedConnection: true, remoteIp: privateText, localIp: privateText, remotePort: 443 },
    performanceTiming: { remote: privateText } };
  await secondResponse(s, response, 30); const proof = await task;
  dualProof(s, proof, 120, 'passed', 30, '', 'reused'); assert.equal(Object.keys(proof).length, 12);
  assert.equal(s.files.size, 0); assert(!JSON.stringify(proof).includes('remotePort'));
});

test('second HTTP rejection retains first success but no second duration or raw reason', async () => {
  const s = scenario(), task = s.measure(); s.clock.uptime += 100; s.pending.resolve(goodResponse()); await flush();
  s.clock.uptime += 30; s.pendingRequests[1].reject(new Error(privateText)); const proof = await task;
  dualProof(s, proof, 100, 'failed', 0, 'https');
  s.protocol.writeLatencyProof('/synthetic', proof); assert.deepEqual(plain(s.protocol.readLatencyProof('/synthetic')), plain(proof));
});

test('second invalid or oversized response cannot report successful reuse', async () => {
  for (const response of [{ ...goodResponse(), responseCode: 204 }, { ...goodResponse(), responseCode: 302 },
    { ...goodResponse(), result: 'h=wrong.invalid\nip=192.0.2.1\nvisit_scheme=https\n' },
    { ...goodResponse(), result: goodResponse().result + 'ip=192.0.2.2\n' },
    { ...goodResponse(), result: goodResponse().result + 'a'.repeat(4096) },
    { ...goodResponse(), result: goodResponse().result + '汉'.repeat(1500) },
    { ...goodResponse(), result: { secret: privateText } }]) {
    response.connectionExtraInfo = { isReusedConnection: true };
    const s = scenario(), task = s.measure(); s.clock.uptime += 100; s.pending.resolve(goodResponse());
    await secondResponse(s, response); dualProof(s, await task, 100, 'failed', 0, 'https');
  }
});

test('second synchronous request failure does not erase a valid first measurement', async () => {
  const s = scenario({ failRequestAt: 2 }), task = s.measure(); s.clock.uptime += 80; s.pending.resolve(goodResponse());
  dualProof(s, await task, 80, 'failed', 0, 'https'); assert.equal(s.calls.request.length, 2);
});

test('second eight-second timeout retains first success and late outcomes stay inert', async () => {
  for (const reject of [false, true]) {
    const s = scenario(), task = s.measure(); s.clock.uptime += 170; s.pending.resolve(goodResponse()); await flush();
    assert.equal(s.calls.request.length, 2); s.clock.uptime += 8000; s.fire(8000); const proof = await task;
    dualProof(s, proof, 170, 'failed', 0, 'timeout'); const before = JSON.stringify(proof);
    if (reject) s.pendingRequests[1].reject(new Error(privateText)); else s.pendingRequests[1].resolve(goodResponse());
    await flush(); assert.equal(JSON.stringify(proof), before); assert.equal(s.calls.destroy, 1); assert.equal(s.files.size, 0);
  }
});

test('a late second response or error is timeout even before its timer dispatch', async () => {
  for (const reject of [false, true]) {
    const s = scenario(), task = s.measure(); s.clock.uptime += 100; s.pending.resolve(goodResponse()); await flush();
    s.clock.uptime += 9000;
    if (reject) s.pendingRequests[1].reject(new Error(privateText)); else s.pendingRequests[1].resolve(goodResponse());
    dualProof(s, await task, 100, 'failed', 0, 'timeout');
  }
});

test('first failure ends after one request while two near-eight-second successes fit the total bound', async () => {
  const failed = scenario(), failure = failed.measure(); failed.clock.uptime += 8000; failed.pending.resolve(goodResponse());
  failedProof(failed, await failure, 'timeout'); assert.equal(failed.calls.request.length, 1);
  const s = scenario(), task = s.measure(); s.clock.uptime += 7999; s.pending.resolve(goodResponse());
  await secondResponse(s, goodResponse(), 7999); dualProof(s, await task, 7999, 'passed', 7999);
  assert.equal(s.clock.uptime - 10000, 15998);
});

test('time between requests reduces the second deadline to respect sixteen seconds total', async () => {
  const s = scenario({ advanceAfterClearAt: 2, advanceAfterClearMs: 9000 }), task = s.measure();
  s.clock.uptime += 200; s.pending.resolve(goodResponse()); await flush();
  assert.equal(s.calls.request.length, 2); assert([...s.timers.values()].some(t => t.ms === 6800));
  s.clock.uptime += 6800; s.fire(6800); dualProof(s, await task, 200, 'failed', 0, 'timeout');
  assert.equal(s.clock.uptime - 10000, 16000);
});

test('no second network request is sent after the total deadline is already exhausted', async () => {
  const s = scenario({ advanceAfterClearAt: 2, advanceAfterClearMs: 16000 }), task = s.measure();
  s.clock.uptime += 200; s.pending.resolve(goodResponse()); dualProof(s, await task, 200, 'failed', 0, 'timeout');
  assert.equal(s.calls.request.length, 1);
});

test('cancellation between attempts suppresses the first success instead of persisting partial evidence', async () => {
  const s = scenario({ cancelAfterClearAt: 2 }), task = s.measure(); s.clock.uptime += 100; s.pending.resolve(goodResponse());
  assert.equal(await task, undefined); assert.equal(s.calls.request.length, 1); cleaned(s);
});

test('cancellation while the second request is active consumes either late outcome without a proof', async () => {
  for (const reject of [false, true]) {
    const s = scenario(), task = s.measure(); s.clock.uptime += 100; s.pending.resolve(goodResponse()); await flush();
    s.clock.current = false; s.fire(100); assert.equal(await task, undefined); cleaned(s);
    s.clock.current = true;
    if (reject) s.pendingRequests[1].reject(new Error(privateText)); else s.pendingRequests[1].resolve(goodResponse());
    await flush(); assert.equal(s.calls.destroy, 1); assert.equal(s.files.size, 0);
  }
});

test('second response identity change or throwing current guard suppresses both measurements', async () => {
  for (const throwing of [false, true]) {
    const s = scenario(); let rejectGuard = false;
    const task = s.measure(() => { if (rejectGuard && throwing) throw new Error(privateText); return !rejectGuard; });
    s.clock.uptime += 100; s.pending.resolve(goodResponse()); await flush(); rejectGuard = true;
    s.pendingRequests[1].resolve(goodResponse()); assert.equal(await task, undefined); cleaned(s);
  }
});

test('current identity loss during metadata access cannot leak a first or second success', async () => {
  const s = scenario(), task = s.measure(); s.clock.uptime += 100; s.pending.resolve(goodResponse());
  const response = Object.defineProperty(goodResponse(), 'connectionExtraInfo', { get() { s.clock.current = false; return { isReusedConnection: true }; } });
  await secondResponse(s, response); assert.equal(await task, undefined); cleaned(s);
});

test('a backward or invalid second clock retains the first but fails the second safely', async () => {
  const between = scenario({ advanceAfterClearAt: 2, advanceAfterClearMs: -1 }), betweenTask = between.measure();
  between.clock.uptime += 100; between.pending.resolve(goodResponse());
  dualProof(between, await betweenTask, 100, 'failed', 0, 'https'); assert.equal(between.calls.request.length, 1);
  for (const uptime of [10099, NaN, Infinity, -1]) {
    const s = scenario(), task = s.measure(); s.clock.uptime += 100; s.pending.resolve(goodResponse()); await flush();
    s.clock.uptime = uptime; s.pendingRequests[1].resolve(goodResponse()); dualProof(s, await task, 100, 'failed', 0, 'https');
  }
});

test('timer setup failures before either request settle safely and clear earlier timers', async () => {
  for (const at of [1, 2, 3, 4]) {
    const s = scenario({ failTimerAt: at }), task = s.measure();
    if (at > 2) { s.clock.uptime += 100; s.pending.resolve(goodResponse()); }
    const proof = await task;
    if (at <= 2) failedProof(s, proof, 'https'); else dualProof(s, proof, 100, 'failed', 0, 'https');
  }
});

test('a cancellation poll that cannot schedule its successor does not hang', async () => {
  for (const second of [false, true]) {
    const s = scenario(), task = s.measure();
    if (second) { s.clock.uptime += 100; s.pending.resolve(goodResponse()); await flush(); }
    s.faults.failTimerAt = s.calls.timerCreated + 1; s.fire(100); const proof = await task;
    if (second) dualProof(s, proof, 100, 'failed', 0, 'https'); else failedProof(s, proof, 'https');
  }
});

test('timer cleanup failure still attempts every cleanup and native destruction', async () => {
  for (const second of [false, true]) {
    const s = scenario(), task = s.measure(); s.clock.uptime += 100;
    if (second) { s.pending.resolve(goodResponse()); await flush(); }
    s.faults.fail = 'clearTimeout'; (second ? s.pendingRequests[1] : s.pending).resolve(goodResponse());
    failedProof(s, await task, 'https'); assert.equal(s.calls.timerCleared.length, second ? 4 : 2);
  }
});

test('uncleared one-shot cancellation and deadline callbacks become inert instead of looping', async () => {
  const s = scenario({ fail: 'clearTimeout-retains' }), task = s.measure(); s.clock.uptime += 100; s.pending.resolve(goodResponse());
  const proof = await task; assert.equal(s.calls.destroy, 1); assert.equal(s.calls.timerCleared.length, 2);
  assert.equal(s.timers.size, 2); s.faults.fail = ''; s.fire(100); s.fire(8000);
  assert.equal(s.calls.timerCreated, 2); assert.equal(s.calls.request.length, 1); failedProof(s, proof, 'https');
});

test('cancellation remains undefined even when timer cleanup and native destroy both throw', async () => {
  const s = scenario(), task = s.measure(); s.pending.resolve(goodResponse()); await flush();
  s.clock.current = false; s.faults.fail = 'clearTimeout'; s.faults.destroyAlsoThrows = true; s.fire(100);
  assert.equal(await task, undefined); cleaned(s); s.pendingRequests[1].reject(new Error(privateText)); await flush();
  assert.equal(s.calls.destroy, 1);
});

(async () => {
  const results = [], unhandled = [];
  const listener = error => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  try {
    for (const { name, body } of tests) {
      try { await body(); results.push({ name, passed: true }); }
      catch (error) { results.push({ name, passed: false, detail: String(error.message) }); }
    }
    await new Promise(resolve => setImmediate(resolve));
    results.push({ name: 'no detached HTTP promise creates an unhandled rejection', passed: unhandled.length === 0 });
  } finally { process.off('unhandledRejection', listener); }
  const passed = results.filter(item => item.passed).length;
  const report = { checkedAt: new Date().toISOString(), passed, failed: results.length - passed, total: results.length,
    scope: 'Actual LatencyProtocol and LatencyProbe ArkTS modules transpiled by DevEco SDK; synthetic bounded HTTP responses, file operations, monotonic/wall clocks and timers. No phone/network/private files.',
    limitations: ['The service must independently validate proxy traffic and node/network/run identity before persisting the measured result.',
      'SDK TLS, HTTP body limits and destruction are configured and mocked here; real-device behavior requires separate verification.'],
    sourceSHA256: Object.fromEntries([...sources].map(([name, source]) => [name, crypto.createHash('sha256').update(source).digest('hex')])), results };
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/latency-probe-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, failed: report.failed, total: results.length, failedCases: results.filter(item => !item.passed), scope: report.scope }));
  if (report.failed) process.exitCode = 1;
})().catch(() => { console.error('Synthetic latency probe harness failed.'); process.exitCode = 1; });
