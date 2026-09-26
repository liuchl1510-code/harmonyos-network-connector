'use strict';
// Execute actual page methods and policy validation with a synthetic in-memory
// store. This checks draft/confirmation/feedback behavior, not device rendering.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sdk = path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader');
const ts = require(path.join(sdk, 'node_modules/typescript'));
const parserOptions = ts.readConfigFile(path.join(sdk, 'tsconfig.json'), ts.sys.readFile).config.compilerOptions;
const sourceHashes = {}, sources = {};
function load(relative, imports = {}, isPage = false) {
  const file = path.join(root, 'entry/src/main/ets', relative);
  const original = fs.readFileSync(file, 'utf8'); sources[relative] = original;
  sourceHashes[relative] = crypto.createHash('sha256').update(original).digest('hex');
  let source = original;
  if (isPage) {
    const end = source.indexOf('\n  build() {'); assert(end > 0);
    source = source.slice(0, end) + '\n}\n';
    source = source.replace(/^@Entry\s*$/gm, '').replace(/^@Component\s*$/gm, '')
      .replace(/^(\s*)@State /gm, '$1').replace(/@StorageProp\([^)]*\)\s*/g, '')
      .replace(/^struct (\w+) \{/m, 'export class $1 {');
  }
  const result = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0, relative);
  const context = { exports: {}, Error, Promise, $r: name => name,
    require(name) { assert(Object.hasOwn(imports, name), 'Unexpected dependency: ' + name); return imports[name]; } };
  vm.runInNewContext(result.outputText, context, { filename: relative }); return context.exports;
}
const bootstrap = load('model/NodeBootstrap.ets');
const appRouting = load('model/AppRouting.ets');
const policy = load('model/NetworkPolicy.ets', { './NodeBootstrap': bootstrap, './AppRouting': appRouting });
const clone = value => JSON.parse(JSON.stringify(value));
const rawError = new Error('synthetic-private-path synthetic-private-token');
function fixture(options = {}) {
  const state = { value: options.value || new policy.NetworkPolicy(), writes: 0, reads: 0, allowed: true,
    failure: options.failure || '', dialogs: [], backs: 0, routerFailure: false, guardFailure: false };
  // This module must remain pure. The loader rejects any dependency, including a
  // BundleManager SDK import or an installation-query adapter.
  const candidates = load('model/AppCandidates.ets');
  const api = load('pages/NetworkSettings.ets', {
    '@kit.AbilityKit': {}, '../model/NetworkPolicy': policy,
    '../model/AppRouting': appRouting, '../model/AppCandidates': candidates,
    '../model/NetworkPolicyStore': {
      readNetworkPolicy() {
        state.reads++;
        if (state.failure === 'read' || (state.failure === 'readback' && state.writes > 0)) throw rawError;
        return policy.validateNetworkPolicy(clone(state.value));
      },
      saveNetworkPolicy(_, value) {
        assert(state.allowed, 'Blocked mutation reached the store');
        const validated = policy.validateNetworkPolicy(value);
        if (state.failure === 'write') throw rawError;
        state.value = clone(validated); state.writes++;
      }
    },
    '../model/NodeEditGuard': { isNodeManagementAllowed() { if (state.guardFailure) throw rawError; return state.allowed; } }
  }, true);
  const page = new api.NetworkSettings();
  page.getUIContext = () => ({ getHostContext: () => ({ filesDir: 'synthetic-memory-only' }),
    getRouter: () => ({ back() { if (state.routerFailure) throw rawError; state.backs++; } }),
    getPromptAction: () => ({ showDialog(options) {
      const request = { options }; state.dialogs.push(request);
      return new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    } }) });
  page.aboutToAppear();
  return { state, page, candidates, change(field, value) { page[field] = value; page.draftChanged(); } };
}
function privateSafe(value) { assert(!JSON.stringify(value).includes('synthetic-private')); }
const cases = [], add = (name, run) => cases.push({ name, run });
const changes = { mode: 'rules', bypassLan: true, direct: 'direct.example.com', proxy: 'proxy.example.com',
  block: 'full:blocked.example.com', dnsUrl: 'https://dns.example.com/dns-query',
  dnsMode: 'split', directDnsUrl: 'https://1.1.1.1/dns-query' };
