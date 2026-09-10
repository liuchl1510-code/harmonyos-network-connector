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
const policy = load('model/NetworkPolicy.ets', { './NodeBootstrap': bootstrap });
const clone = value => JSON.parse(JSON.stringify(value));
const rawError = new Error('synthetic-private-path synthetic-private-token');
function fixture(options = {}) {
  const state = { value: new policy.NetworkPolicy(), writes: 0, reads: 0, allowed: true,
    failure: options.failure || '', dialogs: [], backs: 0, routerFailure: false, guardFailure: false };
  const api = load('pages/NetworkSettings.ets', {
    '@kit.AbilityKit': {}, '../model/NetworkPolicy': policy,
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
  return { state, page, change(field, value) { page[field] = value; page.draftChanged(); } };
}
function privateSafe(value) { assert(!JSON.stringify(value).includes('synthetic-private')); }
const cases = [], add = (name, run) => cases.push({ name, run });
const changes = { mode: 'rules', bypassLan: true, direct: 'direct.example.com', proxy: 'proxy.example.com',
  block: 'full:blocked.example.com', dnsUrl: 'https://dns.example.com/dns-query' };
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
function parsePage(relative) {
  const text = fs.readFileSync(path.join(root, 'entry/src/main/ets', relative), 'utf8');
  const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.ETS, parserOptions);
  assert.equal(ast.parseDiagnostics.length, 0, relative);
  const ids = new Map();
  function walk(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'id' &&
      ts.isStringLiteral(node.arguments[0])) { assert(!ids.has(node.arguments[0].text), 'Repeated ID'); ids.set(node.arguments[0].text, node); }
    ts.forEachChild(node, walk);
  }
  walk(ast); return { ast, ids };
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
  for (const id of ['routingGlobal', 'routingRules', 'bypassLan', 'routingDirect', 'routingProxy', 'routingBlock', 'dnsUrl', 'resetDns', 'saveNetworkSettings']) {
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
  const record = { generatedAt: new Date().toISOString(), passed: passed.length, failed: failed.length, sourceHashes,
    scope: 'Actual page methods, policy validation and ArkUI bindings; synthetic in-memory store/dialogs; no device/network/native build.', tests: passed, failures: failed };
  const output = path.join(root, 'build/network-settings-form-verification.json'); fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ passed: passed.length, failed: failed.length, failures: failed, record: output }));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
