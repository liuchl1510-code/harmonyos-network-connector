'use strict';
// Exercises actual service, protocol and result persistence with synthetic SDK,
// core, node catalog and atomic in-memory files. Never uses phone/private data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const names = ['model/ConnectionFailure.ets', 'model/ConnectionSnapshot.ets', 'model/ConnectionControl.ets', 'model/ProbeState.ets',
  'model/NodeBootstrap.ets', 'model/AppRouting.ets', 'model/NetworkPolicy.ets', 'model/LatencyProtocol.ets', 'model/NodeLatency.ets', 'model/DiagnosticJournal.ets', 'vpn/VpnProbeAbility.ets'];
const sources = new Map(names.map(name => [name, fs.readFileSync(path.join(root, 'entry/src/main/ets', name), 'utf8')]));
const compiled = new Map([...sources].map(([name, source]) => {
  const result = ts.transpileModule(source.replace(/^import[\s\S]*?;\r?\n/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0, 'SDK transpilation ' + name); return [name, result.outputText];
}));
const runId = '1789000000000';
const nextRun = '1789000000001';
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let n = 0; n < 55; n++) await Promise.resolve(); }

function scenario(options = {}) {
  const files = new Map(), handles = new Map(), timers = new Map();
  let nextFd = 100, uuid = 1, nextTimer = 1, service;
  const clock = { now: 1789000000500, uptime: 10000 };
  const calls = { create: [], coreStart: [], coreStop: 0, coreSuspend: 0, coreResume: 0, destroy: 0, stop: 0,
    rawClose: [], save: [], journal: [], profileRead: 0, snapshot: 0, watcherStart: 0, watcherStop: 0 };
  const fakeFs = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 }, accessSync: name => files.has(name),
    statSync: name => ({ size: files.get(name).length, isFile: () => true }),
    openSync(name) { files.set(name, Buffer.alloc(0)); const fd = nextFd++; handles.set(fd, name); return { fd }; },
    writeSync(fd, data) { const name = handles.get(fd); assert.ok(name); const bytes = Buffer.from(data);
      const n = name.includes('vpn-probe.json') ? bytes.length : Math.min(7, bytes.length);
      files.set(name, Buffer.concat([files.get(name), bytes.subarray(0, n)])); return n; },
    fsyncSync(fd) { assert.ok(handles.has(fd)); },
    closeSync(file) { const fd = typeof file === 'number' ? file : file.fd;
      if (handles.has(fd)) handles.delete(fd); else calls.rawClose.push(fd); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(name) { files.delete(name); },
    readTextSync(name, opts) { assert.ok(files.has(name)); return files.get(name).subarray(0, opts?.length).toString(); }
  };
  class FakeDate extends Date { static now() { return clock.now; } }
  class ImportedNode { constructor(name, protocol, outboundJson) { Object.assign(this, { name, protocol, outboundJson }); } }
  class PhysicalNetwork { constructor(netId = 100, kind = 'wifi', key = '100/wifi/synthetic') { Object.assign(this, { netId, kind, key }); } }
  const physical = { current: options.offline ? undefined : new PhysicalNetwork(), listener: undefined };
  const outbound = address => JSON.stringify({ protocol: 'vless', settings: { vnext: [{ address, port: 443,
    users: [{ id: '00000000-0000-4000-8000-000000000001', encryption: 'none' }] }] } });
  const active = { id: 'active-node', name: 'synthetic active', protocol: 'vless', outboundJson: outbound('192.0.2.11') };
  const target = { id: 'test-node', name: 'synthetic target', protocol: 'vless', outboundJson: outbound('192.0.2.22') };
  const catalog = { activeNodeId: active.id, nodes: options.missingNode ? [active] : [active, target] };
  const context = { filesDir: '/synthetic-latency' };
  const shared = { VPN_CORE_AVAILABLE: true, fs: fakeFs, Date: FakeDate, ImportedNode, PhysicalNetwork,
    systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => clock.uptime },
    util: { generateRandomUUID: () => 'synthetic-' + uuid++, TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } } },
    cryptoFramework: { createMd(algorithm) {
      assert.equal(algorithm, 'SHA256'); let input;
      return { async update(blob) { input = Buffer.from(blob.data); }, async digest() {
        if (options.fingerprintGate) await options.fingerprintGate;
        return { data: new Uint8Array(crypto.createHash('sha256').update(input).digest()) };
      } };
    } },
    setInterval(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms, interval: false }); return id; },
    clearTimeout(id) { timers.delete(id); },
    hilog: { info() {}, warn() {}, error() {} }, describeError: () => 'synthetic safe error',
    readNetworkPolicy: () => { assert.fail('Node latency must never read the daily network policy'); },
    readNodeCatalog: () => catalog,
    readNodeProfile: () => { calls.profileRead++; return active; },
    nodeServerAddress: node => JSON.parse(node.outboundJson).settings.vnext[0].address,
    PhysicalNetworkWatcher: class {
      async start(listener) { physical.listener = listener; calls.watcherStart++; }
      async stop() { physical.listener = undefined; calls.watcherStop++; }
    },
    readPhysicalNetwork: async () => physical.current,
    resolvePhysicalIpv4: async () => '192.0.2.22',
    publishConnectionNotification: async () => {}, cancelConnectionNotification: async () => {},
    readTransferResult: () => ({ status: 'pending', runId: '' }),
    native: { currentProcessId: () => 4242, inspectFd: () => 'synthetic fd', inspectTunAddresses: () => 'synthetic tun' }
  };
  function load(name) { const exported = {};
    vm.runInNewContext(compiled.get(name), { ...shared, exports: exported, module: { exports: exported } }, { filename: name });
    Object.assign(shared, exported); return exported;
  }
  for (const name of names.slice(0, -1)) load(name);
  const actualSave = shared.saveNodeLatency;
  shared.saveNodeLatency = (dir, result) => {
    calls.save.push(plain(result));
    if (options.saveFailure) throw new Error('synthetic persistence failure');
    return actualSave(dir, result);
  };
  const actualJournal = shared.appendDiagnosticEvent;
  shared.appendDiagnosticEvent = (...args) => { calls.journal.push(args.slice(1)); return actualJournal(...args); };
  const snapshot = Object.assign(new shared.ConnectionSnapshot(), { active: true, startedAt: clock.now,
    sampledAt: clock.now, coreVersion: '26.6.1', uplink: 123, downlink: 456 });
  const core = { async startConnection(...args) { calls.coreStart.push(args); if (options.coreStart) await options.coreStart(); },
    async stop() { calls.coreStop++; }, async suspendConnection() { calls.coreSuspend++; }, async resumeConnection() { calls.coreResume++; },
    async logNodeTraffic() {}, readConnectionSnapshot() { calls.snapshot++; return options.snapshot ? options.snapshot(snapshot) : Promise.resolve(snapshot); },
    diagnosticSummary: '' };
  const connection = { async protectProcessNet() {}, async protect() {},
    create(config) { calls.create.push(plain(config)); return options.create ? options.create() : Promise.resolve(7000); },
    async destroy() { calls.destroy++; } };
  Object.assign(shared, { VpnExtensionAbility: class { constructor() { this.context = context; } },
    CoreProbe: class { constructor() { return core; } },
    vpnExtension: { createVpnConnection: () => connection, async stopVpnExtensionAbility() {
      calls.stop++; if (options.autoDestroy !== false) service.onDestroy();
    } }
  });
  const Service = load('vpn/VpnProbeAbility.ets').default;
  service = new Service();
  const request = new shared.LatencyRequest(runId, target.id,
    options.wrongHash ? 'b'.repeat(64) : hash(target.outboundJson));
  function prepare(id = runId) {
    shared.writeProbeState(context.filesDir, new shared.ProbeState('starting', 'synthetic latency', id, 'node-latency'));
    shared.writeConnectionCommand(context.filesDir, new shared.ConnectionCommand(id, 'start'));
    shared.writeLatencyRequest(context.filesDir, request);
    return { runId: id };
  }
  function fire(id) { const timer = timers.get(id); assert.ok(timer); if (!timer.interval) timers.delete(id); timer.fn(); }
  async function drainZeroTimers() {
    for (let n = 0; n < 10; n++) {
      await flush(); const zero = [...timers].find(([, timer]) => !timer.interval && timer.ms === 0);
      if (!zero) return; fire(zero[0]);
    }
    throw new Error('SYNTHETIC_ZERO_TIMER_LOOP');
  }
  async function settleCleanup() { await drainZeroTimers(); if (service.cleanup) await service.cleanup; await flush(); }
  async function launch() { service.onCreate({ parameters: prepare() }); await service.initialization; await flush(); }
  function proof(changes = {}) {
    const value = new shared.LatencyProof(runId, target.id, hash(target.outboundJson), 'passed', 250, '');
    Object.assign(value, changes); shared.writeLatencyProof(context.filesDir, value); return value;
  }
  function controlTick() { const timer = [...timers].find(([, item]) => item.interval && item.ms === 300); assert.ok(timer); fire(timer[0]); }
  return { shared, files, handles, timers, clock, calls, physical, active, target, catalog, context, service, snapshot, core,
    request, prepare, launch, proof, fire, drainZeroTimers, settleCleanup, controlTick,
    results: () => shared.readNodeLatencies(context.filesDir), status: () => shared.readConnectionStatus(context.filesDir),
    stopCommand: () => shared.writeConnectionCommand(context.filesDir, new shared.ConnectionCommand(runId, 'stop')) };
}

