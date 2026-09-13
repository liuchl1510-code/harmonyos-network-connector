'use strict';
// Real authored control methods with synthetic SDK/filesystem/core adapters only.
// No user profile, HDC, native library, phone or network is used by this script.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const devEco = process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(path.join(devEco, 'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const names = ['model/ConnectionControl.ets', 'model/ConnectionSnapshot.ets', 'model/ConnectionNotification.ets', 'model/TransferRate.ets',
  'model/ProbeState.ets', 'model/NodeBootstrap.ets', 'model/NetworkPolicy.ets', 'model/VpnAuthorization.ets', 'vpn/VpnProbeAbility.ets', 'pages/Home.ets', 'pages/Index.ets'];
const sources = new Map(names.map(name => [name, fs.readFileSync(path.join(root, 'entry/src/main/ets', name), 'utf8')]));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 35; i++) await Promise.resolve(); }

function scenario(options = {}) {
  const files = new Map(), handles = new Map(), timers = new Map(), appStorage = new Map();
  const clock = { now: 1000000 };
  let nextFd = 100, nextTimer = 1, uuid = 1;
  const calls = { rawCloses: [], create: 0, destroy: 0, coreStart: 0, coreStop: 0, serviceStop: 0,
    publish: [], cancel: [], transfer: 0, ipv6Datagrams: 0, partialWrites: 0, processAliveQueries: [],
    observerCreate: 0, observerOn: 0, observerOff: 0, coreConstruct: 0, coreSuspend: 0, coreResume: 0,
    coreStartArgs: [], coreResumeArgs: [], snapshot: 0, protect: [], networkRead: 0, dns: [], watcherStart: 0, watcherStop: 0,
    commandWrites: [], resourceReads: [] };
  class PhysicalNetwork {
    constructor(netId = 100, kind = 'wifi', key = `${netId}/${kind}/synthetic`) { Object.assign(this, { netId, kind, key }); }
  }
  const physical = { current: new PhysicalNetwork(), listener: undefined };
  const selectedNode = { protocol: 'vless', name: 'synthetic-node', outboundJson: JSON.stringify({ protocol: 'vless',
    settings: { vnext: [{ address: options.hostname ? 'node.example.test' : '192.0.2.123', port: 443,
      users: [{ id: '00000000-0000-4000-8000-000000000001', encryption: 'none' }] }] } }) };
  const fakeFs = {
    OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4 },
    accessSync: name => files.has(name),
    openSync(name, flags) {
      if (!files.has(name) || (flags & 4)) files.set(name, Buffer.alloc(0));
      const fd = nextFd++; handles.set(fd, { name, position: 0 }); return { fd };
    },
    writeSync(fd, value) {
      const handle = handles.get(fd); if (!handle) throw new Error('unknown synthetic file fd');
      const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
      const n = handle.name.includes('connection-') ? Math.min(7, bytes.length) : bytes.length;
      if (n < bytes.length) calls.partialWrites++;
      const previous = files.get(handle.name), output = Buffer.alloc(Math.max(previous.length, handle.position + n));
      previous.copy(output); bytes.copy(output, handle.position, 0, n); handle.position += n;
      files.set(handle.name, output); return n;
    },
    closeSync(file) {
      const fd = typeof file === 'number' ? file : file.fd;
      if (handles.has(fd)) handles.delete(fd); else calls.rawCloses.push(fd);
    },
    renameSync(from, to) { if (!files.has(from)) throw new Error('missing synthetic temp'); files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(name) { files.delete(name); },
    readTextSync(name) { if (!files.has(name)) throw new Error('synthetic missing file'); return files.get(name).toString('utf8'); }
  };
  class FakeDate extends Date { static now() { return clock.now; } }
  const silent = { info() {}, error() {}, warn() {} };
  const context = { filesDir: '/synthetic-vpn', openLink: async () => {} };
  const shared = { VPN_CORE_AVAILABLE: !options.preview, deviceInfo: { sdkApiVersion: options.sdkApiVersion ?? 26 }, fs: fakeFs, Date: FakeDate, systemDateTime: { TimeType: { STARTUP: 0 }, getUptime: () => clock.now }, hilog: silent, describeError: () => 'synthetic-error',
    AppStorage: {
      get: key => appStorage.get(key),
      set(key, value) { if (!appStorage.has(key)) return false; appStorage.set(key, value); return true; },
      setOrCreate(key, value) { appStorage.set(key, value); return true; }
    },
    $r(name) { calls.resourceReads.push(name); return { id: name }; },
    util: { generateRandomUUID: () => 'synthetic-' + uuid++, TextEncoder: class { encodeInto(s) { return new TextEncoder().encode(s); } } },
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval: id => timers.delete(id),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms, interval: false }); return id; },
    clearTimeout: id => timers.delete(id),
    console: { info() {}, log() {}, warn() {}, error() {} },
    readNodeProfile: () => selectedNode,
    readNetworkPolicy: () => options.readNetworkPolicy ? options.readNetworkPolicy() : undefined,
    nodeServerAddress: node => JSON.parse(node.outboundJson).settings.vnext[0].address,
    PhysicalNetwork, PhysicalNetworkWatcher: class {
      async start(listener) { calls.watcherStart++; physical.listener = listener; if (options.watcherStart) await options.watcherStart(); }
      async stop() { calls.watcherStop++; physical.listener = undefined; if (options.watcherStop) await options.watcherStop(); }
    },
    readPhysicalNetwork: () => { calls.networkRead++; return options.networkRead ? options.networkRead() : Promise.resolve(physical.current); },
    resolvePhysicalIpv4: (host, network, current) => {
      calls.dns.push({ host, network, current });
      return options.resolvePhysicalIpv4 ? options.resolvePhysicalIpv4(host, network, current) : Promise.resolve('192.0.2.123');
    },
    readTransferResult: () => ({ status: 'pending', runId: '' }),
    connectionExitMarker: () => 'synthetic-exit',
    checkProxyDns: () => options.checkProxyDns ? options.checkProxyDns() : Promise.resolve(),
    probeIpv6Datagram: () => {
      calls.ipv6Datagrams++;
      return options.probeIpv6Datagram ? options.probeIpv6Datagram() : Promise.resolve(false);
    }
  };
  function load(name, extra = {}) {
    let source = sources.get(name).replace(/^import[^\n]*\n/gm, '');
    if (name === 'pages/Home.ets' || name === 'pages/Index.ets') {
      const pageName = name === 'pages/Home.ets' ? 'Home' : 'Index';
      source = source.slice(0, source.indexOf('\n  build() {')) + '\n}\n';
      source = source.replace(/@Entry\s*\n|@Component\s*\n/g, '').replace(/@State /g, '').replace(/@StorageProp\([^)]*\)\s*/g, '').replace('struct ' + pageName, 'export class ' + pageName);
    }
    const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
    assert.equal(result.diagnostics.length, 0, 'transpile ' + name);
    const exported = {};
    vm.runInNewContext(result.outputText, { ...shared, ...extra, exports: exported, module: { exports: exported } }, { filename: name });
    return exported;
  }
  Object.assign(shared, load('model/ConnectionSnapshot.ets'));
  Object.assign(shared, load('model/TransferRate.ets'));
  Object.assign(shared, load('model/ConnectionControl.ets'));
  const writeConnectionCommand = shared.writeConnectionCommand;
  shared.writeConnectionCommand = (filesDir, command) => {
    calls.commandWrites.push({ ...command });
    return writeConnectionCommand(filesDir, command);
  };
  Object.assign(shared, load('model/ProbeState.ets'));
  Object.assign(shared, load('model/NodeBootstrap.ets'));
  Object.assign(shared, load('model/NetworkPolicy.ets'));
  const notificationManager = {
    isNotificationEnabled: () => options.notificationEnabled ? options.notificationEnabled() : Promise.resolve(true),
    requestEnableNotification: async () => {},
    ContentType: { NOTIFICATION_CONTENT_BASIC_TEXT: 0 },
    publish: request => { calls.publish.push(request); return options.notificationPublish ? options.notificationPublish(request) : Promise.resolve(); },
    cancel: async (id, label) => { calls.cancel.push({ id, label }); }
  };
  const wantAgent = { OperationType: { START_ABILITY: 0 }, WantAgentFlags: { UPDATE_PRESENT_FLAG: 0 }, getWantAgent: async () => ({}) };
  Object.assign(shared, { notificationManager, wantAgent });
  Object.assign(shared, load('model/ConnectionNotification.ets'));
  const snapshot = Object.assign(new shared.ConnectionSnapshot(), { active: true, startedAt: clock.now - 1000,
    sampledAt: clock.now, coreVersion: '26.6.1', uplink: 12, downlink: 34 });
  const core = { startConnection: async (...args) => { calls.coreStart++; calls.coreStartArgs.push(args); if (options.coreStart) await options.coreStart(...args); },
    stop: async () => { calls.coreStop++; if (options.coreStop) await options.coreStop(); },
    suspendConnection: async () => { calls.coreSuspend++; if (options.coreSuspend) await options.coreSuspend(); },
    resumeConnection: async (...args) => { calls.coreResume++; calls.coreResumeArgs.push(args); if (options.coreResume) await options.coreResume(...args); },
    logNodeTraffic: async () => {}, readConnectionSnapshot: () => { calls.snapshot++; return options.snapshot ? options.snapshot() : Promise.resolve(snapshot); },
    diagnosticSummary: '', detectOutboundLoop: () => false };
  const connection = { protectProcessNet: async () => {}, protect: async fd => { calls.protect.push(fd); if (options.protect) await options.protect(fd); },
    create: () => { calls.create++; return options.create ? options.create() : Promise.resolve(7000); },
    destroy: async () => { calls.destroy++; } };
  let service;
  let authorizationCallback;
  const vpnExtension = { createVpnConnection: () => connection,
    startVpnExtensionAbility: async want => { if (options.startVpnRequest) await options.startVpnRequest(want); },
    stopVpnExtensionAbility: async () => { calls.serviceStop++; if (options.autoDestroy !== false) service?.onDestroy(); },
    createVpnObserver: () => {
      calls.observerCreate++;
      return {
        onAuthorizationResult(callback) { calls.observerOn++; authorizationCallback = callback; },
        offAuthorizationResult() { calls.observerOff++; authorizationCallback = undefined; }
      };
    } };
  if (options.missingObserver) delete vpnExtension.createVpnObserver;
  const http = { RequestMethod: { GET: 0 }, HttpDataType: { STRING: 0 }, createHttp: () => ({
    request: () => { calls.transfer++; return options.httpRequest ? options.httpRequest() : Promise.resolve({ responseCode: 200, result: 'h=www.cloudflare.com\nip=synthetic\n' }); },
    destroy() {} }) };
  Object.assign(shared, { vpnExtension, http,
    VpnExtensionAbility: class { constructor() { this.context = context; } }, CoreProbe: class { constructor() { calls.coreConstruct++; return core; } },
    native: { inspectFd: () => 'synthetic fd OK', inspectTunAddresses: () => 'synthetic TUN addresses', currentProcessId: () => 4242 },
    nativeBridge: { selfCheck: () => 'NATIVE_OK synthetic',
      processAlive: pid => { calls.processAliveQueries.push(pid); return options.processAlive ? options.processAlive(pid) : true; } } });
  Object.assign(shared, load('model/VpnAuthorization.ets'));
  const Service = load('vpn/VpnProbeAbility.ets').default;
  const Home = load('pages/Home.ets').Home;
  const Index = load('pages/Index.ets').Index;
  service = new Service();
  const home = new Home();
  home.getUIContext = () => ({ getHostContext: () => context, getRouter: () => ({ back() {}, pushUrl() {} }) });
  const index = new Index();
  index.getUIContext = home.getUIContext;
  function prepare(runId = 'run-one', phase = 'starting', kind = 'connection') {
    shared.writeProbeState(context.filesDir, new shared.ProbeState(phase, 'synthetic', runId, kind));
    shared.writeConnectionCommand(context.filesDir, new shared.ConnectionCommand(runId, 'start'));
    return { runId, kind };
  }
  function activate(runId = 'run-one') {
    prepare(runId, 'active');
    service.runId = runId; service.testKind = 'connection'; service.coreProbe = core;
    service.initialization = Promise.resolve(); service.tunFd = 7000; service.networkCreated = true; service.connection = connection;
    service.connectionPhase = 'active'; service.connectionMessage = 'synthetic active'; service.connectionNode = selectedNode;
    service.desiredNetwork = physical.current; service.networkEpoch = 1; service.dialEpoch = 1;
    service.appliedNetworkKey = physical.current.key;
    shared.writeConnectionStatus(context.filesDir, new shared.ConnectionStatus(runId, 'active', snapshot, false, 4242));
  }
  function fire(id) { const task = timers.get(id); if (!task.interval) timers.delete(id); task.fn(); }
  async function launch() {
    service.onCreate({ parameters: prepare() }); await service.initialization; await flush();
    assert.equal(service.failure, ''); assert.equal(service.connectionPhase, 'active');
  }
  function controlTick() { const control = [...timers.entries()].find(([, task]) => task.interval && task.ms === 300); assert(control); fire(control[0]); }
  return { shared, context, service, home, index, calls, files, timers, clock, snapshot, core, prepare, activate, fire,
    physical, selectedNode, launch, controlTick,
    emitAuthorization: allowed => { assert.equal(typeof authorizationCallback, 'function'); authorizationCallback(allowed); },
    status: () => shared.readConnectionStatus(context.filesDir), command: () => shared.readConnectionCommand(context.filesDir) };
}

