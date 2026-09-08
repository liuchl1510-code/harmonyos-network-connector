'use strict';
// Execute authored CoreProbe methods with synthetic SDK/native adapters only.
// No phone, real node, real native library, network or user file is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const project = path.resolve(__dirname, '..');
const etsRoot = path.join(project, 'entry/src/main/ets');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourceNames = ['vpn/CoreProbe.ets', 'model/ConnectionConfig.ets', 'model/ConnectionSnapshot.ets', 'model/NodeBootstrap.ets'];
const sources = new Map(sourceNames.map(name => [name, fs.readFileSync(path.join(etsRoot, name), 'utf8')]));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
const reply = data => Buffer.from(JSON.stringify({ success: true, data })).toString('base64');
const failureReply = () => Buffer.from(JSON.stringify({ success: false, error: 'synthetic core failure' })).toString('base64');
const outbound = JSON.stringify({ protocol: 'vless', settings: { vnext: [{ address: 'node.example.test', port: 443,
  users: [{ id: '00000000-0000-4000-8000-000000000001', encryption: 'none' }] }] },
  streamSettings: { network: 'raw', security: 'tls', tlsSettings: { serverName: 'sni.example.test' } } });
function scenario() {
  const s = { calls: [], configs: [], logs: [], files: new Map(), count: { uplink: 20, downlink: 30 }, clock: 100000,
    core: false, hev: false, startGate: undefined, stopGate: undefined, statsGate: undefined,
    statsFail: false, startFail: false, stopFail: false, active: 0, activeSamples: [], waits: [], profileReads: 0, httpRequests: 0,
    wallOffset: 0, wallShiftPerWait: 0 };
  class FakeDate extends Date { static now() { return s.clock + s.wallOffset; } }
  function load(name, imports = {}) {
    const result = ts.transpileModule(sources.get(name), { compilerOptions: { target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
    assert.equal(result.diagnostics.length, 0, name);
    const exported = {};
    vm.runInNewContext(result.outputText, { exports: exported, module: { exports: exported }, Date: FakeDate,
      setTimeout: (fn, ms) => {
        assert(s.waits.length < 200, 'synthetic wait exceeded bounded timer budget');
        s.waits.push(ms); s.clock += ms; s.wallOffset += s.wallShiftPerWait; queueMicrotask(fn); return s.waits.length;
      },
      require: key => { assert(Object.hasOwn(imports, key), 'unexpected import ' + key); return imports[key]; } }, { filename: name });
    return exported;
  }
  const bootstrap = load('model/NodeBootstrap.ets');
  const config = load('model/ConnectionConfig.ets', { './NodeBootstrap': bootstrap });
  const snapshot = load('model/ConnectionSnapshot.ets');
  const native = {
    getFreePorts: () => { s.calls.push('ports'); return JSON.stringify({ socksPort: 18900, metricsPort: 18901 }); },
    configureXrayCa: async () => { s.calls.push('ca'); },
    installSocketProtector: () => { s.calls.push('protector'); },
    xrayCall: async (operation, request) => {
      s.calls.push(operation);
      if (operation === 'version') return reply('26.6.1');
      if (operation === 'runtime') return reply({ unixMillis: s.clock + s.wallOffset, goVersion: 'go1.26.7', goos: 'openharmony', goarch: 'arm64' });
      if (operation === 'start') {
        assert.equal(s.core, false, 'core start must follow successful stop');
        s.configs.push(JSON.parse(JSON.parse(Buffer.from(request, 'base64').toString()).configJSON));
        if (s.startGate) await s.startGate.promise;
        if (s.startFail) return failureReply();
        s.core = true; s.count = { uplink: 20, downlink: 30 };
      }
      if (operation === 'stats') {
        assert.equal(request, '');
        if (!s.core) return failureReply();
        const captured = { ...s.count };
        if (s.statsGate) await s.statsGate.promise;
        if (s.statsFail) return failureReply();
        return reply(captured);
      }
      if (operation === 'stop') {
        if (s.stopGate) await s.stopGate.promise;
        if (s.stopFail) return failureReply();
        s.core = false;
      }
      return reply('');
    },
    startHev: async (fd, port, ipv6) => { assert.equal(s.hev, false); s.calls.push(['hev-start', fd, port, ipv6]); s.hev = true; },
    stopHev: async () => { s.calls.push('hev-stop'); s.hev = false; return '{}'; },
    socketProtectionStats: () => JSON.stringify({ requests: 2, succeeded: 2, failed: 0, timedOut: 0,
      active: s.activeSamples.length ? s.activeSamples.shift() : s.active }),
    forwardingStatus: () => JSON.stringify({ hevRunning: s.hev, hevExit: 0 })
  };
  const fileIo = { OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    openSync: name => { s.files.set(name, ''); return { fd: 900 }; }, closeSync: () => {},
    accessSync: name => s.files.has(name), statSync: name => ({ size: Buffer.byteLength(s.files.get(name)) }),
    readTextSync: (name, opts = {}) => Buffer.from(s.files.get(name)).subarray(opts.offset || 0,
      (opts.offset || 0) + opts.length).toString(), truncateSync: name => { s.files.set(name, ''); } };
  const CoreProbe = load('vpn/CoreProbe.ets', {
    '@kit.ArkTS': { util: { Base64Helper: class { encodeToStringSync(bytes) { return Buffer.from(bytes).toString('base64'); }
      decodeSync(value) { return Buffer.from(value, 'base64'); } }, TextEncoder: class { encodeInto(text) { return Buffer.from(text); } },
      TextDecoder: class { decodeToString(bytes) { return Buffer.from(bytes).toString(); } } } },
    'libvpnbridge.so': { default: native }, '@kit.AbilityKit': {},
    '@kit.BasicServicesKit': { systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => s.clock } },
    '@kit.PerformanceAnalysisKit': { hilog: { info: (...args) => s.logs.push(args), error: () => {} } },
    '@kit.CoreFileKit': { fileIo }, './CaBundle': { prepareCaBundle: async () => '/synthetic/ca.pem' },
    '../model/NodeProfile': { readNodeProfile: () => { s.profileReads++; return { outboundJson: outbound }; } },
    '../model/NodeImport': { parseNode: value => ({ outboundJson: value }) }, '../model/ErrorInfo': { describeError: () => 'synthetic' },
    '../model/ConnectionConfig': config, '../model/ConnectionSnapshot': snapshot, '../model/NodeBootstrap': bootstrap,
    '@kit.NetworkKit': { http: { createHttp: () => { s.httpRequests++; throw new Error('Stats must not make an HTTP request'); } }, socket: {} }
  }).CoreProbe;
  s.probe = new CoreProbe(); s.context = { filesDir: '/synthetic' };
  s.pin = ip => new bootstrap.NodeBootstrap('node.example.test', ip);
  s.start = () => s.probe.startConnection(7000, s.context, async () => {}, s.pin('192.0.2.1'), outbound);
  s.resume = (ip = '192.0.2.2') => s.probe.resumeConnection(s.context, s.pin(ip));
  s.appendDiagnostics = () => { const name = '/synthetic/xray-connection-diagnostic.log';
    s.files.set(name, s.files.get(name) + 'app/dispatcher: taking detour [dns-out]\napp/dispatcher: taking detour [block-ipv6]\n'); };
  return s;
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const count = (s, value) => s.calls.filter(item => item === value).length;
test('three recoveries preserve Hev TUN ports credentials duration and cumulative traffic', async () => {
  const s = scenario(); await s.start();
  const startedAt = (await s.probe.readConnectionSnapshot()).startedAt;
  let up = 0, down = 0;
  for (let i = 1; i <= 3; i++) {
    s.count = { uplink: 20 + 11 * i, downlink: 30 + 13 * i }; s.appendDiagnostics();
    const before = await s.probe.readConnectionSnapshot();
    assert.equal(before.uplink, up + 11 * i); assert.equal(before.downlink, down + 13 * i);
    await s.probe.suspendConnection(); await s.probe.suspendConnection();
    await assert.rejects(s.probe.readConnectionSnapshot(), { message: '持续连接核心已暂停' });
    up += 11 * i; down += 13 * i; s.clock += 500;
    await s.resume('192.0.2.' + (i + 1));
    const after = await s.probe.readConnectionSnapshot();
    assert.equal(after.uplink, up); assert.equal(after.downlink, down); assert.equal(after.startedAt, startedAt);
    assert.equal(after.dnsRequests, i); assert.equal(after.ipv6BlockedRequests, i);
  }
  for (const key of ['ca', 'version', 'runtime', 'protector', 'ports']) assert.equal(count(s, key), 1, key);
  assert.equal(s.calls.filter(Array.isArray).length, 1); assert.equal(s.profileReads, 0); assert.equal(s.httpRequests, 0);
  assert.equal(count(s, 'hev-stop'), 0); assert.equal(count(s, 'start'), 4); assert.equal(count(s, 'stop'), 3);
  for (const cfg of s.configs) {
    assert.equal(cfg.inbounds[0].port, 18900); assert.equal(cfg.metrics, undefined);
    assert.equal(cfg.outbounds[0].settings.vnext[0].users[0].id, '00000000-0000-4000-8000-000000000001');
    assert.equal(cfg.outbounds[0].settings.vnext[0].address, 'node.example.test');
  }
  assert.equal(s.configs[3].dns.hosts['full:node.example.test'], '192.0.2.4');
  await s.probe.stop(); assert.equal(count(s, 'hev-stop'), 1); assert.equal(s.core, false);
});
test('pause uses latest cached counters when direct native stats fail', async () => {
  const s = scenario(); await s.start(); s.count = { uplink: 120, downlink: 230 };
  await s.probe.readConnectionSnapshot(); s.statsFail = true; await s.probe.suspendConnection();
  s.statsFail = false; await s.resume(); const snap = await s.probe.readConnectionSnapshot();
  assert.equal(snap.uplink, 100); assert.equal(snap.downlink, 200); await s.probe.stop();
});
test('pause takes newer native counters even without a heartbeat', async () => {
  const s = scenario(); await s.start(); s.count = { uplink: 33, downlink: 47 };
  await s.probe.suspendConnection(); await s.resume(); const snap = await s.probe.readConnectionSnapshot();
  assert.equal(snap.uplink, 13); assert.equal(snap.downlink, 17); await s.probe.stop();
});
test('final stop while paused is idempotent and cannot resume', async () => {
  const s = scenario(); await s.start(); await s.probe.suspendConnection();
  await Promise.all([s.probe.stop(), s.probe.stop()]);
  assert.equal(count(s, 'stop'), 1); assert.equal(count(s, 'hev-stop'), 1);
  await assert.rejects(s.resume()); assert.equal(count(s, 'start'), 1);
});
test('stop waits for late resume and never publishes active afterwards', async () => {
  const s = scenario(); await s.start(); await s.probe.suspendConnection(); s.startGate = deferred();
  const resume = s.resume(); const resumeRejected = assert.rejects(resume); await flush();
  assert.equal(count(s, 'start'), 2);
  const stop = s.probe.stop(); await flush(); assert.equal(count(s, 'hev-stop'), 0);
  s.startGate.resolve(); await resumeRejected; await stop;
  assert.equal(s.core, false); assert.equal(s.hev, false); assert.equal(count(s, 'stop'), 2);
  assert.equal(s.logs.filter(args => args[2] === 'CONNECTION_CORE_RESUMED hev=retained').length, 0);
  await assert.rejects(s.probe.readConnectionSnapshot());
});
test('queued resume cannot start after stop cancels a pending suspend', async () => {
  const s = scenario(); await s.start(); s.stopGate = deferred();
  const suspend = s.probe.suspendConnection(); await flush();
  const resumeRejected = assert.rejects(s.resume()); const stop = s.probe.stop();
  s.stopGate.resolve(); await suspend; await resumeRejected; await stop;
  assert.equal(count(s, 'start'), 1); assert.equal(s.core, false); assert.equal(s.hev, false);
});
test('concurrent resume requests serialize to one core start', async () => {
  const s = scenario(); await s.start(); await s.probe.suspendConnection();
  await Promise.all([s.resume(), s.resume()]); assert.equal(count(s, 'start'), 2);
  await s.probe.stop();
});
test('stop cancels initial startup before Hev starts', async () => {
  const s = scenario(); s.startGate = deferred(); const starting = s.start();
  const rejected = assert.rejects(starting); await flush(); const stopping = s.probe.stop();
  s.startGate.resolve(); await rejected; await stopping;
  assert.equal(s.calls.filter(Array.isArray).length, 0); assert.equal(s.core, false);
});
test('late native counters cannot revive a snapshot from the previous epoch', async () => {
  const s = scenario(); await s.start(); s.statsGate = deferred();
  const snapshotRejected = assert.rejects(s.probe.readConnectionSnapshot());
  const suspend = s.probe.suspendConnection(); s.statsGate.resolve(); await snapshotRejected;
  await suspend; s.statsGate = undefined; await s.probe.stop();
});
test('dead Hev refuses recovery without restarting it', async () => {
  const s = scenario(); await s.start(); await s.probe.suspendConnection(); s.hev = false;
  await assert.rejects(s.resume(), { message: 'Hev 转发已停止，需要重新连接' });
  assert.equal(count(s, 'start'), 1); assert.equal(s.calls.filter(Array.isArray).length, 1); await s.probe.stop();
});
test('protection completion is awaited asynchronously before resume', async () => {
  const s = scenario(); await s.start(); s.activeSamples = [1, 1, 0];
  await s.probe.suspendConnection(); assert.equal(s.waits.length, 2);
  s.activeSamples = [1, 0]; await s.resume(); assert.equal(s.waits.length, 3); await s.probe.stop();
});
test('protection timeout retains ownership and repeated pause does not hide it', async () => {
  const s = scenario(); await s.start(); s.active = 1;
  await assert.rejects(s.probe.suspendConnection(), { message: '仍有未完成的 socket 保护请求' });
  assert.equal(s.waits.reduce((a, b) => a + b, 0), 3000);
  await assert.rejects(s.probe.suspendConnection()); assert.equal(count(s, 'stop'), 1);
  await assert.rejects(s.resume()); assert.equal(count(s, 'start'), 1); assert.equal(s.hev, true);
  s.active = 0; await s.probe.stop();
});
test('failed core stop blocks another start and final stop retries cleanup', async () => {
  const s = scenario(); await s.start(); s.stopFail = true;
  await assert.rejects(s.probe.suspendConnection()); await assert.rejects(s.resume());
  assert.equal(count(s, 'start'), 1); s.stopFail = false; await s.probe.stop(); assert.equal(s.core, false);
});
test('failed resume never becomes active and final stop cleans attempted core', async () => {
  const s = scenario(); await s.start(); await s.probe.suspendConnection(); s.startFail = true;
  await assert.rejects(s.resume()); await assert.rejects(s.probe.readConnectionSnapshot());
  await s.probe.stop(); assert.equal(s.hev, false); assert.equal(count(s, 'stop'), 2);
});
test('wrong bootstrap cannot replace the frozen selected node', async () => {
  const s = scenario(); await s.start(); await s.probe.suspendConnection();
  await assert.rejects(s.probe.resumeConnection(s.context, { host: 'different.example.test', ipv4: '192.0.2.2' }));
  assert.equal(count(s, 'start'), 1); await s.resume(); assert.equal(s.profileReads, 0); assert.equal(s.httpRequests, 0); await s.probe.stop();
});
test('late native stats completion after final stop cannot expose the previous core counters', async () => {
  const s = scenario(); await s.start(); s.count = { uplink: 120, downlink: 230 }; s.statsGate = deferred();
  const rejected = assert.rejects(s.probe.readCounters(), { message: 'Xray 流量统计读取已失效' });
  await flush(); await s.probe.stop(); s.statsGate.resolve(); await rejected;
  const before = count(s, 'stats'); await assert.rejects(s.probe.readCounters());
  assert.equal(count(s, 'stats'), before); assert.equal(s.httpRequests, 0);
});
test('paused direct counter read is rejected without querying a retired core', async () => {
  const s = scenario(); await s.start(); await s.probe.suspendConnection();
  const before = count(s, 'stats'); await assert.rejects(s.probe.readCounters());
  assert.equal(count(s, 'stats'), before); await s.probe.stop();
});
test('socket protection timeout uses monotonic uptime despite repeated wall-clock changes', async () => {
  for (const direction of [-1, 1]) {
    const s = scenario(); await s.start(); s.active = 1; s.wallShiftPerWait = direction * 600000;
    const before = s.clock;
    await assert.rejects(s.probe.suspendConnection(), { message: '仍有未完成的 socket 保护请求' });
    assert.equal(s.clock - before, 3000); assert.equal(s.waits.reduce((total, ms) => total + ms, 0), 3000);
    s.active = 0; await s.probe.stop();
  }
});
(async () => {
  const results = [];
  for (const item of tests) { await item.fn(); results.push({ name: item.name, passed: true }); console.log('PASS ' + item.name); }
  const record = { createdAtUtc: new Date().toISOString(), mode: 'authored CoreProbe with synthetic SDK/native adapters',
    realNetwork: false, realPhone: false, privateFilesRead: false, passed: results.length, tests: results,
    sources: Object.fromEntries(sourceNames.map(name => [name, crypto.createHash('sha256').update(sources.get(name)).digest('hex')])) };
  const output = path.join(project, 'build/core-recovery-verification.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  console.log(`${results.length}/${tests.length} synthetic recovery checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