function cleanedOnce(s) {
  assert.equal(s.calls.coreStop, 1); assert.equal(s.calls.destroy, 1); assert.equal(s.calls.stop, 1);
  assert.equal(s.calls.rawClose.filter(fd => fd === 7000).length, 1); assert.equal(s.status().phase, 'destroyed');
  assert.equal(s.status().cleanupConfirmed, true); assert.equal(s.handles.size, 0); assert.equal(s.timers.size, 0);
}
const tests = [];
function test(name, body) { tests.push({ name, body }); }

for (const [stage, reason, expected] of [['forwarding','failed','internal'], ['core-init','timeout','timeout'], ['configuration','failed','configuration']]) {
  test('latency startup retains only truthful coarse reason from typed stage: ' + stage + '/' + reason, async () => {
    const s = scenario({ coreStart: async () => { throw new s.shared.ConnectionFailureError(stage, reason); } });
    await s.launch(); await s.settleCleanup();
    assert.equal(s.results()[0].reason, expected); assert.equal(s.results()[0].status, 'failed');
    assert.equal(s.status().failure.stage, stage); assert.equal(s.results()[0].secondStatus, 'not-tested');
  });
}

test('node-latency is a persistent-control kind but routes only its own application', async () => {
  const s = scenario(); await s.launch(); assert.equal(s.service.connectionPhase, 'active');
  assert.deepEqual(s.calls.create[0].trustedApplications, ['com.example.harmonyvpnlab']);
  assert.equal(s.calls.profileRead, 0); assert.equal(s.catalog.activeNodeId, s.active.id);
  assert.equal(s.calls.coreStart[0][4], s.target.outboundJson); assert.notEqual(s.calls.coreStart[0][4], s.active.outboundJson);
  assert.equal([...s.timers.values()].some(timer => timer.ms === 90000), false);
  assert.equal([...s.timers.values()].some(timer => timer.ms === 30000), true);
  await s.service.requestStop(false); await s.settleCleanup(); cleanedOnce(s);
});
test('mismatched fingerprint and removed target fail before TUN/core creation without selecting another node', async () => {
  for (const options of [{ wrongHash: true }, { missingNode: true }]) {
    const s = scenario(options); await s.launch(); await s.settleCleanup();
    assert.equal(s.calls.create.length, 0); assert.equal(s.calls.coreStart.length, 0); assert.equal(s.calls.profileRead, 0);
    assert.equal(s.catalog.activeNodeId, s.active.id); assert.equal(s.calls.save.length, 1);
    assert.equal(s.results()[0].status, 'failed'); assert.equal(s.results()[0].reason, 'configuration');
  }
});
test('matching proof plus positive proxy traffic records success once and cleanup avoids self-await', async () => {
  const s = scenario(); await s.launch(); s.proof(); s.controlTick(); await flush(); await s.settleCleanup();
  assert.equal(s.calls.save.length, 1); assert.equal(s.results()[0].status, 'passed'); assert.equal(s.results()[0].durationMs, 250);
  assert.equal(s.results()[0].nodeId, s.target.id); assert.equal(s.catalog.activeNodeId, s.active.id); cleanedOnce(s);
  await s.service.acceptLatencyProof(); await s.service.requestStop(false); s.service.onDestroy(); await flush();
  assert.equal(s.calls.save.length, 1); assert.equal(s.calls.coreStop, 1);
});
test('dual proof preserves first timing and second connection evidence through service storage', async () => {
  for (const secondConnection of ['reused', 'new', 'unknown']) {
    const s = scenario(); await s.launch();
    s.proof({ measurementVersion: 2, durationMs: 2400, secondStatus: 'passed', secondDurationMs: 230,
      secondReason: '', secondConnection });
    await s.service.acceptLatencyProof(); await s.settleCleanup();
    const result = s.results()[0];
    assert.equal(result.status, 'passed'); assert.equal(result.durationMs, 2400);
    assert.equal(result.measurementVersion, 2); assert.equal(result.secondDurationMs, 230);
    assert.equal(result.secondStatus, 'passed'); assert.equal(result.secondConnection, secondConnection);
    assert.equal(s.catalog.activeNodeId, s.active.id); cleanedOnce(s);
  }
});

