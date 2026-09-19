'use strict';
// Execute the pure preset module and bundle validator. No installed-app claims,
// SDK mocks, device queries or private files are part of this suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sources = new Map(), dependencyCalls = [];
function load(name) {
  const relative = 'entry/src/main/ets/model/' + name + '.ets';
  const source = fs.readFileSync(path.join(root, relative), 'utf8'); sources.set(relative, source);
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS
  }, reportDiagnostics: true });
  assert.equal(output.diagnostics.length, 0, name + ' transpilation');
  const context = { exports: {}, require: key => { dependencyCalls.push(key); assert.fail('Unexpected dependency ' + key); } };
  vm.runInNewContext(output.outputText, context, { filename: relative }); return context.exports;
}
const routing = load('AppRouting'), presets = load('AppCandidates');
const cases = [], plain = value => JSON.parse(JSON.stringify(value));
function test(name, run) { run(); cases.push({ name, passed: true }); }
test('preset module loads with no SDK, installation API or external dependency', () => {
  assert.deepEqual(dependencyCalls, []);
  assert.deepEqual(Object.keys(presets).sort(), ['AppCandidate', 'COMMON_APP_CANDIDATES']);
});
test('candidate constructor preserves exact package identity and display name without installation state', () => {
  const value = new presets.AppCandidate('Org.Example.Reader', 'Synthetic Reader');
  assert.deepEqual(plain(value), { bundleName: 'Org.Example.Reader', name: 'Synthetic Reader' });
});
test('all presets are bounded, unique, valid bundle identities and exclude the VPN app', () => {
  const values = presets.COMMON_APP_CANDIDATES;
  assert(values.length >= 6 && values.length <= 16);
  assert.equal(new Set(values.map(app => app.bundleName)).size, values.length);
  for (const app of values) {
    assert.equal(routing.normalizeAppBundle(app.bundleName), app.bundleName);
    assert.notEqual(app.bundleName, routing.OWN_VPN_BUNDLE);
  }
});
test('six requested common-app presets retain their explicitly verified mapping', () => {
  assert.deepEqual(plain(presets.COMMON_APP_CANDIDATES.slice(0, 6)).map(app => [app.name, app.bundleName]), [
    ['微信', 'com.tencent.wechat'], ['抖音', 'com.ss.hm.ugc.aweme'], ['QQ', 'com.tencent.mqq'],
    ['支付宝', 'com.alipay.mobile.client'], ['美团', 'com.sankuai.hmeituan'], ['京东', 'com.jd.hm.mall']
  ]);
});
test('preset display records contain readable bounded names and no inferred enabled or installed fields', () => {
  for (const app of presets.COMMON_APP_CANDIDATES) {
    assert.deepEqual(Object.keys(app).sort(), ['bundleName', 'name']);
    assert.equal(typeof app.name, 'string'); assert(app.name.length > 0 && app.name.length <= 80);
    assert.equal(app.name.trim(), app.name); assert(!/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/.test(app.name));
  }
});
test('constructing a manual candidate does not mutate the common presets or perform lookup', () => {
  const before = JSON.stringify(presets.COMMON_APP_CANDIDATES);
  new presets.AppCandidate('com.example.manual', 'Manual');
  assert.equal(JSON.stringify(presets.COMMON_APP_CANDIDATES), before); assert.deepEqual(dependencyCalls, []);
});
const sourceSHA256 = Object.fromEntries([...sources].map(([name, source]) =>
  [name, crypto.createHash('sha256').update(source).digest('hex')]));
const report = { checkedAt: new Date().toISOString(), passed: cases.length, failed: 0,
  scope: 'Actual pure AppCandidates preset data and AppRouting validation; no SDK queries, installation detection, device, network or private files.',
  testSourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), sourceSHA256, cases };
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/app-candidates-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: 0 }));