const tests = [];
function test(name, body) { tests.push({ name, body }); }

test('atomic stop command survives service heartbeats and partial writes', async () => {
  const s = scenario(); s.prepare();
  s.shared.writeConnectionCommand(s.context.filesDir, new s.shared.ConnectionCommand('run-one', 'stop'));
  for (let i = 0; i < 3; i++) s.shared.writeConnectionStatus(s.context.filesDir, new s.shared.ConnectionStatus('run-one', 'active', s.snapshot));
  assert.equal(s.command().action, 'stop'); assert.equal(s.command().runId, 'run-one');
  assert(s.calls.partialWrites > 0);
});

test('pending heartbeat honors stop before publishing', async () => {
  const gate = deferred(), s = scenario({ snapshot: () => gate.promise }); s.activate();
  const pending = s.service.refreshConnectionStatus();
  s.shared.writeConnectionCommand(s.context.filesDir, new s.shared.ConnectionCommand('run-one', 'stop'));
  gate.resolve(s.snapshot); await pending;
  assert.equal(s.command().action, 'stop'); assert.equal(s.service.stopRequested, true); assert.equal(s.calls.publish.length, 0);
});

test('pending heartbeat does not overwrite superseding run', async () => {
  const gate = deferred(), s = scenario({ snapshot: () => gate.promise }); s.activate();
  const pending = s.service.refreshConnectionStatus();
  s.prepare('run-two'); s.shared.writeConnectionStatus(s.context.filesDir, new s.shared.ConnectionStatus('run-two', 'starting'));
  gate.resolve(s.snapshot); await pending;
  assert.equal(s.status().runId, 'run-two'); assert.equal(s.status().phase, 'starting');
});

test('stop during create owns returned fd and destroys once', async () => {
  const gate = deferred(), s = scenario({ create: () => gate.promise }); const launch = s.prepare();
  s.service.onCreate({ parameters: launch }); await flush(); assert.equal(s.calls.create, 1);
  s.shared.writeConnectionCommand(s.context.filesDir, new s.shared.ConnectionCommand('run-one', 'stop'));
  const stopping = s.service.requestStop(false); gate.resolve(7000); await stopping; await flush();
  assert.equal(s.calls.rawCloses.filter(fd => fd === 7000).length, 1); assert.equal(s.calls.destroy, 1);
  assert.equal(s.calls.coreStart, 0); assert.equal(s.status().phase, 'destroyed');
});

test('onDestroy receipt remains terminal after pending initialization cleanup', async () => {
  const gate = deferred(), s = scenario({ create: () => gate.promise }); const launch = s.prepare();
  s.service.onCreate({ parameters: launch }); await flush();
  s.service.onDestroy(); assert.equal(s.status().phase, 'destroying');
  assert.equal(s.status().cleanupConfirmed, false); s.home.refresh(); assert.equal(s.home.closed, false);
  gate.resolve(7000); await s.service.cleanup; await flush();
  assert.equal(s.status().phase, 'destroyed', 'completed post-destroy cleanup must retain terminal acknowledgement');
  assert.equal(s.status().cleanupConfirmed, true); s.home.refresh(); assert.equal(s.home.closed, true);
});