test('second request failure preserves successful first measurement without claiming reuse', async () => {
  for (const secondReason of ['https', 'timeout']) {
    const s = scenario(); await s.launch();
    s.proof({ measurementVersion: 2, durationMs: 2400, secondStatus: 'failed', secondDurationMs: 0,
      secondReason, secondConnection: 'unknown' });
    await s.service.acceptLatencyProof(); await s.settleCleanup();
    const result = s.results()[0];
    assert.equal(result.status, 'passed'); assert.equal(result.durationMs, 2400);
    assert.equal(result.secondStatus, 'failed'); assert.equal(result.secondReason, secondReason);
    assert.equal(result.secondDurationMs, 0); assert.equal(result.secondConnection, 'unknown'); cleanedOnce(s);
  }
});

test('dual measurement still needs proxy traffic and cannot survive a persistent cancellation', async () => {
  for (const cancelled of [false, true]) {
    const s = scenario(); await s.launch();
    s.proof({ measurementVersion: 2, durationMs: 2400, secondStatus: 'passed', secondDurationMs: 230,
      secondReason: '', secondConnection: 'reused' });
    if (cancelled) s.stopCommand(); else s.snapshot.uplink = 0;
    await s.service.acceptLatencyProof();
    if (cancelled) await s.service.requestStop(false);
    await s.settleCleanup();
    const result = s.results()[0];
    assert.notEqual(result.status, 'passed'); assert.equal(result.secondStatus, 'not-tested');
    assert.equal(result.secondDurationMs, 0); cleanedOnce(s);
  }
});

