'use strict';
// Execute authored page methods with controlled models/SDK callbacks. This does
// not render ArkUI or use the real clipboard, picker, configuration or devices.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const relative = 'entry/src/main/ets/pages/DiagnosticSummary.ets';
const original = fs.readFileSync(path.join(root, relative), 'utf8');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const boundary = original.indexOf('\n  build() {'); assert(boundary > 0);
const source = (original.slice(0, boundary) + '\n}\n')
  .replace(/^@Entry\s*$/gm, '').replace(/^@Component\s*$/gm, '')
  .replace(/^(\s*)@State /gm, '$1').replace(/@StorageProp\([^)]*\)\s*/g, '')
  .replace(/^struct (\w+) \{/m, 'export class $1 {');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics.length, 0, relative + ' method transpilation');
const RAW = Error('synthetic-secret-platform-error-must-not-be-shown');
function deferred() {
  let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(coreAvailable = true) {
  const state = { collects: [], copies: [], saves: [], back: 0, versionName: '0.22.0', versionCode: 43,
    api: 26, metadataError: false, apiError: false, collectError: false, copyState: 'copied', saveState: 'saved',
    copyError: false, saveError: false, copyPending: undefined, savePending: undefined,
    nextSnapshot: { text: '合成诊断摘要一\n没有记录不代表成功。', generatedAt: 1700000000000,
      eventCount: 0, recoveryCount: 0, sessionCount: 0, partial: false,
      journalStatus: 'empty', recoveryStatus: 'empty', lifecycleStatus: 'missing' } };
  const context = { filesDir: '/synthetic' };
  const bundleManager = { BundleFlag: { GET_BUNDLE_INFO_DEFAULT: 0 }, getBundleInfoForSelfSync(flag) {
    assert.equal(flag, 0); if (state.metadataError) throw RAW;
    return { versionName: state.versionName, versionCode: state.versionCode };
  } };
  const deviceInfo = { get sdkApiVersion() { if (state.apiError) throw RAW; return state.api; } };
  const imports = {
    '@kit.AbilityKit': { bundleManager }, '@kit.BasicServicesKit': { deviceInfo },
    '../model/BuildCapabilities': { VPN_CORE_AVAILABLE: coreAvailable },
    '../model/DiagnosticSummary': { collectDiagnosticSummary(...args) {
      state.collects.push(args); if (state.collectError) throw RAW; return { ...state.nextSnapshot };
    } },
    '../model/DiagnosticSummaryExport': {
      copyDiagnosticSummary(text, current) {
        state.copies.push({ text, current });
        if (state.copyError) return Promise.reject(RAW);
        return state.copyPending?.promise ?? Promise.resolve({ state: state.copyState });
      },
      saveDiagnosticSummary(selectedContext, text, current) {
        assert.equal(selectedContext, context); state.saves.push({ text, current });
        if (state.saveError) return Promise.reject(RAW);
        return state.savePending?.promise ?? Promise.resolve({ state: state.saveState });
      }
    }
  };
  const sandbox = { exports: {}, Error, Promise, Date,
    require: name => { assert(Object.hasOwn(imports, name), name); return imports[name]; } };
  vm.runInNewContext(compiled.outputText, sandbox);
  const page = new sandbox.exports.DiagnosticSummary();
  page.getUIContext = () => ({ getHostContext: () => context,
    getRouter: () => ({ back: () => { state.back++; } }) });
  return { page, state, ready() { page.aboutToAppear(); page.onPageShow(); } };
}
const tests = [], staticChecks = [];
function test(name, body) { tests.push({ name, body }); }
function sourceCheck(name, body) { staticChecks.push({ name, body }); }
test('initial display reads one snapshot, no clipboard or export side effect', () => {
  const f = fixture(); f.ready();
  assert.equal(f.state.collects.length, 1); assert.equal(f.page.previewText, f.state.nextSnapshot.text);
  assert.equal(f.state.copies.length, 0); assert.equal(f.state.saves.length, 0); assert.equal(f.page.busy, false);
  assert.deepEqual(Array.from(f.state.collects[0]), ['/synthetic', '0.22.0', 43, 26, true]);
});
test('explicit refresh replaces snapshot while page show preserves it', () => {
  const f = fixture(); f.ready(); const old = f.page.previewText;
  f.state.nextSnapshot.text = '合成诊断摘要二'; f.page.onPageHide(); f.page.onPageShow();
  assert.equal(f.page.previewText, old); assert.equal(f.state.collects.length, 1);
  f.page.refresh(); assert.equal(f.page.previewText, '合成诊断摘要二'); assert.equal(f.state.collects.length, 2);
});
test('preview build suffix is removed exactly as in About', () => {
  const f = fixture(false); f.state.versionName = '0.22.0-ui-preview'; f.ready();
  assert.deepEqual(Array.from(f.state.collects[0]), ['/synthetic', '0.22.0', 43, 26, false]);
});
test('metadata failures preserve unavailable placeholders without SDK text', () => {
  const f = fixture(); f.state.metadataError = true; f.state.apiError = true; f.ready();
  assert.deepEqual(Array.from(f.state.collects[0]), ['/synthetic', '', 0, 0, true]);
  assert(!f.page.message.includes(RAW.message));
});
test('partial is carried as completeness, no invented diagnosis', () => {
  const f = fixture(); f.state.nextSnapshot.partial = true; f.ready();
  assert.equal(f.page.partial, true); assert.equal(f.page.previewText, f.state.nextSnapshot.text);
});
test('failed refresh clears outdated preview and cannot copy it', async () => {
  const f = fixture(); f.ready(); f.state.collectError = true; f.page.refresh();
  assert.equal(f.page.previewText, ''); assert.equal(f.page.previewTime, '');
  await f.page.copy(); await f.page.save();
  assert.equal(f.state.copies.length, 0); assert.equal(f.state.saves.length, 0);
  assert.equal(f.page.message, '摘要暂时无法生成，请稍后刷新。原记录已保留。');
});
test('copy and save consume displayed snapshot despite underlying new records', async () => {
  const f = fixture(); f.ready(); const displayed = f.page.previewText;
  f.state.nextSnapshot.text = '未刷新，不得复制的内容';
  await f.page.copy(); await f.page.save();
  assert.equal(f.state.collects.length, 1);
  assert.equal(f.state.copies[0].text, displayed); assert.equal(f.state.saves[0].text, displayed);
});
test('pending copy prevents duplicate copy, export and refresh', async () => {
  const f = fixture(); f.ready(); f.state.copyPending = deferred(); const operation = f.page.copy();
  assert.equal(f.page.busy, true); await f.page.copy(); await f.page.save(); f.page.refresh();
  assert.equal(f.state.copies.length, 1); assert.equal(f.state.saves.length, 0); assert.equal(f.state.collects.length, 1);
  f.state.copyPending.resolve({ state: 'copied' }); await operation; assert.equal(f.page.busy, false);
});
test('pending picker prevents duplicate export, copy and refresh', async () => {
  const f = fixture(); f.ready(); f.state.savePending = deferred(); const operation = f.page.save();
  await f.page.copy(); await f.page.save(); f.page.refresh();
  assert.equal(f.state.saves.length, 1); assert.equal(f.state.copies.length, 0); assert.equal(f.state.collects.length, 1);
  f.state.savePending.resolve({ state: 'saved' }); await operation; assert.equal(f.page.busy, false);
});
test('picker hide/show does not invalidate pending selected-file write', async () => {
  const f = fixture(); f.ready(); f.state.savePending = deferred(); const operation = f.page.save();
  f.page.onPageHide(); assert.equal(f.state.saves[0].current(), true);
  f.page.onPageShow(); assert.equal(f.page.busy, true); assert.equal(f.state.saves[0].current(), true);
  f.state.savePending.resolve({ state: 'saved' }); await operation;
  assert.equal(f.page.message, 'TXT 已保存，并核对为当前预览的完整内容。'); assert.equal(f.page.busy, false);
});
test('cancelled picker retains preview and permits a later refresh or copy', async () => {
  const f = fixture(); f.ready(); const preview = f.page.previewText;
  f.state.savePending = deferred(); const operation = f.page.save(); f.page.onPageHide();
  f.state.savePending.resolve({ state: 'cancelled' }); f.page.onPageShow(); await operation;
  assert.equal(f.page.message, '已取消保存，预览仍然保留。'); assert.equal(f.page.previewText, preview);
  await f.page.copy(); assert.equal(f.state.copies.length, 1);
  f.page.refresh(); assert.equal(f.state.collects.length, 2);
});
for (const method of ['back', 'onBackPress', 'aboutToDisappear']) {
  test(method + ' invalidates export callback and suppresses late success', async () => {
    const f = fixture(); f.ready(); f.state.savePending = deferred(); const operation = f.page.save();
    const message = f.page.message; f.page[method]();
    assert.equal(f.state.saves[0].current(), false);
    f.state.savePending.resolve({ state: 'saved' }); await operation;
    assert.equal(f.page.message, message); assert.equal(f.page.busy, false);
  });
}
test('page still shown after back recovers new actions without reviving old callback', async () => {
  const f = fixture(); f.ready(); f.state.savePending = deferred(); const oldOperation = f.page.save();
  const oldCurrent = f.state.saves[0].current; f.page.onBackPress(); f.page.onPageShow();
  assert.equal(oldCurrent(), false); await f.page.copy();
  assert.equal(f.page.message, '已复制当前预览，仅在本机剪贴板可用。');
  f.state.savePending.resolve({ state: 'saved' }); await oldOperation;
  assert.equal(f.page.message, '已复制当前预览，仅在本机剪贴板可用。'); assert.equal(oldCurrent(), false);
  assert.equal(f.state.collects.length, 1);
});
test('destroyed page ignores rejected copy callback', async () => {
  const f = fixture(); f.ready(); f.state.copyPending = deferred(); const operation = f.page.copy();
  const message = f.page.message; f.page.aboutToDisappear(); f.state.copyPending.reject(RAW); await operation;
  assert.equal(f.page.message, message); assert.equal(f.state.copies[0].current(), false);
});
test('destroyed page ignores rejected picker callback', async () => {
  const f = fixture(); f.ready(); f.state.savePending = deferred(); const operation = f.page.save();
  const message = f.page.message; f.page.aboutToDisappear(); f.state.savePending.reject(RAW); await operation;
  assert.equal(f.page.message, message); assert.equal(f.state.saves[0].current(), false);
});
for (const operation of ['copy', 'save']) {
  test(operation + ' unexpected SDK rejection yields fixed Chinese message and resets busy', async () => {
    const f = fixture(); f.ready(); f.state[operation + 'Error'] = true; await f.page[operation]();
    assert(!f.page.message.includes(RAW.message)); assert.equal(f.page.busy, false);
    assert.equal(f.page.message, operation === 'copy' ? '复制未完成，请重试。' :
      '保存未完成，文件可能不完整，请重新选择位置重试。');
  });
}
for (const [state, message] of [['saved', 'TXT 已保存，并核对为当前预览的完整内容。'],
  ['verification-failed', '文件已写入，但保存后核对未通过。请重新选择位置保存。'],
  ['failed', '保存未完成，文件可能不完整，请重新选择位置重试。']]) {
  test('save result distinguishes ' + state, async () => {
    const f = fixture(); f.ready(); f.state.saveState = state; await f.page.save();
    assert.equal(f.page.message, message); assert.equal(f.page.busy, false);
  });
}
test('invalid generated time does not throw or display invalid date', () => {
  for (const time of [NaN, 0, -1, 0.5, Infinity]) {
    const f = fixture(); f.state.nextSnapshot.generatedAt = time; f.ready();
    assert.equal(f.page.previewTime, '生成时间不可用');
  }
});
sourceCheck('page uses adaptive width, scrolling preview and minimum touch targets', () => {
  const ui = original.slice(boundary);
  assert(ui.includes('.width(formContentWidth(this.windowWidthVp))'));
  assert(ui.includes(".id('diagnosticSummaryScroll')"));
  assert.equal((ui.match(/minHeight: 48/g) || []).length, 3);
  assert(ui.includes('.wordBreak(WordBreak.BREAK_ALL)'));
  assert(!/\.maxLines\(/.test(ui));
});
sourceCheck('refresh, copy and save bindings share the busy guard', () => {
  const ui = original.slice(boundary);
  assert(ui.includes('.enabled(!this.busy).onClick(() => { this.refresh(); })'));
  assert(ui.includes('.enabled(!this.busy && this.previewText.length > 0).onClick(() => { void this.copy(); })'));
  assert(ui.includes('.enabled(!this.busy && this.previewText.length > 0).onClick(() => { void this.save(); })'));
});
sourceCheck('shared theme resources cover edge background and primary-button foreground', () => {
  const ui = original.slice(boundary);
  assert(ui.includes(".background($r('app.color.page_bg'))"));
  assert(ui.includes(".fontColor($r('app.color.on_accent'))"));
  assert(!ui.includes('Color.White'));
});
sourceCheck('preview is plain nonselectable text: copy only through explicit local-only button', () => {
  assert(original.includes("Text(this.previewText).id('diagnosticSummaryPreview')"));
  assert(!original.includes('.copyOption(')); assert(!original.includes('SelectionMenu'));
});
(async () => {
  const results = [];
  for (const [kind, list] of [['execution', tests], ['static', staticChecks]]) {
    for (const item of list) {
      try { await item.body(); results.push({ name: item.name, kind, passed: true }); }
      catch (error) { results.push({ name: item.name, kind, passed: false, detail: error.message }); }
    }
  }
  const passed = results.filter(result => result.passed).length;
  const inputs = [relative, 'scripts/test-diagnostic-summary-page.cjs'];
  const report = { generatedAt: new Date().toISOString(), passed, failed: results.length - passed,
    total: results.length, executedCases: tests.length, staticChecks: staticChecks.length,
    sourceSHA256: Object.fromEntries(inputs.map(file => [file,
      crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    scope: 'Actual ArkTS page methods with controlled SDK/model callbacks; static builder bindings. No ArkUI rendering or real clipboard/picker/device execution.', results };
  const output = path.join(root, 'build/diagnostic-summary-page-verification.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, failed: report.failed, total: report.total,
    executedCases: report.executedCases, staticChecks: report.staticChecks,
    failures: results.filter(result => !result.passed), record: output }));
  if (report.failed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