test('old onDestroy does not replace newer session status', async () => {
  const s = scenario(); s.activate('run-one'); s.service.resourceCleanupConfirmed = true; s.service.cleanup = Promise.resolve();
  s.prepare('run-two', 'active'); s.shared.writeConnectionStatus(s.context.filesDir, new s.shared.ConnectionStatus('run-two', 'active', s.snapshot));
  s.service.onDestroy(); await flush();
  assert.equal(s.status().runId, 'run-two'); assert.equal(s.status().phase, 'active');
});

test('90-second test arms active-session stop and closes once', async () => {
  const s = scenario(); const launch = s.prepare('run-one', 'starting', 'connection-test');
  s.service.onCreate({ parameters: launch }); await flush();
  const timer = [...s.timers.entries()].find(([, t]) => !t.interval && t.ms === 90000);
  assert(timer, 'test timeout must be armed'); s.clock.now += 90000; s.fire(timer[0]);
  await s.service.cleanup; await flush();
  assert.equal(s.calls.coreStop, 1); assert.equal(s.calls.destroy, 1); assert.equal(s.status().phase, 'destroyed');
});

test('persistent connection has no 90-second automatic stop', async () => {
  const s = scenario(); s.service.onCreate({ parameters: s.prepare() }); await flush();
  assert.equal([...s.timers.values()].some(t => !t.interval && t.ms === 90000), false);
  assert.equal(s.calls.serviceStop, 0);
});

test('status failure schedules cleanup outside its own task', async () => {
  const s = scenario({ snapshot: async () => { throw new Error('synthetic stats failure'); } }); s.activate();
  const task = s.service.refreshConnectionStatus(); s.service.statusTask = task;
  void task.then(() => { if (s.service.statusTask === task) s.service.statusTask = undefined; });
  await task; await flush();
  const stop = [...s.timers.entries()].find(([, t]) => !t.interval && t.ms === 0);
  assert(stop); s.fire(stop[0]); await s.service.cleanup; await flush();
  assert.equal(s.calls.coreStop, 1); assert.equal(s.calls.destroy, 1);
});

test('Home hide/disappear never writes stop or stops extension', async () => {
  const s = scenario(); s.activate(); s.home.aboutToAppear(); await flush();
  s.home.onPageHide(); s.home.aboutToDisappear();
  assert.equal(s.command().action, 'start'); assert.equal(s.calls.serviceStop, 0);
});

test('API 24 creates no unsupported observer and still launches the service', async () => {
  const s = scenario({ sdkApiVersion: 24, missingObserver: true });
  s.home.aboutToAppear(); s.index.aboutToAppear(); await flush();
  assert.equal(s.home.authorizationSubscription, -1); assert.equal(s.index.authorizationSubscription, -1);
  assert.equal(s.calls.observerCreate, 0); assert.equal(s.calls.observerOn, 0);
  await s.launch(); assert.equal(s.calls.create, 1); assert.equal(s.calls.coreStart, 1);
});

test('missing observer factory on an API 26 device does not break subscriptions', async () => {
  const s = scenario({ missingObserver: true });
  assert.equal(s.shared.subscribeVpnAuthorization(() => assert.fail('must not invent authorization')), -1);
  assert.equal(s.calls.observerCreate, 0);
});

test('unstarted request expires without claiming an authorization denial or creating TUN', async () => {
  const s = scenario({ sdkApiVersion: 24, missingObserver: true }); s.prepare();
  s.clock.now += 25000; s.home.refresh(); assert.equal(s.command().action, 'start');
  s.clock.now++; s.home.refresh();
  assert.equal(s.command().action, 'stop'); assert.equal(s.home.phase, 'failed'); assert.equal(s.home.closed, true);
  assert.match(s.home.detail, /未收到 VPN 启动结果/); assert.equal(s.calls.create, 0);
  s.service.onCreate({ parameters: { runId: 'run-one', kind: 'connection' } });
  await s.service.initialization; await flush();
  assert.equal(s.calls.create, 0); assert.equal(s.calls.coreStart, 0);
});

test('pending cancellation settles after admission timeout and remains retryable', async () => {
  const s = scenario({ sdkApiVersion: 24 }); s.prepare(); s.home.refresh();
  await s.home.disconnect(); assert.equal(s.command().action, 'stop');
  s.clock.now += 25001; s.home.refresh();
  assert.equal(s.home.phase, 'failed'); assert.equal(s.home.closed, true); assert.match(s.home.detail, /已取消/);
  s.home.hasNode = true; await s.home.connect();
  assert.equal(s.command().action, 'start'); assert.notEqual(s.command().runId, 'run-one');
});

test('unstarted timeout never closes a service that already reported the request', async () => {
  const s = scenario({ sdkApiVersion: 24 }); s.prepare();
  s.shared.writeConnectionStatus(s.context.filesDir, new s.shared.ConnectionStatus('run-one', 'starting', undefined, false, 4242));
  s.clock.now += 25001; s.home.refresh();
  assert.equal(s.command().action, 'start'); assert.equal(s.home.closed, false); assert.equal(s.home.phase, 'unknown');
});

test('pending API 24 start expires and late rejection cannot stop the retry', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const s = scenario({ sdkApiVersion: 24, missingObserver: true, startVpnRequest: () => ++calls === 1 ? first.promise : second.promise });
  s.home.closed = true; s.home.hasNode = true;
  const firstConnect = s.home.connect(); await flush();
  const oldRun = s.command().runId; assert.equal(s.home.requesting, true); assert.equal(s.home.phase, 'starting');
  s.clock.now += 25001; s.home.refresh();
  assert.equal(s.home.requesting, false); assert.equal(s.home.closed, true); assert.equal(s.command().action, 'stop');
  const secondConnect = s.home.connect(); await flush();
  const newRun = s.command().runId; assert.notEqual(newRun, oldRun); assert.equal(s.home.requesting, true);
  first.reject(new Error('old delayed rejection')); await firstConnect; await flush();
  assert.equal(s.command().runId, newRun); assert.equal(s.command().action, 'start');
  assert.equal(s.home.requesting, true); assert.equal(s.home.phase, 'starting');
  second.resolve(); await secondConnect; assert.equal(s.home.requesting, false);
});

test('API 26 authorization refusal also invalidates a still-pending start promise', async () => {
  const pending = deferred(); const s = scenario({ startVpnRequest: () => pending.promise });
  s.home.aboutToAppear(); await flush(); s.home.closed = true;
  const connecting = s.home.connect(); await flush(); assert.equal(s.home.requesting, true);
  s.emitAuthorization(false); assert.equal(s.home.requesting, false); assert.equal(s.home.closed, true);
  const writes = s.calls.commandWrites.length; pending.reject(new Error('late denied start')); await connecting;
  assert.equal(s.calls.commandWrites.length, writes); assert.equal(s.home.phase, 'failed');
});

test('unstarted timeout cannot cancel another UI process owner', async () => {
  const s = scenario({ sdkApiVersion: 24 }); s.prepare();
  s.shared.writeConnectionCommand(s.context.filesDir, new s.shared.ConnectionCommand('run-one', 'start', 'different-owner'));
  s.clock.now += 25001; s.home.refresh();
  assert.equal(s.command().action, 'start'); assert.equal(s.home.phase, 'interrupted');
});

test('Home first-run primary action opens import without a VPN start', async () => {
  const s = scenario(), routes = [];
  s.home.getUIContext = () => ({ getHostContext: () => s.context, getRouter: () => ({ pushUrl: async want => routes.push(want.url) }) });
  s.home.hasNode = false; s.home.closed = true; await s.home.primaryAction();
  assert.deepEqual(routes, ['pages/NodeConfig']); assert.equal(s.calls.commandWrites.length, 0); assert.equal(s.calls.create, 0);
});

test('Home primary action preserves request and preview-core guards', async () => {
  const s = scenario({ preview: true }); s.home.hasNode = true; s.home.closed = true;
  await s.home.primaryAction(); assert.equal(s.calls.commandWrites.length, 0); assert.equal(s.calls.create, 0);
  s.home.hasNode = false; s.home.requesting = true;
  s.home.getUIContext = () => { assert.fail('requesting primary action must not navigate'); };
  await s.home.primaryAction();
});