test('wrong run, node or hash proof is ignored and cannot complete the test', async () => {
  for (const changes of [{ runId: nextRun }, { nodeId: 'different-node' }, { outboundFingerprint: 'b'.repeat(64) }]) {
    const s = scenario(); await s.launch(); s.proof(changes); await s.service.acceptLatencyProof();
    assert.equal(s.calls.save.length, 0); assert.equal(s.service.latencyFinished, false);
    await s.service.requestStop(false); await s.settleCleanup(); assert.equal(s.results()[0].status, 'cancelled'); cleanedOnce(s);
  }
});
test('a proof from another network epoch is not accepted', async () => {
  const s = scenario(); await s.launch(); s.proof(); s.service.networkEpoch++;
  await s.service.acceptLatencyProof(); assert.equal(s.calls.save.length, 0);
  await s.service.requestStop(false); await s.settleCleanup(); assert.equal(s.results()[0].status, 'cancelled'); cleanedOnce(s);
});
test('missing uplink or downlink cannot count as a passed proxy test', async () => {
  for (const changes of [{ uplink: 0 }, { downlink: 0 }, { uplink: -1 }]) {
    const s = scenario(); await s.launch(); Object.assign(s.snapshot, changes); s.proof();
    await s.service.acceptLatencyProof(); await s.settleCleanup();
    assert.equal(s.results()[0].status, 'failed'); assert.equal(s.results()[0].reason, 'internal'); cleanedOnce(s);
  }
});
test('non-finite proxy counters cannot provide positive traffic evidence', async () => {
  for (const changes of [{ uplink: NaN }, { downlink: Infinity }]) {
    const s = scenario(); await s.launch(); Object.assign(s.snapshot, changes); s.proof();
    await s.service.acceptLatencyProof(); await s.settleCleanup();
    assert.notEqual(s.results()[0].status, 'passed');
  }
});
test('an inactive core cannot use retained positive counters as current traffic evidence', async () => {
  const s = scenario(); await s.launch(); s.snapshot.active = false; s.proof();
  await s.service.acceptLatencyProof(); await s.settleCleanup(); assert.notEqual(s.results()[0]?.status, 'passed');
});
test('missing proof leaves the temporary connection pending until its bounded stop', async () => {
  const s = scenario(); await s.launch(); await s.service.acceptLatencyProof();
  assert.equal(s.calls.save.length, 0); assert.equal(s.service.latencyFinished, false);
  await s.service.requestStop(false); await s.settleCleanup(); assert.equal(s.results()[0].status, 'cancelled'); cleanedOnce(s);
});
test('failed HTTPS proof records its fixed reason and then cleans up without requiring traffic', async () => {
  const s = scenario(); await s.launch(); s.snapshot.uplink = 0; s.snapshot.downlink = 0;
  s.proof({ status: 'failed', reason: 'timeout', durationMs: 8000 });
  await s.service.acceptLatencyProof(); await s.settleCleanup();
  assert.equal(s.results()[0].status, 'failed'); assert.equal(s.results()[0].reason, 'timeout'); cleanedOnce(s);
});
test('stop during an awaited traffic snapshot cancels once and late success cannot overwrite it', async () => {
  const gate = deferred(); let delayed = false;
  const s = scenario({ snapshot: snapshot => delayed ? gate.promise : Promise.resolve(snapshot) }); await s.launch();
  delayed = true; s.proof(); const checking = s.service.acceptLatencyProof(); s.service.latencyTask = checking;
  const stopping = s.service.requestStop(false); gate.resolve(s.snapshot); await checking; await stopping; await s.settleCleanup();
  assert.equal(s.calls.save.length, 1); assert.equal(s.results()[0].status, 'cancelled'); assert.equal(s.results()[0].reason, 'stopped'); cleanedOnce(s);
});
test('UI stop written before snapshot completion cancels even before the control poll runs', async () => {
  const gate = deferred(); let delayed = false;
  const s = scenario({ snapshot: snapshot => delayed ? gate.promise : Promise.resolve(snapshot) }); await s.launch();
  delayed = true; s.proof(); const checking = s.service.acceptLatencyProof();
  s.stopCommand(); gate.resolve(s.snapshot); await checking; await s.service.requestStop(false); await s.settleCleanup();
  assert.notEqual(s.results()[0].status, 'passed'); assert.equal(s.calls.save.length, 1); cleanedOnce(s);
});
test('UI stop before proof reading suppresses success without requiring a controller tick', async () => {
  const s = scenario(); await s.launch(); s.proof(); s.stopCommand(); await s.service.acceptLatencyProof();
  await s.service.requestStop(false); await s.settleCleanup();
  assert.equal(s.results()[0].status, 'cancelled'); assert.equal(s.calls.save.length, 1); cleanedOnce(s);
});
test('superseding request before snapshot completion cannot save a successful result for the old run', async () => {
  const gate = deferred(); let delayed = false;
  const s = scenario({ snapshot: snapshot => delayed ? gate.promise : Promise.resolve(snapshot) }); await s.launch();
  delayed = true; s.proof(); const checking = s.service.acceptLatencyProof();
  s.shared.writeConnectionCommand(s.context.filesDir, new s.shared.ConnectionCommand(nextRun, 'start'));
  s.shared.writeProbeState(s.context.filesDir, new s.shared.ProbeState('starting', 'synthetic new run', nextRun, 'node-latency'));
  gate.resolve(s.snapshot); await checking; await s.service.requestStop(false); await s.settleCleanup();
  assert.notEqual(s.results()[0]?.status, 'passed');
  assert.equal(s.shared.readProbeState(s.context.filesDir).runId, nextRun);
  assert.equal(s.shared.readProbeState(s.context.filesDir).phase, 'starting');
});
test('physical network change cancels an active test and ignores late matching proof', async () => {
  const s = scenario(); await s.launch(); s.physical.current = new s.shared.PhysicalNetwork(101, 'cellular', '101/cellular/synthetic');
  await s.service.refreshDesiredNetwork(); s.proof(); await s.service.acceptLatencyProof(); await s.settleCleanup();
  assert.equal(s.calls.save.length, 1); assert.equal(s.results()[0].status, 'cancelled');
  assert.equal(s.results()[0].reason, 'network-changed'); cleanedOnce(s);
});
test('network change while traffic snapshot is awaited cannot later record passed', async () => {
  const gate = deferred(); let delayed = false;
  const s = scenario({ snapshot: snapshot => delayed ? gate.promise : Promise.resolve(snapshot) }); await s.launch();
  delayed = true; s.proof(); const checking = s.service.acceptLatencyProof(); s.service.latencyTask = checking;
  s.physical.current = undefined; await s.service.refreshDesiredNetwork(); gate.resolve(s.snapshot);
  await checking; await s.settleCleanup();
  assert.equal(s.calls.save.length, 1); assert.equal(s.results()[0].status, 'cancelled'); assert.equal(s.results()[0].reason, 'network-changed'); cleanedOnce(s);
});
test('stop while fingerprint is pending prevents core start and does not change the selected node', async () => {
  const gate = deferred(); const s = scenario({ fingerprintGate: gate.promise });
  s.service.onCreate({ parameters: s.prepare() }); await flush(); s.stopCommand();
  const stopping = s.service.requestStop(false); gate.resolve(); await stopping; await s.settleCleanup();
  assert.equal(s.calls.coreStart.length, 0); assert.equal(s.catalog.activeNodeId, s.active.id);
  assert.equal(s.results()[0].status, 'cancelled'); assert.equal(s.calls.save.length, 1);
});
test('30-second bounded service watchdog stops a test whose UI never submits proof', async () => {
  const s = scenario(); await s.launch(); const timer = [...s.timers].find(([, item]) => item.ms === 30000); assert.ok(timer);
  s.clock.now += 30000; s.clock.uptime += 30000; s.fire(timer[0]); await s.settleCleanup();
  assert.equal(s.results()[0].status, 'cancelled'); assert.equal(s.calls.save.length, 1); cleanedOnce(s);
});
test('result persistence failure still stops and cleans up exactly once', async () => {
  const s = scenario({ saveFailure: true }); await s.launch(); s.proof(); await s.service.acceptLatencyProof(); await s.settleCleanup();
  assert.equal(s.calls.save.length, 1); assert.deepEqual(plain(s.results()), []); cleanedOnce(s);
});
test('corrupt proof becomes a fixed internal failure without retaining its contents', async () => {
  const s = scenario(); await s.launch(); s.files.set(s.context.filesDir + '/latency-proof.json', Buffer.from('{synthetic-private-error'));
  await s.service.acceptLatencyProof(); await s.settleCleanup();
  assert.equal(s.results()[0].reason, 'internal'); assert.ok(!JSON.stringify(s.results()).includes('synthetic-private-error')); cleanedOnce(s);
});

