'use strict';
// Run the authored UI intent queue, lifecycle resolver, navigation model and
// dock methods with synthetic receipts/router/timers. No device or VPN writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const project = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourceHashes = {};
function source(relative) {
  const text = fs.readFileSync(path.join(project, 'entry/src/main/ets', relative), 'utf8');
  sourceHashes[relative] = crypto.createHash('sha256').update(text).digest('hex');
  return text;
}
const sources = {
  lifecycle: source('model/ConnectionLifecycle.ets'), action: source('model/DockConnectionAction.ets'),
  navigation: source('model/MainNavigation.ets'), button: source('components/DockPowerButton.ets'),
  bar: source('components/AppTabBar.ets')
};
const NOW = 1800000000000, RUN = 'current-run';
function scenario(core = true) {
  const io = {
    state: { phase: 'idle', kind: '', runId: '', updatedAt: NOW }, command: undefined, status: undefined,
    alive: true, reads: 0, lifecycleThrows: false, now: NOW, core,
    route: 'pages/Nodes', routeThrows: false, routePending: false, back: 0, prompt: 0,
    callback: 0, intervals: new Map(), cleared: [], intervalSequence: 0
  };
  const cache = {};
  function execute(text, filename, require) {
    const result = ts.transpileModule(text, { compilerOptions: {
      target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
    assert.equal(result.diagnostics.length, 0, filename);
    const exported = {};
    vm.runInNewContext(result.outputText, { exports: exported, require, console,
      Date: class extends Date { static now() { return io.now; } },
      setTimeout: fn => { fn(); return 1; }, clearTimeout: () => {},
      setInterval: (fn, ms) => { const id = ++io.intervalSequence; io.intervals.set(id, { fn, ms }); return id; },
      clearInterval: id => { io.cleared.push(id); io.intervals.delete(id); }
    }, { filename });
    return exported;
  }
  function load(name) {
    if (cache[name]) return cache[name];
    if (name === '@kit.AbilityKit' || name === '@kit.ArkUI') return {};
    if (name === './ProbeState') return { readProbeState() { io.reads++; if (io.lifecycleThrows) throw new Error('synthetic'); return io.state; } };
    if (name === './ConnectionControl') return {
      CONNECTION_UI_EPOCH: 'current-ui', isConnectionKind: kind => ['connection', 'connection-test', 'connection-app-test', 'node-latency'].includes(kind),
      readConnectionCommand: () => io.command, readConnectionStatus: () => io.status
    };
    if (name === 'libvpnbridge.so') return { default: { processAlive: () => io.alive } };
    if (name === '../model/BuildCapabilities') return { VPN_CORE_AVAILABLE: io.core };
    // Rendering/material capability is covered by its own suite. Keep the
    // authored button lifecycle and activate() methods intact in this suite.
    if (name === '../model/DockMaterial') {
      class DockMaterialState {}
      return { DockMaterialState, loadDockMaterial: async () => new DockMaterialState() };
    }
    if (['./ConnectionLifecycle', '../model/ConnectionLifecycle'].includes(name)) {
      if (!cache.lifecycle) cache.lifecycle = execute(sources.lifecycle, 'ConnectionLifecycle.ets', load);
      return cache.lifecycle;
    }
    if (name === '../model/DockConnectionAction') return cache.action;
    if (name === '../model/MainNavigation') return cache.navigation;
    throw new Error('Unexpected dependency ' + name);
  }
  cache.action = execute(sources.action, 'DockConnectionAction.ets', load);
  cache.navigation = execute(sources.navigation, 'MainNavigation.ets', load);
  const methods = sources.button.slice(0, sources.button.indexOf('\n  build() {'))
    .replace('@Component\n', '').replace('export struct DockPowerButton', 'export class DockPowerButton')
    .replace(/@(State|Prop) /g, '') + '\n}\n';
  const { DockPowerButton } = execute(methods, 'DockPowerButton.methods.ets', load);
  const component = new DockPowerButton();
  const context = {
    getHostContext: () => ({ filesDir: '/synthetic/app' }),
    getRouter: () => ({
      back() { io.back++; if (io.routeThrows) throw new Error('private-route-details'); io.route = 'pages/Home'; },
      async pushUrl() {}, async replaceUrl() {}
    }),
    getPromptAction: () => ({ showToast() { io.prompt++; } })
  };
  component.getUIContext = () => context;
  component.onConnectionAction = () => { io.callback++; };
  const active = (change = {}) => {
    io.state = { phase: 'active', kind: 'connection', runId: RUN, updatedAt: io.now, ...change };
    io.command = { runId: io.state.runId, action: 'start', ownerEpoch: 'current-ui' };
    io.status = { runId: io.state.runId, phase: io.state.phase, servicePid: 2345, cleanupConfirmed: false, updatedAt: io.now };
  };
  return { io, component, active, ...cache.action,
    queue: (action = io.state.phase === 'idle' || io.status?.phase === 'destroyed' && io.status.cleanupConfirmed ? 'connect' : 'disconnect', run = io.state.runId) =>
      cache.action.queueDockConnectionAction('/synthetic/app', core, action, run, io.now),
    consume: () => cache.action.consumeDockConnectionAction('/synthetic/app', core, io.now) };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }
test('closed initial state queues explicit connect, consumes once and never repeats on page show', () => {
  const s = scenario(), r = s.queue(); assert.equal(r.action, 'connect'); assert.equal(r.runId, '');
  assert.equal(s.consume().sequence, r.sequence); assert.equal(s.consume(), undefined); assert.equal(s.io.reads, 2);
});
test('returned request is a copy and cannot mutate the queued action or run', () => {
  const s = scenario(), r = s.queue(); r.action = 'disconnect'; r.runId = 'other'; r.createdAt = 0;
  const accepted = s.consume(); assert.equal(accepted.action, 'connect'); assert.equal(accepted.runId, '');
});
test('repeated tap before and after consumption is rejected until the intent expires', () => {
  const s = scenario(); const r = s.queue(); assert.equal(s.queue(), undefined); s.consume(); assert.equal(s.queue(), undefined);
  s.io.now += 5000; const retry = s.queue(); assert(retry.sequence > r.sequence); assert.equal(retry.action, 'connect');
});
for (const phase of ['starting', 'active', 'recovering', 'waiting-network']) {
  test('normal connection permits explicit disconnect during ' + phase, () => {
    const s = scenario(); s.active({ phase }); assert.equal(s.queue().action, 'disconnect');
    const r = s.consume(); assert.equal(r.action, 'disconnect'); assert.equal(r.runId, RUN);
  });
}
for (const kind of ['node-latency', 'connection-test', 'connection-app-test', 'clock-probe']) {
  test('active temporary task cannot be stopped or overlapped from dock: ' + kind, () => {
    const s = scenario(); s.active({ kind }); assert.equal(s.queue(), undefined); assert.equal(s.consume(), undefined);
  });
}
for (const phase of ['stopping', 'destroying', 'failed', 'stopped']) {
  test('live service cleanup or terminal contradiction remains blocked: ' + phase, () => {
    const s = scenario(); s.active(); s.io.status.phase = phase;
    assert.equal(s.queue(), undefined); assert.equal(s.consume(), undefined);
  });
}
test('unresolved old owner cannot become a dock start or stop', () => {
  const s = scenario(); s.active(); s.io.command.ownerEpoch = 'old-ui'; assert.equal(s.queue(), undefined);
});
test('confirmed destroyed receipt permits a new explicit connection', () => {
  const s = scenario(); s.active(); s.io.status.phase = 'destroyed'; s.io.status.cleanupConfirmed = true;
  assert.equal(s.queue().action, 'connect'); assert.equal(s.consume().action, 'connect');
});
test('a connection starting between queue and consume rejects the earlier connect intent', () => {
  const s = scenario(); s.queue(); s.active({ phase: 'starting' }); assert.equal(s.consume(), undefined);
});
test('stale disconnect button cannot become a connect request after cleanup', () => {
  const s = scenario(); s.active(); s.io.status.phase = 'destroyed'; s.io.status.cleanupConfirmed = true;
  assert.equal(s.queue('disconnect', RUN), undefined); assert.equal(s.consume(), undefined);
});
test('stale connect button cannot stop a connection established before the tap', () => {
  const s = scenario(); s.active(); assert.equal(s.queue('connect', ''), undefined); assert.equal(s.consume(), undefined);
});
test('stale disconnect button cannot stop a replacement run before the tap', () => {
  const s = scenario(); s.active({ runId: 'new-run' }); assert.equal(s.queue('disconnect', RUN), undefined);
});
test('a replaced run cannot be stopped by the preceding run request', () => {
  const s = scenario(); s.active(); s.queue(); s.active({ runId: 'new-run' });
  assert.equal(s.consume(), undefined); assert.equal(s.consume(), undefined);
});
test('disconnect intent cannot turn into connect after normal cleanup', () => {
  const s = scenario(); s.active(); s.queue(); s.io.status.phase = 'destroyed'; s.io.status.cleanupConfirmed = true;
  assert.equal(s.consume(), undefined);
});
test('a new stop request invalidates pending dock disconnect without another command', () => {
  const s = scenario(); s.active(); s.queue(); s.io.command.action = 'stop'; assert.equal(s.consume(), undefined);
});
for (const elapsed of [5000, 60000, -1]) {
  test('expired or reversed-clock request is consumed without executing: ' + elapsed, () => {
    const s = scenario(); s.queue(); s.io.now += elapsed; assert.equal(s.consume(), undefined);
    s.io.now = NOW; assert.equal(s.consume(), undefined);
  });
}
test('nonfinite clock cannot enqueue or consume an action', () => {
  const s = scenario(); s.io.now = NaN; assert.equal(s.queue(), undefined);
  s.io.now = NOW; s.queue(); s.io.now = Infinity; assert.equal(s.consume(), undefined);
});
test('wrong storage context cannot consume or later replay the intent', () => {
  const s = scenario(); s.queue(); assert.equal(s.consumeDockConnectionAction('/other', true, NOW), undefined);
  assert.equal(s.consume(), undefined);
});
test('failed read clears pending action before propagating the exception', () => {
  const s = scenario(); s.queue(); s.io.lifecycleThrows = true;
  assert.throws(() => s.consume()); s.io.lifecycleThrows = false; assert.equal(s.consume(), undefined);
});
test('matching navigation cancellation permits an immediate retry', () => {
  const s = scenario(); const first = s.queue(); s.cancelDockConnectionAction(first.sequence);
  const next = s.queue(); assert(next.sequence > first.sequence); assert.equal(s.consume().sequence, next.sequence);
});
test('late navigation cancellation cannot erase a newer pending request', () => {
  const s = scenario(); const first = s.queue(); s.io.now += 5000; const next = s.queue();
  s.cancelDockConnectionAction(first.sequence); assert.equal(s.consume().sequence, next.sequence);
});
test('preview cannot enqueue and enabling preview at consumption drops the intent', () => {
  const preview = scenario(false); assert.equal(preview.queue(), undefined); assert.equal(preview.io.reads, 0);
  const s = scenario(); s.queue(); assert.equal(s.consumeDockConnectionAction('/synthetic/app', false, NOW), undefined);
  assert.equal(s.consume(), undefined);
});
test('component polls only while visible, never duplicates timers and stops when hidden or destroyed', () => {
  const s = scenario(), c = s.component; c.aboutToAppear(); assert.equal(s.io.intervals.size, 0);
  c.setVisible(true); c.setVisible(true); assert.equal(s.io.intervals.size, 1);
  const timer = [...s.io.intervals.values()][0]; assert.equal(timer.ms, 1000);
  const reads = s.io.reads; timer.fn(); assert(s.io.reads > reads);
  c.setVisible(false); assert.equal(s.io.intervals.size, 0); c.setVisible(true);
  c.aboutToDisappear(); assert.equal(s.io.intervals.size, 0);
  c.setVisible(true); assert.equal(s.io.intervals.size, 0, 'late visibility event must not restart a destroyed component');
});
test('preview component neither polls nor navigates nor calls Home', async () => {
  const s = scenario(false), c = s.component; c.aboutToAppear(); c.setVisible(true); await c.activate();
  assert.equal(c.action, ''); assert.equal(s.io.intervals.size, 0); assert.equal(s.io.reads, 0);
  assert.equal(s.io.back, 0); assert.equal(s.io.callback, 0);
});
test('a delayed tap on a destroyed component cannot queue or navigate', async () => {
  const s = scenario(), c = s.component; c.aboutToAppear(); c.aboutToDisappear();
  await c.activate(); assert.equal(s.io.callback, 0); assert.equal(s.io.back, 0); assert.equal(s.consume(), undefined);
});
test('Home dock calls its callback once while repeated taps are still the same intent', async () => {
  const s = scenario(), c = s.component; c.current = 'home'; c.aboutToAppear();
  c.onConnectionAction = () => { s.io.callback++; assert.equal(s.consume().action, 'connect'); };
  await c.activate(); await c.activate(); assert.equal(s.io.callback, 1); assert.equal(s.io.back, 0);
});
test('in-progress Home authorization prevents another intent before a status receipt exists', async () => {
  const s = scenario(), c = s.component; c.requestInProgress = true;
  c.aboutToAppear(); assert.equal(c.mounted, true); assert.equal(c.action, 'connect');
  await c.activate(); assert.equal(s.io.callback, 0); assert.equal(s.consume(), undefined);
});
test('non-Home action returns to retained Home for execution, without writing commands itself', async () => {
  const s = scenario(), c = s.component; c.current = 'nodes'; c.aboutToAppear(); await c.activate();
  assert.equal(s.io.back, 1); assert.equal(s.io.callback, 0); assert.equal(s.consume().action, 'connect');
});
test('routing failure cancels the action and allows retry instead of later accidental execution', async () => {
  const s = scenario(), c = s.component; c.current = 'settings'; c.aboutToAppear(); s.io.routeThrows = true;
  await c.activate(); assert.equal(s.io.prompt, 1); assert.equal(s.consume(), undefined); assert.equal(c.navigating, false);
  s.io.routeThrows = false; await c.activate(); assert.equal(s.io.back, 2); assert.equal(s.consume().action, 'connect');
});
test('Home callback exception cancels the queued intent and releases component latch', async () => {
  const s = scenario(), c = s.component; c.aboutToAppear(); c.onConnectionAction = () => { throw new Error('synthetic'); };
  await c.activate(); assert.equal(s.consume(), undefined); assert.equal(c.navigating, false);
});

(async () => {
  const results = [];
  for (const item of tests) {
    try { await item.run(); results.push({ name: item.name, passed: true }); }
    catch (e) { results.push({ name: item.name, passed: false, detail: e.message }); }
  }
  const staticChecks = [];
  function check(name, fn) { try { fn(); staticChecks.push({ name, passed: true }); }
    catch (e) { staticChecks.push({ name, passed: false, detail: e.message }); } }
  check('all existing navigation IDs and accessible labels remain present', () => {
    for (const value of ['navHome', 'navNodes', 'navSettings', '连接', '节点', '设置']) assert(sources.bar.includes(value));
    assert(sources.bar.includes('.accessibilityText(label)'));
    assert(sources.button.includes(".id('dockConnectionAction')"));
  });
  check('glass modifiers belong to the capsule and power control, not an opaque full-width dock wrapper', () => {
    assert(sources.bar.includes('.attributeModifier(new DockGlassModifier(this.material.capsule))'));
    assert(sources.button.includes('.attributeModifier(new DockGlassModifier(this.material.action))'));
    const wrapper = sources.bar.slice(sources.bar.indexOf(".id('floatingNavigationDock')"), sources.bar.indexOf('\n  @Builder'));
    assert(!/\.background\(|\.backgroundColor\(|\.backgroundImage\(|\.expandSafeArea\(/.test(wrapper));
    assert(wrapper.includes('.hitTestBehavior(HitTestMode.Transparent)'));
  });
  check('320vp dock leaves enough width for each two-character label at 2x font without capping user font scale', () => {
    assert(sources.bar.includes('left: 12, right: 12')); assert(sources.bar.includes('Row({ space: 10 })'));
    assert(sources.button.includes('.width(64).height(64).flexShrink(0)'));
    assert(sources.bar.includes('Row({ space: 2 })')); assert(sources.bar.includes('.padding(5)'));
    const minimumTab = (320 - 24 - 10 - 64 - 10 - 4) / 3;
    assert(minimumTab >= 12 * 2 * 2); assert(sources.bar.includes('.fontSize(12)'));
    assert(!/maxFontScale|minFontSize|height\(64\)/.test(sources.bar));
  });
  check('component visibility callback and lifecycle cleanup wire polling boundaries', () => {
    assert(sources.button.includes('.onVisibleAreaChange([0.0]'));
    assert(sources.button.includes('this.setVisible(visible && ratio > 0)'));
    assert(sources.button.includes('aboutToDisappear(): void { this.mounted = false; this.stopPolling(); }'));
  });
  check('dock does not own VPN writes, native startup or node-library polling', () => {
    const text = sources.action + sources.button;
    assert(!/writeConnectionCommand|writeProbeState|startVpnExtensionAbility|readNodeCatalog|writeFile|fileIo/.test(text));
  });
  const failed = results.filter(x => !x.passed).length + staticChecks.filter(x => !x.passed).length;
  const report = { generatedAt: new Date().toISOString(), passed: results.filter(x => x.passed).length,
    failed, total: results.length, staticChecks, sourceSHA256: sourceHashes,
    scope: 'Authored queue, lifecycle, navigation and component methods with synthetic stores/router/timers; material loader is an explicit inert stub. Layout constraints are static only, not ArkUI rendering or material-capability proof.',
    results };
  const output = path.join(project, 'build/dock-connection-action-verification.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, total: report.total, static: staticChecks.length, failed,
    failures: [...results, ...staticChecks].filter(x => !x.passed), record: output }));
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