test('Home network summary refreshes saved preferences without changing the session', async () => {
  let policy = { mode: 'global', bypassLan: false }; const s = scenario({ readNetworkPolicy: () => policy });
  s.activate(); const writes = s.calls.commandWrites.length;
  s.home.onPageShow(); assert.equal(s.home.routingSummary, '全部代理');
  policy = { mode: 'rules', bypassLan: true }; s.home.onPageShow();
  assert.equal(s.home.routingSummary, '规则分流 · 绕过局域网'); assert.equal(s.calls.commandWrites.length, writes);
  assert.equal(s.calls.create, 0); assert.equal(s.calls.serviceStop, 0);
});

test('Home unreadable policy summary does not masquerade as the default configuration', async () => {
  const s = scenario({ readNetworkPolicy: () => { throw new Error('synthetic unreadable policy'); } });
  s.home.refreshProfile(); assert.equal(s.home.routingSummary, '网络设置需要检查');
  assert.equal(s.calls.commandWrites.length, 0);
});

test('Home foreground cycles retain one native observer and one poll', async () => {
  const s = scenario(); s.prepare(); s.home.aboutToAppear(); await flush();
  const subscription = s.home.authorizationSubscription;
  for (let i = 0; i < 20; i++) {
    s.home.aboutToAppear();
    assert.equal(s.home.authorizationSubscription, subscription);
    assert.equal(s.timers.size, 1);
    s.home.onPageHide(); assert.equal(s.timers.size, 0);
    s.home.onPageShow(); s.home.onPageShow(); assert.equal(s.timers.size, 1);
  }
  s.emitAuthorization(false);
  assert.equal(s.command().action, 'stop'); assert.equal(s.home.phase, 'failed');
  s.home.aboutToDisappear(); assert.equal(s.timers.size, 0);
  assert.equal(s.home.authorizationSubscription, -1);
  s.home.aboutToAppear(); await flush();
  assert(s.home.authorizationSubscription > subscription);
  assert.equal(s.calls.observerCreate, 1); assert.equal(s.calls.observerOn, 1); assert.equal(s.calls.observerOff, 0);
});

test('Home developer view cycles retain the active session and authorization subscription', async () => {
  const s = scenario(); s.activate(); s.home.aboutToAppear(); await flush();
  const subscription = s.home.authorizationSubscription;
  const writes = s.calls.commandWrites.length;
  const generation = s.home.checkGeneration;
  assert.equal(s.home.onBackPress(), false);
  s.home.onPageShow(); assert.equal(s.home.developerTools, false);
  for (let i = 0; i < 20; i++) {
    s.home.onPageHide(); assert.equal(s.timers.size, 0);
    s.shared.AppStorage.setOrCreate('openDeveloperTools', true);
    s.home.onPageShow();
    assert.equal(s.home.developerTools, true); assert.equal(s.shared.AppStorage.get('openDeveloperTools'), false);
    assert.equal(s.home.phase, 'active'); assert.equal(s.home.runId, 'run-one'); assert.equal(s.home.closed, false);
    assert.equal(s.home.statusTone().id, 'app.color.success');
    assert.equal(s.home.onBackPress(), true); assert.equal(s.home.developerTools, false);
    assert.equal(s.home.onBackPress(), false);
    s.home.onPageShow(); assert.equal(s.home.developerTools, false, 'consumed developer flag must not reopen the view');
    assert.equal(s.home.authorizationSubscription, subscription); assert.equal(s.timers.size, 1);
    assert.equal(s.home.checkGeneration, generation);
    assert.equal(s.calls.commandWrites.length, writes, 'view changes must not write any connection command');
    assert.equal(s.command().action, 'start'); assert.equal(s.calls.serviceStop, 0);
    assert.equal(s.calls.coreStop, 0); assert.equal(s.calls.destroy, 0);
    assert.equal(s.calls.observerCreate, 1); assert.equal(s.calls.observerOn, 1); assert.equal(s.calls.observerOff, 0);
  }
});

test('Home developer view changes preserve an in-flight connection check', async () => {
  const gate = deferred(), s = scenario({ httpRequest: () => gate.promise });
  s.activate(); s.home.aboutToAppear(); await flush();
  const pending = s.home.checkConnection(); await flush(); assert.equal(s.calls.transfer, 1);
  const generation = s.home.checkGeneration, subscription = s.home.authorizationSubscription;
  const writes = s.calls.commandWrites.length;
  s.home.onPageHide(); s.shared.AppStorage.setOrCreate('openDeveloperTools', true); s.home.onPageShow();
  assert.equal(s.home.developerTools, true); assert.equal(s.home.checking, true);
  assert.equal(s.home.onBackPress(), true); assert.equal(s.home.checking, true);
  assert.equal(s.home.checkGeneration, generation); assert.equal(s.home.authorizationSubscription, subscription);
  gate.resolve({ responseCode: 200, result: 'h=www.cloudflare.com\nip=synthetic\n' }); await pending;
  assert.equal(s.home.checkResult, '代理 DNS 与域名 HTTPS 检查通过。'); assert.equal(s.home.checking, false);
  assert.equal(s.calls.commandWrites.length, writes); assert.equal(s.calls.serviceStop, 0);
  assert.equal(s.calls.observerCreate, 1); assert.equal(s.calls.observerOn, 1); assert.equal(s.calls.observerOff, 0);
});

test('Home developer view closes without disconnecting and retains pending authorization rejection handling', async () => {
  const s = scenario(); s.prepare(); s.home.aboutToAppear(); await flush();
  const subscription = s.home.authorizationSubscription, writes = s.calls.commandWrites.length;
  s.shared.AppStorage.setOrCreate('openDeveloperTools', true); s.home.onPageShow();
  assert.equal(s.home.developerTools, true); assert.equal(s.home.phase, 'starting');
  assert.equal(s.home.onBackPress(), true); assert.equal(s.home.developerTools, false);
  assert.equal(s.calls.commandWrites.length, writes); assert.equal(s.command().action, 'start');
  assert.equal(s.calls.serviceStop, 0); assert.equal(s.home.authorizationSubscription, subscription);
  s.emitAuthorization(false);
  assert.equal(s.calls.commandWrites.length, writes + 1); assert.equal(s.command().action, 'stop');
  assert.equal(s.home.phase, 'failed'); assert.equal(s.home.closed, true);
  assert.equal(s.calls.observerCreate, 1); assert.equal(s.calls.observerOn, 1); assert.equal(s.calls.observerOff, 0);
});

test('Home disposal leaves the Index authorization subscriber active', async () => {
  const s = scenario(); s.prepare('run-diagnostic', 'starting', 'lifecycle');
  s.home.aboutToAppear(); s.index.aboutToAppear(); await flush();
  assert.equal(s.calls.observerCreate, 1); assert.equal(s.calls.observerOn, 1);
  s.home.aboutToDisappear(); s.emitAuthorization(false);
  assert.equal(s.index.phase, 'failed'); assert.equal(s.index.runId, 'run-diagnostic');
  assert.equal(s.calls.observerOff, 0);
  s.index.aboutToDisappear(); assert.equal(s.timers.size, 0);
});

test('independent subscriptions unsubscribe without native off or duplicate delivery', async () => {
  const s = scenario(), first = [], second = [];
  const one = s.shared.subscribeVpnAuthorization(allowed => first.push(allowed));
  const two = s.shared.subscribeVpnAuthorization(allowed => second.push(allowed));
  assert.notEqual(one, two); s.emitAuthorization(true);
  s.shared.unsubscribeVpnAuthorization(one); s.shared.unsubscribeVpnAuthorization(one);
  s.emitAuthorization(false);
  assert.deepEqual(first, [true]); assert.deepEqual(second, [true, false]);
  s.shared.unsubscribeVpnAuthorization(two); s.emitAuthorization(true);
  assert.deepEqual(second, [true, false]); assert.equal(s.calls.observerOff, 0);
});

test('resubscribing after the last page leaves reuses the native observer', async () => {
  const s = scenario(), events = [];
  const first = s.shared.subscribeVpnAuthorization(() => {});
  s.shared.unsubscribeVpnAuthorization(first);
  const second = s.shared.subscribeVpnAuthorization(value => events.push(value));
  s.emitAuthorization(false);
  assert(second > first); assert.deepEqual(events, [false]);
  assert.equal(s.calls.observerCreate, 1); assert.equal(s.calls.observerOn, 1); assert.equal(s.calls.observerOff, 0);
});

