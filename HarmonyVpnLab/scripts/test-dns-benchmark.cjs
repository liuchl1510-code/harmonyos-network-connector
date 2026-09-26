'use strict';
// Runs the authored diagnostic model with synthetic status, sockets, HTTP and
// private in-memory files. No device, user configuration or network is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourcePath = 'entry/src/main/ets/model/DnsBenchmark.ets';
const source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
const compiled = ts.transpileModule(source.replace(/^import[^\n]*\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(compiled.diagnostics.length, 0);
function loadPureModel(name, imports = {}) {
  const text = fs.readFileSync(path.join(root, 'entry/src/main/ets/model', name + '.ets'), 'utf8');
  const result = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2021,
    module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0);
  const exported = {};
  vm.runInNewContext(result.outputText, { exports: exported, module: { exports: exported },
    require: key => { assert(Object.hasOwn(imports, key), key); return imports[key]; } }, { filename: name + '.ets' });
  return exported;
}
const bootstrapModel = loadPureModel('NodeBootstrap'), appRoutingModel = loadPureModel('AppRouting');
const policyModel = loadPureModel('NetworkPolicy', { './NodeBootstrap': bootstrapModel, './AppRouting': appRoutingModel });
const faultModel = loadPureModel('DnsFaultTest', { './NetworkPolicy': policyModel });
const plain = value => JSON.parse(JSON.stringify(value));
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const secret = 'never-export-response-or-error';
const ip = '192.0.2.123';
function arrayBuffer(text) { const bytes = new TextEncoder().encode(text); return bytes.buffer; }
const goodHttp = () => ({ responseCode: 200, result: arrayBuffer(`h=www.cloudflare.com\nip=${ip}\nvisit_scheme=https\nsecret=${secret}\n`),
  performanceTiming: { dnsTiming: 3, tcpTiming: 7, tlsTiming: 11, totalTiming: 24, remoteAddress: ip },
  connectionExtraInfo: { isReusedConnection: false, localAddress: ip, remoteAddress: ip, remotePort: 443, localPort: 2345, redirectCount: 0 } });

function scenario(options = {}) {
  const calls = { http: [], httpInstances: [], udp: [], destroyed: 0, closed: 0, reads: 0 };
  const clock = { now: 1789000000000, uptime: 1000 };
  const state = { active: options.active !== false, runId: '1789000000000', servicePid: 501, reconnectCount: 0,
    ownerChanged: false, phase: 'active', statusAge: 0, stateAge: 0, mode: 'whitelist', dnsMode: 'proxy',
    effectiveMode: undefined, effectiveDnsMode: undefined, dnsFault: undefined };
  const timers = new Map(), files = new Map(), handles = new Map(); let nextTimer = 1, nextFd = 1;
  class FakeDate extends Date { static now() { return clock.now; } }
  const exported = {};
  const context = { exports: exported, module: { exports: exported }, ArrayBuffer, Uint8Array, Date: FakeDate,
    systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => clock.uptime },
    deviceInfo: { sdkApiVersion: options.sdkApiVersion ?? 26 },
    util: { TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } },
      TextDecoder: { create: (_, opts) => ({ decodeToString: bytes => new TextDecoder('utf-8', opts).decode(bytes) }) } },
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    readConnectionLifecycle() {
      calls.reads++;
      return { phase: state.active ? state.phase : 'stopped', ownerChanged: state.ownerChanged,
        state: { phase: state.phase, runId: state.runId, updatedAt: clock.now - state.stateAge },
        status: { phase: state.phase, runId: state.runId, servicePid: state.servicePid,
          reconnectCount: state.reconnectCount, updatedAt: clock.now - state.statusAge,
          effectiveMode: state.effectiveMode, effectiveDnsMode: state.effectiveDnsMode, dnsFault: state.dnsFault } };
    },
    validDnsFaultRequestShape: faultModel.validDnsFaultRequestShape,
    readNetworkPolicy() { return { mode: state.mode, dnsMode: state.dnsMode, dnsUrl: secret, other: secret }; },
    fs: {
      OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
      openSync(name, flags) { assert.equal(flags, 7); files.set(name, Buffer.alloc(0)); const fd = nextFd++; handles.set(fd, name); return { fd }; },
      writeSync(fd, bytes) { const current = handles.get(fd); assert.ok(current); const data = Buffer.from(bytes); const size = Math.min(31, data.length);
        files.set(current, Buffer.concat([files.get(current), data.subarray(0, size)])); return size; },
      fsyncSync(fd) { assert.ok(handles.has(fd)); }, closeSync(file) { handles.delete(file.fd); },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
      accessSync(name) { return files.has(name); }, unlinkSync(name) { files.delete(name); }
    },
    http: { HttpDataType: { ARRAY_BUFFER: 2 }, HttpProtocol: { HTTP1_1: 0 }, RequestMethod: { GET: 0 }, createHttp() {
      const pending = deferred();
      const instance = { index: calls.httpInstances.length, requests: 0, destroys: 0 }; calls.httpInstances.push(instance);
      return {
        request(url, requestOptions) {
          instance.requests++; assert.equal(instance.requests, 1, 'one HttpRequest instance per SDK request');
          calls.http.push({ url, options: requestOptions, pending, instance });
          if (options.throwRequestIndexes?.includes(instance.index)) throw new Error(secret);
          return pending.promise;
        },
        destroy() {
          calls.destroyed++; instance.destroys++; assert.equal(instance.destroys, 1, 'destroy each instance exactly once');
          if (options.onDestroy) options.onDestroy(instance, { calls, files, state });
          if (options.failDestroyIndexes?.includes(instance.index)) throw new Error(secret);
        }
      };
    } },
    socket: { constructUDPSocketInstance() {
      const item = { callbacks: {}, sends: [], bind: deferred(), close: deferred(), open: false }; calls.udp.push(item);
      return { on(name, fn) { item.callbacks[name] = fn; }, off(name) { delete item.callbacks[name]; },
        bind() { return (options.hangBind ? item.bind.promise : Promise.resolve()).then(() => { item.open = true; }); },
        send(request) { item.sends.push(request); return Promise.resolve(); }, close() {
          calls.closed++;
          if (options.throwClose) throw new Error(secret);
          if (options.failClose) return Promise.reject(new Error(secret));
          return (options.hangClose ? item.close.promise : Promise.resolve()).then(() => { item.open = false; });
        } };
    } }
  };
  vm.runInNewContext(compiled.outputText, context, { filename: sourcePath });
  const run = new exported.DnsBenchmarkRun();
  return { api: exported, run, calls, clock, state, timers, files,
    start(target = 'https-cloudflare', token = 'Token0001', allowed = true) { return run.run('/synthetic', target, token, allowed); },
    fire(ms) { const entry = [...timers].find(([, value]) => value.ms === ms); assert.ok(entry, 'timer ' + ms); timers.delete(entry[0]);
      clock.uptime += ms; clock.now += ms; entry[1].fn(); },
    receipt() { return JSON.parse(files.get('/synthetic/dns-benchmark-result.json')); }
  };
}

