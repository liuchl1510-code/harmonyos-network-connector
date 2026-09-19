'use strict';
// Actual EntryAbility methods with synthetic window callbacks; geometry uses the
// authored Scrim AST expressions. No device, window mutation, HDC or UI rendering.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vm = require('node:vm'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sdk = path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader');
const ts = require(path.join(sdk, 'node_modules/typescript'));
const entryPath = 'entryability/EntryAbility.ets', scrimPath = 'components/StatusBarScrim.ets';
const sources = new Map([entryPath, scrimPath].map(name => [name, fs.readFileSync(path.join(root, 'entry/src/main/ets', name), 'utf8')]));
const compiled = ts.transpileModule(sources.get(entryPath), { compilerOptions: { target: ts.ScriptTarget.ES2021,
  module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics.length, 0);
function scenario(options = {}) {
  const values = new Map(), listeners = new Map(), attached = [], detached = [], queries = [], logs = [], fonts = [], resizes = [];
  const state = { top: options.top ?? 96, density: options.density ?? 2, width: 720, height: 1600,
    getterThrows: false, conversionThrows: false, onThrows: '', offThrows: '', invalidVp: undefined };
  const ui = { px2vp(value) { if (state.conversionThrows) throw Error('unavailable'); return state.invalidVp ?? value / state.density; },
    vp2px: value => value * state.density };
  const main = {
    getUIContext: () => ui,
    getWindowProperties: () => ({ windowRect: { width: state.width, height: state.height } }),
    getWindowAvoidArea(type) { queries.push(type); if (state.getterThrows) throw Error('not-ready'); return { topRect: { height: state.top } }; },
    on(name, callback) { if (state.onThrows === name) throw Error('on failed'); attached.push({ name, callback }); listeners.set(name, callback); },
    off(name, callback) { detached.push({ name, callback }); if (state.offThrows === name) throw Error('off failed');
      assert.equal(listeners.get(name), callback); listeners.delete(name); },
    resizeAsync: async (width, height) => { resizes.push([width, height]); }
  };
  const imports = {
    '@kit.AbilityKit': { UIAbility: class {} },
    '@kit.ArkUI': { window: { AvoidAreaType: { TYPE_SYSTEM: 0 } } },
    '@kit.BasicServicesKit': { deviceInfo: { deviceType: options.deviceType ?? 'phone', sdkApiVersion: 24 } },
    '@kit.PerformanceAnalysisKit': { hilog: { info(...args) { logs.push(args); }, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } } },
    'libvpnbridge.so': {}, '../model/Appearance': { applyAppearance() {}, readAppearance: () => 'system' },
    '../model/AdaptiveLayout': { normalizedWindowWidth: value => Number.isFinite(value) && value > 0 ? value : 360 },
    '../model/BuildCapabilities': { VPN_CORE_AVAILABLE: false }
  };
  const exported = {};
  vm.runInNewContext(compiled.outputText, { exports: exported, AppStorage: {
    setOrCreate: (key, value) => values.set(key, value), set: (key, value) => values.set(key, value)
  }, require(name) { assert(Object.hasOwn(imports, name), name); return imports[name]; } }, { filename: entryPath });
  const ability = new exported.default();
  ability.context = { filesDir: '/synthetic', applicationInfo: { debug: options.debug ?? false },
    getApplicationContext: () => ({ setFontSizeScale: scale => fonts.push(scale) }) };
  const stage = { getMainWindowSync: () => main, loadContent(page, callback) { assert(['pages/Home', 'pages/RuntimeSmoke'].includes(page)); callback({ code: 0 }); } };
  function start() { ability.onCreate({ parameters: {} }); ability.onWindowStageCreate(stage); }
  function emit(type, height) { assert(listeners.has('avoidAreaChange')); listeners.get('avoidAreaChange')({ type, area: { topRect: { height } } }); }
  return { ability, values, listeners, attached, detached, queries, state, main, stage, start, emit, logs, fonts, resizes };
}
const results = [];
function test(name, body) {
  try { body(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); }
}
test('API24 startup publishes actual density-aware system top height alongside original window width', () => {
  const s = scenario(); s.start(); assert.equal(s.values.get('statusBarHeightVp'), 48); assert.equal(s.values.get('windowWidthVp'), 360);
  assert.deepEqual(s.attached.map(entry => entry.name), ['windowSizeChange', 'avoidAreaChange']);
  assert(s.queries.every(value => value === 0));
});
test('onCreate initializes an empty top inset before the window is ready', () => {
  const s = scenario(); s.values.set('statusBarHeightVp', 999); s.ability.onCreate({ parameters: {} });
  assert.equal(s.values.get('statusBarHeightVp'), 0); assert.equal(s.queries.length, 0);
});
test('native TYPE_SYSTEM event uses its current area and px2vp conversion', () => {
  const s = scenario(); s.start(); s.state.top = 96; s.emit(0, 101);
  assert.equal(s.values.get('statusBarHeightVp'), 50.5);
});
test('keyboard and gesture avoidance events cannot alter the status bar inset', () => {
  const s = scenario(); s.start(); for (const type of [1, 2, 3, 4]) s.emit(type, 500);
  assert.equal(s.values.get('statusBarHeightVp'), 48);
});
test('window resize refreshes both width and current system top area', () => {
  const s = scenario(); s.start(); s.state.top = 60; s.state.density = 3;
  s.listeners.get('windowSizeChange')({ width: 1440, height: 2200 });
  assert.equal(s.values.get('windowWidthVp'), 480); assert.equal(s.values.get('statusBarHeightVp'), 20);
});
test('zero top area on rotation or window-mode changes removes the scrim', () => {
  const s = scenario(); s.start(); s.emit(0, 0); assert.equal(s.values.get('statusBarHeightVp'), 0);
  s.state.top = 0; s.listeners.get('windowSizeChange')({ width: 1600, height: 720 }); assert.equal(s.values.get('statusBarHeightVp'), 0);
});
for (const type of ['2in1', 'pc']) test(type + ' remains zero without subscribing or querying system status-area data', () => {
  const s = scenario({ deviceType: type }); s.start(); assert.equal(s.values.get('statusBarHeightVp'), 0);
  assert.equal(s.queries.length, 0); assert(!s.listeners.has('avoidAreaChange'));
  s.listeners.get('windowSizeChange')({ width: 1440, height: 900 }); assert.equal(s.values.get('statusBarHeightVp'), 0);
});
test('tablet retains a real system top area rather than sharing the PC exception', () => {
  const s = scenario({ deviceType: 'tablet', top: 80, density: 2 }); s.start(); assert.equal(s.values.get('statusBarHeightVp'), 40);
});
test('temporary getter or conversion failure retains the last measured inset', () => {
  const s = scenario(); s.start(); s.state.getterThrows = true; s.ability.updateStatusBarHeight(s.main);
  assert.equal(s.values.get('statusBarHeightVp'), 48); s.state.getterThrows = false; s.state.conversionThrows = true;
  s.emit(0, 120); assert.equal(s.values.get('statusBarHeightVp'), 48);
});
test('invalid or negative native dimensions cannot become overlay sizes', () => {
  const s = scenario(); s.start(); for (const height of [-1, NaN, Infinity]) s.emit(0, height);
  assert.equal(s.values.get('statusBarHeightVp'), 48);
  s.state.invalidVp = -5; s.emit(0, 100); assert.equal(s.values.get('statusBarHeightVp'), 48);
});
test('repeated attach does not duplicate either listener', () => {
  const s = scenario(); s.start(); s.ability.attachStatusBarHeight(); s.ability.attachStatusBarHeight(); s.ability.attachWindowSize();
  assert.equal(s.attached.length, 2);
});
test('resize subscription failure does not block independent avoidance updates', () => {
  const s = scenario(); s.state.onThrows = 'windowSizeChange'; s.start();
  assert(s.listeners.has('avoidAreaChange')); s.emit(0, 120); assert.equal(s.values.get('statusBarHeightVp'), 60);
});
test('avoidance subscription failure leaves resize refresh usable and can retry later', () => {
  const s = scenario(); s.state.onThrows = 'avoidAreaChange'; s.start();
  assert(!s.listeners.has('avoidAreaChange')); s.state.top = 120;
  s.listeners.get('windowSizeChange')({ width: 720, height: 1600 }); assert.equal(s.values.get('statusBarHeightVp'), 60);
  s.state.onThrows = ''; s.ability.attachStatusBarHeight(); assert(s.listeners.has('avoidAreaChange'));
});
test('destroy removes exact independent callbacks and resets the published top area', () => {
  const s = scenario(); s.start(); s.ability.onWindowStageDestroy();
  assert.equal(s.detached.length, 2); for (const entry of s.detached) assert.equal(entry.callback, s.attached.find(a => a.name === entry.name).callback);
  assert.equal(s.values.get('statusBarHeightVp'), 0); assert.equal(s.ability.mainWindow, undefined); assert.equal(s.ability.contentReady, false);
});
test('failed resize detach cannot suppress avoidance detach or cleanup', () => {
  const s = scenario(); s.start(); s.state.offThrows = 'windowSizeChange'; s.ability.onWindowStageDestroy();
  assert(s.detached.some(entry => entry.name === 'avoidAreaChange')); assert.equal(s.values.get('statusBarHeightVp'), 0);
  assert.equal(s.ability.avoidAreaListener, undefined);
});
test('late old-window avoidance and resize callbacks cannot restore a destroyed status inset', () => {
  const s = scenario(); s.start(); const avoid = s.listeners.get('avoidAreaChange'), resize = s.listeners.get('windowSizeChange');
  s.ability.onWindowStageDestroy(); avoid({ type: 0, area: { topRect: { height: 200 } } }); resize({ width: 720, height: 1600 });
  assert.equal(s.values.get('statusBarHeightVp'), 0);
});
test('debug font and PC resize test entrypoints are preserved', () => {
  const s = scenario({ deviceType: '2in1', debug: true });
  s.ability.onCreate({ parameters: { uiFontScale: '2', uiWindowSize: '800x600' } }); s.ability.onWindowStageCreate(s.stage);
  assert.deepEqual(s.fonts, [2]); assert.deepEqual(s.resizes, [[1600, 1200]]); assert.equal(s.values.get('statusBarHeightVp'), 0);
});

const config = ts.readConfigFile(path.join(sdk, 'tsconfig.json'), ts.sys.readFile).config.compilerOptions;
const parsed = ts.createSourceFile(scrimPath, sources.get(scrimPath), ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS, config);
assert.equal(parsed.parseDiagnostics.length, 0);
const calls = new Map(); let condition;
function walk(node) {
  if (ts.isIfStatement(node)) condition = node.expression;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) calls.set(node.expression.name.text, node.arguments);
  ts.forEachChild(node, walk);
}
walk(parsed);
function expression(node, height) {
  return vm.runInNewContext('(function(){return (' + node.getText(parsed) + ');}).call(value)', {
    value: { statusBarHeightVp: height }, GradientDirection: { Bottom: 'bottom' }, $r: value => value,
    HitTestMode: { None: 'none' }
  });
}
const geometryChecks = [];
function geometry(name, body) {
  try { body(); geometryChecks.push({ name, passed: true }); }
  catch (error) { geometryChecks.push({ name, passed: false, detail: error.message }); }
}
geometry('zero, negative or invalid insets create no scrim component', () => {
  for (const height of [0, -1, NaN, Infinity]) assert.equal(expression(condition, height), false);
});
geometry('authored absolute position covers only the actual status area and 20vp of page fade', () => {
  for (const height of [0.1, 24, 48, 50.5, 96]) {
    assert.equal(expression(condition, height), true);
    const size = expression(calls.get('height')[0], height), position = expression(calls.get('position')[0], height);
    assert.equal(position.x, 0); assert.equal(position.y, -height); assert.equal(position.y + size, 20);
    const gradient = expression(calls.get('linearGradient')[0], height);
    assert.equal(gradient.direction, 'bottom'); assert.equal(gradient.colors[0][0], 'app.color.status_bar_tint');
    assert.equal(gradient.colors[1][0], 'app.color.status_bar_tint'); assert.equal(gradient.colors[2][0], 'app.color.status_bar_clear');
    assert.equal(gradient.colors[1][1] * size + position.y, 0, 'constant tint must end exactly at the safe-layout origin');
  }
});
geometry('scrim is full-width, absolutely positioned and cannot intercept touch/focus/accessibility', () => {
  assert.equal(expression(calls.get('width')[0], 48), '100%'); assert(calls.has('position')); assert(!calls.has('offset'));
  assert.equal(expression(calls.get('hitTestBehavior')[0], 48), 'none'); assert.equal(expression(calls.get('focusable')[0], 48), false);
  assert.equal(expression(calls.get('accessibilityLevel')[0], 48), 'no-hide-descendants');
});
geometry('window setup never hides system bars or requests full-screen layout', () => {
  assert(!/setWindowLayoutFullScreen|setWindowSystemBarEnable|setSpecificSystemBarEnabled/.test(sources.get(entryPath)));
});

const failed = [...results, ...geometryChecks].filter(value => !value.passed);
const report = { generatedAt: new Date().toISOString(), passed: results.filter(v => v.passed).length, total: results.length,
  failed: failed.length, geometryChecks, results, sourceSHA256: Object.fromEntries([...sources].map(([name, value]) =>
    [name, crypto.createHash('sha256').update(value).digest('hex')])),
  scope: 'Actual EntryAbility with synthetic API24 window events; authored Scrim AST geometry expressions, no ArkUI rendering or device execution.' };
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/window-insets-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, total: report.total, geometryChecks: geometryChecks.length, failed: failed.length, failures: failed }));
if (failed.length) process.exitCode = 1;