test('Home waits for destroyed acknowledgement before reconnect', async () => {
  const s = scenario(); s.prepare('run-one', 'stopped');
  s.shared.writeConnectionStatus(s.context.filesDir, new s.shared.ConnectionStatus('run-one', 'stopped'));
  s.home.refresh(); assert.equal(s.home.closed, false);
  const destroyed = new s.shared.ConnectionStatus('run-one', 'destroyed');
  destroyed.cleanupConfirmed = false; s.shared.writeConnectionStatus(s.context.filesDir, destroyed);
  s.home.refresh(); assert.equal(s.home.closed, false);
  destroyed.cleanupConfirmed = true; s.shared.writeConnectionStatus(s.context.filesDir, destroyed);
  s.home.refresh(); assert.equal(s.home.closed, true);
});

test('confirmed dead service permits local reconnect without forging cleanup receipt', async () => {
  const s = scenario({ processAlive: () => false }); s.prepare('run-one', 'active');
  s.shared.writeConnectionStatus(s.context.filesDir, new s.shared.ConnectionStatus('run-one', 'destroying', s.snapshot, false, 4242));
  s.home.refresh();
  assert.equal(s.home.phase, 'interrupted'); assert.equal(s.home.closed, true);
  assert.deepEqual(s.calls.processAliveQueries, [4242]);
  assert.equal(s.status().cleanupConfirmed, false); assert.equal(s.status().phase, 'destroying');
});

test('service not proven dead preserves conservative reconnect gate', async () => {
  const s = scenario({ processAlive: () => true }); s.prepare('run-one', 'active');
  s.shared.writeConnectionStatus(s.context.filesDir, new s.shared.ConnectionStatus('run-one', 'destroying', s.snapshot, false, 4242));
  s.home.refresh(); assert.equal(s.home.closed, false); assert.equal(s.home.phase, 'active');
  assert.equal(s.status().cleanupConfirmed, false);
});

test('new UI epoch does not display previous process connection as live', async () => {
  const s = scenario(); s.prepare('run-one', 'active');
  s.shared.writeConnectionCommand(s.context.filesDir, new s.shared.ConnectionCommand('run-one', 'start', 'previous-ui-epoch'));
  s.shared.writeConnectionStatus(s.context.filesDir, new s.shared.ConnectionStatus('run-one', 'active', s.snapshot, false, 4242));
  s.home.refresh(); assert.equal(s.home.phase, 'interrupted'); assert.equal(s.home.closed, true);
  assert.equal(s.status().phase, 'active'); assert.equal(s.status().cleanupConfirmed, false);
});

test('late failed connectivity check cannot replace newer run result', async () => {
  const gate = deferred(), s = scenario({ httpRequest: () => gate.promise });
  s.activate(); s.home.refresh();
  const check = s.home.checkConnection(false); await flush(); assert.equal(s.calls.transfer, 1);
  s.activate('run-two'); s.home.refresh(); s.home.checkResult = 'new session result';
  gate.reject(new Error('synthetic old check')); await check;
  assert.equal(s.home.checkResult, 'new session result');
});

test('late IPv6 response cannot replace newer run result', async () => {
  const gate = deferred(), s = scenario({ httpRequest: () => gate.promise });
  s.activate(); s.home.refresh();
  const check = s.home.checkConnection(true); await flush();
  assert.equal(s.calls.transfer, 1, 'the old IPv6 HTTP request must actually be in flight');
  s.activate('run-two'); s.home.refresh(); s.home.checkResult = 'new session result';
  gate.resolve({ responseCode: 200, result: 'synthetic' }); await check;
  assert.equal(s.home.checkResult, 'new session result');
});

test('late IPv6 UDP reply cannot replace newer run result', async () => {
  const gate = deferred(), s = scenario({ probeIpv6Datagram: () => gate.promise });
  s.activate(); s.home.refresh();
  const check = s.home.checkConnection(true); await flush();
  assert.equal(s.calls.ipv6Datagrams, 1); assert.equal(s.calls.transfer, 0);
  s.activate('run-two'); s.home.refresh(); s.home.checkResult = 'new session result';
  gate.resolve(true); await check;
  assert.equal(s.home.checkResult, 'new session result'); assert.equal(s.calls.transfer, 0);
});

test('late IPv6 UDP timeout cannot start HTTP after disconnect', async () => {
  const gate = deferred(), s = scenario({ probeIpv6Datagram: () => gate.promise });
  s.activate(); s.home.refresh();
  const check = s.home.checkConnection(true); await flush();
  refreshHomePhase(s, 'stopped'); s.home.checkResult = 'disconnected result';
  gate.resolve(false); await check;
  assert.equal(s.home.checkResult, 'disconnected result'); assert.equal(s.calls.transfer, 0);
});

test('late DNS completion cannot start HTTP after disconnect', async () => {
  const gate = deferred(), s = scenario({ checkProxyDns: () => gate.promise });
  s.activate(); s.home.refresh();
  const check = s.home.checkConnection(false); await flush();
  assert.equal(s.calls.transfer, 0);
  refreshHomePhase(s, 'stopped'); s.home.checkResult = 'disconnected result';
  gate.resolve(); await check;
  assert.equal(s.home.checkResult, 'disconnected result'); assert.equal(s.calls.transfer, 0);
});

test('late IPv6 UDP rejection cannot start HTTP after disconnect', async () => {
  const gate = deferred(), s = scenario({ probeIpv6Datagram: () => gate.promise });
  s.activate(); s.home.refresh();
  const check = s.home.checkConnection(true); await flush();
  refreshHomePhase(s, 'stopped'); s.home.checkResult = 'disconnected result';
  gate.reject(new Error('synthetic late UDP failure')); await check;
  assert.equal(s.home.checkResult, 'disconnected result'); assert.equal(s.calls.transfer, 0);
});

test('new connect resets previous connectivity-check bookkeeping', async () => {
  const s = scenario(); s.home.phase = 'idle'; s.home.closed = true; s.home.hasNode = true;
  s.home.checking = true; await s.home.connect();
  assert.equal(s.home.checking, false);
});

test('old check finally cannot clear newer in-flight check', async () => {
  const oldGate = deferred(), newGate = deferred(), pending = [oldGate, newGate];
  const s = scenario({ httpRequest: () => pending.shift().promise });
  s.activate(); s.home.refresh();
  const oldCheck = s.home.checkConnection(false); await flush();
  assert.equal(s.calls.transfer, 1);
  s.activate('run-two'); s.home.refresh(); s.home.checking = false;
  const newCheck = s.home.checkConnection(false); await flush();
  assert.equal(s.calls.transfer, 2, 'both old and newer requests must be in flight');
  oldGate.reject(new Error('synthetic stale check')); await oldCheck;
  assert.equal(s.home.checking, true, 'old finally must not release new check ownership');
  newGate.resolve({ responseCode: 200, result: 'h=www.cloudflare.com\nip=synthetic\n' });
  await newCheck; assert.equal(s.home.checking, false);
});

test('notification cancellation before publish suppresses publication', async () => {
  const gate = deferred(), s = scenario({ notificationEnabled: () => gate.promise }); let active = true;
  const pending = s.shared.publishConnectionNotification(s.snapshot, 'run-one', () => active);
  active = false; gate.resolve(true); await pending; assert.equal(s.calls.publish.length, 0);
});

test('late publication cancels only its own run-labelled notification', async () => {
  const gate = deferred();
  const s = scenario({ notificationPublish: request => request.label === 'vpn-run-one' ? gate.promise : Promise.resolve() });
  let oldActive = true;
  const old = s.shared.publishConnectionNotification(s.snapshot, 'run-one', () => oldActive); await flush();
  oldActive = false; await s.shared.publishConnectionNotification(s.snapshot, 'run-two', () => true);
  gate.resolve(); await old;
  assert(s.calls.cancel.some(c => c.label === 'vpn-run-one'));
  assert.equal(s.calls.cancel.some(c => c.label === 'vpn-run-two'), false);
});

test('connection notification carries bounded expiry and return intent', async () => {
  const s = scenario(); await s.shared.publishConnectionNotification(s.snapshot, 'run-one', () => true);
  assert.equal(s.calls.publish[0].autoDeletedTime, s.clock.now + 90000);
  assert.equal(s.calls.publish[0].tapDismissed, false); assert(s.calls.publish[0].wantAgent);
});