function dnsResponse(query, replacementHost, api) {
  const id = (query[0] << 8) | query[1];
  const question = replacementHost ? api.benchmarkQuery(id, replacementHost) : query;
  const bytes = Buffer.concat([Buffer.from(question), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 123])]);
  bytes[2] = 0x81; bytes[3] = 0x80; bytes[7] = 1;
  return new Uint8Array(bytes);
}
function sendDns(s, index = 0) {
  const udp = s.calls.udp[index]; assert.equal(udp.sends.length, 1);
  const query = new Uint8Array(udp.sends[0].data), bytes = dnsResponse(query);
  udp.callbacks.message({ message: bytes.buffer, remoteInfo: { address: '198.18.0.1', port: 53 } });
}
function cleaned(s) { assert.equal(s.timers.size, 0); assert.equal(s.calls.destroyed, s.calls.http.length); assert.equal(s.calls.closed, s.calls.udp.length); }
function privateResult(result) { const text = JSON.stringify(result); assert.ok(!text.includes(secret)); assert.ok(!text.includes(ip));
  assert.ok(!text.includes('remoteAddress')); assert.ok(!text.includes('dnsUrl')); }
const tests = [];
const test = (name, body) => tests.push({ name, body });

test('strict fixed target and token validation', () => {
  const s = scenario();
  for (const target of ['dns-baidu', 'dns-google', 'dns-cloudflare', 'https-baidu', 'https-cloudflare', 'https-cloudflare-keepalive']) {
    assert.equal(s.api.validDnsBenchmark(target, 'Alpha0099'), true);
  }
  for (const token of ['short', 'Token0001\n', 'Alpha-0099', 'a'.repeat(41), '../secret']) {
    assert.equal(s.api.validDnsBenchmark('dns-baidu', token), false);
  }
  assert.equal(s.api.validDnsBenchmark('https://example.test', 'Alpha0099'), false);
  for (const target of ['https-cloudflare-keepalive:443', 'https-cloudflare-keepalive?url=evil', 'https-cloudflare-keepalive/']) {
    assert.equal(s.api.validDnsBenchmark(target, 'Alpha0099'), false);
  }
});
test('release/preview gate performs no network or file writes', async () => {
  const s = scenario(); const result = await s.start('dns-baidu', 'Token0001', false);
  assert.equal(result.reason, 'unavailable'); assert.equal(s.files.size, 0); assert.equal(s.calls.udp.length, 0); assert.equal(s.calls.reads, 0);
});
test('no active session rejects without network', async () => {
  const s = scenario({ active: false }); const result = await s.start();
  assert.equal(result.reason, 'no-active-session'); assert.equal(s.calls.http.length, 0); assert.equal(s.receipt().status, 'rejected'); privateResult(result);
});
test('stale status, stale probe, changed owner and invalid identity reject', async () => {
  for (const patch of [{ statusAge: 12001 }, { stateAge: 12001 }, { statusAge: -1 }, { ownerChanged: true },
    { servicePid: 0 }, { reconnectCount: -1 }, { runId: secret }, { dnsMode: secret }]) {
    const s = scenario(); Object.assign(s.state, patch); assert.equal((await s.start()).reason, 'no-active-session'); assert.equal(s.calls.http.length, 0);
  }
});
test('effective service policy identifies a fault session despite different saved preferences', async () => {
  const s = scenario(); Object.assign(s.state, { mode: 'global', dnsMode: 'proxy',
    effectiveMode: 'whitelist', effectiveDnsMode: 'split',
    dnsFault: { kind: 'timeout', token: 'Fault001', createdAt: 0 } });
  const pending = s.start(); await flush();
  // A admitted descriptor remains valid after its start admission window;
  // a measurement binds the live service rather than admitting a new request.
  s.calls.http[0].pending.resolve(goodHttp()); const result = await pending;
  assert.equal(result.status, 'passed');
  assert.deepEqual(plain(result.session), { runId: '1789000000000', servicePid: 501, reconnectCount: 0,
    mode: 'whitelist', dnsMode: 'split', faultKind: 'timeout', faultToken: 'Fault001' });
  privateResult(result); cleaned(s);
});
test('saved preference edits cannot relabel a service with explicit effective policy', async () => {
  const s = scenario(); Object.assign(s.state, { effectiveMode: 'whitelist', effectiveDnsMode: 'split' });
  const pending = s.start(); await flush();
  Object.assign(s.state, { mode: 'rules', dnsMode: 'proxy' }); s.fire(100);
  s.calls.http[0].pending.resolve(goodHttp()); const result = await pending;
  assert.equal(result.status, 'passed'); assert.equal(result.session.mode, 'whitelist'); assert.equal(result.session.dnsMode, 'split');
  cleaned(s);
});
test('effective policy or fault identity changes abort the in-flight measurement', async () => {
  for (const patch of [{ effectiveMode: 'global' }, { effectiveDnsMode: 'proxy' },
    { dnsFault: { kind: 'http404', token: 'Fault001', createdAt: 0 } },
    { dnsFault: { kind: 'timeout', token: 'Fault002', createdAt: 0 } }, { dnsFault: undefined }]) {
    const s = scenario(); Object.assign(s.state, { effectiveMode: 'whitelist', effectiveDnsMode: 'split',
      dnsFault: { kind: 'timeout', token: 'Fault001', createdAt: 0 } });
    const pending = s.start(); await flush(); Object.assign(s.state, patch); s.fire(100);
    assert.equal((await pending).reason, 'session-changed'); cleaned(s);
  }
});
test('malformed fault descriptors are rejected without measuring or exporting extra fields', async () => {
  for (const dnsFault of [{ kind: 'unknown', token: 'Fault001', createdAt: 0 },
    { kind: 'timeout', token: 'Fault001\n', createdAt: 0 }, { kind: 'timeout', token: 'Fault001' },
    { kind: 'timeout', token: 'Fault001', createdAt: -1 },
    { kind: 'timeout', token: 'Fault001', createdAt: 0, url: secret }]) {
    const s = scenario(); s.state.dnsFault = dnsFault;
    const result = await s.start(); assert.equal(result.reason, 'no-active-session'); assert.equal(s.calls.http.length, 0);
    privateResult(result);
  }
});
test('HTTPS full GET has bounded options and sanitized SDK timings', async () => {
  const s = scenario(); const promise = s.start(); await flush();
  const request = s.calls.http[0]; assert.equal(request.url, 'https://www.cloudflare.com/cdn-cgi/trace?dnsbenchmark=Token0001');
  assert.equal(request.options.maxLimit, 65536); assert.equal(request.options.usingCache, false);
  assert.equal(request.options.usingProtocol, 0); assert.equal(request.options.header.Connection, 'close');
  assert.equal(Object.hasOwn(request.options, 'reuseConnections'), false);
  assert.equal(request.options.connectTimeout, 8000); assert.equal(request.options.readTimeout, 8000); assert.equal(request.options.maxRedirects, 0);
  s.clock.uptime += 24; request.pending.resolve(goodHttp()); const result = await promise;
  assert.equal(result.status, 'passed'); assert.equal(result.samples[0].durationMs, 24);
  assert.deepEqual(plain(result.samples[0].connection), { isReusedConnection: false });
  assert.equal(result.samples[0].timings.tlsTiming, 11); privateResult(result); privateResult(s.receipt()); cleaned(s);
});
test('keepalive performs two serial GETs using distinct retained SDK instances and observes actual reuse', async () => {
  for (const reused of [true, false, undefined]) {
    const s = scenario({ onDestroy(_, context) { assert.equal(context.files.size, 0, 'cleanup before receipt'); } });
    const pending = s.start('https-cloudflare-keepalive'); await flush();
    assert.equal(s.calls.http.length, 1); assert.equal(s.calls.httpInstances.length, 1); assert.equal(s.calls.destroyed, 0);
    s.clock.uptime += 17; s.calls.http[0].pending.resolve(goodHttp()); await flush();
    assert.equal(s.calls.http.length, 2); assert.equal(s.calls.httpInstances.length, 2);
    assert.equal(s.calls.destroyed, 0, 'retain first instance while second request runs'); assert.equal(s.files.size, 0);
    assert.notEqual(s.calls.http[0].instance, s.calls.http[1].instance);
    for (const request of s.calls.http) {
      assert.equal(request.url, 'https://www.cloudflare.com/cdn-cgi/trace?dnsbenchmark=Token0001');
      assert.equal(request.options.usingProtocol, 0); assert.equal(request.options.usingCache, false);
      assert.equal(request.options.maxRedirects, 0); assert.equal(request.options.maxLimit, 65536);
      assert.equal(request.options.connectTimeout, 8000); assert.equal(request.options.readTimeout, 8000);
      assert.equal(request.options.header.Connection, 'keep-alive'); assert.equal(request.options.header['Cache-Control'], 'no-cache');
      assert.equal(request.options.reuseConnections, true);
    }
    const response = goodHttp(); response.connectionExtraInfo.isReusedConnection = reused;
    s.clock.uptime += 3; s.calls.http[1].pending.resolve(response); const result = await pending;
    assert.equal(result.status, 'passed'); assert.deepEqual(plain(result.samples.map(x => x.stage)), ['first-get', 'repeat-get']);
    assert.deepEqual(plain(result.samples.map(x => x.durationMs)), [17, 3]);
    assert.deepEqual(plain(result.samples[0].connection), { isReusedConnection: false });
    assert.deepEqual(plain(result.samples[1].connection), reused === undefined ? {} : { isReusedConnection: reused });
    privateResult(result); privateResult(s.receipt()); cleaned(s);
  }
});
test('keepalive sends API26 reuseConnections only on API26 or later', async () => {
  for (const sdkApiVersion of [24, 25, 26, 27]) {
    const s = scenario({ sdkApiVersion }); const pending = s.start('https-cloudflare-keepalive'); await flush();
    s.calls.http[0].pending.resolve(goodHttp()); await flush(); s.calls.http[1].pending.resolve(goodHttp());
    assert.equal((await pending).status, 'passed');
    for (const request of s.calls.http) {
      assert.equal(Object.hasOwn(request.options, 'reuseConnections'), sdkApiVersion >= 26);
      assert.equal(request.options.header.Connection, 'keep-alive');
    }
    cleaned(s);
  }
});
test('keepalive alias retains strict Cloudflare response validation and stops after first failed GET', async () => {
  const responses = [
    { responseCode: 404, result: goodHttp().result },
    { responseCode: 200, result: arrayBuffer('h=evil.test\nip=192.0.2.123\nvisit_scheme=https') },
    { responseCode: 200, result: arrayBuffer('h=www.cloudflare.com\nip=999.0.0.1\nvisit_scheme=https') },
    { responseCode: 200, result: arrayBuffer('h=www.cloudflare.com\nip=192.0.2.123\nvisit_scheme=http') },
    { responseCode: 200, result: arrayBuffer('h=www.cloudflare.com\nip=192.0.2.123\nip=1.1.1.1\nvisit_scheme=https') },
    { responseCode: 200, result: new ArrayBuffer(0) }
  ];
  for (const response of responses) {
    const s = scenario(); assert.equal(s.api.validBenchmarkHttp('https-cloudflare-keepalive', response), false);
    const pending = s.start('https-cloudflare-keepalive'); await flush(); s.calls.http[0].pending.resolve(response);
    const result = await pending; assert.equal(result.reason, 'https-response'); assert.equal(s.calls.http.length, 1);
    privateResult(result); cleaned(s);
  }
  const s = scenario(); assert.equal(s.api.validBenchmarkHttp('https-cloudflare-keepalive', goodHttp()), true);
  const pending = s.start('https-cloudflare-keepalive'); await flush(); s.calls.http[0].pending.resolve(goodHttp()); await flush();
  s.calls.http[1].pending.resolve(responses[0]); assert.equal((await pending).reason, 'https-response'); cleaned(s);
});
test('keepalive cancellation in either stage destroys retained requests and ignores late callbacks', async () => {
  for (const stage of [0, 1]) {
    const s = scenario(); const pending = s.start('https-cloudflare-keepalive'); await flush();
    if (stage === 1) { s.calls.http[0].pending.resolve(goodHttp()); await flush(); }
    s.run.cancel(); const result = await pending;
    assert.equal(result.reason, 'cancelled'); assert.equal(s.calls.http.length, stage + 1); cleaned(s);
    const receipt = JSON.stringify(s.receipt()); s.calls.http[stage].pending.resolve(goodHttp()); await flush();
    assert.equal(JSON.stringify(s.receipt()), receipt); assert.equal(s.calls.http.length, stage + 1);
  }
});
test('keepalive session change during second GET destroys both requests before receipt', async () => {
  const s = scenario(); const pending = s.start('https-cloudflare-keepalive'); await flush();
  s.calls.http[0].pending.resolve(goodHttp()); await flush(); s.state.reconnectCount++; s.fire(100);
  assert.equal((await pending).reason, 'session-changed'); assert.equal(s.calls.http.length, 2); cleaned(s);
  const receipt = JSON.stringify(s.receipt()); s.calls.http[1].pending.resolve(goodHttp()); await flush();
  assert.equal(JSON.stringify(s.receipt()), receipt);
});
test('keepalive each pending GET keeps the eight-second bound and destroys all retained instances', async () => {
  for (const stage of [0, 1]) {
    const s = scenario(); const pending = s.start('https-cloudflare-keepalive'); await flush();
    if (stage === 1) { s.calls.http[0].pending.resolve(goodHttp()); await flush(); }
    s.fire(8000); assert.equal((await pending).reason, 'timeout'); assert.equal(s.calls.http.length, stage + 1); cleaned(s);
  }
});
test('keepalive synchronous SDK failure and asynchronous rejection clean either stage without exposing SDK errors', async () => {
  for (const stage of [0, 1]) {
    for (const synchronous of [false, true]) {
      const s = scenario(synchronous ? { throwRequestIndexes: [stage] } : {});
      const pending = s.start('https-cloudflare-keepalive'); await flush();
      if (stage === 1) { s.calls.http[0].pending.resolve(goodHttp()); await flush(); }
      if (!synchronous) s.calls.http[stage].pending.reject(new Error(secret));
      const result = await pending; assert.equal(result.reason, 'https-request');
      assert.equal(s.calls.http.length, stage + 1); privateResult(result); privateResult(s.receipt()); cleaned(s);
    }
  }
});
test('keepalive destroy failure fails the owning sample and receipt while still destroying all instances', async () => {
  for (const failedIndex of [0, 1]) {
    const s = scenario({ failDestroyIndexes: [failedIndex],
      onDestroy(_, context) { assert.equal(context.files.size, 0, 'no receipt until cleanup has been attempted'); } });
    const pending = s.start('https-cloudflare-keepalive'); await flush();
    s.calls.http[0].pending.resolve(goodHttp()); await flush(); s.calls.http[1].pending.resolve(goodHttp());
    const result = await pending; assert.equal(result.status, 'failed'); assert.equal(result.reason, 'cleanup');
    assert.equal(result.samples[failedIndex].status, 'failed'); assert.equal(result.samples[failedIndex].reason, 'cleanup');
    assert.equal(s.receipt().status, 'failed'); privateResult(result); cleaned(s);
  }
});
test('keepalive final cleanup observes cancellation and session change before publishing success', async () => {
  for (const action of ['cancel', 'session']) {
    let s;
    s = scenario({ onDestroy(instance, context) {
      if (instance.index === 0) { if (action === 'cancel') s.run.cancel(); else context.state.reconnectCount++; }
    } });
    const pending = s.start('https-cloudflare-keepalive'); await flush();
    s.calls.http[0].pending.resolve(goodHttp()); await flush(); s.calls.http[1].pending.resolve(goodHttp());
    assert.equal((await pending).reason, action === 'cancel' ? 'cancelled' : 'session-changed'); cleaned(s);
  }
});
test('superseded keepalive second GET cannot overwrite a new token receipt or restart a request', async () => {
  const s = scenario(); const oldPending = s.start('https-cloudflare-keepalive'); await flush();
  s.calls.http[0].pending.resolve(goodHttp()); await flush();
  const next = new s.api.DnsBenchmarkRun(); const newPending = next.run('/synthetic', 'https-cloudflare', 'Token0002', true);
  await flush(); assert.equal(s.calls.http.length, 3);
  s.calls.http[2].pending.resolve(goodHttp()); assert.equal((await newPending).status, 'passed');
  const receipt = JSON.stringify(s.receipt()); s.calls.http[1].pending.resolve(goodHttp());
  assert.equal((await oldPending).reason, 'session-changed'); assert.equal(JSON.stringify(s.receipt()), receipt);
  assert.equal(s.receipt().token, 'Token0002'); assert.equal(s.calls.http.length, 3); cleaned(s);
});
test('Baidu requires an actual robots body', async () => {
  for (const [text, success] of [['User-agent: *\nDisallow: /private\n', true], ['<html>success</html>', false], ['', false]]) {
    const s = scenario(); const pending = s.start('https-baidu'); await flush();
    assert.equal(s.calls.http[0].url, 'https://www.baidu.com/robots.txt?dnsbenchmark=Token0001');
    s.calls.http[0].pending.resolve({ responseCode: 200, result: arrayBuffer(text) });
    assert.equal((await pending).status, success ? 'passed' : 'failed'); cleaned(s);
  }
});
test('Cloudflare validates unique host, IPv4 and HTTPS trace fields', () => {
  const s = scenario();
  for (const text of ['h=evil.test\nip=192.0.2.123\nvisit_scheme=https', 'h=www.cloudflare.com\nip=999.0.0.1\nvisit_scheme=https',
    'h=www.cloudflare.com\nip=192.0.2.123\nvisit_scheme=http', 'h=www.cloudflare.com\nip=192.0.2.123\nip=1.1.1.1\nvisit_scheme=https']) {
    assert.equal(s.api.validBenchmarkHttp('https-cloudflare', { responseCode: 200, result: arrayBuffer(text) }), false);
  }
});
test('DNS measures first and repeat serially and retains counts only', async () => {
  const s = scenario(); const promise = s.start('dns-baidu'); await flush(); assert.equal(s.calls.udp.length, 1);
  s.clock.uptime += 50; sendDns(s); await flush(); assert.equal(s.calls.udp.length, 2);
  s.clock.uptime += 5; sendDns(s, 1); const result = await promise;
  assert.equal(result.status, 'passed'); assert.deepEqual(plain(result.samples.map(x => x.durationMs)), [50, 5]);
  assert.deepEqual(plain(result.samples.map(x => x.stage)), ['first', 'repeat']); assert.equal(result.samples[0].answerCount, 1);
  privateResult(result); privateResult(s.receipt()); cleaned(s);
});
test('DNS rejects wrong question, transaction, type, rcode and malformed answers', () => {
  const s = scenario(), query = s.api.benchmarkQuery(123, 'www.baidu.com');
  assert.equal(s.api.validateBenchmarkDns(dnsResponse(query), 123, 'www.baidu.com'), 1);
  assert.throws(() => s.api.validateBenchmarkDns(dnsResponse(query, 'www.google.com', s.api), 123, 'www.baidu.com'));
  for (const mutate of [b => b[1]++, b => b[3] = 0x83, b => b[2] |= 2, b => b[query.length - 3] = 28,
    b => b[b.length - 5] = 5, b => b[7] = 0]) {
    const bytes = dnsResponse(query); mutate(bytes); assert.throws(() => s.api.validateBenchmarkDns(bytes, 123, 'www.baidu.com'));
  }
});
test('HTTP cancel resolves and destroys the request; late response is inert', async () => {
  const s = scenario(); const pending = s.start(); await flush(); s.run.cancel(); const result = await pending;
  assert.equal(result.reason, 'cancelled'); cleaned(s); const receipt = JSON.stringify(s.receipt());
  s.calls.http[0].pending.resolve(goodHttp()); await flush(); assert.equal(JSON.stringify(s.receipt()), receipt);
});
test('cancel during DNS bind resolves and closes socket without send', async () => {
  const s = scenario({ hangBind: true }); const pending = s.start('dns-google'); await flush(); s.run.cancel();
  assert.equal((await pending).reason, 'cleanup'); cleaned(s); const receipt = JSON.stringify(s.receipt());
  s.calls.udp[0].bind.resolve(); await flush(); assert.equal(s.calls.udp[0].sends.length, 0);
  assert.equal(s.calls.closed, 2); assert.equal(s.calls.udp[0].open, false); assert.equal(s.timers.size, 0);
  assert.equal(JSON.stringify(s.receipt()), receipt, 'late bind cleanup cannot claim retroactive receipt success');
});
test('HTTP timeout is bounded even when SDK promise never settles', async () => {
  const s = scenario(); const pending = s.start(); await flush(); s.fire(8000);
  assert.equal((await pending).reason, 'timeout'); cleaned(s);
});
test('DNS bind timeout is bounded without trusting native bind completion', async () => {
  const s = scenario({ hangBind: true }); const pending = s.start('dns-google'); await flush(); s.fire(8000);
  assert.equal((await pending).reason, 'cleanup'); cleaned(s);
});
test('failed UDP close does not report successful DNS or start repeat', async () => {
  for (const options of [{ failClose: true }, { throwClose: true }]) {
    const s = scenario(options); const pending = s.start('dns-baidu'); await flush(); sendDns(s);
    const result = await pending; assert.equal(result.reason, 'cleanup'); assert.equal(result.samples[0].status, 'failed');
    assert.equal(s.calls.udp.length, 1); assert.equal(s.calls.udp[0].open, true); privateResult(result); cleaned(s);
  }
});
test('hanging UDP close has one-second bound and retains uncertain cleanup', async () => {
  const s = scenario({ hangClose: true }); const pending = s.start('dns-baidu'); await flush(); sendDns(s); await flush();
  assert.equal(s.files.size, 0, 'do not save passed result before socket close finishes'); s.fire(1000);
  const result = await pending; assert.equal(result.reason, 'cleanup'); assert.equal(result.samples[0].status, 'failed');
  assert.equal(s.calls.udp.length, 1); assert.equal(s.calls.udp[0].open, true); cleaned(s);
  const receipt = JSON.stringify(s.receipt()); s.calls.udp[0].close.resolve(); await flush();
  assert.equal(s.calls.udp[0].open, false); assert.equal(JSON.stringify(s.receipt()), receipt);
});
test('superseded token stops old DNS before repeat and cannot replace new receipt', async () => {
  const s = scenario(); const oldPending = s.start('dns-baidu'); await flush();
  const next = new s.api.DnsBenchmarkRun(); const newPending = next.run('/synthetic', 'https-cloudflare', 'Token0002', true);
  await flush(); sendDns(s); const oldResult = await oldPending;
  assert.equal(oldResult.reason, 'session-changed'); assert.equal(s.calls.udp.length, 1); assert.equal(s.files.size, 0);
  s.calls.http[0].pending.resolve(goodHttp()); const newResult = await newPending;
  assert.equal(newResult.status, 'passed'); assert.equal(s.receipt().token, 'Token0002'); cleaned(s);
});
test('same-session check rejects run, PID, recovery counter and policy changes', async () => {
  for (const patch of [{ runId: '1789000000001' }, { servicePid: 502 }, { reconnectCount: 1 }, { mode: 'global' }, { dnsMode: 'split' }, { phase: 'recovering' }]) {
    const s = scenario(); const pending = s.start(); await flush(); Object.assign(s.state, patch); s.fire(100);
    assert.equal((await pending).reason, 'session-changed'); cleaned(s);
  }
});
test('duplicate token never repeats a network measurement', async () => {
  const s = scenario(); const pending = s.start(); await flush(); s.run.cancel(); await pending;
  const duplicate = await new s.api.DnsBenchmarkRun().run('/synthetic', 'https-cloudflare', 'Token0001', true);
  assert.equal(duplicate.reason, 'duplicate-token'); assert.equal(s.calls.http.length, 1);
});
test('raw HTTP rejection and response text never enter receipt', async () => {
  const s = scenario(); const pending = s.start(); await flush(); s.calls.http[0].pending.reject(new Error(secret));
  const result = await pending; assert.equal(result.reason, 'https-request'); privateResult(result); privateResult(s.receipt()); cleaned(s);
});
test('timing numeric whitelist rejects strings, negative and nonfinite fields', () => {
  const s = scenario(); const result = s.api.safeBenchmarkTiming({ performanceTiming: { dnsTiming: secret, tcpTiming: -1, tlsTiming: NaN,
    firstReceiveTiming: Infinity, totalTiming: 10, extra: secret } }); assert.deepEqual(plain(result), { totalTiming: 10 });
});
test('source integration keeps debug/core gates and onNewWant path', () => {
  const entry = fs.readFileSync(path.join(root, 'entry/src/main/ets/entryability/EntryAbility.ets'), 'utf8');
  assert.match(entry, /onNewWant[\s\S]*readDnsBenchmark\(want\)[\s\S]*replaceUrl/);
  assert.match(entry, /!this\.context\.applicationInfo\.debug \|\| !VPN_CORE_AVAILABLE/);
  assert.match(source, /TOTAL_MS: number = 20000/);
  for (const forbidden of ['writeConnectionCommand', 'saveNetworkPolicy', 'writeNodeProfile', 'startVpnExtensionAbility', 'stopVpnExtensionAbility']) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'entry/src/main/resources/base/profile/main_pages.json'), 'utf8'));
  assert.ok(pages.src.includes('pages/DnsBenchmark'));
});

(async () => {
  let passed = 0;
  for (const item of tests) { await item.body(); passed++; }
  process.stdout.write(JSON.stringify({ passed, total: tests.length, sdkTranspiled: true, networkRequests: 0,
    devicesTouched: 0, sourceSha256: crypto.createHash('sha256').update(source).digest('hex') }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
