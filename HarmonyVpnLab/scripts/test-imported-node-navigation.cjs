'use strict';
// Execute authored import-page methods and route validation with synthetic
// in-memory catalogs. No private files, device, network, or native core is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const sourceHashes = {};
function compile(relative, page = false) {
  const source = fs.readFileSync(path.join(root, 'entry/src/main/ets', relative), 'utf8');
  sourceHashes[relative] = crypto.createHash('sha256').update(source).digest('hex');
  let text = source;
  if (page) {
    const boundary = text.indexOf('\n  build() {'); assert(boundary > 0);
    text = text.slice(0, boundary) + '\n}\n';
    text = text.replace(/^@Entry\s*$/gm, '').replace(/^@Component\s*$/gm, '')
      .replace(/^(\s*)@State /gm, '$1').replace(/@StorageProp\([^)]*\)\s*/g, '')
      .replace(/^struct (\w+) \{/m, 'export class $1 {');
  }
  const result = ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS
  }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0);
  return result.outputText;
}
function execute(source, imports, extra = {}) {
  const scope = { exports: {}, Error, Promise, Array, Set, ...extra,
    require(name) { assert(Object.hasOwn(imports, name), 'Unexpected dependency: ' + name); return imports[name]; } };
  vm.runInNewContext(source, scope); return scope.exports;
}
const navigation = execute(compile('model/NodeListNavigation.ets'), {});
const pageCode = compile('pages/NodeConfig.ets', true);
const UUID = '00000000-0000-4000-8000-000000000001';
const makeParams = (ids = ['node-old'], requestId = UUID) => new navigation.ImportedNodesNavigation(ids, requestId);
const clone = value => JSON.parse(JSON.stringify(value));
const first = { name: 'Synthetic first', protocol: 'vless', outboundJson: '{"synthetic":"first"}' };
const second = { name: 'Synthetic second', protocol: 'trojan', outboundJson: '{"synthetic":"second"}' };
const secret = 'synthetic-private-content-never-in-navigation';
function fixture(options = {}) {
  const state = { nodes: [{ ...first, id: 'node-old' }], activeNodeId: 'node-old', writes: 0, reads: 0,
    profileReads: 0, receipts: 0, calls: [], dialogs: [], backs: 0, scans: [], mode: '', allowed: true, scannerSupported: true };
  function parseNodeBatch(input) {
    if (input === 'first') return { nodes: [first], rejected: 0, duplicates: 0 };
    if (input === 'second') return { nodes: [second], rejected: 0, duplicates: 0 };
    if (input === 'mixed') return { nodes: [first, second], rejected: 0, duplicates: 0 };
    if (input === 'partial') return { nodes: [second], rejected: 1, duplicates: 0 };
    throw new Error(secret);
  }
  const modules = {
    '@kit.AbilityKit': {}, '@kit.BasicServicesKit': {},
    '@kit.ArkUI': { router: { RouterMode: { Single: 1 } } },
    '@kit.PerformanceAnalysisKit': { hilog: { info() {} } },
    '@kit.ArkTS': { util: { generateRandomUUID() {
      assert(state.writes > 0); assert(state.reads > 0); assert(state.profileReads > 0);
      return '00000000-0000-4000-8000-' + String(++state.receipts).padStart(12, '0');
    } } },
    '../model/AdaptiveLayout': {}, '../model/NodeListNavigation': navigation,
    '../model/NodeBatchImport': { parseNodeBatch },
    '../model/NodeEditGuard': { isNodeManagementAllowed: () => state.allowed, assertNodeManagementAllowed() {
      if (!state.allowed) throw new Error(secret);
    } },
    '../model/NodeCatalog': {
      importManualNodes(_, nodes) {
        if (state.mode === 'write-fail') throw new Error(secret);
        let added = 0, duplicates = 0;
        for (const node of nodes) {
          if (state.nodes.some(saved => saved.outboundJson === node.outboundJson)) { duplicates++; }
          else { state.nodes.push({ ...node, id: 'node-' + state.nodes.length }); added++; }
        }
        state.writes++; return { added, duplicates, activeNodeId: state.activeNodeId };
      },
      readNodeCatalog() {
        state.reads++;
        if (state.mode === 'read-fail') throw new Error(secret);
        return { nodes: clone(state.mode === 'missing' ? state.nodes.slice(0, -1) : state.nodes) };
      }
    },
    '../model/NodeProfile': {
      readNodeProfile() { state.profileReads++; if (state.mode === 'profile-fail') throw new Error(secret); return clone(first); },
      nodeServerAddress: () => 'example.invalid', updateNodeServerAddress() { throw new Error(secret); }
    },
    '../model/NodeScanner': { scanNodeCode() { return new Promise((resolve, reject) => state.scans.push({ resolve, reject })); } }
  };
  const Page = execute(pageCode, modules, { $r: name => name, canIUse: () => state.scannerSupported }).NodeConfig;
  const page = new Page();
  page.getUIContext = () => ({
    getHostContext: () => ({ filesDir: 'synthetic-memory-only' }),
    getRouter: () => ({
      back() { state.backs++; },
      replaceUrl(params, mode) {
        const call = { params: clone(params), mode }; state.calls.push(call);
        if (options.routeDeferred) return new Promise((resolve, reject) => Object.assign(call, { resolve, reject }));
        if (state.mode === 'route-fail') return Promise.reject(new Error(secret));
        return Promise.resolve();
      }
    }),
    getPromptAction: () => ({ showDialog(params) {
      const dialog = { params }; state.dialogs.push(dialog);
      return new Promise((resolve, reject) => Object.assign(dialog, { resolve, reject }));
    } })
  });
  return { page, state, save(input = 'second') { page.changeInput(input); page.save(); } };
}
const cases = [];
const test = (name, run) => cases.push({ name, run });
const ids = params => Array.from(navigation.readImportedNodeIds(params));
const request = params => navigation.readImportedNavigationRequestId(params);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test('valid route returns an independent bounded ID array and its same request UUID', () => {
  const original = ['node-a', 'node-b'], params = makeParams(original); original.push('node-later');
  assert.deepEqual(ids(params), ['node-a', 'node-b']); assert.equal(request(params), UUID);
  const read = navigation.readImportedNodeIds(params); read.push('node-other'); assert.equal(params.importedNodeIds.length, 2);
  const maximum = makeParams(Array.from({ length: 500 }, (_, i) => 'node-' + i)); assert.equal(ids(maximum).length, 500);
  assert.equal(ids(makeParams(['x'.repeat(96)])).length, 1);
});
for (const [name, params] of [
  ['absent', undefined], ['null', null], ['array', []], ['primitive', 'node-old'],
  ['no UUID', { importedNodeIds: ['node-old'] }], ['no IDs', { requestId: UUID }],
  ['empty IDs', makeParams([])], ['duplicate IDs', makeParams(['node-old', 'node-old'])],
  ['oversize IDs', makeParams(Array.from({ length: 501 }, (_, i) => 'node-' + i))],
  ['non-array IDs', { importedNodeIds: 'node-old', requestId: UUID }],
  ['empty ID', makeParams([''])], ['oversize ID', makeParams(['x'.repeat(97)])],
  ['foreign content', makeParams(['vless://synthetic@example.invalid'])], ['numeric ID', makeParams([5])],
  ['sparse IDs', { importedNodeIds: new Array(1), requestId: UUID }],
  ['invalid UUID', makeParams(['node-old'], secret)], ['extra property', { ...makeParams(), outboundJson: secret }]
]) test('invalid route rejects both reads: ' + name, () => { assert.deepEqual(ids(params), []); assert.equal(request(params), ''); });

