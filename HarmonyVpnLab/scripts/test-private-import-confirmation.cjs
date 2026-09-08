'use strict';
// Synthetic adapters only: no private file access, HDC process, phone or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { importOutboundText, isEmptyInput } = require('./import-private-node.cjs');
const { runNodeConfigReceiptTests } = require('./test-node-management-ui.cjs');

const OLD = '保存回执：00000000-0000-4000-8000-000000000001';
const FRESH = '保存回执：00000000-0000-4000-8000-000000000002';
const CHANGED = '保存回执：00000000-0000-4000-8000-000000000003';
const outbound = { protocol: 'vless', settings: { vnext: [{ address: 'node.example.invalid', port: 443,
  users: [{ id: 'd83b7e56-c9d8-4ce7-b8fb-90a784b40c60', encryption: 'none' }] }] },
  streamSettings: { network: 'tcp', security: 'tls' } };
const syntheticText = JSON.stringify(outbound);

function mockUi(mode = 'success') {
  const state = { page: 'main', viewport: 0, receipt: OLD, input: '', host: outbound.settings.vnext[0].address,
    saved: false, dumps: 0, cleanups: 0, visibleClearedVisits: 0, stage: '', writes: 0, foreignActions: 0,
    resultText: '已新增 1 个节点，跳过 0 个已有节点。可返回节点列表选择连接。', visited: [] };
  if (mode === 'unsaved') state.input = 'synthetic-unsaved-input';
  function control(id, type, text, bounds, at) {
    return { attributes: { id, type, text, bounds, enabled: 'true',
      visible: state.viewport === at ? 'true' : 'false' } };
  }
  function tree() {
    if (state.page === 'foreign') return { children: [control('nodeInput', 'TextArea', '', '[40,50][360,90]', 0)] };
    if (state.page === 'main') {
      return { children: [control('openNodeConfig', 'Button', 'open', '[40,30][360,90]', 0),
        control('toggleConnection', 'Button', 'connect', '[40,130][360,190]', 0)] };
    }
    if (state.page === 'nodes') {
      return { attributes: { id: 'scroll', type: 'Scroll', visible: 'true', enabled: 'true', bounds: '[0,0][400,900]' },
        children: [control('nodeCount', 'Text', '共 2 个节点', '[40,130][360,190]', 0),
          control('importNodes', 'Button', 'import', '[40,30][360,90]', 0),
          control('backToConnection', 'Button', 'back', '[40,350][360,400]', 1)] };
    }
    const children = [control('saveNode', 'Button', 'save', '[40,350][360,400]', 0),
      control('nodeSaveReceipt', 'Text', state.receipt, '[40,50][360,90]', 1),
      control('nodeSaveResult', 'Text', state.resultText, '[40,100][360,150]', 1),
      control('currentNodeHost', 'Text', '当前远端服务器：' + state.host, '[40,160][360,210]', 1),
      control('backToProbe', 'Button', 'back', '[40,350][360,400]', 2)];
    if (!(mode === 'missing-input' && state.saved)) {
      children.push(control('nodeInput', 'TextArea', state.input, '[40,100][360,300]', 0));
      if (state.saved && state.viewport === 0 && state.input === '') state.visibleClearedVisits++;
    }
    return { attributes: { id: 'scroll', type: 'Scroll', visible: 'true', enabled: 'true', bounds: '[0,0][400,900]' }, children };
  }
  const io = {
    wait: async () => {},
    onStage: value => {
      state.stage = value;
      if (mode === 'changed-receipt' && value === 'verify-receipt-still-current') state.receipt = CHANGED;
      if (mode === 'late-failure-ui' && value === 'verify-receipt-still-current') state.resultText = '保存未完成，请重试。';
      if (mode === 'foreign-before-input' && value === 'enter-private-outbound') state.page = 'foreign';
      if (mode === 'foreign-before-save' && value === 'save-private-outbound') state.page = 'foreign';
      if (mode === 'foreign-start' && value === 'open-visible-form') state.page = 'foreign';
    },
    command: args => {
      if (args[0] === 'list') return 'SYNTHETIC USB Connected device\n';
      const command = args[3];
      if (command.startsWith('uitest dumpLayout')) {
        assert(!command.includes(' -b '), 'Bundle-filtered snapshot must not be used');
        state.dumps++;
        if (mode === 'dump-failure') throw new Error('SYNTHETIC_PRIVATE_DUMP_FAILURE');
        return 'No Error';
      }
      if (command.startsWith('cat ')) {
        if (mode === 'cat-failure') throw new Error('SYNTHETIC_PRIVATE_CAT_FAILURE');
        if (mode === 'invalid-layout') return '{SYNTHETIC_PRIVATE_MALFORMED_LAYOUT';
        return JSON.stringify(tree());
      }
      if (command.startsWith('rm -f ')) { state.cleanups++; return ''; }
      if (state.page === 'foreign' && command.startsWith('uitest uiInput')) {
        state.foreignActions++; throw new Error('foreign-control-operation');
      }
      if (command.startsWith('uitest uiInput swipe')) {
        const numbers = command.match(/-?\d+/g).map(Number);
        const towardTop = numbers[3] > numbers[1];
        state.viewport = Math.max(0, Math.min(state.page === 'nodes' ? 1 : 2, state.viewport + (towardTop ? -1 : 1)));
        return 'No Error';
      }
      if (command.startsWith('uitest uiInput inputText')) {
        state.input = syntheticText;
        state.writes++;
        return 'No Error';
      }
      if (command.startsWith('uitest uiInput keyEvent')) return 'No Error';
      if (command.startsWith('uitest uiInput click')) {
        if (state.page === 'main') {
          state.page = mode === 'direct-form' ? 'form' : mode === 'foreign-after-open' ? 'foreign' : 'nodes';
          state.visited.push(state.page); state.viewport = 0; return 'No Error';
        }
        if (state.page === 'nodes') {
          state.page = state.viewport === 0 ? 'form' : 'main'; state.visited.push(state.page); state.viewport = 0; return 'No Error';
        }
        if (state.viewport === 2) {
          state.page = mode === 'direct-form' ? 'main' : 'nodes'; state.visited.push(state.page); state.viewport = 0; return 'No Error';
        }
        assert.equal(state.viewport, 0);
        state.saved = true;
        state.receipt = mode === 'stale' ? OLD : mode === 'failed-save' ? '本次保存未完成' : FRESH;
        state.input = mode === 'not-cleared' ? syntheticText : '';
        if (mode === 'wrong-host') state.host = 'different.example.invalid';
        if (mode === 'failure-ui') state.resultText = '保存未完成，请先断开连接并重试。';
        if (mode === 'old-success-ui') state.resultText = '已保存旧节点';
        state.viewport = 2; // textarea is deliberately off-screen immediately after save.
        return 'No Error';
      }
      throw new Error('unexpected-synthetic-command');
    }
  };
  return { state, io };
}