(async () => {
  const results = [], unhandled = []; const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    for (const { name, body } of tests) {
      let watchdog;
      try {
        await Promise.race([Promise.resolve().then(body), new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('SYNTHETIC_LATENCY_SESSION_DEADLOCK')), 2000);
        })]); results.push({ name, passed: true });
      } catch (error) { results.push({ name, passed: false, detail: String(error.message) }); }
      finally { clearTimeout(watchdog); }
    }
    await new Promise(resolve => setImmediate(resolve));
    results.push({ name: 'service callbacks do not create unhandled promise rejections', passed: unhandled.length === 0 });
  } finally { process.off('unhandledRejection', listener); }
  const passed = results.filter(result => result.passed).length;
  const report = { checkedAt: new Date().toISOString(), passed, failed: results.length - passed, total: results.length,
    scope: 'Actual VpnProbeAbility, LatencyProtocol, NodeLatency, DiagnosticJournal, connection control and bootstrap modules via DevEco SDK transpilation; synthetic node catalog, core/SDK, monotonic clock and atomic in-memory files. No phone/network/private files.',
    limitations: ['Native proxy routing and core counters are mocked; real phone routing and latency measurement require separate verification.',
      'This service suite does not execute Nodes UI lifecycle or its input guards.'],
    sourceSHA256: Object.fromEntries([...sources].map(([name, source]) => [name, hash(source)])), results };
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/node-latency-session-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, failed: report.failed, total: results.length, failedCases: results.filter(result => !result.passed), scope: report.scope }));
  if (report.failed) process.exitCode = 1;
})().catch(() => { console.error('Synthetic node latency session harness failed.'); process.exitCode = 1; });