for (const [field, value] of Object.entries(changes)) add(field + ' detects changes and exact undo becomes clean', () => {
  const f = fixture(), initial = f.page[field]; f.change(field, value); assert.equal(f.page.dirty, true);
  f.change(field, initial); assert.equal(f.page.dirty, false); assert.equal(f.state.writes, 0);
});
add('clean system return delegates and explicit return cannot navigate twice', async () => {
  const f = fixture(); assert.equal(f.page.onBackPress(), false);
  await f.page.requestBack(); await f.page.requestBack();
  assert.equal(f.state.backs, 1); assert.equal(f.state.dialogs.length, 0);
});
add('unchanged save does not write or replace feedback', () => {
  const f = fixture(); f.page.message = 'retained feedback'; f.page.save();
  assert.equal(f.state.writes, 0); assert.equal(f.page.message, 'retained feedback');
});
add('valid save normalizes rules, resets dirty state and absorbs repeated clicks', () => {
  const f = fixture(); f.change('mode', 'rules'); f.change('direct', ' Example.COM\nexample.com\n192.0.2.99/24');
  f.page.save(); assert.equal(f.state.writes, 1); assert.equal(f.page.dirty, false);
  assert.equal(f.page.direct, 'domain:example.com\n192.0.2.0/24'); assert.match(f.page.message, /已保存/);
  const message = f.page.message; f.page.save(); assert.equal(f.state.writes, 1); assert.equal(f.page.message, message);
});
add('actual whitelist selection and exact undo preserve the clean global default', () => {
  const f = fixture(); assert.equal(f.page.mode, 'global');
  pageEvent(f, 'routingWhitelist', 'onClick'); assert.equal(f.page.mode, 'whitelist'); assert.equal(f.page.dirty, true);
  pageEvent(f, 'routingGlobal', 'onClick'); assert.equal(f.page.mode, 'global'); assert.equal(f.page.dirty, false);
  assert.equal(f.state.writes, 0);
});
for (const appMode of ['all', 'include', 'exclude']) {
  add('whitelist save and reopening retain custom rules, DNS and ' + appMode + ' app scope', () => {
    const value = appPolicy(appMode); value.mode = 'rules'; value.bypassLan = true;
    value.direct = ['domain:direct.example.com']; value.proxy = ['domain:proxy.example.com'];
    value.block = ['full:blocked.example.com']; value.dnsUrl = 'https://dns.example.com/query';
    const f = fixture({ value }); pageEvent(f, 'routingWhitelist', 'onClick'); f.page.save();
    assert.equal(f.state.writes, 1); assert.equal(f.page.dirty, false);
    assert.deepEqual(clone(f.state.value), { ...clone(value), mode: 'whitelist' });
    f.page.aboutToDisappear(); f.page.aboutToAppear(); assert.equal(f.page.mode, 'whitelist');
    assert.equal(f.page.direct, value.direct.join('\n')); assert.equal(f.page.bypassLan, true);
    pageEvent(f, 'routingRules', 'onClick'); f.page.save();
    assert.equal(f.state.writes, 2); assert.deepEqual(clone(f.state.value), clone(value));
  });
}
for (const id of ['routingGlobal', 'routingWhitelist', 'routingRules']) {
  for (const denial of ['connection', 'confirmation', 'leaving', 'guard-error']) {
    add('queued ' + id + ' click cannot change the draft during ' + denial, () => {
      const f = fixture(); const previous = f.page.snapshot();
      if (denial === 'connection') f.state.allowed = false;
      if (denial === 'confirmation') f.page.confirmingLeave = true;
      if (denial === 'leaving') f.page.leaving = true;
      if (denial === 'guard-error') f.state.guardFailure = true;
      pageEvent(f, id, 'onClick'); assert.equal(f.page.snapshot(), previous);
      assert.equal(f.page.dirty, false); assert.equal(f.state.writes, 0); privateSafe(f.page.message);
    });
  }
}
add('actual DNS mode selection is default-off and exact undo leaves a clean draft', () => {
  const f = fixture(); assert.equal(f.page.dnsMode, 'proxy');
  assert.equal(f.page.directDnsUrl, 'https://223.5.5.5/dns-query');
  assert.match(f.page.dnsModeHint(), /默认.*经节点.*未开启/);
  pageEvent(f, 'dnsModeSplit', 'onClick'); assert.equal(f.page.dnsMode, 'split'); assert.equal(f.page.dirty, true);
  assert.match(f.page.dnsModeHint(), /已保留.*不是白名单.*经节点/);
  pageEvent(f, 'dnsModeProxy', 'onClick'); assert.equal(f.page.dnsMode, 'proxy'); assert.equal(f.page.dirty, false);
  assert.equal(f.state.writes, 0);
});
add('split save and reopening retain both DNS URLs, app scope and custom rules', () => {
  const value = appPolicy('include'); value.mode = 'rules'; value.bypassLan = true;
  value.direct = ['domain:direct.example.com']; value.proxy = ['domain:proxy.example.com'];
  value.block = ['full:blocked.example.com']; value.dnsUrl = 'https://dns.example.com/query';
  const f = fixture({ value }); pageEvent(f, 'routingWhitelist', 'onClick'); pageEvent(f, 'dnsModeSplit', 'onClick');
  pageEvent(f, 'directDnsUrl', 'onChange', '  https://1.1.1.1:443/dns-query  '); f.page.save();
  const saved = { ...clone(value), mode: 'whitelist', dnsMode: 'split', directDnsUrl: 'https://1.1.1.1:443/dns-query' };
  assert.equal(f.state.writes, 1); assert.equal(f.page.dirty, false); assert.deepEqual(clone(f.state.value), saved);
  f.page.aboutToDisappear(); f.page.aboutToAppear(); assert.equal(f.page.dnsMode, 'split');
  assert.equal(f.page.directDnsUrl, saved.directDnsUrl); assert.equal(f.page.dnsUrl, saved.dnsUrl);
  assert.match(f.page.dnsModeHint(), /下次连接.*Google.*其余域名经节点/);
  pageEvent(f, 'dnsModeProxy', 'onClick'); f.page.save();
  assert.deepEqual(clone(f.state.value), { ...saved, dnsMode: 'proxy' });
  pageEvent(f, 'dnsModeSplit', 'onClick'); f.page.save(); assert.deepEqual(clone(f.state.value), saved);
});
for (const mode of ['global', 'rules']) {
  add('split preference and direct URL survive inactive ' + mode + ' and restoring whitelist', () => {
    const value = appPolicy(); value.mode = 'whitelist'; value.dnsMode = 'split';
    value.directDnsUrl = 'https://1.1.1.1/dns-query';
    const f = fixture({ value }); f.page.changeRoutingMode(mode); f.page.save();
    assert.deepEqual(clone(f.state.value), { ...clone(value), mode });
    assert.match(f.page.dnsModeHint(), /已保留.*不是白名单.*经节点/);
    f.page.aboutToDisappear(); f.page.aboutToAppear(); assert.equal(f.page.dnsMode, 'split');
    assert.equal(f.page.directDnsUrl, value.directDnsUrl);
    pageEvent(f, 'routingWhitelist', 'onClick'); f.page.save();
    assert.deepEqual(clone(f.state.value), clone(value));
  });
}
for (const [id, field, original, replacement] of [
  ['resetDns', 'dnsUrl', 'https://1.1.1.1/dns-query', 'https://dns.example.com/query'],
  ['resetDirectDns', 'directDnsUrl', 'https://223.5.5.5/dns-query', 'https://1.1.1.1/dns-query']
]) {
  add('actual ' + id + ' resets only its own URL and allows exact undo', () => {
    const value = appPolicy(); value.dnsMode = 'split'; value[field] = replacement;
    const f = fixture({ value }); const other = field === 'dnsUrl' ? 'directDnsUrl' : 'dnsUrl';
    pageEvent(f, id, 'onClick'); assert.equal(f.page[field], original); assert.equal(f.page[other], value[other]);
    assert.equal(f.page.dirty, true); pageEvent(f, id, 'onClick'); assert.equal(f.page.dirty, true);
    pageEvent(f, field, 'onChange', replacement); assert.equal(f.page.dirty, false); assert.equal(f.state.writes, 0);
  });
}
for (const id of ['dnsModeProxy', 'dnsModeSplit', 'resetDns', 'resetDirectDns']) {
  for (const denial of ['connection', 'confirmation', 'leaving', 'guard-error']) {
    add('queued ' + id + ' click cannot mutate a draft during ' + denial, () => {
      const value = appPolicy(); value.dnsMode = id === 'dnsModeProxy' ? 'split' : 'proxy';
      value.dnsUrl = 'https://dns.example.com/query'; value.directDnsUrl = 'https://1.1.1.1/dns-query';
      const f = fixture({ value }); const previous = f.page.snapshot();
      if (denial === 'connection') f.state.allowed = false;
      if (denial === 'confirmation') f.page.confirmingLeave = true;
      if (denial === 'leaving') f.page.leaving = true;
      if (denial === 'guard-error') f.state.guardFailure = true;
      pageEvent(f, id, 'onClick'); assert.equal(f.page.snapshot(), previous);
      assert.equal(f.page.dirty, false); assert.equal(f.state.writes, 0);
    });
  }
}
for (const invalid of ['http://223.5.5.5/dns-query', 'https://dns.example.com/query',
  'https://[2001:db8::1]/dns-query', 'https://user:secret@223.5.5.5/query', 'https://223.5.5.5/query#part',
  'https://127.0.0.1/query', 'https://198.18.0.1/query']) {
  for (const mode of ['proxy', 'split']) add('direct DNS ' + mode + ' rejects ' + invalid + ' without replacing saved preferences', () => {
    const f = fixture(); const previous = clone(f.state.value);
    f.page.changeDnsMode(mode); pageEvent(f, 'directDnsUrl', 'onChange', invalid); f.page.save();
    assert.equal(f.page.directDnsUrl, invalid); assert.equal(f.page.dirty, true); assert.equal(f.state.writes, 0);
    assert.deepEqual(clone(f.state.value), previous); assert.match(f.page.message, /DNS.*(?:地址|格式)/);
    assert(!f.page.message.includes(invalid)); assert(!f.page.message.includes('secret'));
  });
}
add('DNS-only edits participate in leave confirmation and are preserved when discard is declined', async () => {
  const f = fixture(); pageEvent(f, 'dnsModeSplit', 'onClick');
  pageEvent(f, 'directDnsUrl', 'onChange', 'https://1.1.1.1/dns-query'); const previous = f.page.snapshot();
  const pending = f.page.requestBack(); assert.equal(f.state.dialogs.length, 1);
  f.state.dialogs[0].resolve({ index: 0 }); await pending;
  assert.equal(f.page.snapshot(), previous); assert.equal(f.page.dirty, true); assert.equal(f.state.writes, 0);
});
add('switching off split retains an invalid direct URL for correction before save', () => {
  const f = fixture(); const original = clone(f.state.value);
  pageEvent(f, 'dnsModeSplit', 'onClick'); pageEvent(f, 'directDnsUrl', 'onChange', 'https://dns.example.com/query');
  pageEvent(f, 'dnsModeProxy', 'onClick'); f.page.save();
  assert.equal(f.page.dnsMode, 'proxy'); assert.equal(f.page.directDnsUrl, 'https://dns.example.com/query');
  assert.match(f.page.message, /直连 DNS.*IPv4/); assert.equal(f.state.writes, 0);
  assert.deepEqual(clone(f.state.value), original);
  pageEvent(f, 'directDnsUrl', 'onChange', 'https://1.1.1.1/dns-query'); f.page.save();
  assert.equal(f.state.writes, 1); assert.equal(f.state.value.dnsMode, 'proxy');
  assert.equal(f.state.value.directDnsUrl, 'https://1.1.1.1/dns-query'); assert.equal(f.page.dirty, false);
});
for (const [field, value] of [['direct', 'https://invalid.example.com'], ['dnsUrl', 'http://dns.example.com/query']]) {
  add(field + ' validation failure preserves raw draft and old policy', () => {
    const f = fixture(), previous = clone(f.state.value); f.change(field, value); f.page.save();
    assert.equal(f.page[field], value); assert.equal(f.page.dirty, true); assert.equal(f.state.writes, 0);
    assert.deepEqual(clone(f.state.value), previous); assert(f.page.message); privateSafe(f.page.message);
  });
}
add('write failure keeps draft and cannot expose unexpected exception payload', () => {
  const f = fixture(); f.change('direct', changes.direct); f.state.failure = 'write'; f.page.save();
  assert.equal(f.state.writes, 0); assert.equal(f.page.direct, changes.direct); assert.equal(f.page.dirty, true);
  assert.match(f.page.message, /输入已保留/); privateSafe(f.page.message);
});
add('successful commit and failed readback are distinguished without an automatic second write', () => {
  const f = fixture(); f.change('direct', changes.direct); f.state.failure = 'readback'; f.page.save();
  assert.equal(f.state.writes, 1); assert.equal(f.page.direct, changes.direct); assert.equal(f.page.dirty, false);
  assert.match(f.page.message, /保存已提交.*读回未确认/); privateSafe(f.page.message);
  f.page.save(); assert.equal(f.state.writes, 1);
});
add('corrupt initial settings permit explicit replacement by defaults', () => {
  const f = fixture({ failure: 'read' }); assert.equal(f.page.needsRepair, true); assert.equal(f.page.dirty, false);
  privateSafe(f.page.message); f.state.failure = ''; f.page.save();
  assert.equal(f.state.writes, 1); assert.equal(f.page.needsRepair, false); assert.equal(f.page.dirty, false);
});
add('page show refreshes connection permission without overwriting an edited draft', () => {
  const f = fixture(); f.change('direct', changes.direct); const reads = f.state.reads;
  f.state.allowed = false; f.page.onPageShow(); assert.equal(f.page.editable, false);
  f.state.allowed = true; f.page.onPageShow(); assert.equal(f.page.editable, true);
  assert.equal(f.page.direct, changes.direct); assert.equal(f.page.dirty, true); assert.equal(f.state.reads, reads);
});
add('save checks permission again after a connection starts', () => {
  const f = fixture(); f.change('direct', changes.direct); f.state.allowed = false; f.page.save();
  assert.equal(f.state.writes, 0); assert.equal(f.page.direct, changes.direct); assert.equal(f.page.dirty, true);
  assert.equal(f.page.editable, false); assert.match(f.page.message, /先断开/);
});
add('unexpected permission read failure is fail closed and private', () => {
  const f = fixture(); f.change('direct', changes.direct); f.state.guardFailure = true;
  assert.doesNotThrow(() => f.page.save()); assert.equal(f.state.writes, 0); assert.equal(f.page.editable, false); privateSafe(f.page.message);
});
add('declining discard keeps exact draft and duplicate back opens one dialog', async () => {
  const f = fixture(); f.change('direct', changes.direct); const pending = f.page.requestBack();
  await f.page.requestBack(); assert.equal(f.page.onBackPress(), true); assert.equal(f.state.dialogs.length, 1);
  assert(!JSON.stringify(f.state.dialogs[0].options).includes(changes.direct));
  f.state.dialogs[0].resolve({ index: 0 }); await pending;
  assert.equal(f.page.direct, changes.direct); assert.equal(f.page.dirty, true); assert.equal(f.state.backs, 0);
  assert.equal(f.page.confirmingLeave, false);
});
add('accepting discard navigates once without persisting the draft', async () => {
  const f = fixture(); f.change('dnsUrl', changes.dnsUrl); const pending = f.page.requestBack();
  f.state.dialogs[0].resolve({ index: 1 }); await pending; await f.page.requestBack();
  assert.equal(f.state.backs, 1); assert.equal(f.state.writes, 0); assert.equal(f.page.leaving, true);
});
add('system dirty return consumes the platform back action', async () => {
  const f = fixture(); f.change('mode', 'rules'); assert.equal(f.page.onBackPress(), true);
  assert.equal(f.state.dialogs.length, 1); f.state.dialogs[0].resolve({ index: 0 }); await Promise.resolve();
  assert.equal(f.state.backs, 0); assert.equal(f.page.mode, 'rules');
});
for (const failure of ['dialog', 'router']) add(failure + ' failure preserves draft and lets the user retry', async () => {
  const f = fixture(); f.change('direct', changes.direct); const pending = f.page.requestBack();
  if (failure === 'dialog') f.state.dialogs[0].reject(rawError);
  else { f.state.routerFailure = true; f.state.dialogs[0].resolve({ index: 1 }); }
  await pending; assert.equal(f.page.direct, changes.direct); assert.equal(f.page.confirmingLeave, false);
  assert.equal(f.page.leaving, false); assert.equal(f.state.writes, 0); privateSafe(f.page.message);
});
add('confirmation in flight prevents a stale queued save', async () => {
  const f = fixture(); f.change('direct', changes.direct); const pending = f.page.requestBack();
  f.page.save(); assert.equal(f.state.writes, 0); f.state.dialogs[0].resolve({ index: 0 }); await pending;
});
add('old confirmation after destruction cannot navigate a new visit', async () => {
  const f = fixture(); f.change('direct', changes.direct); const old = f.page.requestBack();
  f.page.aboutToDisappear(); f.page.aboutToAppear(); f.change('block', changes.block);
  f.state.dialogs[0].resolve({ index: 1 }); await old;
  assert.equal(f.state.backs, 0); assert.equal(f.page.block, changes.block); assert.equal(f.page.leaving, false);
});
for (const outcome of ['resolve', 'reject']) add('hidden old ' + outcome + ' cannot affect a newer confirmation', async () => {
  const f = fixture(); f.change('direct', changes.direct); const old = f.page.requestBack();
  f.page.onPageHide(); f.page.onPageShow(); f.change('block', changes.block); const fresh = f.page.requestBack();
  if (outcome === 'resolve') f.state.dialogs[0].resolve({ index: 1 }); else f.state.dialogs[0].reject(rawError);
  await old; assert.equal(f.page.confirmingLeave, true); assert.equal(f.state.backs, 0);
  assert.equal(f.page.direct, changes.direct); assert.equal(f.page.block, changes.block); privateSafe(f.page.message);
  f.state.dialogs[1].resolve({ index: 0 }); await fresh; assert.equal(f.page.confirmingLeave, false);
});

