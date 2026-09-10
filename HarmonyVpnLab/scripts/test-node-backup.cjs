'use strict';
// Execute the authored file module and page methods with synthetic SDK/files.
// No real document URIs, user configuration, device, network, or build output.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
function compile(relative, page = false) {
  let source = fs.readFileSync(path.join(root, 'entry/src/main/ets', relative), 'utf8');
  if (page) {
    const boundary = source.indexOf('\n  build() {');
    assert(boundary > 0);
    source = source.slice(0, boundary) + '\n}\n';
    source = source.replace(/^@Entry\s*$/gm, '').replace(/^@Component\s*$/gm, '')
      .replace(/^(\s*)@State /gm, '$1').replace(/@StorageProp\([^)]*\)\s*/g, '')
      .replace(/^struct (\w+) \{/m, 'export class $1 {');
  }
  const result = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0, relative + ' transpilation');
  return result.outputText;
}
const modelCode = compile('model/NodeBackup.ets');
const pageCode = compile('pages/NodeBackup.ets', true);
const LIMIT = 5 * 1024 * 1024;
const URI = 'content://synthetic-provider/private-document';
const RAW_ERROR = Error('synthetic-credential-and-document-uri-never-displayed');
const TEXT = JSON.stringify({ format: 'harmony-vpn-node-backup', name: '合成节点', password: 'synthetic-only' });
const clone = value => JSON.parse(JSON.stringify(value));
function execute(code, imports) {
  const sandbox = { exports: {}, Error, Uint8Array, ArrayBuffer, Promise, Date,
    require: name => { assert(Object.hasOwn(imports, name), name); return imports[name]; } };
  vm.runInNewContext(code, sandbox);
  return sandbox.exports;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const files = new Map([[URI, Buffer.from(TEXT)]]), handles = new Map();
  const state = { nextFd: 1, opens: 0, reads: 0, writes: 0, closes: 0, syncs: 0,
    maxRead: Infinity, maxWrite: Infinity, statSize: undefined, grow: false,
    readFault: '', writeFault: '', closeFault: false, syncFault: false, openFault: false,
    pickFault: false, selected: [URI], saved: [URI], pickerCalls: [], pending: undefined,
    allowed: true, revision: 7, restored: [], route: {}, back: 0, failRestoredReadback: false };
  const io = {
    OpenMode: { READ_ONLY: 0, WRITE_ONLY: 1, TRUNC: 8 },
    openSync(uri, mode) {
      state.opens++;
      if (state.openFault) throw RAW_ERROR;
      assert.equal(uri, URI);
      if (mode & 8) files.set(uri, Buffer.alloc(0));
      const fd = state.nextFd++; handles.set(fd, { uri, position: 0 }); return { fd };
    },
    statSync(fd) {
      assert(handles.has(fd), 'size checked on open descriptor');
      return { size: state.statSize ?? files.get(handles.get(fd).uri).length };
    },
    readSync(fd, target) {
      state.reads++; assert(target.byteLength <= 65536);
      if (state.readFault === 'throw') throw RAW_ERROR;
      if (state.readFault === 'zero') return 0;
      if (state.readFault === 'too-large') return target.byteLength + 1;
      if (state.readFault === 'fraction') return 0.5;
      const handle = handles.get(fd), data = files.get(handle.uri);
      if (state.grow && handle.position >= data.length) return 1;
      const count = Math.min(target.byteLength, state.maxRead, data.length - handle.position);
      new Uint8Array(target).set(data.subarray(handle.position, handle.position + count));
      handle.position += count; return count;
    },
    writeSync(fd, input) {
      state.writes++;
      const data = Buffer.from(input); assert(data.length <= 65536);
      if (state.writeFault === 'throw') throw RAW_ERROR;
      if (state.writeFault === 'zero') return 0;
      if (state.writeFault === 'too-large') return data.length + 1;
      if (state.writeFault === 'fraction') return 0.5;
      const handle = handles.get(fd), count = Math.min(state.maxWrite, data.length);
      const previous = files.get(handle.uri), next = Buffer.alloc(Math.max(previous.length, handle.position + count));
      previous.copy(next); data.copy(next, handle.position, 0, count);
      handle.position += count; files.set(handle.uri, next); return count;
    },
    fsyncSync(fd) { assert(handles.has(fd)); state.syncs++; if (state.syncFault) throw RAW_ERROR; },
    closeSync(file) { state.closes++; assert(handles.delete(file.fd)); if (state.closeFault) throw RAW_ERROR; }
  };
  class DocumentViewPicker {
    constructor(context) { assert.equal(context.filesDir, '/synthetic-app'); }
    save(options) {
      state.pickerCalls.push({ action: 'save', options });
      if (state.pickFault) return Promise.reject(RAW_ERROR);
      return state.pending?.promise ?? Promise.resolve(state.saved);
    }
    select(options) {
      state.pickerCalls.push({ action: 'select', options });
      if (state.pickFault) return Promise.reject(RAW_ERROR);
      return state.pending?.promise ?? Promise.resolve(state.selected);
    }
  }
  const core = { fileIo: io, picker: { DocumentViewPicker, DocumentSaveOptions: class {}, DocumentSelectOptions: class {} } };
  const ark = { util: {
    TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } },
    TextDecoder: { create: (name, options) => ({ decodeToString: bytes => new TextDecoder(name, options).decode(bytes) }) }
  } };
  const model = execute(modelCode, { '@kit.CoreFileKit': core, '@kit.ArkTS': ark });
  const context = { filesDir: '/synthetic-app' };
  const catalog = { schemaVersion: 1, revision: 7, activeNodeId: 'node-before',
    nodes: [{ id: 'node-before', name: '当前节点' }], subscriptions: [] };
  const backup = { schemaVersion: 1, revision: 3, activeNodeId: 'node-restored',
    nodes: [{ id: 'node-restored', name: '恢复节点' }, { id: 'node-second', name: '第二节点' }], subscriptions: [{ id: 'source-1' }] };
  const guard = {
    isNodeManagementAllowed: () => state.allowed,
    assertNodeManagementAllowed: () => { if (!state.allowed) throw RAW_ERROR; }
  };
  const catalogApi = {
    readNodeCatalog: () => {
      if (state.failRestoredReadback && state.restored.length > 0) throw RAW_ERROR;
      return { ...clone(catalog), revision: state.revision };
    },
    exportCatalogNode: (_, id) => { assert.equal(id, 'node-before'); return '{"single":true}'; },
    exportNodeCatalogBackup: () => TEXT,
    previewNodeCatalogBackup: text => { assert.equal(text, TEXT); return clone(backup); },
    restoreNodeCatalogBackup: (_, text, revision) => {
      guard.assertNodeManagementAllowed();
      if (revision !== state.revision) throw RAW_ERROR;
      assert.equal(text, TEXT); state.restored.push({ text, revision });
    }
  };
  const Page = execute(pageCode, { '../model/NodeCatalog': catalogApi, '../model/NodeEditGuard': guard,
    '../model/NodeBackup': model }).NodeBackup;
  const page = new Page();
  page.getUIContext = () => ({ getHostContext: () => context,
    getRouter: () => ({ getParams: () => state.route, back: () => { state.back++; } }) });
  return { files, handles, state, model, context, page, clean() { assert.equal(handles.size, 0); },
    safe(error) { assert(!error.message.includes('synthetic-credential')); assert(!error.message.includes(URI)); return true; } };
}
const passed = [];
async function test(name, fn) { await fn(); passed.push(name); }
(async () => {
  await test('short reads reassemble UTF-8 and close the descriptor', () => {
    const f = fixture(); f.state.maxRead = 2;
    assert.equal(f.model.readNodeBackupDocument(URI), TEXT); assert(f.state.reads > 5); f.clean();
  });
  await test('exactly 5 MiB accepted; oversize, unknown and invalid stat sizes rejected before allocation/read', () => {
    const f = fixture(); f.files.set(URI, Buffer.alloc(LIMIT, 32));
    assert.equal(f.model.readNodeBackupDocument(URI).length, LIMIT); f.clean();
    for (const size of [0, -1, LIMIT + 1, 2.5, NaN, Infinity]) {
      const f = fixture(); f.state.statSize = size;
      assert.throws(() => f.model.readNodeBackupDocument(URI), f.safe); assert.equal(f.state.reads, 0); f.clean();
    }
  });
  await test('truncated, growing, malformed UTF-8 and erroneous read counts fail closed', () => {
    for (const fault of ['zero', 'too-large', 'fraction', 'throw']) {
      const f = fixture(); f.state.readFault = fault;
      assert.throws(() => f.model.readNodeBackupDocument(URI), f.safe); f.clean();
    }
    for (const setup of [f => { f.state.statSize = Buffer.byteLength(TEXT) + 1; },
      f => { f.state.grow = true; }, f => { f.files.set(URI, Buffer.from([0xc3, 0x28])); }]) {
      const f = fixture(); setup(f); assert.throws(() => f.model.readNodeBackupDocument(URI), f.safe); f.clean();
    }
  });
  await test('short writes preserve Unicode bytes, flush and close', () => {
    const f = fixture(); f.state.maxWrite = 3;
    f.model.writeNodeBackupDocument(URI, TEXT); assert.equal(f.files.get(URI).toString(), TEXT);
    assert(f.state.writes > 5); assert.equal(f.state.syncs, 1); f.clean();
  });
  await test('write byte cap rejects multibyte oversize before opening; exact cap works', () => {
    const f = fixture(); assert.throws(() => f.model.writeNodeBackupDocument(URI, '中'.repeat(Math.floor(LIMIT / 3) + 1)), f.safe);
    assert.equal(f.state.opens, 0);
    f.model.writeNodeBackupDocument(URI, ' '.repeat(LIMIT)); assert.equal(f.files.get(URI).length, LIMIT); f.clean();
  });
  await test('open, short-write, sync and close failures never reveal provider details', () => {
    for (const fault of ['zero', 'too-large', 'fraction', 'throw']) {
      const f = fixture(); f.state.writeFault = fault;
      assert.throws(() => f.model.writeNodeBackupDocument(URI, TEXT), f.safe); f.clean();
    }
    for (const key of ['openFault', 'syncFault', 'closeFault']) {
      const f = fixture(); f.state[key] = true;
      assert.throws(() => f.model.writeNodeBackupDocument(URI, TEXT), f.safe); f.clean();
    }
    const f = fixture(); f.state.closeFault = true;
    assert.throws(() => f.model.readNodeBackupDocument(URI), f.safe); f.clean();
  });
  await test('SDK document options select a single JSON and save a generic non-sensitive filename', async () => {
    const f = fixture();
    const selected = await f.model.selectNodeBackupDocument(f.context, () => true);
    assert.equal(selected.text, TEXT); assert.equal(f.state.pickerCalls[0].options.maxSelectNumber, 1);
    assert.equal(f.state.pickerCalls[0].options.fileSuffixFilters[0], 'JSON|.json');
    await f.model.saveNodeBackupDocument(f.context, TEXT, true, () => true);
    assert.equal(f.state.pickerCalls[1].options.newFileNames[0], 'harmony-vpn-node.json');
    assert.equal(f.state.pickerCalls[1].options.fileSuffixChoices[0], 'JSON|.json'); f.clean();
  });
  await test('picker cancellation does not open a file and malformed URI results are rejected', async () => {
    const f = fixture(); f.state.selected = []; f.state.saved = [];
    assert.equal((await f.model.selectNodeBackupDocument(f.context, () => true)).state, 'cancelled');
    assert.equal((await f.model.saveNodeBackupDocument(f.context, TEXT, false, () => true)).state, 'cancelled');
    assert.equal(f.state.opens, 0);
    for (const uris of [[''], [URI, URI]]) {
      f.state.selected = uris; f.state.saved = uris;
      await assert.rejects(f.model.selectNodeBackupDocument(f.context, () => true), f.safe);
      await assert.rejects(f.model.saveNodeBackupDocument(f.context, TEXT, false, () => true), f.safe);
    }
    assert.equal(f.state.opens, 0);
  });
  await test('picker errors use fixed text and stale callbacks cannot read or write', async () => {
    for (const saving of [false, true]) {
      const f = fixture(); let current = true; f.state.pending = deferred();
      const pending = saving ? f.model.saveNodeBackupDocument(f.context, TEXT, false, () => current) :
        f.model.selectNodeBackupDocument(f.context, () => current);
      current = false; f.state.pending.resolve([URI]);
      assert.equal((await pending).state, 'stale'); assert.equal(f.state.opens, 0);
      f.state.pending = undefined; f.state.pickFault = true;
      await assert.rejects(saving ? f.model.saveNodeBackupDocument(f.context, TEXT, false, () => true) :
        f.model.selectNodeBackupDocument(f.context, () => true), f.safe);
    }
  });
  await test('preview reports counts and selection; only explicit confirmation restores the captured revision', async () => {
    const f = fixture(); f.page.aboutToAppear(); await f.page.preview();
    assert.equal(f.state.restored.length, 0); assert.equal(f.page.previewCount, 2);
    assert.equal(f.page.previewSourceCount, 1); assert.equal(f.page.previewSelection, '恢复节点');
    assert.equal(f.page.pendingRevision, 7); f.page.restore();
    assert.equal(f.state.restored.length, 1); assert.equal(f.page.previewReady, false); assert.equal(f.page.pendingText, '');
  });
  await test('connection guard and changed revision reject restoration and clear pending credentials', async () => {
    for (const changed of ['connection', 'revision']) {
      const f = fixture(); f.page.aboutToAppear(); await f.page.preview();
      if (changed === 'connection') f.state.allowed = false; else f.state.revision++;
      f.page.restore(); assert.equal(f.state.restored.length, 0); assert.equal(f.page.pendingText, '');
      assert.equal(f.page.previewReady, false); assert(!f.page.message.includes('synthetic-credential'));
    }
    const f = fixture(); f.state.allowed = false; f.page.aboutToAppear(); await f.page.preview();
    assert.equal(f.state.pickerCalls.length, 0);
  });
  await test('committed restore with failed readback is reported distinctly', async () => {
    const f = fixture(); f.page.aboutToAppear(); await f.page.preview();
    f.state.failRestoredReadback = true; f.page.restore();
    assert.equal(f.state.restored.length, 1); assert.equal(f.page.readable, false);
    assert.equal(f.page.message, '恢复已提交，但列表读取未确认，请返回核对。');
    assert.equal(f.page.pendingText, '');
  });
  await test('page navigation rejects late picker selection/save and clears preview text', async () => {
    for (const method of ['preview', 'save']) {
      for (const lifecycle of ['aboutToDisappear', 'onBackPress', 'back']) {
        const f = fixture(); f.page.aboutToAppear(); f.state.pending = deferred();
        const pending = method === 'save' ? f.page.save(false) : f.page.preview();
        f.page[lifecycle](); f.state.pending.resolve([URI]); await pending;
        assert.equal(f.state.opens, 0); assert.equal(f.page.pendingText, ''); assert.equal(f.page.previewReady, false);
        assert.equal(f.page.busy, false);
      }
    }
    const f = fixture(); f.page.aboutToAppear(); await f.page.preview();
    f.page.onBackPress(); assert.equal(f.page.pendingText, ''); f.page.restore(); assert.equal(f.state.restored.length, 0);
  });
  await test('ordinary backgrounding during a document picker preserves the requested save or preview', async () => {
    for (const method of ['preview', 'save']) {
      const f = fixture(); f.page.aboutToAppear(); f.state.pending = deferred();
      const pending = method === 'save' ? f.page.save(false) : f.page.preview();
      f.page.onPageHide(); assert.equal(f.page.busy, true); f.page.onPageShow();
      f.state.pending.resolve([URI]); await pending;
      assert.equal(f.state.opens, 1); assert.equal(f.page.busy, false); f.clean();
      if (method === 'save') assert.equal(f.files.get(URI).toString(), TEXT);
      else { assert.equal(f.page.previewReady, true); assert.equal(f.page.pendingText, TEXT); }
      assert.equal(f.state.restored.length, 0, 'Picker success never performs an automatic restore');
    }
  });
  await test('backgrounding keeps an existing preview but does not bypass a changed revision or connection guard', async () => {
    for (const changed of ['none', 'revision', 'connection']) {
      const f = fixture(); f.page.aboutToAppear(); await f.page.preview(); const revision = f.page.pendingRevision;
      f.page.onPageHide(); assert.equal(f.page.previewReady, true); assert.equal(f.page.pendingRevision, revision);
      if (changed === 'revision') f.state.revision++;
      if (changed === 'connection') f.state.allowed = false;
      f.page.onPageShow(); assert.equal(f.state.restored.length, 0); f.page.restore();
      assert.equal(f.state.restored.length, changed === 'none' ? 1 : 0);
    }
  });
  await test('single-node route exports that node and picker cancellation is friendly', async () => {
    const f = fixture(); f.state.route = { nodeId: 'node-before' }; f.page.aboutToAppear();
    assert.equal(f.page.nodeName, '当前节点'); await f.page.save(true);
    assert.equal(f.files.get(URI).toString(), '{"single":true}');
    f.state.saved = []; await f.page.save(false); assert.equal(f.page.message, '已取消保存。');
    f.state.selected = []; await f.page.preview(); assert.equal(f.page.previewReady, false);
    assert.equal(f.state.restored.length, 0);
  });
  console.log(JSON.stringify({ passed: passed.length, tests: passed,
    scope: 'SDK transpilation and authored methods; synthetic files/picker/catalog only; no device picker or ArkUI layout validation' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