test('same physical identity does not restart the existing connection', async () => {
  const s = scenario(); await s.launch(); const epoch = s.service.networkEpoch;
  s.physical.current = new s.shared.PhysicalNetwork(100, 'wifi', s.physical.current.key);
  await s.service.refreshDesiredNetwork(); await s.service.runNetworkTransition();
  assert.equal(s.service.networkEpoch, epoch); assert.equal(s.calls.coreSuspend, 0); assert.equal(s.calls.coreResume, 0);
  assert.equal(s.calls.coreConstruct, 1); assert.equal(s.calls.create, 1);
  assert.equal(s.calls.coreStartArgs[0][4], s.selectedNode.outboundJson, 'initial core receives the frozen selected outbound');
  await s.service.requestStop(false);
});

test('network loss suspends while retaining TUN and existing core then resumes in place', async () => {
  const s = scenario(); await s.launch(); const ownedCore = s.service.coreProbe;
  s.physical.current = undefined; await s.service.refreshDesiredNetwork(); await s.service.runNetworkTransition();
  assert.equal(s.service.connectionPhase, 'waiting-network'); assert.equal(s.status().phase, 'waiting-network');
  assert.equal(s.calls.coreSuspend, 1); assert.equal(s.calls.coreStop, 0);
  assert.equal(s.service.tunFd, 7000); assert.equal(s.calls.destroy, 0); assert.deepEqual(s.calls.rawCloses, []);
  const snapshots = s.calls.snapshot; await s.service.refreshConnectionStatus(); await flush();
  assert.equal(s.calls.snapshot, snapshots, 'paused service does not read unavailable core metrics');
  assert.equal(s.calls.publish.at(-1).content.normal.title, 'Harmony VPN · 等待网络');
  s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular');
  await s.service.refreshDesiredNetwork(); await s.service.runNetworkTransition();
  assert.equal(s.service.coreProbe, ownedCore); assert.equal(s.calls.coreConstruct, 1); assert.equal(s.calls.coreStart, 1);
  assert.equal(s.calls.coreResume, 1); assert.equal(s.calls.create, 1); assert.equal(s.calls.destroy, 0);
  assert.equal(s.service.connectionPhase, 'active'); assert.equal(s.status().networkKind, 'cellular');
  assert.equal(s.status().reconnectCount, 1); await s.service.requestStop(false);
});

test('late DNS from a superseded network cannot resume and next network uses a fresh pin', async () => {
  const dns = deferred();
  const s = scenario({ hostname: true, resolvePhysicalIpv4: async (_, network) =>
    network.netId === 200 ? dns.promise : '192.0.2.' + (network.netId / 100) });
  await s.launch(); s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular');
  await s.service.refreshDesiredNetwork(); const stale = s.service.runNetworkTransition(); await flush();
  assert.equal(s.calls.dns.at(-1).network.netId, 200);
  s.physical.current = new s.shared.PhysicalNetwork(300, 'wifi'); await s.service.refreshDesiredNetwork();
  assert.equal(s.calls.dns.at(-1).current(), false);
  dns.resolve('192.0.2.2'); await stale; assert.equal(s.calls.coreResume, 0);
  await s.service.runNetworkTransition();
  assert.equal(s.calls.coreResume, 1); assert.equal(s.calls.coreResumeArgs[0][1].ipv4, '192.0.2.3');
  assert.equal(s.service.appliedNetworkKey, s.physical.current.key); assert.equal(s.service.connectionPhase, 'active');
  await s.service.requestStop(false);
});

test('DNS retry respects backoff and retries the same physical network', async () => {
  let fail = false;
  const s = scenario({ hostname: true, resolvePhysicalIpv4: async () => {
    if (fail) throw new Error('synthetic DNS unavailable'); return '192.0.2.123';
  } });
  await s.launch(); fail = true; s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular');
  await s.service.refreshDesiredNetwork(); await s.service.runNetworkTransition();
  assert.equal(s.service.connectionPhase, 'recovering'); assert.equal(s.service.retryAt, s.clock.now + 2000);
  const queries = s.calls.dns.length; s.controlTick(); await flush(); assert.equal(s.calls.dns.length, queries);
  s.clock.now += 2000; fail = false; s.controlTick(); await flush();
  assert.equal(s.calls.dns.length, queries + 1); assert.equal(s.calls.coreResume, 1);
  assert.equal(s.service.connectionPhase, 'active'); assert.equal(s.service.retryAt, 0);
  await s.service.requestStop(false);
});

test('stop during resume waits for transition and never republishes active', async () => {
  const gate = deferred(); const s = scenario({ coreResume: () => gate.promise }); await s.launch();
  s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular'); await s.service.refreshDesiredNetwork();
  const transition = s.service.runNetworkTransition(); await flush(); assert.equal(s.calls.coreResume, 1);
  assert.equal(s.service.connectionPhase, 'recovering'); const stopping = s.service.requestStop(false); await flush();
  assert.equal(s.calls.coreStop, 0); assert.equal(s.calls.destroy, 0);
  gate.resolve(); await transition; await stopping; await flush();
  assert.equal(s.service.connectionPhase, 'recovering', 'stale transition must not set active');
  assert.equal(s.status().phase, 'destroyed'); assert.equal(s.calls.coreStop, 1); assert.equal(s.calls.destroy, 1);
  assert.equal(s.calls.coreConstruct, 1); assert.equal(s.service.networkTask, undefined);
});

test('socket protection rejects stale network epochs before and after the IPC', async () => {
  const gate = deferred(); const s = scenario({ protect: () => gate.promise }); s.activate();
  s.service.networkEpoch++; await assert.rejects(s.service.protectSocket(21)); assert.deepEqual(s.calls.protect, []);
  s.service.dialEpoch = s.service.networkEpoch;
  const pending = s.service.protectSocket(22); await flush(); s.service.networkEpoch++; gate.resolve();
  await assert.rejects(pending); assert.deepEqual(s.calls.protect, [22]);
  s.service.dialEpoch = s.service.networkEpoch; s.service.desiredNetwork = undefined;
  await assert.rejects(s.service.protectSocket(23)); assert.deepEqual(s.calls.protect, [22]);
});

test('recovering notification never describes the connection as active', async () => {
  const gate = deferred(); const s = scenario({ coreResume: () => gate.promise }); await s.launch();
  s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular'); await s.service.refreshDesiredNetwork();
  const transition = s.service.runNetworkTransition(); await flush();
  const snapshots = s.calls.snapshot; await s.service.refreshConnectionStatus(); await flush();
  assert.equal(s.calls.snapshot, snapshots); assert.equal(s.status().phase, 'recovering');
  assert.equal(s.calls.publish.at(-1).content.normal.title, 'Harmony VPN · 正在恢复连接');
  gate.resolve(); await transition; await s.service.requestStop(false);
});

test('manual reconnect is consumed once per command and reuses core and TUN', async () => {
  const s = scenario(); await s.launch(); s.clock.now++;
  s.shared.writeConnectionCommand(s.context.filesDir, new s.shared.ConnectionCommand('run-one', 'reconnect'));
  s.controlTick(); await flush(); assert.equal(s.calls.coreResume, 1);
  const epoch = s.service.networkEpoch;
  for (let i = 0; i < 4; i++) { s.controlTick(); await flush(); }
  assert.equal(s.service.networkEpoch, epoch); assert.equal(s.calls.coreResume, 1); assert.equal(s.calls.coreSuspend, 1);
  assert.equal(s.calls.coreConstruct, 1); assert.equal(s.calls.create, 1); assert.equal(s.calls.destroy, 0);
  assert.equal(s.command().action, 'reconnect'); assert.equal(s.service.stopRequested, false);
  s.clock.now++; s.shared.writeConnectionCommand(s.context.filesDir, new s.shared.ConnectionCommand('run-one', 'reconnect'));
  s.controlTick(); await flush(); assert.equal(s.calls.coreResume, 2); await s.service.requestStop(false);
});

test('late physical network read cannot revive a stopping service', async () => {
  let pendingRead;
  const s = scenario({ networkRead: () => pendingRead ? pendingRead.promise : Promise.resolve(new s.shared.PhysicalNetwork()) });
  await s.launch(); const originalKey = s.service.desiredNetwork.key;
  pendingRead = deferred(); const reading = s.service.refreshDesiredNetwork(); await flush();
  const stopping = s.service.requestStop(false); await flush(); assert.equal(s.calls.destroy, 0);
  pendingRead.resolve(new s.shared.PhysicalNetwork(200, 'cellular')); await reading; await stopping;
  assert.equal(s.service.desiredNetwork.key, originalKey); assert.equal(s.calls.coreResume, 0);
  assert.equal(s.calls.coreStop, 1); assert.equal(s.calls.destroy, 1); assert.equal(s.calls.watcherStop, 1);
  assert.equal(s.status().phase, 'destroyed');
});