const exampleApp = 'com.example.reader';
const presetApp = 'com.tencent.wechat';
function appPolicy(mode = 'exclude', bundles = [exampleApp]) {
  const value = new policy.NetworkPolicy(); value.appMode = mode; value.appBundles = bundles.slice(); return value;
}
async function flushPromises() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function pageEvent(f, id, event, value) {
  const { ast, ids } = parsePage('pages/NetworkSettings.ets'); const origin = ids.get(id); assert(origin, id);
  for (let node = origin.parent; node && !ts.isExpressionStatement(node); node = node.parent) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === event) {
      const result = ts.transpileModule('const callback = ' + node.arguments[0].getText(ast) + '; callback(value);', {
        compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
      assert.equal(result.diagnostics.length, 0); new Function('value', result.outputText).call(f.page, value); return;
    }
  }
  assert.fail('Missing actual ' + id + ' ' + event + ' handler');
}
add('actual package input event marks dirty and exact undo returns clean without altering selection', () => {
  const f = fixture({ value: appPolicy() }); const before = clone(f.state.value);
  pageEvent(f, 'appBundleInput', 'onChange', 'com.example.other'); assert.equal(f.page.dirty, true);
  assert.equal(f.page.appInput, 'com.example.other'); assert.deepEqual(clone(f.page.appBundles), [exampleApp]);
  pageEvent(f, 'appBundleInput', 'onChange', ''); assert.equal(f.page.dirty, false);
  assert.deepEqual(clone(f.state.value), before); assert.equal(f.state.writes, 0);
});
add('actual clear pending package action clears only pending input and recalculates dirty state', () => {
  const f = fixture({ value: appPolicy() }); pageEvent(f, 'appBundleInput', 'onChange', 'com.example.other');
  pageEvent(f, 'clearAppBundleInput', 'onClick'); assert.equal(f.page.appInput, ''); assert.equal(f.page.dirty, false);
  assert.deepEqual(clone(f.page.appBundles), [exampleApp]); assert.equal(f.state.writes, 0);
  f.change('dnsUrl', changes.dnsUrl); pageEvent(f, 'appBundleInput', 'onChange', 'com.example.other');
  pageEvent(f, 'clearAppBundleInput', 'onClick'); assert.equal(f.page.dirty, true); assert.equal(f.page.dnsUrl, changes.dnsUrl);
});
for (const mode of ['all', 'include', 'exclude']) {
  for (const input of ['com.example.other', '  ']) add(mode + ' cannot save while unsubmitted ' + JSON.stringify(input) + ' remains', () => {
    const f = fixture({ value: appPolicy(mode) }); pageEvent(f, 'appBundleInput', 'onChange', input);
    const before = clone(f.state.value); f.page.save(); assert.equal(f.state.writes, 0);
    assert.deepEqual(clone(f.state.value), before); assert.equal(f.page.appInput, input); assert.equal(f.page.dirty, true);
    assert.match(f.page.message, /核对并添加|清空/);
  });
}
add('pending package alone prompts before leaving and declining preserves it exactly', async () => {
  const f = fixture({ value: appPolicy() }); pageEvent(f, 'appBundleInput', 'onChange', '  com.example.other  ');
  assert.equal(f.page.onBackPress(), true); assert.equal(f.state.dialogs.length, 1);
  assert(!JSON.stringify(f.state.dialogs[0].options).includes('com.example.other'));
  f.state.dialogs[0].resolve({ index: 0 }); await flushPromises();
  assert.equal(f.page.appInput, '  com.example.other  '); assert.equal(f.page.dirty, true);
  assert.equal(f.state.backs, 0); assert.equal(f.state.writes, 0);
});
add('confirmed discard and a new visit clear pending input, search and expanded presets', async () => {
  const f = fixture({ value: appPolicy() }); pageEvent(f, 'appBundleInput', 'onChange', 'com.example.other');
  f.page.appSearch = 'other'; f.page.appMessage = 'previous manual input'; f.page.refreshAppChoices();
  const pending = f.page.requestBack(); f.state.dialogs[0].resolve({ index: 1 }); await pending;
  assert.equal(f.state.backs, 1); f.page.aboutToDisappear(); f.page.aboutToAppear();
  assert.equal(f.page.appInput, ''); assert.equal(f.page.appSearch, ''); assert.equal(f.page.appMessage, '');
  assert.equal(f.page.appPickerOpen, false); assert.equal(f.page.dirty, false);
  assert.deepEqual(clone(f.page.appBundles), [exampleApp]); assert.equal(f.state.writes, 0);
});
for (const mode of ['exclude', 'include']) {
  add(mode + ' empty selection cannot replace original policy', () => {
    const f = fixture(); const old = clone(f.state.value); f.page.changeAppMode(mode); f.page.save();
    assert.equal(f.page.appMode, mode); assert.equal(f.page.dirty, true); assert.equal(f.state.writes, 0);
    assert.deepEqual(clone(f.state.value), old); assert.match(f.page.message, /至少选择一个应用/);
  });
  add(mode + ' mode change and exact undo restores clean state', () => {
    const f = fixture(); f.page.changeAppMode(mode); assert.equal(f.page.dirty, true);
    f.page.changeAppMode('all'); assert.equal(f.page.dirty, false); assert.equal(f.state.writes, 0);
  });
  add(mode + ' selection persists with original DNS and rules', () => {
    const value = appPolicy('all'); value.mode = 'rules'; value.bypassLan = true;
    value.direct = ['domain:direct.example.com']; value.proxy = ['domain:proxy.example.com'];
    value.block = ['full:blocked.example.com']; value.dnsUrl = 'https://dns.example.com/query';
    const f = fixture({ value }); f.page.changeAppMode(mode); f.page.save();
    assert.equal(f.state.writes, 1); assert.equal(f.page.dirty, false);
    assert.deepEqual(clone(f.state.value), { ...clone(value), appMode: mode });
  });
  add(mode + ' to all saves retained selection and restoring mode restores same entries', () => {
    const f = fixture({ value: appPolicy(mode, [exampleApp, 'com.example.other']) });
    f.page.changeAppMode('all'); f.page.save(); assert.equal(f.state.writes, 1);
    assert.deepEqual(clone(f.state.value.appBundles), [exampleApp, 'com.example.other']);
    f.page.changeAppMode(mode); f.page.save(); assert.equal(f.state.writes, 2);
    assert.deepEqual(clone(f.state.value.appBundles), [exampleApp, 'com.example.other']);
  });
}
for (const version of [1, 2]) add('legacy schema ' + version + ' loads proxy DNS without writing or discarding existing rules', () => {
  const value = clone(appPolicy()); value.schemaVersion = version; delete value.dnsMode; delete value.directDnsUrl;
  if (version === 1) { delete value.appMode; delete value.appBundles; }
  value.mode = 'rules'; value.direct = ['domain:example.com'];
  const f = fixture({ value }); assert.equal(f.page.appMode, version === 1 ? 'all' : 'exclude');
  assert.deepEqual(clone(f.page.appBundles), version === 1 ? [] : [exampleApp]);
  assert.equal(f.page.dnsMode, 'proxy'); assert.equal(f.page.directDnsUrl, 'https://223.5.5.5/dns-query');
  assert.equal(f.page.direct, 'domain:example.com'); assert.equal(f.page.dirty, false); assert.equal(f.state.writes, 0);
});
add('remove and readd preset restores clean state independently of array order', () => {
  const f = fixture({ value: appPolicy('include', [presetApp, exampleApp]) });
  f.page.toggleApp(presetApp, false); assert.equal(f.page.dirty, true);
  f.page.toggleApp(presetApp, true); assert.equal(f.page.dirty, false);
  assert.equal(f.state.writes, 0); assert.equal(f.page.appBundles.length, 2);
});
add('removing the final entry preserves empty draft but cannot save it', () => {
  const f = fixture({ value: appPolicy() }); f.page.toggleApp(exampleApp, false); f.page.save();
  assert.equal(f.page.appBundles.length, 0); assert.equal(f.page.dirty, true); assert.equal(f.state.writes, 0);
  assert.deepEqual(clone(f.state.value.appBundles), [exampleApp]);
});
add('manual package adds synchronously with exact trimmed identity and states installation is unverified', () => {
  const f = fixture({ value: appPolicy() }); pageEvent(f, 'appBundleInput', 'onChange', '  com.example.Other  ');
  assert.equal(f.page.addAppByBundle(), undefined);
  assert.deepEqual(clone(f.page.appBundles), [exampleApp, 'com.example.Other']);
  assert.equal(f.page.appInput, ''); assert.equal(f.page.dirty, true); assert.equal(f.state.writes, 0);
  assert.match(f.page.appMessage, /安装状态未自动核实/); assert.doesNotMatch(f.page.appMessage, /已检测到|已安装成功/);
  f.page.save(); assert.equal(f.state.writes, 1); assert.equal(f.page.dirty, false);
});
for (const invalid of ['', '微信', 'com.android', 'com..example.app', 'a'.repeat(129), 'com.example.app\nother', 'com.example._app']) {
  add('manual invalid package ' + JSON.stringify(invalid.slice(0, 24)) + ' keeps exact input and original selection', () => {
    const f = fixture({ value: appPolicy() }); pageEvent(f, 'appBundleInput', 'onChange', invalid); f.page.addAppByBundle();
    assert.equal(f.page.appInput, invalid); assert.deepEqual(clone(f.page.appBundles), [exampleApp]);
    assert.equal(f.state.writes, 0); assert.match(f.page.appMessage, /完整的鸿蒙应用包名/);
  });
}
add('manual own bundle is rejected without changing selected apps', () => {
  const f = fixture({ value: appPolicy() }); pageEvent(f, 'appBundleInput', 'onChange', appRouting.OWN_VPN_BUNDLE);
  f.page.addAppByBundle(); assert.deepEqual(clone(f.page.appBundles), [exampleApp]); assert.match(f.page.appMessage, /无需添加/);
});
add('manual duplicate retains one selected entry and the unsubmitted input', () => {
  const f = fixture({ value: appPolicy() }); pageEvent(f, 'appBundleInput', 'onChange', exampleApp); f.page.addAppByBundle();
  assert.equal(f.page.appBundles.length, 1); assert.match(f.page.appMessage, /已经/); assert.equal(f.page.appInput, exampleApp);
});
add('checkbox refuses arbitrary non-preset and own package names', () => {
  const f = fixture({ value: appPolicy() }); f.page.toggleApp('com.example.other', true); f.page.toggleApp(appRouting.OWN_VPN_BUNDLE, true);
  assert.deepEqual(clone(f.page.appBundles), [exampleApp]); assert.equal(f.page.dirty, false);
});
add('preset selection is idempotent and removable without a query', () => {
  const f = fixture({ value: appPolicy() }); f.page.toggleApp(presetApp, true); f.page.toggleApp(presetApp, true);
  assert.equal(f.page.appBundles.length, 2); assert.equal(f.page.dirty, true);
  f.page.toggleApp(presetApp, false); assert.equal(f.page.dirty, false);
});
for (const method of ['manual', 'checkbox']) add(method + ' respects the 255 selected-app limit', () => {
  const bundles = Array.from({ length: 255 }, (_, i) => 'com.example.app' + i);
  const f = fixture({ value: appPolicy('exclude', bundles) });
  if (method === 'manual') { pageEvent(f, 'appBundleInput', 'onChange', exampleApp); f.page.addAppByBundle(); }
  else f.page.toggleApp(presetApp, true);
  assert.deepEqual(clone(f.page.appBundles), bundles); assert.match(f.page.appMessage, /255/); assert.equal(f.state.writes, 0);
});
add('the 255th selected app is accepted and saved', () => {
  const bundles = Array.from({ length: 254 }, (_, i) => 'com.example.app' + i);
  const f = fixture({ value: appPolicy('include', bundles) }); pageEvent(f, 'appBundleInput', 'onChange', exampleApp);
  f.page.addAppByBundle(); f.page.save(); assert.equal(f.state.value.appBundles.length, 255); assert.equal(f.state.writes, 1);
});
add('expanding and collapsing presets is synchronous read-only UI state and never edits saved or pending selection', () => {
  const f = fixture({ value: appPolicy('include', [exampleApp, 'com.example.missing']) });
  const before = clone(f.state.value); const reads = f.state.reads;
  assert.equal(f.page.refreshAppChoices(), undefined); assert.equal(f.page.appPickerOpen, true);
  assert.equal(f.page.visibleAppChoices().length, f.candidates.COMMON_APP_CANDIDATES.length);
  f.page.refreshAppChoices(); assert.equal(f.page.appPickerOpen, false);
  assert.deepEqual(clone(f.page.appBundles), before.appBundles); assert.deepEqual(clone(f.state.value), before);
  assert.equal(f.state.reads, reads); assert.equal(f.state.writes, 0); assert.equal(f.page.dirty, false);
});
add('search filters pure presets by display name and package without including selected entries', () => {
  const f = fixture({ value: appPolicy('exclude', [presetApp]) });
  pageEvent(f, 'appCandidateSearch', 'onChange', ' 微信 '); assert.equal(f.page.visibleAppChoices().length, 0);
  pageEvent(f, 'appCandidateSearch', 'onChange', ' 抖音 '); assert.equal(f.page.visibleAppChoices()[0].bundleName, 'com.ss.hm.ugc.aweme');
  pageEvent(f, 'appCandidateSearch', 'onChange', 'COM.JD.HM.MALL'); assert.equal(f.page.visibleAppChoices()[0].name, '京东');
  pageEvent(f, 'appCandidateSearch', 'onChange', ''); assert.equal(f.page.visibleAppChoices().length, f.candidates.COMMON_APP_CANDIDATES.length - 1);
  assert.equal(f.page.dirty, false); assert.equal(f.state.writes, 0);
});
add('stored custom packages remain visible by package identity rather than receiving guessed labels', () => {
  const f = fixture({ value: appPolicy() }); assert.equal(f.page.appName(exampleApp), exampleApp);
  assert.equal(f.page.appName(presetApp), '微信'); assert.deepEqual(clone(f.page.appBundles), [exampleApp]);
});
for (const method of ['refreshAppChoices', 'addAppByBundle']) {
  for (const denial of ['all', 'connection', 'confirmation', 'leaving', 'guard-error']) {
    add(method + ' is blocked before any edit during ' + denial, () => {
      const f = fixture({ value: appPolicy() }); pageEvent(f, 'appBundleInput', 'onChange', 'com.example.other');
      if (denial === 'all') f.page.appMode = 'all';
      if (denial === 'connection') f.state.allowed = false;
      if (denial === 'confirmation') f.page.confirmingLeave = true;
      if (denial === 'leaving') f.page.leaving = true;
      if (denial === 'guard-error') f.state.guardFailure = true;
      f.page[method](); assert.deepEqual(clone(f.page.appBundles), [exampleApp]); assert.equal(f.page.appPickerOpen, false);
      assert.equal(f.page.appInput, 'com.example.other'); assert.equal(f.state.writes, 0);
    });
  }
}
add('an expanded preset list cannot bypass a subsequent connection-state change', () => {
  const f = fixture({ value: appPolicy() }); f.page.refreshAppChoices(); f.state.allowed = false;
  f.page.toggleApp(presetApp, true); f.page.toggleApp(exampleApp, false); f.page.changeAppMode('include');
  f.change('dnsUrl', changes.dnsUrl); f.page.save();
  assert.equal(f.page.appMode, 'exclude'); assert.deepEqual(clone(f.page.appBundles), [exampleApp]);
  assert.equal(f.page.editable, false); assert.equal(f.state.writes, 0);
});