test('old catalog and lifecycle appearance never create an import navigation receipt', () => {
  const f = fixture(); f.page.importedNodeIds = ['old']; f.page.importedRequestId = UUID; f.page.aboutToAppear();
  assert.equal(f.page.importedNodeIds.length, 0); assert.equal(f.page.importedRequestId, ''); assert.equal(f.state.receipts, 0);
});
test('confirmed mixed import exposes new and existing IDs without selecting or connecting', async () => {
  const f = fixture(); f.save('mixed'); assert.deepEqual(Array.from(f.page.importedNodeIds), ['node-old', 'node-1']);
  assert.equal(f.page.importedRequestId, UUID); assert.equal(f.page.saveReceipt, '保存回执：' + UUID);
  assert.equal(f.state.activeNodeId, 'node-old'); await f.page.viewImportedNodes();
  assert.deepEqual(f.state.calls, [{ params: { url: 'pages/Nodes', params: { importedNodeIds: ['node-old', 'node-1'], requestId: UUID } }, mode: 1 }]);
  assert.equal(f.state.writes, 1); assert(!JSON.stringify(f.state.calls).includes('outboundJson'));
});
test('duplicate-only import still has matching IDs and a fresh navigation request each time', () => {
  const f = fixture(); f.save('first'); const old = f.page.importedRequestId;
  assert.deepEqual(Array.from(f.page.importedNodeIds), ['node-old']); f.save('first');
  assert.deepEqual(Array.from(f.page.importedNodeIds), ['node-old']); assert.notEqual(f.page.importedRequestId, old);
  assert.equal(f.state.nodes.length, 1); assert.equal(f.state.activeNodeId, 'node-old');
});
for (const mode of ['write-fail', 'read-fail', 'missing', 'profile-fail']) {
  test('failed save clears earlier navigation and retains input: ' + mode, async () => {
    const f = fixture(); f.save('first'); f.state.mode = mode; f.save('second');
    assert.equal(f.page.importedNodeIds.length, 0); assert.equal(f.page.importedRequestId, '');
    assert.equal(f.page.input, 'second'); assert(!f.page.message.includes(secret)); await f.page.viewImportedNodes();
    assert.equal(f.state.calls.length, 0);
  });
}
test('partial import exposes no old navigation until valid content is explicitly saved and read back', () => {
  const f = fixture(); f.save('first'); f.save('partial'); assert.equal(f.page.importedNodeIds.length, 0);
  assert.equal(f.page.partialCount, 1); f.page.savePartial(); assert.deepEqual(Array.from(f.page.importedNodeIds), ['node-1']);
  assert.equal(f.page.input, ''); assert.equal(f.page.partialCount, 0);
});
test('parse failure and blocked save cannot retain a stale successful route', () => {
  const f = fixture(); f.save('first'); f.save('invalid'); assert.equal(f.page.importedNodeIds.length, 0);
  f.save('first'); f.state.allowed = false; f.save('second'); assert.equal(f.page.importedNodeIds.length, 0);
});
test('genuine input editing clears success while a programmatic same-empty update preserves it', () => {
  const f = fixture(); f.save(); f.page.changeInput(''); assert.equal(f.page.importedNodeIds.length, 1);
  f.page.changeInput('first'); assert.equal(f.page.importedNodeIds.length, 0);
  f.page.changeInput(''); assert.equal(f.page.importedNodeIds.length, 0);
});
test('server draft change or an attempted server update invalidates earlier import navigation', () => {
  const f = fixture(); f.save(); f.page.changeReplacementAddress('changed.invalid'); assert.equal(f.page.importedNodeIds.length, 0);
  f.page.changeReplacementAddress(''); f.save(); f.page.replacementAddress = 'changed.invalid'; f.page.updateAddress();
  assert.equal(f.page.importedNodeIds.length, 0); assert(!f.page.message.includes(secret));
});
test('unsupported or cancelled new scanning cannot keep an earlier import result', async () => {
  const f = fixture(); f.save(); f.state.scannerSupported = false; await f.page.scan(); assert.equal(f.page.importedNodeIds.length, 0);
  f.state.scannerSupported = true; f.save(); const scan = f.page.scan(); await flush();
  assert.equal(f.page.importedNodeIds.length, 0); f.state.scans[0].reject(new Error(secret)); await scan;
  assert.equal(f.page.importedNodeIds.length, 0);
});
test('a completed scan is only input and a late abandoned scan cannot resurrect navigation', async () => {
  const f = fixture(); f.save(); const firstScan = f.page.scan(); await flush(); f.state.scans[0].resolve('first'); await firstScan;
  assert.equal(f.page.input, 'first'); assert.equal(f.page.importedNodeIds.length, 0);
  f.page.changeInput(''); const lateScan = f.page.scan(); await flush(); f.page.aboutToDisappear();
  f.state.scans[1].resolve('second'); await lateScan; assert.equal(f.page.input, ''); assert.equal(f.page.importedNodeIds.length, 0);
});
test('view cannot bypass an unsaved server draft or its return confirmation', async () => {
  const f = fixture(); f.page.changeReplacementAddress('changed.invalid'); f.save(); await f.page.viewImportedNodes();
  assert.equal(f.state.calls.length, 0); const back = f.page.requestBack(); await f.page.viewImportedNodes();
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.dialogs.length, 1);
  f.state.dialogs[0].resolve({ index: 0 }); await back; assert.equal(f.state.backs, 0);
});
test('pending navigation is single-flight and cannot change the saved catalog', async () => {
  const f = fixture({ routeDeferred: true }); f.save(); const pending = f.page.viewImportedNodes();
  await f.page.viewImportedNodes(); f.page.save(); assert.equal(f.state.calls.length, 1); assert.equal(f.state.writes, 1);
  assert.equal(f.page.onBackPress(), true); f.state.calls[0].resolve(); await pending;
});
test('routing failure is safe and retryable without a second save', async () => {
  const f = fixture(); f.save(); f.state.mode = 'route-fail'; await f.page.viewImportedNodes();
  assert.equal(f.page.leaving, false); assert.equal(f.page.importedNodeIds.length, 1); assert(!f.page.message.includes(secret));
  f.state.mode = ''; await f.page.viewImportedNodes(); assert.equal(f.state.calls.length, 2); assert.equal(f.state.writes, 1);
});
test('late route failure after hide cannot overwrite a later save or strand the visible page', async () => {
  const f = fixture({ routeDeferred: true }); f.save(); const old = f.page.viewImportedNodes();
  f.page.onPageHide(); f.page.onPageShow(); assert.equal(f.page.leaving, false); f.save('first');
  const message = f.page.message, receipt = f.page.saveReceipt;
  f.state.calls[0].reject(new Error(secret)); await old;
  assert.equal(f.page.message, message); assert.equal(f.page.saveReceipt, receipt); assert.equal(f.page.leaving, false);
});
test('leaving clears both navigation components and invalid internal IDs cannot be routed', async () => {
  const f = fixture(); f.save(); f.page.importedNodeIds = ['invalid/id']; await f.page.viewImportedNodes();
  assert.equal(f.state.calls.length, 0); assert.equal(f.page.importedNodeIds.length, 0); assert.equal(f.page.importedRequestId, '');
  f.save(); f.page.aboutToDisappear(); assert.equal(f.page.importedNodeIds.length, 0); assert.equal(f.page.importedRequestId, '');
});
(async () => {
  const passed = [], failures = [];
  for (const item of cases) {
    try { await item.run(); passed.push(item.name); }
    catch (error) { failures.push({ name: item.name, error: error.message }); }
  }
  const record = { generatedAt: new Date().toISOString(), passed: passed.length, failed: failures.length,
    sourceHashes, tests: passed, failures,
    scope: 'Actual page methods and route validators with synthetic catalog, scanner and router mocks; no private data, real SDK UI, device, network or native core.' };
  const output = path.join(root, 'build/imported-node-navigation-verification.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ passed: passed.length, failed: failures.length, failures, record: output }));
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