test('late initial hostname resolution cannot allocate TUN after stop', async () => {
  const gate = deferred(); const s = scenario({ hostname: true, resolvePhysicalIpv4: () => gate.promise });
  s.service.onCreate({ parameters: s.prepare() }); await flush(); assert.equal(s.calls.dns.length, 1);
  const stopping = s.service.requestStop(false); gate.resolve('192.0.2.123'); await stopping; await flush();
  assert.equal(s.calls.create, 0); assert.equal(s.calls.coreStart, 0); assert.equal(s.calls.watcherStop, 1);
  assert.equal(s.status().phase, 'destroyed');
});

test('manual reconnect supersedes pending DNS rather than publishing stale active state', async () => {
  let gate;
  const s = scenario({ hostname: true, resolvePhysicalIpv4: () => gate ? gate.promise : Promise.resolve('192.0.2.123') });
  await s.launch(); gate = deferred(); s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular');
  await s.service.refreshDesiredNetwork(); const old = s.service.runNetworkTransition(); await flush();
  s.clock.now++; s.shared.writeConnectionCommand(s.context.filesDir, new s.shared.ConnectionCommand('run-one', 'reconnect'));
  s.controlTick(); gate.resolve('192.0.2.123'); await old;
  assert.equal(s.calls.coreResume, 0); assert.equal(s.service.connectionPhase, 'recovering');
  gate = undefined; s.controlTick(); await flush(); assert.equal(s.calls.coreResume, 1);
  assert.equal(s.service.connectionPhase, 'active'); await s.service.requestStop(false);
});

test('initial no-network state retains TUN and starts exactly one core when network appears', async () => {
  const s = scenario(); s.physical.current = undefined;
  s.service.onCreate({ parameters: s.prepare() }); await s.service.initialization; await flush();
  assert.equal(s.service.connectionPhase, 'waiting-network'); assert.equal(s.calls.create, 1);
  assert.equal(s.service.tunFd, 7000); assert.equal(s.calls.coreConstruct, 0); assert.equal(s.calls.coreStart, 0);
  await assert.rejects(s.service.protectSocket(25)); assert.equal(s.calls.protect.length, 0);
  s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular');
  await s.service.refreshDesiredNetwork(); await s.service.runNetworkTransition();
  assert.equal(s.service.connectionPhase, 'active'); assert.equal(s.calls.coreConstruct, 1);
  assert.equal(s.calls.coreStart, 1); assert.equal(s.calls.coreResume, 0); assert.equal(s.calls.create, 1);
  await s.service.requestStop(false);
});

test('network change during initial core startup retries without a second core or TUN', async () => {
  const gate = deferred(); const s = scenario({ coreStart: () => gate.promise });
  s.service.onCreate({ parameters: s.prepare() }); await flush(); assert.equal(s.calls.coreStart, 1);
  s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular'); await s.service.refreshDesiredNetwork();
  gate.resolve(); await s.service.initialization; await flush();
  assert.notEqual(s.service.connectionPhase, 'active'); assert.equal(s.service.appliedNetworkKey, '');
  await s.service.runNetworkTransition(); assert.equal(s.calls.coreSuspend, 1); assert.equal(s.calls.coreResume, 1);
  assert.equal(s.calls.coreConstruct, 1); assert.equal(s.calls.create, 1); assert.equal(s.service.connectionPhase, 'active');
  assert.equal(s.service.dialEpoch, s.service.networkEpoch); await s.service.requestStop(false);
});

function writeServicePhase(s, phase, reconnectCount = 0) {
  s.shared.writeProbeState(s.context.filesDir, new s.shared.ProbeState(phase, 'synthetic transition', 'run-one', 'connection'));
  s.shared.writeConnectionStatus(s.context.filesDir,
    new s.shared.ConnectionStatus('run-one', phase, s.snapshot, false, 4242, 'wifi', reconnectCount));
}
function refreshHomePhase(s, phase, reconnectCount = 0) {
  writeServicePhase(s, phase, reconnectCount); s.home.refresh();
}

test('same-run late HTTP cannot replace a new check after recovery or clear its ownership', async () => {
  const oldGate = deferred(), newGate = deferred(), responses = [oldGate, newGate];
  const s = scenario({ httpRequest: () => responses.shift().promise }); s.activate(); s.home.refresh();
  const old = s.home.checkConnection(false); await flush(); assert.equal(s.calls.transfer, 1);
  const generation = s.home.checkGeneration;
  refreshHomePhase(s, 'recovering'); assert.equal(s.home.checking, false); assert(s.home.checkGeneration > generation);
  refreshHomePhase(s, 'active', 1); const newer = s.home.checkConnection(false); await flush();
  s.home.checkResult = 'new network check is pending'; s.home.exitMarker = 'new-marker';
  oldGate.resolve({ responseCode: 200, result: 'h=www.cloudflare.com\nip=old-synthetic\n' }); await old;
  assert.equal(s.home.checkResult, 'new network check is pending'); assert.equal(s.home.exitMarker, 'new-marker');
  assert.equal(s.home.checking, true); assert.equal(s.home.runId, 'run-one');
  newGate.resolve({ responseCode: 200, result: 'h=www.cloudflare.com\nip=new-synthetic\n' }); await newer;
  assert.equal(s.home.checking, false); assert.equal(s.home.checkResult, '代理 DNS 与域名 HTTPS 检查通过。');
});

test('missed transient phase still invalidates old HTTP when same-run reconnect count changes', async () => {
  const gate = deferred(); const s = scenario({ httpRequest: () => gate.promise }); s.activate(); s.home.refresh();
  const pending = s.home.checkConnection(false); await flush(); const generation = s.home.checkGeneration;
  refreshHomePhase(s, 'active', 1); assert(s.home.checkGeneration > generation); assert.equal(s.home.checking, false);
  s.home.checkResult = 'current network result'; s.home.exitMarker = 'current-marker';
  gate.reject(new Error('synthetic old-network HTTP failure')); await pending;
  assert.equal(s.home.checkResult, 'current network result'); assert.equal(s.home.exitMarker, 'current-marker');
});

test('same-run late physical DNS cannot replace a new check after recovery or clear its ownership', async () => {
  const oldGate = deferred(), newGate = deferred(), results = [oldGate, newGate];
  const s = scenario({ resolvePhysicalIpv4: () => results.shift().promise }); s.activate(); s.home.refresh();
  const old = s.home.checkPhysicalResolver(); await flush(); assert.equal(s.calls.dns.length, 1);
  assert.equal(s.calls.dns[0].host, 'example.com', 'resolver diagnostic uses the fixed public test host');
  refreshHomePhase(s, 'waiting-network'); assert.equal(s.home.checking, false);
  refreshHomePhase(s, 'active', 1); const newer = s.home.checkPhysicalResolver(); await flush();
  assert.equal(s.calls.dns.length, 2); assert.equal(s.calls.dns[0].current(), false); assert.equal(s.calls.dns[1].current(), true);
  s.home.checkResult = 'new physical DNS check is pending'; oldGate.resolve('192.0.2.11'); await old;
  assert.equal(s.home.checkResult, 'new physical DNS check is pending'); assert.equal(s.home.checking, true);
  newGate.resolve('192.0.2.12'); await newer;
  assert.equal(s.home.checkResult, '物理网络 DNS 检查通过，已得到 IPv4 结果。'); assert.equal(s.home.checking, false);
});

test('same-run late physical DNS failure is ignored when recovery count changes', async () => {
  const gate = deferred(); const s = scenario({ resolvePhysicalIpv4: () => gate.promise }); s.activate(); s.home.refresh();
  const pending = s.home.checkPhysicalResolver(); await flush(); refreshHomePhase(s, 'active', 1);
  s.home.checkResult = 'current physical DNS result'; gate.reject(new Error('synthetic stale resolver failure')); await pending;
  assert.equal(s.home.checkResult, 'current physical DNS result'); assert.equal(s.home.checking, false);
});

