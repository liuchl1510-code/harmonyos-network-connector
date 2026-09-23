'use strict';
// Actual transfer module plus the existing document writer, with synthetic SDKs.
// Never touches a real clipboard, user document, node, device, or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const inputs = ['entry/src/main/ets/model/DiagnosticSummaryExport.ets',
  'entry/src/main/ets/model/NodeBackup.ets', 'scripts/test-diagnostic-summary-export.cjs'];
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const pasteboardDeclaration = fs.readFileSync(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/api/@ohos.pasteboard.d.ts'), 'utf8');
const sdkLocalDevice = pasteboardDeclaration.match(/\bLOCALDEVICE\s*=\s*(\d+)/);
assert(sdkLocalDevice, 'installed SDK must declare ShareOption.LOCALDEVICE');
const localDeviceValue = Number(sdkLocalDevice[1]);
function compile(relative) {
  const result = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0, relative); return result.outputText;
}
const transferCode = compile(inputs[0]), documentCode = compile(inputs[1]);
const URI = 'content://synthetic-provider/selected-summary.txt';
const TEXT = 'Harmony VPN 诊断摘要\n没有记录，不代表连接成功。\n';
const RAW = Error('sensitive-provider-uri-and-platform-error');
function execute(code, imports) {
  const sandbox = { exports: {}, Error, Uint8Array, ArrayBuffer, Promise, Date,
    require: name => { assert(Object.hasOwn(imports, name), name); return imports[name]; } };
  vm.runInNewContext(code, sandbox); return sandbox.exports;
}
function deferred() {
  let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const state = { current: true, picks: 0, copies: [], writes: 0, reads: 0, closes: 0, selected: [URI],
    maxWrite: Infinity, maxRead: Infinity, pickError: false, writeError: false, readError: false,
    statDelta: 0, corrupt: false, extraEofByte: false, readCount: undefined, syncError: false,
    closeError: false, copyError: false, clipboardPending: undefined, pickerPending: undefined,
    created: 0, propertyError: false, checks: 0, expiresOn: Infinity, pickerOptions: undefined };
  const handles = new Map(); let nextFd = 1, bytes = Buffer.from('synthetic-old-document');
  const io = {
    OpenMode: { READ_ONLY: 0, WRITE_ONLY: 1, TRUNC: 8 },
    openSync(uri, mode) {
      assert.equal(uri, URI, 'only the user-selected URI is used');
      if ((mode & 8) !== 0) bytes = Buffer.alloc(0);
      const fd = nextFd++; handles.set(fd, { position: 0, mode }); return { fd };
    },
    statSync(fd) { assert(handles.has(fd)); return { size: bytes.length + state.statDelta }; },
    readSync(fd, buffer) {
      state.reads++; if (state.readError) throw RAW;
      if (state.readCount !== undefined) return state.readCount;
      const handle = handles.get(fd); assert(handle);
      if (handle.position === bytes.length && state.extraEofByte) return 1;
      const count = Math.min(state.maxRead, buffer.byteLength, bytes.length - handle.position);
      new Uint8Array(buffer).set(bytes.subarray(handle.position, handle.position + count));
      if (state.corrupt && count > 0) new Uint8Array(buffer)[0] ^= 1;
      handle.position += count; return count;
    },
    writeSync(fd, buffer) {
      state.writes++; if (state.writeError) throw RAW;
      const handle = handles.get(fd); assert(handle);
      const input = Buffer.from(buffer), count = Math.min(state.maxWrite, input.length);
      const next = Buffer.alloc(Math.max(bytes.length, handle.position + count));
      bytes.copy(next); input.copy(next, handle.position, 0, count); bytes = next;
      handle.position += count; return count;
    },
    fsyncSync(fd) { assert(handles.has(fd)); if (state.syncError) throw RAW; },
    closeSync(file) { assert(handles.delete(file.fd)); state.closes++; if (state.closeError) throw RAW; }
  };
  class DocumentViewPicker {
    constructor(context) { assert.equal(context.filesDir, '/synthetic'); }
    save(options) {
      state.picks++; state.pickerOptions = options;
      if (state.pickError) return Promise.reject(RAW);
      return state.pickerPending?.promise ?? Promise.resolve(state.selected);
    }
  }
  const core = { fileIo: io, picker: { DocumentViewPicker, DocumentSaveOptions: class {} } };
  const ark = { util: { TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } } } };
  const clipboard = {
    MIMETYPE_TEXT_PLAIN: 'text/plain', ShareOption: { LOCALDEVICE: localDeviceValue },
    createData(type, text) {
      assert.equal(type, 'text/plain'); state.created++;
      let property = { shareOption: 'synthetic-default-cross-device' };
      return { text, getProperty: () => property, setProperty: value => {
        if (state.propertyError) throw RAW; property = value;
      } };
    },
    getSystemPasteboard: () => ({ setData(data) {
      assert.equal(data.getProperty().shareOption, localDeviceValue, 'must restrict writes to local device');
      state.copies.push(data.text); if (state.copyError) return Promise.reject(RAW);
      return state.clipboardPending?.promise ?? Promise.resolve();
    } })
  };
  const document = execute(documentCode, { '@kit.CoreFileKit': core, '@kit.ArkTS': ark });
  const model = execute(transferCode, { '@kit.CoreFileKit': core, '@kit.ArkTS': ark,
    '@kit.BasicServicesKit': { pasteboard: clipboard }, './NodeBackup': document });
  const current = () => { state.checks++; return state.current && state.checks < state.expiresOn; };
  return { state, model, context: { filesDir: '/synthetic' }, current,
    text: () => bytes.toString('utf8'), clean: () => assert.equal(handles.size, 0) };
}
const tests = [];
function test(name, body) { tests.push({ name, body }); }
test('save writes the preview and verifies exact UTF-8 bytes', async () => {
  const f = fixture(); const result = await f.model.saveDiagnosticSummary(f.context, TEXT, f.current);
  assert.equal(result.state, 'saved'); assert.equal(f.text(), TEXT); assert.equal(f.state.closes, 2);
  assert.deepEqual(Array.from(f.state.pickerOptions.newFileNames), ['harmony-vpn-diagnostic-summary.txt']);
  assert.deepEqual(Array.from(f.state.pickerOptions.fileSuffixChoices), ['TXT|.txt']); f.clean();
});
test('Unicode survives short writes and short reads', async () => {
  const f = fixture(); f.state.maxWrite = 3; f.state.maxRead = 2;
  assert.equal((await f.model.saveDiagnosticSummary(f.context, TEXT, f.current)).state, 'saved');
  assert(f.state.writes > 5 && f.state.reads > 5); assert.equal(f.text(), TEXT); f.clean();
});
test('large summaries are written and verified across multiple chunks', async () => {
  const f = fixture(), text = '中'.repeat(50000);
  assert.equal((await f.model.saveDiagnosticSummary(f.context, text, f.current)).state, 'saved');
  assert(f.state.writes >= 3 && f.state.reads >= 4); assert.equal(f.text(), text); f.clean();
});
test('cancel returns without opening or changing a document', async () => {
  const f = fixture(); f.state.selected = [];
  assert.equal((await f.model.saveDiagnosticSummary(f.context, TEXT, f.current)).state, 'cancelled');
  assert.equal(f.state.writes, 0); assert.equal(f.text(), 'synthetic-old-document'); f.clean();
});
test('stale before picker has no side effects', async () => {
  const f = fixture(); f.state.current = false;
  assert.equal((await f.model.saveDiagnosticSummary(f.context, TEXT, f.current)).state, 'stale');
  assert.equal(f.state.picks, 0); assert.equal(f.state.writes, 0); f.clean();
});
test('leaving while picker is open prevents a later document write', async () => {
  const f = fixture(); f.state.pickerPending = deferred();
  const operation = f.model.saveDiagnosticSummary(f.context, TEXT, f.current);
  f.state.current = false; f.state.pickerPending.resolve([URI]);
  assert.equal((await operation).state, 'stale'); assert.equal(f.state.writes, 0); f.clean();
});
test('a final current check occurs immediately before document mutation', async () => {
  const f = fixture(); f.state.expiresOn = 3;
  assert.equal((await f.model.saveDiagnosticSummary(f.context, TEXT, f.current)).state, 'stale');
  assert.equal(f.state.picks, 1); assert.equal(f.state.writes, 0); f.clean();
});
for (const selected of [[URI, URI], [''], [17]]) {
  test('invalid picker selection fails without mutation: ' + JSON.stringify(selected), async () => {
    const f = fixture(); f.state.selected = selected;
    assert.equal((await f.model.saveDiagnosticSummary(f.context, TEXT, f.current)).state, 'failed');
    assert.equal(f.state.writes, 0); f.clean();
  });
}
for (const field of ['pickError', 'writeError', 'syncError', 'closeError']) {
  test(field + ' produces a fixed failure status, never SDK details', async () => {
    const f = fixture(); f.state[field] = true;
    const result = await f.model.saveDiagnosticSummary(f.context, TEXT, f.current);
    assert.equal(result.state, 'failed'); assert.equal(Object.keys(result).join(','), 'state'); f.clean();
  });
}
for (const setup of [f => { f.state.readError = true; }, f => { f.state.statDelta = 1; },
  f => { f.state.corrupt = true; }, f => { f.state.extraEofByte = true; }]) {
  test('post-write readback fault reports verification-failed #' + tests.length, async () => {
    const f = fixture(); setup(f);
    assert.equal((await f.model.saveDiagnosticSummary(f.context, TEXT, f.current)).state, 'verification-failed');
    assert.equal(f.text(), TEXT); f.clean();
  });
}
for (const readCount of [0, -1, 0.5, 65537, NaN]) {
  test('invalid read count cannot claim verified save: ' + readCount, async () => {
    const f = fixture(); f.state.readCount = readCount;
    assert.equal((await f.model.saveDiagnosticSummary(f.context, TEXT, f.current)).state, 'verification-failed'); f.clean();
  });
}
for (const text of ['', '中'.repeat(90000)]) {
  test('empty or oversized preview rejected before picker/clipboard #' + tests.length, async () => {
    const f = fixture();
    assert.equal((await f.model.saveDiagnosticSummary(f.context, text, f.current)).state, 'failed');
    assert.equal((await f.model.copyDiagnosticSummary(text, f.current)).state, 'failed');
    assert.equal(f.state.picks, 0); assert.equal(f.state.created, 0); f.clean();
  });
}
test('clipboard contains only frozen preview with LOCAL_DEVICE policy', async () => {
  const f = fixture();
  assert.equal((await f.model.copyDiagnosticSummary(TEXT, f.current)).state, 'copied');
  assert.deepEqual(f.state.copies, [TEXT]); assert.equal(f.state.created, 1);
});
test('stale copy does not touch existing clipboard', async () => {
  const f = fixture(); f.state.current = false;
  assert.equal((await f.model.copyDiagnosticSummary(TEXT, f.current)).state, 'stale');
  assert.equal(f.state.created, 0); assert.equal(f.state.copies.length, 0);
});
test('failed LOCAL_DEVICE property prevents clipboard submission', async () => {
  const f = fixture(); f.state.propertyError = true;
  assert.equal((await f.model.copyDiagnosticSummary(TEXT, f.current)).state, 'failed');
  assert.equal(f.state.copies.length, 0);
});
test('clipboard rejection has no provider error payload', async () => {
  const f = fixture(); f.state.copyError = true;
  const result = await f.model.copyDiagnosticSummary(TEXT, f.current);
  assert.equal(result.state, 'failed'); assert.equal(Object.keys(result).join(','), 'state');
});
test('leaving during clipboard submission suppresses its late success', async () => {
  const f = fixture(); f.state.clipboardPending = deferred();
  const operation = f.model.copyDiagnosticSummary(TEXT, f.current); f.state.current = false;
  f.state.clipboardPending.resolve(); assert.equal((await operation).state, 'stale');
});
test('leaving during rejected picker suppresses late error', async () => {
  const f = fixture(); f.state.pickerPending = deferred();
  const operation = f.model.saveDiagnosticSummary(f.context, TEXT, f.current); f.state.current = false;
  f.state.pickerPending.reject(RAW); assert.equal((await operation).state, 'stale'); f.clean();
});
(async () => {
  const results = [];
  for (const item of tests) {
    try { await item.body(); results.push({ name: item.name, passed: true }); }
    catch (error) { results.push({ name: item.name, passed: false, detail: error.message }); }
  }
  const passed = results.filter(result => result.passed).length;
  const report = { generatedAt: new Date().toISOString(), passed, failed: results.length - passed,
    total: results.length, sourceSHA256: Object.fromEntries(inputs.map(file => [file,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    scope: 'Actual ArkTS transfer model and reused writer executed with synthetic clipboard, picker and file descriptors; no real device or system picker UI.', results };
  const output = path.join(root, 'build/diagnostic-summary-export-verification.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, failed: report.failed, total: report.total,
    failures: results.filter(result => !result.passed), record: output }));
  if (report.failed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