add('programmatic input clearing echo preserves manual-add feedback and selection', () => {
  const f = fixture({ value: appPolicy() });
  pageEvent(f, 'appBundleInput', 'onChange', 'com.example.other');
  f.page.addAppByBundle();
  const feedback = f.page.appMessage, selected = clone(f.page.appBundles);
  assert.match(feedback, /安装状态未自动核实/);
  pageEvent(f, 'appBundleInput', 'onChange', '');
  assert.equal(f.page.appMessage, feedback);
  assert.deepEqual(clone(f.page.appBundles), selected);
  assert.equal(f.page.dirty, true); assert.equal(f.state.writes, 0);
});
add('a genuinely new package input clears prior add feedback and keeps the new draft', () => {
  const f = fixture({ value: appPolicy() });
  pageEvent(f, 'appBundleInput', 'onChange', 'com.example.other');
  f.page.addAppByBundle(); assert.match(f.page.appMessage, /安装状态未自动核实/);
  pageEvent(f, 'appBundleInput', 'onChange', 'com.example.third');
  assert.equal(f.page.appInput, 'com.example.third'); assert.equal(f.page.appMessage, '');
  assert.deepEqual(clone(f.page.appBundles), [exampleApp, 'com.example.other']);
  f.page.save(); assert.equal(f.state.writes, 0); assert.match(f.page.message, /核对并添加|清空/);
});

