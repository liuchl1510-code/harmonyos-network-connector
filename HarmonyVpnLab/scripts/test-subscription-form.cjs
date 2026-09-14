'use strict';
// Real Subscriptions page methods with in-memory catalog, parser/fetch, router
// and native-dialog adapters. No build, device, HTTP, real files or report writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'entry/src/main/ets/pages/Subscriptions.ets'), 'utf8');
const methods = source.split('  build() {')[0].replace(/^@Entry\s*$/gm, '').replace(/^@Component\s*$/gm, '')
  .replace(/@State\s*/g, '').replace(/@StorageProp\([^)]*\)\s*/g, '')
  .replace('struct Subscriptions', 'export class Subscriptions') + '\n}';
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const compiled = ts.transpileModule(methods, { compilerOptions: {
  target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics.length, 0, 'SDK transpilation');
const nodeIssues = require('./node-import-loader.cjs').loadNodeImporter().issues;
const URL_FIXTURE = 'https://subscription.invalid/list?token=synthetic-only';
const RAW_ERROR = Error('synthetic-private-uri-and-credential');
const FIXED_FETCH_ERROR = '订阅请求失败，请检查网络或订阅服务';
const SOURCE_CHANGED = '订阅已发生变化，请重新获取。';
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const state = {
    catalog: { revision: 1, activeNodeId: 'manual', subscriptions: [],
      nodes: [{ id: 'manual', name: 'Manual', protocol: 'vless', sourceId: '', outboundJson: 'synthetic-manual' }] },
    nodes: [{ name: 'Imported', protocol: 'trojan', outboundJson: 'synthetic-node' }],
    fetches: [], dialogs: [], writes: [], logs: [], backs: 0, reads: 0, allowed: true,
    readFailure: false, failReadAfterSave: false, failReadAfterDelete: false,
    normalizeError: undefined, parseError: undefined, saveError: undefined,
    fetchError: undefined, dialogError: undefined, backError: undefined, logError: undefined
  };
  function allowed() { if (!state.allowed) throw Error('请先断开连接并等待清理完成，再修改节点。'); }
  const catalog = {
    readNodeCatalog() { state.reads++; if (state.readFailure) throw RAW_ERROR; return clone(state.catalog); },
    saveSubscriptionWithNodes(_, id, name, url, nodes) {
      allowed(); if (state.saveError) throw state.saveError;
      const target = id || 'added-source';
      let current = state.catalog.subscriptions.find(item => item.id === target);
      if (!current) { current = { id: target }; state.catalog.subscriptions.push(current); }
      Object.assign(current, { name, url, lastUpdatedAt: 10 });
      state.catalog.nodes = state.catalog.nodes.filter(node => node.sourceId !== target)
        .concat(nodes.map((node, index) => ({ ...clone(node), id: 'imported-' + index, sourceId: target })));
      state.catalog.revision++; state.writes.push('save');
      if (state.failReadAfterSave) state.readFailure = true;
      return { added: nodes.length, duplicates: 0 };
    },
    deleteSubscription(_, id) {
      allowed(); state.catalog.subscriptions = state.catalog.subscriptions.filter(item => item.id !== id);
      state.catalog.nodes = state.catalog.nodes.filter(node => node.sourceId !== id);
      state.catalog.revision++; state.writes.push('delete');
      if (state.failReadAfterDelete) state.readFailure = true;
    }
  };
  const imports = {
    '../model/NodeIssue': nodeIssues,
    '../model/NodeCatalog': catalog,
    '../model/NodeEditGuard': { assertNodeManagementAllowed: allowed, isNodeManagementAllowed: () => state.allowed },
    '../model/NodeBatchImport': { parseNodeBatch() {
      if (state.parseError) throw state.parseError;
      return { nodes: clone(state.nodes), duplicates: 0, rejected: 0 };
    } },
    '../model/SubscriptionFetch': {
      normalizeSubscriptionUrl(value) { if (state.normalizeError) throw state.normalizeError; return value.trim(); },
      fetchSubscription() {
        if (state.fetchError) throw state.fetchError;
        const request = deferred(); state.fetches.push(request); return request.promise;
      }
    },
    '@kit.PerformanceAnalysisKit': { hilog: { info() { if (state.logError) throw state.logError; state.logs.push('saved'); } } }
  };
  const exports = {};
  vm.runInNewContext(compiled.outputText, { exports, Error, $r: value => value,
    require(name) { assert(Object.hasOwn(imports, name), name); return imports[name]; } });
  const page = new exports.Subscriptions();
  page.getUIContext = () => ({ getHostContext: () => ({ filesDir: 'synthetic-memory-only' }),
    getRouter: () => ({ back() { if (state.backError) throw state.backError; state.backs++; } }),
    getPromptAction: () => ({ showDialog(options) {
      if (state.dialogError) throw state.dialogError;
      const pending = deferred(); state.dialogs.push({ ...pending, options }); return pending.promise;
    } }) });
  page.aboutToAppear();
  function existing() {
    state.catalog.subscriptions = [{ id: 'source-old', name: 'Existing', url: URL_FIXTURE, lastUpdatedAt: 1 }];
    page.reload();
  }
  function draft() { page.changeName('Draft name'); page.changeAddress(URL_FIXTURE); }
  async function preview(id = '') {
    const pending = page.preview(id, id ? 'Existing' : page.name, URL_FIXTURE);
    state.fetches.at(-1).resolve('synthetic subscription body'); await pending;
    assert.equal(page.previewReady, true);
  }
  return { state, page, existing, draft, preview };
}
function safe(page) {
  assert(!page.message.includes('synthetic-private'));
  assert(!page.message.includes(URL_FIXTURE));
}
const passed = [];
async function test(name, run) { await run(); passed.push(name); }
async function main() {
  await test('clean return uses one navigation and no discard dialog', async () => {
    const f = fixture(); assert.equal(f.page.onBackPress(), false);
    await f.page.requestBack(); await f.page.requestBack();
    assert.equal(f.state.backs, 1); assert.equal(f.state.dialogs.length, 0); assert.equal(f.page.onBackPress(), true);
  });
  for (const kind of ['name', 'address', 'preview', 'busy']) {
    await test(kind + ' alone requires return confirmation', async () => {
      const f = fixture();
      if (kind === 'name') f.page.name = 'Only name';
      if (kind === 'address') f.page.address = URL_FIXTURE;
      if (kind === 'preview') f.page.previewReady = true;
      if (kind === 'busy') f.page.busy = true;
      const before = [f.page.name, f.page.address, f.page.previewReady];
      const pending = f.page.requestBack(); assert.equal(f.state.dialogs.length, 1); assert.equal(f.state.backs, 0);
      f.state.dialogs[0].resolve({ index: 0 }); await pending;
      assert.deepEqual([f.page.name, f.page.address, f.page.previewReady], before);
      assert.equal(f.page.confirmingLeave, false); assert.equal(f.state.backs, 0);
    });
  }
  await test('system return and repeated return share one pending dialog', async () => {
    const f = fixture(); f.draft(); assert.equal(f.page.onBackPress(), true);
    await f.page.requestBack(); assert.equal(f.page.onBackPress(), true); assert.equal(f.state.dialogs.length, 1);
    f.state.dialogs[0].resolve({ index: 1 }); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.state.backs, 1); assert.equal(f.page.name, ''); assert.equal(f.page.address, '');
    assert.equal(f.page.previewReady, false); await f.page.requestBack(); assert.equal(f.state.backs, 1);
  });
  await test('dialog freezes real mutation methods and cancel retains draft and preview', async () => {
    const f = fixture(); f.existing(); f.draft(); await f.preview(); f.page.deleteId = 'source-old';
    const before = clone(f.state.catalog), requests = f.state.fetches.length;
    const pending = f.page.requestBack(); f.page.changeName('replaced'); f.page.changeAddress('replaced');
    await f.page.preview(); f.page.save(); f.page.remove('source-old'); f.page.cancelPreview();
    assert.equal(f.page.name, 'Draft name'); assert.equal(f.page.address, URL_FIXTURE); assert.equal(f.page.previewReady, true);
    assert.equal(f.state.fetches.length, requests); assert.deepEqual(f.state.catalog, before); assert.equal(f.state.writes.length, 0);
    f.state.dialogs[0].resolve({ index: 0 }); await pending; f.page.save(); assert.deepEqual(f.state.writes, ['save']);
  });
  for (const kind of ['dialog throw', 'dialog rejection', 'router throw']) {
    await test(kind + ' retains content and uses fixed feedback', async () => {
      const f = fixture(); f.draft(); await f.preview();
      if (kind === 'dialog throw') f.state.dialogError = RAW_ERROR;
      const pending = f.page.requestBack();
      if (kind === 'dialog rejection') f.state.dialogs[0].reject(RAW_ERROR);
      if (kind === 'router throw') { f.state.backError = RAW_ERROR; f.state.dialogs[0].resolve({ index: 1 }); }
      await pending; assert.equal(f.page.name, 'Draft name'); assert.equal(f.page.address, URL_FIXTURE);
      assert.equal(f.page.previewReady, true); assert.equal(f.page.confirmingLeave, false); assert.equal(f.page.leaving, false);
      assert.equal(f.state.backs, 0); assert.match(f.page.message, /已保留/); safe(f.page);
    });
  }
  for (const leave of ['hide', 'disappear']) {
    await test('old dialog after ' + leave + ' cannot discard a newer visit', async () => {
      const f = fixture(); f.draft(); const old = f.page.requestBack();
      if (leave === 'hide') { f.page.onPageHide(); f.page.onPageShow(); }
      else { f.page.aboutToDisappear(); f.page.aboutToAppear(); }
      f.page.changeName('New visit'); f.page.changeAddress(URL_FIXTURE); const fresh = f.page.requestBack();
      f.state.dialogs[0].resolve({ index: 1 }); await old;
      assert.equal(f.state.backs, 0); assert.equal(f.page.name, 'New visit'); assert.equal(f.page.confirmingLeave, true);
      f.state.dialogs[1].resolve({ index: 0 }); await fresh; assert.equal(f.page.confirmingLeave, false);
    });
  }
  await test('hide invalidates pending fetch while retaining input and isolating a newer fetch', async () => {
    const f = fixture(); f.draft(); const old = f.page.preview(); f.page.onPageHide();
    assert.equal(f.page.name, 'Draft name'); assert.equal(f.page.address, URL_FIXTURE); assert.equal(f.page.busy, false);
    f.page.onPageShow(); const fresh = f.page.preview(); f.state.fetches[0].resolve('old'); await old;
    assert.equal(f.page.previewReady, false); assert.equal(f.page.busy, true);
    f.state.fetches[1].resolve('fresh'); await fresh; assert.equal(f.page.previewReady, true); assert.equal(f.state.writes.length, 0);
  });
  await test('late rejection after hide cannot replace current feedback', async () => {
    const f = fixture(); f.draft(); const pending = f.page.preview(); f.page.onPageHide(); f.page.message = 'Current feedback';
    f.state.fetches[0].reject(RAW_ERROR); await pending;
    assert.equal(f.page.message, 'Current feedback'); assert.equal(f.page.address, URL_FIXTURE); assert.equal(f.page.previewReady, false);
  });
  await test('completed preview survives hiding; final disappearance clears all draft fields', async () => {
    const f = fixture(); f.draft(); await f.preview(); const pending = clone(f.page.pendingNodes);
    f.page.onPageHide(); assert.equal(f.page.previewReady, true); assert.deepEqual(clone(f.page.pendingNodes), pending);
    f.page.save(); assert.equal(f.state.writes.length, 0); f.page.onPageShow();
    f.page.aboutToDisappear(); assert.equal(f.page.name, ''); assert.equal(f.page.address, '');
    assert.equal(f.page.pendingUrl, ''); assert.equal(f.page.pendingName, ''); assert.equal(f.page.previewReady, false);
  });
  await test('return confirmation invalidates an in-flight result even when the user stays', async () => {
    const f = fixture(); f.draft(); const fetch = f.page.preview(); const back = f.page.requestBack();
    f.state.dialogs[0].resolve({ index: 0 }); await back;
    f.state.fetches[0].resolve('old'); await fetch;
    assert.equal(f.page.previewReady, false); assert.equal(f.page.busy, false); assert.equal(f.page.address, URL_FIXTURE);
    await f.preview(); assert.equal(f.page.previewReady, true);
  });
  await test('fetch and save double-clicks cause one request and one synchronous commit', async () => {
    const f = fixture(); f.draft(); const pending = f.page.preview(); await f.page.preview(); f.page.save();
    f.page.changeName('ignored'); f.page.changeAddress('ignored');
    assert.equal(f.state.fetches.length, 1); assert.equal(f.state.writes.length, 0); assert.equal(f.page.address, URL_FIXTURE);
    f.state.fetches[0].resolve('body'); await pending; f.page.save(); f.page.save();
    assert.deepEqual(f.state.writes, ['save']); assert.match(f.page.message, /2 个节点/);
  });
  for (const kind of ['normalizeError', 'fetchError', 'parseError']) {
    await test(kind + ' retains input and conceals unknown exception details', async () => {
      const f = fixture(); f.draft(); f.state[kind] = RAW_ERROR; const pending = f.page.preview();
      if (kind === 'parseError') f.state.fetches[0].resolve('body'); await pending;
      assert.equal(f.page.name, 'Draft name'); assert.equal(f.page.address, URL_FIXTURE);
      assert.equal(f.page.previewReady, false); assert.equal(f.state.writes.length, 0); safe(f.page);
    });
  }
  await test('known fixed fetch errors remain actionable without discarding input', async () => {
    const f = fixture(); f.draft(); const pending = f.page.preview(); f.state.fetches[0].reject(Error(FIXED_FETCH_ERROR)); await pending;
    assert.equal(f.page.message, FIXED_FETCH_ERROR); assert.equal(f.page.address, URL_FIXTURE);
  });
  await test('save failure retains preview and input, and known errors are allowlisted', async () => {
    const f = fixture(); f.draft(); await f.preview(); const before = clone(f.state.catalog);
    for (const error of [RAW_ERROR, Error('订阅数量不能超过 20。')]) {
      f.state.saveError = error; f.page.save(); assert.equal(f.page.previewReady, true);
      assert.equal(f.page.address, URL_FIXTURE); assert.deepEqual(f.state.catalog, before); safe(f.page);
    }
    assert.equal(f.page.message, '订阅数量不能超过 20。'); assert.equal(f.state.writes.length, 0);
  });
  await test('committed save with failed reload reports unconfirmed readback without stale counts or retry duplication', async () => {
    const f = fixture(); f.draft(); await f.preview(); f.state.failReadAfterSave = true; f.page.save(); f.page.save();
    assert.deepEqual(f.state.writes, ['save']); assert.equal(f.state.catalog.subscriptions.length, 1);
    assert.equal(f.page.readable, false); assert.equal(f.page.editable, false); assert.equal(f.page.nodes.length, 0);
    assert.equal(f.page.sources.length, 0); assert.match(f.page.message, /保存已提交.*读取未确认/);
    assert.doesNotMatch(f.page.message, /共.*个节点|原节点已保留/); assert.equal(f.page.previewReady, false);
    assert.equal(f.page.address, ''); assert.equal(f.page.name, ''); safe(f.page);
  });
  await test('logging failure does not turn a committed save into a failure', async () => {
    const f = fixture(); f.draft(); await f.preview(); f.state.logError = RAW_ERROR; f.page.save();
    assert.deepEqual(f.state.writes, ['save']); assert.match(f.page.message, /订阅已保存/); safe(f.page);
  });
  await test('confirmed delete is single-use and failed reload has an accurate committed result', async () => {
    const f = fixture(); f.existing(); f.state.failReadAfterDelete = true;
    f.page.remove('source-old'); assert.equal(f.state.writes.length, 0);
    f.page.deleteId = 'source-old'; f.page.remove('source-old'); f.page.remove('source-old');
    assert.deepEqual(f.state.writes, ['delete']); assert.equal(f.page.readable, false); assert.equal(f.page.sources.length, 0);
    assert.match(f.page.message, /删除已提交.*读取未确认/);
  });
  for (const phase of ['fetch', 'save']) {
    for (const change of ['delete', 'url', 'name', 'lastUpdatedAt']) {
      await test(change + ' during ' + phase + ' rejects stale source contents', async () => {
        const f = fixture(); f.existing(); const pending = f.page.preview('source-old', 'Existing', URL_FIXTURE);
        if (phase === 'save') { f.state.fetches[0].resolve('body'); await pending; assert.equal(f.page.previewReady, true); }
        if (change === 'delete') f.state.catalog.subscriptions = [];
        else f.state.catalog.subscriptions[0][change] = change === 'lastUpdatedAt' ? 2 : 'changed';
        if (phase === 'fetch') { f.state.fetches[0].resolve('body'); await pending; assert.equal(f.page.previewReady, false); }
        else f.page.save();
        assert.equal(f.state.writes.length, 0); assert.equal(f.page.message, SOURCE_CHANGED);
      });
    }
  }
  await test('source guard does not reject unrelated catalog changes', async () => {
    const f = fixture(); f.existing(); await f.preview('source-old');
    f.state.catalog.nodes[0].name = 'Renamed manual'; f.state.catalog.revision++; f.page.save();
    assert.deepEqual(f.state.writes, ['save']); assert.equal(f.state.catalog.nodes[0].name, 'Renamed manual');
    assert.equal(f.state.catalog.activeNodeId, 'manual');
  });
  await test('newly active connection blocks fetch completion and pending commit', async () => {
    const f = fixture(); f.draft(); const pending = f.page.preview(); f.state.allowed = false;
    f.state.fetches[0].resolve('body'); await pending; assert.equal(f.page.previewReady, false); assert.match(f.page.message, /先断开/);
    f.state.allowed = true; await f.preview(); f.state.allowed = false; f.page.save();
    assert.equal(f.state.writes.length, 0); assert.equal(f.page.previewReady, true); assert.match(f.page.message, /先断开/);
  });
  await test('existing UI IDs remain wired to guarded form methods', () => {
    for (const id of ['backToNodes', 'subscriptionName', 'subscriptionUrl', 'previewSubscription', 'saveSubscription',
      'cancelSubscriptionPreview', 'subscriptionResult', 'confirmDeleteSubscription']) assert(source.includes(`.id('${id}')`), id);
    assert(source.includes('void this.requestBack();'));
    assert(source.includes('this.changeName(value);')); assert(source.includes('this.changeAddress(value);'));
    assert(source.includes('this.readable ? `已有来源 · ${this.sources.length}`'));
  });
  console.log(JSON.stringify({ suite: 'subscription-form', passed: passed.length,
    sourceSHA256: crypto.createHash('sha256').update(source).digest('hex'),
    scope: 'Actual page methods; synthetic catalog, fetch/parser and native-dialog adapters; no device result.', cases: passed }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
