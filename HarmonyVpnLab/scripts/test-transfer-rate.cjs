'use strict';
// Execute the authored rate tracker and Home lifecycle/refresh methods against
// synthetic service snapshots. No device, network, VPN or private files are used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourceSHA256 = {};
function compile(relative, page = false) {
  const original = fs.readFileSync(path.join(root, 'entry/src/main/ets', relative), 'utf8');
  sourceSHA256[relative] = crypto.createHash('sha256').update(original).digest('hex');
  let source = original;
  if (page) {
    const boundary = source.indexOf('\n  build() {');
    assert(boundary > 0, 'Home build boundary changed');
    source = (source.slice(0, boundary) + '\n}\n').replace(/^@Entry\s*$/gm, '').replace(/^@Component\s*$/gm, '')
      .replace(/^(\s*)@State /gm, '$1').replace(/@StorageProp\([^)]*\)\s*/g, '')
      .replace(/^struct (\w+) \{/m, 'export class $1 {');
  }
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
  });
  assert.equal(result.diagnostics.length, 0, 'SDK transpilation failed: ' + relative);
  return result.outputText;
}
const modelCode = compile('model/TransferRate.ets');
const snapshotCode = compile('model/ConnectionSnapshot.ets');
const homeCode = compile('pages/Home.ets', true);
const lifecycleCode = compile('model/ConnectionLifecycle.ets');
const issueCode = compile('model/NodeIssue.ets');
const importCode = compile('model/NodeImport.ets');
const bootstrapCode = compile('model/NodeBootstrap.ets');
const preflightCode = compile('model/NodePreflight.ets');
const failureCode = compile('model/ConnectionFailure.ets');
const appRoutingCode = compile('model/AppRouting.ets');
function execute(code, imports = {}, extra = {}) {
  const context = { exports: {}, require(name) { assert(Object.hasOwn(imports, name), name); return imports[name]; }, ...extra };
  vm.runInNewContext(code, context);
  return context.exports;
}
const snapshots = execute(snapshotCode);
const rates = execute(modelCode, { './ConnectionSnapshot': snapshots });
const issues = execute(issueCode), bootstrap = execute(bootstrapCode), failures = execute(failureCode);
const nodeImports = execute(importCode, { './NodeIssue': issues, '@kit.ArkTS': {
  url: { URL: { parseURL: value => new URL(value) } }, util: {
    Base64Helper: class { decodeSync(value) { return new Uint8Array(Buffer.from(value, 'base64')); } },
    TextDecoder: { create: (encoding, options) => ({ decodeToString: value => new TextDecoder(encoding, options).decode(value) }) }
  }
} });
const preflight = execute(preflightCode, { './NodeImport': nodeImports, './NodeIssue': issues, './NodeBootstrap': bootstrap });
const { TransferRateTracker: Tracker, formatTransferRate } = rates;
function snapshot(sampledAt, uplink, downlink, changes = {}) {
  return Object.assign(new snapshots.ConnectionSnapshot(), { active: true, startedAt: 1000, sampledAt, uplink, downlink }, changes);
}
function sample(tracker, at, up, down, options = {}) {
  return tracker.update(options.runId ?? 'run-one', options.reconnectCount ?? 0,
    snapshot(at, up, down, options.snapshot), options.now ?? at);
}
function unavailable(reading) {
  assert.equal(reading.available, false);
  assert.equal(reading.uplinkPerSecond, 0);
  assert.equal(reading.downlinkPerSecond, 0);
}
function available(reading, up, down) {
  assert.equal(reading.available, true);
  assert.equal(reading.uplinkPerSecond, up);
  assert.equal(reading.downlinkPerSecond, down);
}
function primed() {
  const tracker = new Tracker();
  unavailable(sample(tracker, 10000, 10000, 20000));
  available(sample(tracker, 12000, 12000, 24000), 1000, 2000);
  return tracker;
}
const tests = [];
function test(name, body) { tests.push({ name, body }); }