function testPageSaveMethods() {
  // This now executes the actual batch-aware NodeConfig methods. The old
  // parseNode/saveNodeProfile mock path no longer describes production behavior.
  return runNodeConfigReceiptTests();
}

(async () => {
  let passed = testPageSaveMethods();
  assert.equal(isEmptyInput(undefined), false);
  assert.equal(isEmptyInput({ visible: 'false', type: 'TextArea', text: '' }), false);
  assert.equal(isEmptyInput({ visible: 'true', type: 'Text', text: '' }), false);
  assert.equal(isEmptyInput({ visible: 'true', type: 'TextArea' }), false);
  assert.equal(isEmptyInput({ visible: 'true', type: 'TextArea', text: '在手机上粘贴节点配置' }), false);
  passed += 5;
  for (const mode of ['success', 'direct-form', 'wrong-host']) {
    const success = mockUi(mode);
    const result = await importOutboundText(syntheticText, success.io);
    assert.deepEqual(result, { saved: true, savedToCatalog: true, readbackReceiptVerified: true,
      saveReceiptFresh: true, inputCleared: true, returnedToMain: true });
    assert(success.state.visibleClearedVisits > 0);
    assert.equal(success.state.dumps, success.state.cleanups);
    assert.equal(success.state.page, 'main');
    assert(Object.values(result).every(value => typeof value === 'boolean'));
    assert.equal(Object.hasOwn(result, 'serverMatches'), false);
    assert.equal(Object.hasOwn(result, 'activeServerMatches'), false);
    assert.deepEqual(success.state.visited, mode === 'direct-form' ? ['form', 'main'] : ['nodes', 'form', 'nodes', 'main']);
    passed++;
  }
  for (const [mode, stage] of [
    ['stale', 'verify-fresh-save-receipt'],
    ['failed-save', 'verify-fresh-save-receipt'],
    ['failure-ui', 'verify-save-ui-result'],
    ['old-success-ui', 'verify-save-ui-result'],
    ['late-failure-ui', 'verify-receipt-still-current'],
    ['not-cleared', 'verify-input-cleared'],
    ['missing-input', 'verify-input-cleared'],
    ['changed-receipt', 'verify-receipt-still-current'],
    ['unsaved', 'open-visible-form'],
    ['foreign-start', 'open-visible-form'],
    ['foreign-after-open', 'open-visible-form'],
    ['foreign-before-input', 'enter-private-outbound'],
    ['foreign-before-save', 'save-private-outbound'],
    ['dump-failure', 'open-visible-form'],
    ['cat-failure', 'open-visible-form'],
    ['invalid-layout', 'open-visible-form']
  ]) {
    const test = mockUi(mode);
    await assert.rejects(importOutboundText(syntheticText, test.io));
    assert.equal(test.state.stage, stage);
    assert.equal(test.state.dumps, test.state.cleanups);
    assert.equal(test.state.foreignActions, 0);
    if (['unsaved', 'foreign-start', 'foreign-after-open', 'foreign-before-input', 'dump-failure', 'cat-failure', 'invalid-layout'].includes(mode)) {
      assert.equal(test.state.writes, 0);
    }
    passed++;
  }
  const oversized = mockUi();
  await assert.rejects(importOutboundText(JSON.stringify({ ...outbound, tag: '中'.repeat(23000) }), oversized.io), /input-too-long/);
  assert.equal(oversized.state.dumps, 0); assert.equal(oversized.state.writes, 0); passed++;
  // Exercise the production error boundary with injected modules. No real file
  // or command is used, even though main() receives a synthetic --file argument.
  const helperSource = fs.readFileSync(path.join(__dirname, 'import-private-node.cjs'), 'utf8');
  const fakeModule = { exports: {} };
  let output = '';
  let errors = '';
  let commandOptionsChecked = false;
  function fakeRequire(id) {
    if (id === 'node:fs') return { readFileSync: () => syntheticText };
    if (id === 'node:child_process') return { execFileSync: (_, __, options) => {
      assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
      commandOptionsChecked = true;
      throw new Error('SYNTHETIC_PRIVATE_COMMAND_AND_CREDENTIAL');
    } };
    return require(id);
  }
  fakeRequire.main = fakeModule;
  await vm.runInNewContext(helperSource, { require: fakeRequire, module: fakeModule,
    process: { argv: ['node', 'helper', '--file', 'synthetic-only.json'],
      stdout: { write: value => { output += value; } }, stderr: { write: value => { errors += value; } } },
    setTimeout, Buffer });
  assert(commandOptionsChecked);
  assert.equal(output, '');
  assert.equal(JSON.parse(errors).saved, false);
  assert.equal(JSON.parse(errors).savedToCatalog, false);
  assert.equal(JSON.parse(errors).readbackReceiptVerified, false);
  assert(!errors.includes('SYNTHETIC_PRIVATE_COMMAND_AND_CREDENTIAL'));
  passed++;
  console.log(JSON.stringify({ passed, scope: 'Synthetic UI and persistence mocks only; no private file, device, HDC or network used.' }));
})().catch(error => {
  console.error('Synthetic import-confirmation test failed: ' + error.message);
  process.exitCode = 1;
});
