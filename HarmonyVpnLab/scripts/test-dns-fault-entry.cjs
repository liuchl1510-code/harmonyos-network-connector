'use strict';
// Execute authored EntryAbility methods and the pure request model. Synthetic
// adapters expose no files, real window, node, VPN extension or network.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..'), etsRoot = path.join(root, 'entry/src/main/ets');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourceNames = ['entryability/EntryAbility.ets', 'model/DnsFaultTest.ets', 'model/NetworkPolicy.ets',
  'model/NodeBootstrap.ets', 'model/AppRouting.ets'];
const sources = new Map(sourceNames.map(name => [name, fs.readFileSync(path.join(etsRoot, name), 'utf8')]));
function load(name, imports, globals = {}) {
  const result = ts.transpileModule(sources.get(name), { compilerOptions: { target: ts.ScriptTarget.ES2021,
    module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0, name);
  const exported = {};
  vm.runInNewContext(result.outputText, { exports: exported, module: { exports: exported }, ...globals,
    require: key => { assert(Object.hasOwn(imports, key), 'unexpected import ' + key); return imports[key]; } }, { filename: name });
  return exported;
}
const plain = value => JSON.parse(JSON.stringify(value));
function scenario(options = {}) {
  const s = { now: 100000, closed: options.closed !== false, lifeReads: 0, throwLifecycle: false,
    writes: [], values: new Map(), routes: [], nativeCalls: 0, warnings: [] };
  class FakeDate extends Date { static now() { return s.now; } }
  const bootstrap = load('model/NodeBootstrap.ets', {}), apps = load('model/AppRouting.ets', {});
  const policy = load('model/NetworkPolicy.ets', { './NodeBootstrap': bootstrap, './AppRouting': apps });
  const fault = load('model/DnsFaultTest.ets', { './NetworkPolicy': policy }, { Date: FakeDate });
  class UIAbility {
    constructor() { this.context = { filesDir: '/synthetic', applicationInfo: { debug: options.debug !== false } }; }
  }
  const AppStorage = {
    setOrCreate(name, value) { s.writes.push({ name, value }); s.values.set(name, value); },
    set(name, value) { s.writes.push({ name, value }); s.values.set(name, value); },
    get(name) { return s.values.get(name); }
  };
  const native = new Proxy({}, { get(_target, key) { return () => { s.nativeCalls++; throw new Error('native call prohibited ' + String(key)); }; } });
  const EntryAbility = load('entryability/EntryAbility.ets', {
    '@kit.AbilityKit': { UIAbility }, '@kit.ArkUI': { window: {} },
    '@kit.PerformanceAnalysisKit': { hilog: { warn: (...args) => s.warnings.push(args), info() {}, error() {} } },
    'libvpnbridge.so': { default: native }, '../model/Appearance': {
      applyAppearance() { throw new Error('appearance mutation prohibited'); }, readAppearance() { throw new Error('file read prohibited'); }
    }, '../model/AdaptiveLayout': { normalizedWindowWidth() { throw new Error('window read prohibited'); } },
    '../model/BuildCapabilities': { VPN_CORE_AVAILABLE: options.core !== false },
    '@kit.BasicServicesKit': { deviceInfo: { deviceType: 'phone' } },
    '../model/DnsBenchmark': { validDnsBenchmark() { return false; } },
    '../model/DnsFaultTest': fault,
    '../model/ConnectionLifecycle': { readConnectionLifecycle(filesDir) {
      assert.equal(filesDir, '/synthetic'); s.lifeReads++;
      if (s.throwLifecycle) throw new Error('synthetic lifecycle unavailable');
      return { closed: s.closed };
    } }
  }, { Date: FakeDate, AppStorage }).default;
  s.entry = new EntryAbility(); s.entry.contentReady = options.ready !== false;
  s.entry.mainWindow = { getUIContext() { return { getRouter() { return {
    replaceUrl(value) { s.routes.push(plain(value)); return options.routeReject ? Promise.reject(new Error('synthetic route rejection')) : Promise.resolve(); }
  }; } }; } };
  s.want = (kind = 'baseline', token = 'Fault001', extra = {}) => ({ parameters: { dnsFault: kind, dnsFaultToken: token, ...extra } });
  s.admit = (kind = 'baseline', token = 'Fault001', extra = {}) => s.entry.readDnsFault(s.want(kind, token, extra));
  s.pending = () => s.values.get('pendingDnsFaultRequest');
  s.assertNoSideEffects = () => { assert.equal(s.writes.length, 0); assert.equal(s.routes.length, 0); assert.equal(s.nativeCalls, 0); };
  return s;
}
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS ' + name); }

test('release and preview builds reject before lifecycle access', () => {
  for (const options of [{ debug: false }, { core: false }, { debug: false, core: false }]) {
    const s = scenario(options); assert.equal(s.admit(), false); assert.equal(s.lifeReads, 0); s.assertNoSideEffects();
    s.entry.onNewWant(s.want()); assert.equal(s.lifeReads, 0); s.assertNoSideEffects();
  }
});
test('a live or unresolved session cannot arm a fault and does not consume its token', () => {
  const s = scenario({ closed: false }); assert.equal(s.admit(), false); assert.equal(s.lifeReads, 1); s.assertNoSideEffects();
  assert.equal(s.entry.dnsFaultTokens.length, 0); s.closed = true;
  assert.equal(s.admit(), true); assert.deepEqual(plain(s.pending()), { kind: 'baseline', token: 'Fault001', createdAt: 100000 });
});
test('unavailable lifecycle rejects without storage changes or consuming a token', () => {
  const s = scenario(); s.throwLifecycle = true; assert.equal(s.admit(), false); s.assertNoSideEffects();
  assert.equal(s.entry.dnsFaultTokens.length, 0); s.throwLifecycle = false; assert.equal(s.admit(), true);
});
test('fixed valid kinds are admitted and stored with exactly three fields', () => {
  for (const kind of ['baseline', 'http404', 'timeout']) {
    const s = scenario(); assert.equal(s.admit(kind), true);
    assert.deepEqual(plain(s.pending()), { kind, token: 'Fault001', createdAt: 100000 });
    assert.deepEqual(s.writes.map(item => item.name), ['pendingDnsFaultRequest', 'openDeveloperTools']);
    assert.equal(s.values.get('openDeveloperTools'), true); assert.equal(s.nativeCalls, 0); assert.equal(s.routes.length, 0);
  }
});
test('unknown URL and nonstring kind values reject before lifecycle access', () => {
  for (const kind of ['', 'HTTP404', 'timeout ', 'https://example.test/query', 404, null, undefined, {}, []]) {
    const s = scenario(); const want = { parameters: { dnsFault: kind, dnsFaultToken: 'Fault001' } };
    assert.equal(s.entry.readDnsFault(want), false); assert.equal(s.lifeReads, 0); s.assertNoSideEffects();
  }
});
test('tokens reject tail newline whitespace punctuation Unicode and length violations', () => {
  for (const token of ['', 'short', 'Fault001\n', 'Fault001\r', 'Fault001 ', ' Fault001', 'Fault-001',
    'Fault_001', 'Fault/001', 'Fault００１', 'a'.repeat(41), 12345678, null, undefined, {}]) {
    const s = scenario(); const want = { parameters: { dnsFault: 'timeout', dnsFaultToken: token } };
    assert.equal(s.entry.readDnsFault(want), false); assert.equal(s.lifeReads, 0); s.assertNoSideEffects();
  }
  for (const token of ['a'.repeat(8), '9'.repeat(40)]) assert.equal(scenario().admit('baseline', token), true);
});
test('absent parameters do not arm or navigate', () => {
  for (const want of [{}, { parameters: {} }, { parameters: { dnsFault: 'baseline' } }, { parameters: { dnsFaultToken: 'Fault001' } }]) {
    const s = scenario(); s.entry.onNewWant(want); assert.equal(s.lifeReads, 0); s.assertNoSideEffects();
  }
});
test('duplicate token rejects without replacing the original pending request', () => {
  const s = scenario(); assert.equal(s.admit('baseline'), true); const original = s.pending(), writes = s.writes.length;
  s.now += 100; assert.equal(s.admit('http404'), false);
  assert.equal(s.pending(), original); assert.equal(s.writes.length, writes); assert.equal(s.lifeReads, 1);
  assert.deepEqual(plain(s.entry.dnsFaultTokens), ['Fault001']);
});
test('caller URL port timestamp and credentials never enter the pending descriptor', () => {
  const s = scenario(); const extra = { url: 'https://example.test/query', port: 8443, createdAt: 0,
    configJSON: '{"synthetic":"only"}', secret: 'synthetic-secret' };
  assert.equal(s.admit('timeout', 'Fault001', extra), true);
  assert.deepEqual(plain(s.pending()), { kind: 'timeout', token: 'Fault001', createdAt: 100000 });
  assert.equal(s.nativeCalls, 0);
});
test('onNewWant admits storage and opens Home without starting VPN or native work', () => {
  const s = scenario(); s.entry.onNewWant(s.want('timeout'));
  assert.deepEqual(s.routes, [{ url: 'pages/Home' }]); assert.equal(s.nativeCalls, 0); assert.equal(s.lifeReads, 1);
  assert.deepEqual(s.writes.map(item => item.name), ['pendingDnsFaultRequest', 'openDeveloperTools']);
  assert.equal(s.values.get('openDeveloperTools'), true);
  assert.deepEqual(plain(s.pending()), { kind: 'timeout', token: 'Fault001', createdAt: 100000 });
});
test('onNewWant rejection preserves prior pending descriptor and does not navigate', () => {
  const s = scenario(); assert.equal(s.admit('baseline'), true); const original = s.pending(), writes = s.writes.length;
  s.entry.onNewWant(s.want('timeout')); assert.equal(s.pending(), original); assert.equal(s.writes.length, writes);
  assert.equal(s.routes.length, 0); assert.equal(s.nativeCalls, 0);
  s.closed = false; s.entry.onNewWant(s.want('http404', 'Fault002'));
  assert.equal(s.pending(), original); assert.equal(s.writes.length, writes); assert.equal(s.routes.length, 0);
});
test('accepted requests before content readiness remain pending without premature navigation', () => {
  const s = scenario({ ready: false }); s.entry.onNewWant(s.want('http404'));
  assert.equal(s.routes.length, 0); assert.equal(s.pending().kind, 'http404'); assert.equal(s.nativeCalls, 0);
});
test('seen-token cap accepts 128 unique requests and rejects further admission without replacing pending', () => {
  const s = scenario();
  for (let index = 0; index < 128; index++) {
    assert.equal(s.admit('baseline', 'Token' + String(index).padStart(5, '0')), true);
  }
  assert.equal(s.entry.dnsFaultTokens.length, 128); assert.equal(s.lifeReads, 128);
  const original = s.pending(), writes = s.writes.length;
  assert.equal(s.admit('timeout', 'Token99999'), false);
  assert.equal(s.admit('http404', 'Token00000'), false);
  assert.equal(s.pending(), original); assert.equal(s.writes.length, writes); assert.equal(s.lifeReads, 128); assert.equal(s.nativeCalls, 0);
});
test('cold onCreate keeps an admitted fault pending for Home and performs no native work', () => {
  const s = scenario({ ready: false }); s.entry.onCreate(s.want('baseline'));
  assert.equal(s.entry.dnsBenchmarkRequested, false); assert.equal(s.pending().kind, 'baseline');
  assert.equal(s.values.get('openDeveloperTools'), true); assert.equal(s.routes.length, 0); assert.equal(s.nativeCalls, 0);
  assert.deepEqual(s.writes.map(item => item.name), ['windowWidthVp', 'statusBarHeightVp', 'pendingDnsFaultRequest', 'openDeveloperTools']);
});

console.log(JSON.stringify({ passed, realNetworkUsed: false, devicesTouched: 0, vpnStarts: 0 }));
