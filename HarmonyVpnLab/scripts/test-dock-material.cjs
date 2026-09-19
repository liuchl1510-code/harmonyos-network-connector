'use strict';
// SDK transpilation plus a synthetic native-material module. No UI rendering.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const relative = 'entry/src/main/ets/model/DockMaterial.ets';
const source = fs.readFileSync(path.join(root, relative), 'utf8');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021,
  module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics.length, 0);
function scenario(options = {}) {
  const calls = { imports: [], supported: 0, metadata: 0, constructed: [] };
  const uiMaterial = {
    isImmersiveMaterialSupported() { calls.supported++; if (options.checkThrows) throw Error('synthetic'); return options.supported !== false; },
    getMaterialInfo() { calls.metadata++; if (options.metadataThrows) throw Error('synthetic'); return { state: options.disabled ? 2 : 0 }; },
    MaterialState: { DISABLE: 2 }, ImmersiveStyle: { ULTRA_THIN: 0 },
    ImmersiveMaterial: class {
      constructor(value) { calls.constructed.push(value); if (options.constructThrowsAt === calls.constructed.length) throw Error('synthetic'); this.options = value; }
    }
  };
  const exported = {};
  vm.runInNewContext(compiled.outputText, { exports: exported, $r: value => value,
    Color: { Transparent: 'transparent', White: 'white' }, require(name) {
    calls.imports.push(name);
    if (name === '@kit.BasicServicesKit') return { deviceInfo: { sdkApiVersion: options.api ?? 26 } };
    assert.equal(name, '@ohos.arkui.uiMaterial');
    if (options.importThrows) throw Error('synthetic missing API module');
    return { default: uiMaterial };
  } }, { filename: relative });
  return { calls, load: exported.loadDockMaterial, Modifier: exported.DockGlassModifier };
}
const tests = [];
function test(name, body) { tests.push({ name, body }); }
for (const api of [24, 25, 0, NaN, Infinity]) test('API ' + api + ' never imports the API 26 native material module', async () => {
  const s = scenario({ api, importThrows: true });
  assert.deepEqual(s.calls.imports, ['@kit.BasicServicesKit']);
  const result = await s.load(); assert.equal(result.available, false); assert.equal(result.reason, 'older-api');
  assert.deepEqual(s.calls.imports, ['@kit.BasicServicesKit']); assert.equal(s.calls.constructed.length, 0);
});
test('API 26 module is loaded lazily only after the caller requests it', async () => {
  const s = scenario(); assert.deepEqual(s.calls.imports, ['@kit.BasicServicesKit']);
  const result = await s.load(); assert.equal(result.available, true); assert.equal(result.reason, 'system-material');
  assert.deepEqual(s.calls.imports, ['@kit.BasicServicesKit', '@ohos.arkui.uiMaterial']);
});
test('simultaneous callers share one capability query and two reusable objects', async () => {
  const s = scenario(); const a = s.load(), b = s.load(); assert.equal(a, b);
  const [first, second] = await Promise.all([a, b]); assert.equal(first, second);
  assert.equal(s.calls.supported, 1); assert.equal(s.calls.metadata, 1); assert.equal(s.calls.constructed.length, 2);
});
test('capsule and action use transparent ultra-thin material with action-only deformation and light', async () => {
  const s = scenario(); const result = await s.load();
  assert.notEqual(result.capsule, result.action);
  for (const value of s.calls.constructed) {
    assert.equal(value.style, 0); assert.equal(value.materialColor, 'transparent'); assert.equal(value.applyShadow, true);
    assert.equal(value.colorInvert, false, 'custom palette does not claim automatic system-color inversion');
  }
  assert.equal(result.capsule.options.interactive, false); assert.equal(result.capsule.options.lightEffect, undefined);
  assert.equal(result.action.options.interactive, true); assert.equal(result.action.options.lightEffect.color, 'white');
});
for (const [options, reason] of [
  [{ supported: false }, 'unsupported-device'], [{ disabled: true }, 'disabled-configuration'],
  [{ importThrows: true }, 'unavailable'], [{ checkThrows: true }, 'unavailable'],
  [{ metadataThrows: true }, 'unavailable'], [{ constructThrowsAt: 1 }, 'unavailable'], [{ constructThrowsAt: 2 }, 'unavailable']
]) test('fallback is complete when ' + Object.keys(options)[0] + '=' + Object.values(options)[0], async () => {
  const s = scenario(options); const result = await s.load();
  assert.equal(result.available, false); assert.equal(result.reason, reason);
  assert.equal(result.capsule, undefined); assert.equal(result.action, undefined);
  assert.equal((await s.load()), result, 'failed capabilities must not be polled every render');
});
test('type alias does not emit a static material import or query', () => {
  assert(!compiled.outputText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').includes('SystemUiMaterial'));
  const s = scenario({ api: 24 }); assert.deepEqual(s.calls.imports, ['@kit.BasicServicesKit']);
});
function attributes() {
  const calls = [];
  const value = Object.fromEntries(['backgroundColor', 'backgroundEffect', 'borderWidth', 'shadow', 'systemMaterial', 'border']
    .map(key => [key, (...args) => { calls.push([key, ...args]); return value; }]));
  return { calls, value };
}
test('API 24 fallback cannot invoke the new systemMaterial method even with a supplied object', () => {
  const s = scenario({ api: 24 }), a = attributes(); delete a.value.systemMaterial;
  new s.Modifier({ synthetic: true }).applyNormalAttribute(a.value);
  assert(!a.calls.some(call => call[0] === 'systemMaterial'));
  const effect = a.calls.find(call => call[0] === 'backgroundEffect')[1];
  assert.equal(effect.radius, 20); assert.equal(effect.color, 'app.color.dock_glass_tint');
});
test('initial unsupported or loading state uses transparent background plus configured translucent fallback', () => {
  const s = scenario(), a = attributes(); new s.Modifier().applyNormalAttribute(a.value);
  assert.equal(a.calls[0][0], 'backgroundColor'); assert.equal(a.calls[0][1], 'transparent');
  assert(!a.calls.some(call => call[0] === 'systemMaterial'));
});
test('native modifier removes prior fallback layers before system material is applied', async () => {
  const s = scenario(), a = attributes(), state = await s.load();
  new s.Modifier(state.capsule).applyNormalAttribute(a.value);
  assert.deepEqual(a.calls.map(call => call[0]), ['backgroundColor', 'backgroundEffect', 'borderWidth', 'shadow', 'systemMaterial']);
  assert.equal(a.calls[1][1], undefined); assert.equal(a.calls[2][1], 0);
  assert.equal(a.calls[3][1].radius, 0); assert.equal(a.calls[4][1], state.capsule);
});
(async () => {
  const results = [];
  for (const item of tests) {
    try { await item.body(); results.push({ name: item.name, passed: true }); }
    catch (error) { results.push({ name: item.name, passed: false, detail: error.message }); }
  }
  const passed = results.filter(value => value.passed).length;
  const report = { generatedAt: new Date().toISOString(), passed, total: results.length, failed: results.length - passed,
    sourceSHA256: { [relative]: crypto.createHash('sha256').update(source).digest('hex') }, results,
    scope: 'Actual lazy material loader with SDK transpilation and synthetic native module; no OS module, ArkUI rendering or real API 24 execution.',
    limitation: 'Material availability does not establish renderer support at a particular component location; supported Tabs/Navigation hosting and device appearance need separate verification.' };
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/dock-material-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, total: results.length, failed: report.failed, failures: results.filter(value => !value.passed) }));
  if (report.failed) process.exitCode = 1;
})();