function parsePage(relative) {
  const text = fs.readFileSync(path.join(root, 'entry/src/main/ets', relative), 'utf8');
  sourceHashes[relative] = crypto.createHash('sha256').update(text).digest('hex');
  const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS, parserOptions);
  assert.equal(ast.parseDiagnostics.length, 0, relative);
  const ids = new Map(), dynamicIds = new Map();
  function walk(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'id' &&
      ts.isStringLiteral(node.arguments[0])) { assert(!ids.has(node.arguments[0].text), 'Repeated ID'); ids.set(node.arguments[0].text, node); }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'id' &&
      ts.isBinaryExpression(node.arguments[0]) && ts.isStringLiteral(node.arguments[0].left)) {
      const prefix = node.arguments[0].left.text; assert(!dynamicIds.has(prefix), 'Repeated dynamic ID'); dynamicIds.set(prefix, node);
    }
    ts.forEachChild(node, walk);
  }
  walk(ast); return { ast, ids, dynamicIds };
}
function enabledBinding(idNode, ast) {
  for (let node = idNode.parent; node && !ts.isExpressionStatement(node); node = node.parent) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'enabled') {
      return new Function('return ' + node.arguments[0].getText(ast));
    }
  }
  assert.fail('Missing enabled guard');
}
add('actual NetworkSettings controls freeze during confirmation and footer stays outside scroll', () => {
  const { ast, ids } = parsePage('pages/NetworkSettings.ets');
  const state = { editable: true, dirty: true, needsRepair: false, confirmingLeave: false, leaving: false };
  for (const id of ['routingGlobal', 'routingWhitelist', 'routingRules', 'bypassLan', 'routingDirect', 'routingProxy', 'routingBlock',
    'dnsModeProxy', 'dnsModeSplit', 'dnsUrl', 'resetDns', 'directDnsUrl', 'resetDirectDns', 'saveNetworkSettings']) {
    const enabled = enabledBinding(ids.get(id), ast); assert.equal(enabled.call(state), true, id);
    for (const denied of [{ confirmingLeave: true }, { leaving: true }, { editable: false }]) assert.equal(enabled.call({ ...state, ...denied }), false, id);
  }
  const saveEnabled = enabledBinding(ids.get('saveNetworkSettings'), ast);
  assert.equal(saveEnabled.call({ ...state, dirty: false }), false);
  assert.equal(saveEnabled.call({ ...state, dirty: false, needsRepair: true }), true);
  const parents = node => { const result = []; for (let p = node.parent; p; p = p.parent) if (ts.isEtsComponentExpression(p)) result.push(p); return result; };
  const saveParents = parents(ids.get('saveNetworkSettings')), messageParents = parents(ids.get('networkSettingsResult'));
  assert.equal(saveParents[0], messageParents[0]); assert(saveParents.every(node => node.expression.getText(ast) !== 'Scroll'));
  assert(ids.has('networkSettingsDirtyState')); assert(ids.has('backFromNetworkSettings'));
});
add('actual routing controls show fixed whitelist guidance without custom list or LAN override', () => {
  const { ast, ids } = parsePage('pages/NetworkSettings.ets');
  function visible(id, mode) {
    assert(ids.has(id), id);
    for (let node = ids.get(id).parent; node; node = node.parent) {
      if (ts.isIfStatement(node) && !new Function('return ' + node.expression.getText(ast)).call({ mode })) return false;
    }
    return true;
  }
  for (const mode of ['global', 'whitelist', 'rules']) {
    assert.equal(visible('routingGlobalHint', mode), mode === 'global');
    assert.equal(visible('routingWhitelistHint', mode), mode === 'whitelist');
    for (const id of ['bypassLan', 'routingDirect', 'routingProxy', 'routingBlock']) {
      assert.equal(visible(id, mode), mode === 'rules', id + ' ' + mode);
    }
    assert.equal(visible('dnsUrl', mode), true, 'Existing HTTPS DNS remains shared');
  }
});
add('actual DNS controls expose split or customized direct URLs in every routing mode for correction', () => {
  const { ast, ids } = parsePage('pages/NetworkSettings.ets');
  function visible(id, mode, dnsMode, directDnsUrl) {
    assert(ids.has(id), id);
    for (let node = ids.get(id).parent; node; node = node.parent) {
      if (ts.isIfStatement(node) && !new Function('return ' + node.expression.getText(ast)).call({ mode, dnsMode, directDnsUrl })) return false;
    }
    return true;
  }
  for (const mode of ['global', 'whitelist', 'rules']) for (const dnsMode of ['proxy', 'split']) {
    for (const directDnsUrl of ['https://223.5.5.5/dns-query', 'https://1.1.1.1/dns-query', 'https://invalid.example.com/query']) {
      const showsDirect = dnsMode === 'split' || directDnsUrl !== 'https://223.5.5.5/dns-query';
      for (const id of ['dnsModeProxy', 'dnsModeSplit', 'dnsModeHint', 'dnsUrl', 'resetDns']) {
        assert.equal(visible(id, mode, dnsMode, directDnsUrl), true, id + ' ' + mode + ' ' + dnsMode);
      }
      for (const id of ['directDnsUrl', 'resetDirectDns', 'directDnsHint', 'dnsSplitFailureHint']) {
        assert.equal(visible(id, mode, dnsMode, directDnsUrl), showsDirect, id + ' ' + mode + ' ' + dnsMode);
      }
      assert.equal(visible('directDnsInactiveHint', mode, dnsMode, directDnsUrl),
        showsDirect && (mode !== 'whitelist' || dnsMode !== 'split'));
    }
  }
});
add('actual app controls block mutations during connection, confirmation or navigation', () => {
  const { ast, ids, dynamicIds } = parsePage('pages/NetworkSettings.ets');
  const state = { editable: true, dirty: true, needsRepair: false, confirmingLeave: false, leaving: false,
    appInput: 'com.example.reader' };
  const nodes = ['networkAppAll', 'networkAppExclude', 'networkAppInclude', 'refreshAppCandidates', 'appBundleInput',
    'addAppBundle', 'clearAppBundleInput', 'saveNetworkSettings'].map(id => [id, ids.get(id)]);
  nodes.push(['removeApp-', dynamicIds.get('removeApp-')], ['selectApp-', dynamicIds.get('selectApp-')]);
  for (const [id, node] of nodes) {
    assert(node, id); const enabled = enabledBinding(node, ast); assert.equal(enabled.call(state), true, id);
    for (const denied of [{ confirmingLeave: true }, { leaving: true }, { editable: false }]) {
      assert.equal(enabled.call({ ...state, ...denied }), false, id + JSON.stringify(denied));
    }
  }
  assert.equal(enabledBinding(ids.get('addAppBundle'), ast).call({ ...state, appInput: '  ' }), false);
  const search = enabledBinding(ids.get('appCandidateSearch'), ast);
  assert.equal(search.call({ ...state, editable: false }), true, 'Read-only search stays usable while connected');
  for (const denied of [{ confirmingLeave: true }, { leaving: true }]) {
    assert.equal(search.call({ ...state, ...denied }), false);
  }
  for (const id of ['networkAppScopeHint', 'networkAppSelectedCount', 'networkAppEmptyHint', 'appCandidatesResult']) assert(ids.has(id), id);
  let insideNonAllBlock = false;
  for (let node = ids.get('clearAppBundleInput').parent; node; node = node.parent) {
    if (ts.isIfStatement(node) && node.expression.getText(ast).includes("this.appMode !== 'all'")) insideNonAllBlock = true;
  }
  assert.equal(insideNonAllBlock, false, 'Pending input can be cleared even after switching to all apps');
});
add('actual NodeConfig mutation controls freeze during confirmation without disabling draft typing merely for connectivity', () => {
  const { ast, ids } = parsePage('pages/NodeConfig.ets');
  const state = { editable: true, confirmingLeave: false, leaving: false, scanning: false, input: 'synthetic-input', replacementAddress: 'changed.invalid' };
  for (const id of ['saveNode', 'confirmPartialImport', 'updateNodeHost', 'nodeInput', 'nodeHostInput']) {
    const enabled = enabledBinding(ids.get(id), ast); assert.equal(enabled.call(state), true, id);
    for (const denied of [{ confirmingLeave: true }, { leaving: true }, { scanning: true }]) assert.equal(enabled.call({ ...state, ...denied }), false, id);
  }
  assert.equal(enabledBinding(ids.get('nodeInput'), ast).call({ ...state, editable: false }), true);
  assert.equal(enabledBinding(ids.get('saveNode'), ast).call({ ...state, editable: false }), false);
});
(async () => {
  const passed = [], failed = [];
  for (const item of cases) {
    try { await item.run(); passed.push(item.name); }
    catch (error) { failed.push({ name: item.name, message: error.message }); }
  }
  const bindingNames = cases.filter(item => item.name.startsWith('actual ') && item.name.includes('controls')).map(item => item.name);
  const record = { generatedAt: new Date().toISOString(), passed: passed.length, failed: failed.length, sourceHashes,
    testFileSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    namedCaseCount: cases.length, arkUiBindingCaseCount: bindingNames.length,
    scope: 'Actual NetworkSettings methods/events, AppRouting, NetworkPolicy and pure AppCandidates presets without installed-app SDK APIs; synthetic in-memory store/dialogs; ArkUI AST guards separately identified; no device/network/native build.',
    arkUiBindingCases: bindingNames, tests: passed, failures: failed };
  const output = path.join(root, 'build/network-settings-form-verification.json'); fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ passed: passed.length, failed: failed.length, failures: failed, record: output }));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