test('stale resume rejection after network loss does not trigger final cleanup', async () => {
  const gate = deferred(); const s = scenario({ coreResume: () => gate.promise }); await s.launch();
  s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular'); await s.service.refreshDesiredNetwork();
  const resume = s.service.runNetworkTransition(); await flush(); assert.equal(s.calls.coreResume, 1);
  s.physical.current = undefined; await s.service.refreshDesiredNetwork();
  gate.reject(new Error('synthetic old-network resume failure')); await resume; await flush();
  assert.equal(s.service.failure, ''); assert.equal(s.service.stopRequested, false); assert.equal(s.calls.coreStop, 0);
  assert.equal(s.calls.destroy, 0); assert.equal(s.calls.serviceStop, 0);
  assert.equal([...s.timers.values()].some(t => !t.interval && t.ms === 0), false);
  await s.service.runNetworkTransition(); assert.equal(s.service.connectionPhase, 'waiting-network');
  assert.equal(s.service.tunFd, 7000); assert.equal(s.calls.coreConstruct, 1); await s.service.requestStop(false);
});

test('old-epoch snapshot rejection after a new active epoch does not stop the new connection', async () => {
  const gate = deferred(); const s = scenario({ snapshot: () => gate.promise }); await s.launch();
  const oldEpoch = s.service.networkEpoch;
  const snapshot = s.service.refreshConnectionStatus(); s.service.statusTask = snapshot;
  void snapshot.then(() => { if (s.service.statusTask === snapshot) s.service.statusTask = undefined; });
  await flush(); s.physical.current = new s.shared.PhysicalNetwork(200, 'cellular');
  await s.service.refreshDesiredNetwork(); await s.service.runNetworkTransition();
  assert(s.service.networkEpoch > oldEpoch); assert.equal(s.service.connectionPhase, 'active');
  assert.equal(s.service.networkTask, undefined);
  gate.reject(new Error('synthetic previous metrics listener failure')); await snapshot; await flush();
  assert.equal(s.service.failure, ''); assert.equal(s.service.stopRequested, false); assert.equal(s.calls.coreStop, 0);
  assert.equal([...s.timers.values()].some(t => !t.interval && t.ms === 0), false);
  assert.equal(s.status().phase, 'active'); assert.equal(s.status().reconnectCount, 1); await s.service.requestStop(false);
});

test('first core start failure after an epoch change still requires final cleanup', async () => {
  const gate = deferred(); const s = scenario({ coreStart: () => gate.promise });
  s.service.onCreate({ parameters: s.prepare() }); await flush(); assert.equal(s.calls.coreStart, 1);
  s.physical.current = undefined; await s.service.refreshDesiredNetwork();
  gate.reject(new Error('synthetic incomplete first core initialization'));
  await s.service.initialization; await flush(); if (s.service.cleanup) await s.service.cleanup;
  assert.notEqual(s.service.failure, ''); assert.equal(s.service.stopRequested, true);
  assert.equal(s.calls.coreStop, 1); assert.equal(s.calls.destroy, 1); assert.equal(s.calls.coreConstruct, 1);
  assert.equal(s.status().phase, 'destroyed');
});

test('service recovery counter invalidates in-flight HTTP before Home polls again', async () => {
  const gate = deferred(); const s = scenario({ httpRequest: () => gate.promise }); s.activate(); s.home.refresh();
  const pending = s.home.checkConnection(false); await flush(); assert.equal(s.calls.transfer, 1);
  const generation = s.home.checkGeneration; writeServicePhase(s, 'active', 1);
  assert.equal(s.home.phase, 'active'); assert.equal(s.home.reconnectCount, 0); assert.equal(s.home.checkGeneration, generation);
  s.home.checkResult = 'old request still pending';
  gate.resolve({ responseCode: 200, result: 'h=www.cloudflare.com\nip=old-synthetic\n' }); await pending;
  assert.equal(s.home.checkResult, 'old request still pending'); assert.equal(s.home.exitMarker, '');
  s.home.refresh(); assert.equal(s.home.checkResult, '网络状态已变化，请重新检查连接。');
});

test('service recovering phase invalidates in-flight HTTP before Home polls again', async () => {
  const gate = deferred(); const s = scenario({ httpRequest: () => gate.promise }); s.activate(); s.home.refresh();
  const pending = s.home.checkConnection(false); await flush(); assert.equal(s.calls.transfer, 1);
  writeServicePhase(s, 'recovering'); assert.equal(s.home.phase, 'active');
  s.home.checkResult = 'old request still pending';
  gate.resolve({ responseCode: 200, result: 'h=www.cloudflare.com\nip=old-synthetic\n' }); await pending;
  assert.equal(s.home.checkResult, 'old request still pending'); assert.equal(s.home.exitMarker, '');
  s.home.refresh(); assert.equal(s.home.phase, 'recovering');
  assert.equal(s.home.checkResult, '网络状态已变化，请重新检查连接。');
});

test('service counter change before DNS settles prevents old check from sending HTTP', async () => {
  const gate = deferred(); let dnsStarted = false;
  const s = scenario({ checkProxyDns: () => { dnsStarted = true; return gate.promise; } }); s.activate(); s.home.refresh();
  const pending = s.home.checkConnection(false); await flush(); assert.equal(dnsStarted, true); assert.equal(s.calls.transfer, 0);
  writeServicePhase(s, 'active', 1); assert.equal(s.home.reconnectCount, 0); gate.resolve(); await pending;
  assert.equal(s.calls.transfer, 0); assert.notEqual(s.home.checkResult, '代理 DNS 与域名 HTTPS 检查通过。');
  s.home.refresh(); assert.equal(s.home.checkResult, '网络状态已变化，请重新检查连接。');
});

test('service recovery counter invalidates physical DNS result before Home polls again', async () => {
  const gate = deferred(); const s = scenario({ resolvePhysicalIpv4: () => gate.promise }); s.activate(); s.home.refresh();
  const pending = s.home.checkPhysicalResolver(); await flush(); assert.equal(s.calls.dns.length, 1);
  writeServicePhase(s, 'active', 1); assert.equal(s.home.phase, 'active'); assert.equal(s.home.reconnectCount, 0);
  assert.equal(s.calls.dns[0].current(), false); s.home.checkResult = 'old physical DNS pending';
  gate.resolve('192.0.2.123'); await pending; assert.equal(s.home.checkResult, 'old physical DNS pending');
  s.home.refresh(); assert.equal(s.home.checkResult, '网络状态已变化，请重新检查连接。');
});

test('service waiting state prevents a late physical read from starting a DNS query before Home polls', async () => {
  const gate = deferred(); const s = scenario({ networkRead: () => gate.promise }); s.activate(); s.home.refresh();
  const pending = s.home.checkPhysicalResolver(); await flush(); assert.equal(s.calls.networkRead, 1);
  writeServicePhase(s, 'waiting-network'); assert.equal(s.home.phase, 'active');
  gate.resolve(s.physical.current); await pending; assert.equal(s.calls.dns.length, 0);
  assert.notEqual(s.home.checkResult, '物理网络 DNS 检查通过，已得到 IPv4 结果。');
  s.home.refresh(); assert.equal(s.home.checkResult, '网络状态已变化，请重新检查连接。');
});

(async () => {
  const results = [];
  for (const item of tests) {
    let watchdog;
    try {
      await Promise.race([Promise.resolve().then(item.body), new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('SYNTHETIC_SESSION_DEADLOCK')), 2000);
      })]);
      results.push({ name: item.name, passed: true });
    } catch (error) { results.push({ name: item.name, passed: false, detail: String(error.message) }); }
    finally { clearTimeout(watchdog); }
  }
  const passed = results.filter(r => r.passed).length;
  const report = { checkedAt: new Date().toISOString(), passed, failed: results.length - passed, total: results.length,
    scope: 'Actual authored service/UI/bootstrap methods; synthetic SDK, physical-network and CoreProbe adapters, atomic in-memory files and timers. No phone/network/private files.',
    limitations: ['PhysicalNetwork API bounds and CoreProbe/native internals are tested separately; this suite exercises the service contracts and event ordering.',
      'Native observer allocation, registration and dispatch are modeled. The SDK finalizer, native locks and Ark GC are not executed; passing these tests does not prove an ANR is fixed.'],
    sourceSHA256: Object.fromEntries([...sources].map(([name, source]) => [name, crypto.createHash('sha256').update(source).digest('hex')])), results };
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/connection-session-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, failed: report.failed, total: results.length,
    failedCases: results.filter(r => !r.passed).map(r => ({ name: r.name, detail: r.detail })), scope: report.scope }));
  if (report.failed) process.exitCode = 1;
})().catch(() => { console.error('Synthetic connection-session harness failed.'); process.exitCode = 1; });