test('first sample is unavailable even when its accumulated counters are large', () => {
  unavailable(sample(new Tracker(), 10000, 1024 ** 4, 2 * 1024 ** 4));
});
test('rates use irregular sampledAt intervals instead of the one-second UI poll', () => {
  const t = new Tracker(); sample(t, 10000, 1000, 5000, { now: 11500 });
  available(sample(t, 12500, 8500, 15000, { now: 14500 }), 3000, 4000);
});
test('valid unchanged counters yield measured zero in both directions', () => {
  const t = primed(); available(sample(t, 14000, 12000, 24000), 0, 0);
});
test('fractional rates and independent upload/download changes are preserved', () => {
  const t = primed(); available(sample(t, 14000, 12001, 24000), 0.5, 0);
});
test('a duplicate sample keeps its most recent rate without moving the baseline', () => {
  const t = primed();
  available(sample(t, 12000, 12000, 24000, { now: 13000 }), 1000, 2000);
  available(sample(t, 12000, 12000, 24000, { now: 14000 }), 1000, 2000);
  available(sample(t, 15000, 15000, 30000), 1000, 2000);
});
test('a duplicate first sample remains unavailable rather than producing false zero', () => {
  const t = new Tracker(); sample(t, 10000, 10, 20);
  unavailable(sample(t, 10000, 10, 20, { now: 11000 }));
});
test('old repeated readings expire after six seconds and fresh samples rebuild the baseline', () => {
  const t = primed();
  available(sample(t, 12000, 12000, 24000, { now: 18000 }), 1000, 2000);
  unavailable(sample(t, 12000, 12000, 24000, { now: 18001 }));
  unavailable(sample(t, 19000, 1024000, 2048000));
  available(sample(t, 21000, 1026000, 2052000), 1000, 2000);
});
test('repeated timestamp rollback never becomes a baseline and needs two later samples', () => {
  const t = primed();
  unavailable(sample(t, 11000, 500, 1000, { now: 13000 }));
  unavailable(sample(t, 11000, 500, 1000, { now: 14000 }));
  unavailable(sample(t, 12000, 12000, 24000, { now: 14000 }));
  unavailable(sample(t, 14000, 14000, 28000));
  available(sample(t, 16000, 16000, 32000), 1000, 2000);
});
test('same-timestamp counter changes invalidate a previously valid rate', () => {
  const t = primed();
  unavailable(sample(t, 12000, 900, 1800, { now: 13000 }));
  unavailable(sample(t, 12000, 900, 1800, { now: 14000 }));
  unavailable(sample(t, 14000, 14000, 28000));
  available(sample(t, 16000, 16000, 32000), 1000, 2000);
});
for (const direction of ['uplink', 'downlink']) test(direction + ' reset invalidates both rates and starts a clean baseline', () => {
  const t = primed();
  const up = direction === 'uplink' ? 10 : 14000, down = direction === 'downlink' ? 20 : 28000;
  unavailable(sample(t, 14000, up, down));
  available(sample(t, 16000, up + 2000, down + 4000), 1000, 2000);
});
for (const [description, changes] of [
  ['run identity', { runId: 'run-two' }], ['reconnect generation', { reconnectCount: 1 }],
  ['start timestamp', { snapshot: { startedAt: 2000 } }]
]) test(description + ' change cannot reuse an earlier baseline', () => {
  const t = primed(); unavailable(sample(t, 14000, 1024000, 2048000, changes));
  available(sample(t, 16000, 1026000, 2052000, changes), 1000, 2000);
});
test('a hidden page or explicit reset never includes off-page traffic in a new rate', () => {
  const t = primed(); t.reset(); unavailable(sample(t, 14000, 1024000, 2048000));
  available(sample(t, 16000, 1026000, 2052000), 1000, 2000);
});
test('a long suspended UI interval discards an otherwise fresh snapshot delta', () => {
  const t = primed(); unavailable(sample(t, 20000, 1024000, 2048000));
  available(sample(t, 22000, 1026000, 2052000), 1000, 2000);
});
test('a long service sampling gap is not displayed as current speed', () => {
  const t = primed(); sample(t, 12000, 12000, 24000, { now: 17000 });
  unavailable(sample(t, 19000, 1024000, 2048000));
  available(sample(t, 21000, 1026000, 2052000), 1000, 2000);
});
test('an implausibly short sample interval cannot amplify a counter delta', () => {
  const t = primed(); unavailable(sample(t, 12001, 1024000, 2048000));
  available(sample(t, 14001, 1026000, 2052000), 1000, 2000);
});
test('the minimum accepted sample interval calculates a rate without rounding time', () => {
  const t = primed(); available(sample(t, 12500, 12500, 25000), 1000, 2000);
});
test('wall clock rollback of the UI observation rebaselines even with a fresh sample', () => {
  const t = primed(); sample(t, 12000, 12000, 24000, { now: 15000 });
  unavailable(sample(t, 14000, 1024000, 2048000, { now: 14000 }));
  available(sample(t, 16000, 1026000, 2052000), 1000, 2000);
});
for (const [description, change] of [
  ['inactive', { active: false }], ['missing sampledAt', { sampledAt: undefined }],
  ['NaN sampledAt', { sampledAt: NaN }], ['nonintegral sampledAt', { sampledAt: 14000.5 }],
  ['future sample', { sampledAt: 14001 }], ['sample before start', { startedAt: 15000 }],
  ['missing start', { startedAt: 0 }], ['negative upload', { uplink: -1 }],
  ['negative download', { downlink: -1 }], ['infinite counter', { uplink: Infinity }],
  ['unsafe counter', { downlink: Number.MAX_SAFE_INTEGER + 1 }], ['fractional counter', { uplink: 1.5 }]
]) test(description + ' yields unavailable instead of a fabricated rate', () => {
  const t = primed(); unavailable(sample(t, 14000, 14000, 28000, { snapshot: change }));
  unavailable(sample(t, 16000, 16000, 32000));
});
test('missing snapshot invalidates the baseline', () => {
  const t = primed(); unavailable(t.update('run-one', 0, undefined, 14000));
  unavailable(sample(t, 16000, 16000, 32000));
});
for (const [description, options] of [
  ['empty run identity', { runId: '' }], ['negative reconnect generation', { reconnectCount: -1 }],
  ['invalid reconnect generation', { reconnectCount: 0.5 }], ['invalid observation time', { now: NaN }]
]) test(description + ' cannot calculate rate', () => {
  const t = primed(); unavailable(sample(t, 14000, 14000, 28000, options));
});
test('caller mutations cannot change the stored sample or cached reading', () => {
  const t = new Tracker(), input = snapshot(10000, 10000, 20000);
  t.update('run-one', 0, input, 10000); input.uplink = 0; input.downlink = 0;
  const result = sample(t, 12000, 12000, 24000); available(result, 1000, 2000);
  result.available = false; result.uplinkPerSecond = 900000;
  available(sample(t, 12000, 12000, 24000, { now: 13000 }), 1000, 2000);
});
test('formatting distinguishes unavailable, measured zero and binary-size units', () => {
  assert.equal(formatTransferRate(false, 0), '—'); assert.equal(formatTransferRate(true, 0), '0 B/s');
  assert.equal(formatTransferRate(true, 1536), '1.5 KB/s'); assert.equal(formatTransferRate(true, 1024 ** 2), '1.0 MB/s');
  assert.equal(formatTransferRate(true, 1024 ** 3), '1.0 GB/s');
  for (const invalid of [NaN, Infinity, -1]) assert.equal(formatTransferRate(true, invalid), '—');
});

function homeHarness() {
  const state = { now: 10000, processAlive: true, timers: new Map(), nextTimer: 1, writes: [],
    probe: { runId: 'run-one', kind: 'connection', phase: 'active', updatedAt: 10000, detail: '' },
    command: { runId: 'run-one', action: 'start', ownerEpoch: 'current-ui' },
    status: { runId: 'run-one', phase: 'active', updatedAt: 10000, reconnectCount: 0, networkKind: 'wifi', servicePid: 123,
      cleanupConfirmed: false, snapshot: snapshot(10000, 10000, 20000) } };
  const imports = {
    '@kit.AbilityKit': {}, '@kit.NetworkKit': { vpnExtension: { startVpnExtensionAbility() { throw new Error('Unexpected VPN start'); } }, http: {} },
    '@kit.NotificationKit': { notificationManager: { isNotificationEnabled: async () => true } },
    '@kit.PerformanceAnalysisKit': { hilog: { info() {} } },
    'libvpnbridge.so': { default: { processAlive: () => state.processAlive } },
    '../model/ProbeState': { readProbeState: () => state.probe,
      ProbeState: class { constructor(phase, detail, runId, kind) { Object.assign(this, { phase, detail, runId, kind, updatedAt: state.now }); } },
      writeProbeState(_, value) { state.probe = value; state.writes.push('probe'); } },
    '../model/NodeProfile': { readNodeProfile: () => ({ name: 'Synthetic node', protocol: 'vless' }) },
    '../model/ErrorInfo': {},
    '../model/ConnectionControl': { CONNECTION_UI_EPOCH: 'current-ui',
      isConnectionKind: kind => ['connection', 'connection-test', 'connection-app-test', 'node-latency'].includes(kind),
      readConnectionCommand: () => state.command, readConnectionStatus: () => state.status,
      ConnectionCommand: class { constructor(runId, action, ownerEpoch = 'current-ui') { Object.assign(this, { runId, action, ownerEpoch }); } },
      writeConnectionCommand(_, value) { state.command = value; state.writes.push('command'); } },
    '../model/ConnectionNotification': {}, '../model/ConnectionDiagnostics': {},
    '../model/VpnAuthorization': { subscribeVpnAuthorization: () => 10, unsubscribeVpnAuthorization() {} },
    '../model/PhysicalNetwork': {}, '../model/MainNavigation': {},
    '../model/DockConnectionAction': { consumeDockConnectionAction: () => undefined },
    '../model/BuildCapabilities': { VPN_CORE_AVAILABLE: true },
    '../model/NetworkPolicyStore': { readNetworkPolicy: () => ({ appMode: 'all', appBundles: [] }) },
    '../model/AppRouting': execute(appRoutingCode),
    '../model/NetworkPolicy': { networkPolicyLabel: () => '全部代理', isSplitDnsActive: () => false }, '../model/TransferRate': rates
  };
  imports['../model/ConnectionLifecycle'] = execute(lifecycleCode, {
    'libvpnbridge.so': imports['libvpnbridge.so'], './ProbeState': imports['../model/ProbeState'],
    './ConnectionControl': imports['../model/ConnectionControl']
  }, { Date: class extends Date { static now() { return state.now; } } });
  imports['../model/ConnectionRecoveryStore'] = { recordConnectionRecovery() {} };
  imports['../model/NodeIssue'] = issues;
  imports['../model/NodePreflight'] = preflight;
  imports['../model/ConnectionFailure'] = failures;
  const { Home } = execute(homeCode, imports, {
    Date: class extends Date { static now() { return state.now; } }, $r: name => name,
    AppStorage: { get: () => false },
    setInterval(fn, delay) { const id = state.nextTimer++; state.timers.set(id, { fn, delay }); return id; },
    clearInterval(id) { state.timers.delete(id); }
  });
  const home = new Home(); home.getUIContext = () => ({ getHostContext: () => ({ filesDir: 'synthetic-memory-only' }) });
  function tick(at, up = 12000, down = 24000) {
    state.now = at; state.probe.updatedAt = at; state.status.updatedAt = at; state.status.snapshot = snapshot(at, up, down); home.refresh();
  }
  home.refresh(); tick(12000);
  assert.equal(home.uplinkRate, '1000 B/s'); assert.equal(home.downlinkRate, '2.0 KB/s');
  return { home, state, tick };
}
test('Home keeps cumulative values and connection duration alongside live rates', () => {
  const { home, state } = homeHarness();
  assert.equal(home.uplink, 12000); assert.equal(home.downlink, 24000); assert.equal(home.duration(), '0 分 11 秒');
  assert.deepEqual(state.writes, []);
});
for (const phase of ['starting', 'recovering', 'waiting-network', 'stopping', 'stop_requested', 'destroyed', 'failed']) {
  test('Home clears rates during ' + phase + ' while preserving the last cumulative snapshot', () => {
    const { home, state } = homeHarness(); state.probe.phase = phase; state.status.phase = phase;
    home.refresh(); assert.equal(home.rateAvailable, false); assert.equal(home.uplinkRate, '—');
    assert.equal(home.uplink, 12000); assert.equal(home.downlink, 24000);
  });
}
test('Home refuses an active snapshot when the service status is recovering', () => {
  const { home, state } = homeHarness(); state.status.phase = 'recovering'; home.refresh();
  assert.equal(home.rateAvailable, false);
});
test('Home refuses a different run status and does not present cached rate as live', () => {
  const { home, state } = homeHarness(); state.status.runId = 'older-run'; home.refresh();
  assert.equal(home.rateAvailable, false);
});
test('Home resets at a reconnect counter change even if transition phases were missed', () => {
  const { home, state, tick } = homeHarness(); state.status.reconnectCount = 1; tick(14000, 1000000, 2000000);
  assert.equal(home.rateAvailable, false); tick(16000, 1002000, 2004000); assert.equal(home.uplinkRate, '1000 B/s');
});
for (const kind of ['node-latency', 'lifecycle']) test('Home diagnostic early return resets live rate for ' + kind, () => {
  const { home, state } = homeHarness(); state.probe.kind = kind; home.refresh();
  assert.equal(home.phase, 'diagnostic'); assert.equal(home.rateAvailable, false);
});
test('Home unresolved old UI process cannot retain a rate or authorize reconnect', () => {
  const { home, state } = homeHarness(); state.command.ownerEpoch = 'previous-ui'; home.refresh();
  assert.equal(home.phase, 'unknown'); assert.equal(home.closed, false); assert.equal(home.rateAvailable, false);
});
test('Home startup timeout early return clears rate and uses its existing cancellation path', () => {
  const { home, state } = homeHarness(); state.probe.phase = 'starting'; state.probe.updatedAt = 1000;
  state.now = 40000; state.status.runId = 'older-run'; state.processAlive = false; home.refresh();
  assert.equal(home.phase, 'failed'); assert.equal(home.rateAvailable, false);
  assert.deepEqual(state.writes, ['command', 'probe']);
});
test('Home dead service and stale state invalidate rates despite active snapshot flags', () => {
  for (const reason of ['process', 'heartbeat']) {
    const { home, state } = homeHarness();
    if (reason === 'process') state.processAlive = false; else state.now = 25001;
    home.refresh(); assert.equal(home.phase, reason === 'process' ? 'interrupted' : 'unknown');
    assert.equal(home.rateAvailable, false);
  }
});
test('Home stop command clears rate before the service acknowledges stopping', () => {
  const { home, state } = homeHarness(); state.command.action = 'stop'; home.refresh();
  assert.equal(home.phase, 'stopping'); assert.equal(home.rateAvailable, false);
});
test('Home hide/show removes the old baseline and keeps exactly one polling interval', () => {
  const { home, state, tick } = homeHarness(); home.onPageShow(); assert.equal(state.timers.size, 1);
  tick(14000, 14000, 28000); assert.equal(home.rateAvailable, true);
  home.onPageHide(); assert.equal(state.timers.size, 0); assert.equal(home.rateAvailable, false);
  state.now = 15000; state.status.snapshot = snapshot(15000, 1000000, 2000000);
  home.onPageShow(); assert.equal(state.timers.size, 1); assert.equal(home.rateAvailable, false);
  tick(17000, 1002000, 2004000); assert.equal(home.uplinkRate, '1000 B/s');
  home.aboutToDisappear(); assert.equal(state.timers.size, 0); assert.equal(home.rateAvailable, false);
});
test('Home resets rate immediately when a manual reconnect command is sent', () => {
  const { home, state } = homeHarness(); home.reconnect(); assert.equal(home.phase, 'recovering');
  assert.equal(home.rateAvailable, false); assert.equal(state.command.action, 'reconnect');
});

const results = [];
for (const item of tests) {
  try { item.body(); results.push({ name: item.name, passed: true }); }
  catch (error) { results.push({ name: item.name, passed: false, detail: error.message }); }
}
const report = { generatedAt: new Date().toISOString(), passed: results.filter(item => item.passed).length,
  failed: results.filter(item => !item.passed).length, total: results.length, sourceSHA256,
  scope: 'Actual TransferRate and Home lifecycle/refresh methods, SDK TypeScript transpilation, synthetic clocks, counters and service states.',
  limitations: ['Does not execute ArkUI layout or native page lifecycle. Actual snapshot cadence, navigation/background callbacks and display require device verification.'], results };
const output = path.join(root, 'build/transfer-rate-verification.json');
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, total: report.total,
  failures: results.filter(item => !item.passed), record: output }));
if (report.failed) process.exitCode = 1;
