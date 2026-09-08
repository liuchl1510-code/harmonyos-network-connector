'use strict';

// Explicit UI actions only. AX trees and raw hilog remain in memory; no names,
// addresses, configuration, private errors, or raw UI trees are persisted.
// Usage: node scripts/test-node-latency-device.cjs Inspect|OpenNodes|TestFirst|
//        TestSecond|Cancel|TestCancel|Back|Journal|JournalBack
// Cancel only cancels an existing test. TestCancel starts the first row and
// immediately requests cancellation. No mode changes network settings or nodes.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const HDC = 'C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe';
const MODES = ['Inspect', 'OpenNodes', 'TestFirst', 'TestSecond', 'Cancel', 'TestCancel', 'Back', 'Journal', 'JournalBack'];
const NODE_ID = /^[A-Za-z0-9_-]{1,96}$/;
const HOME_STATES = ['未连接', '已连接', '正在连接', '正在恢复连接', '等待网络', '正在断开', '连接中断', '连接已结束', '正在验证'];
const REASONS = ['', 'dns', 'https', 'timeout', 'network-changed', 'stopped', 'configuration', 'internal'];
const JOURNAL_CATEGORIES = {
  '开始连接': 'session-start', '网络变化': 'network-change', '开始恢复连接': 'recovery-start',
  '连接恢复成功': 'recovery-ok', '连接恢复失败': 'recovery-failed', '等待网络恢复': 'waiting-network',
  '已拒绝过期连接请求': 'protect-stale-before', '已丢弃过期连接结果': 'protect-stale-after',
  '连接保护失败': 'protect-api-failed', '收到断开请求': 'stop-requested', '连接已停止': 'session-stopped',
  '开始延迟检测': 'latency-start', '延迟检测成功': 'latency-ok', '延迟检测未通过': 'latency-failed', '其他诊断事件': 'other'
};
class DriverError extends Error { constructor(code) { super(code); this.code = code; } }
function ensure(value, code) { if (!value) throw new DriverError(code); }
const visible = node => node.visible === true || node.visible === 'true';
const enabled = node => node.enabled === true || node.enabled === 'true';
function selectionLabel(node, id) {
  const labels = [];
  function visit(child) {
    const attributes = child?.attributes;
    // Read only the fixed label belonging to this selection button. Its parent
    // text may be empty, and adjacent node names must never be inspected.
    if (attributes && ['activeNodeLabel', `nodeSelectLabel-${id}`].includes(attributes.id)) {
      ensure(['已选中', '选用'].includes(attributes.text), 'SELECTION_LABEL_UNRECOGNIZED');
      labels.push(attributes.text);
    }
    for (const nested of child?.children || []) visit(nested);
  }
  for (const child of node?.children || []) visit(child);
  ensure(labels.length <= 1, 'SELECTION_LABEL_AMBIGUOUS');
  return labels[0];
}
function flatten(node, result = []) {
  if (node?.attributes) {
    const attributes = node.attributes;
    if (/^(nodeName|selectNode)-/.test(attributes.id || '')) {
      const item = { id: attributes.id, type: attributes.type, visible: attributes.visible,
        enabled: attributes.enabled, bounds: attributes.bounds };
      if (attributes.id.startsWith('selectNode-')) {
        item.selectionLabel = selectionLabel(node, attributes.id.slice('selectNode-'.length));
      }
      result.push(item);
    } else result.push(attributes);
  }
  for (const child of node?.children || []) flatten(child, result);
  return result;
}
function byId(nodes, id) {
  const matches = nodes.filter(node => node.id === id);
  ensure(matches.length === 1, 'CONTROL_MISSING_OR_AMBIGUOUS');
  return matches[0];
}
function pageOf(nodes) {
  ensure(!nodes.some(node => ['nodeInput', 'subscriptionUrl', 'renameNodeInput', 'confirmDeleteNode'].includes(node.id)), 'PRIVATE_OR_EDIT_FORM_OPEN');
  if (nodes.some(node => node.id === 'homePage') ||
    (nodes.some(node => node.id === 'toggleConnection') && nodes.some(node => node.id === 'connectionState'))) {
    ensure(nodes.some(node => visible(node) && ['homePage', 'toggleConnection', 'connectionState', 'openNodeConfig'].includes(node.id)), 'PAGE_NOT_VISIBLE');
    return 'home';
  }
  if (nodes.some(node => node.id === 'nodeCount' || node.id === 'backToConnection' || /^(nodeName|nodeLatency|testNodeLatency|selectNode)-/.test(node.id || ''))) {
    ensure(nodes.some(node => visible(node) && (['nodeCount', 'backToConnection', 'cancelNodeLatency'].includes(node.id) || /^(nodeName|nodeLatency|testNodeLatency|selectNode)-/.test(node.id || ''))), 'PAGE_NOT_VISIBLE');
    return 'nodes';
  }
  if (nodes.some(node => node.id === 'diagnosticEventCount') && nodes.some(node => node.id === 'backFromDiagnosticJournal')) return 'journal';
  if (nodes.some(node => visible(node) && ['settingsTitle', 'openSettingsDiagnostics', 'openDeveloperTools'].includes(node.id))) return 'settings';
  throw new DriverError('UNEXPECTED_FOREGROUND_PAGE');
}
function homeState(nodes, requireDisconnected = false) {
  ensure(pageOf(nodes) === 'home', 'HOME_REQUIRED');
  if (!['connectionState', 'toggleConnection'].every(id => nodes.some(node => node.id === id))) {
    ensure(!requireDisconnected, 'HOME_STATUS_NOT_IN_VIEWPORT');
    return { page: 'home', state: null, disconnected: null, statusInViewport: false };
  }
  const state = byId(nodes, 'connectionState').text;
  ensure(HOME_STATES.includes(state), 'CONNECTION_STATE_UNKNOWN');
  const disconnected = ['未连接', '连接已结束'].includes(state) && byId(nodes, 'toggleConnection').text === '连接' &&
    enabled(byId(nodes, 'toggleConnection'));
  if (requireDisconnected) ensure(disconnected, 'DISCONNECT_BEFORE_LATENCY_TEST');
  return { page: 'home', state, disconnected };
}
function latencyLabel(text) {
  ensure(typeof text === 'string', 'LATENCY_LABEL_UNAVAILABLE');
  const parts = text.split(' · ');
  ensure(parts.length <= 2, 'LATENCY_LABEL_UNRECOGNIZED');
  const label = parts[0];
  const passed = /^HTTPS (\d{1,5}) ms$/.exec(label);
  const pending = ['正在检测 HTTPS…', '正在准备检测…'].includes(label);
  const result = /^(失败|已取消)：(DNS 检查未通过|HTTPS 检查未通过|检测超时|网络已变化|连接已停止|节点配置无效或已变化|检测未完成)$/.exec(label);
  ensure(passed || pending || result || ['未检测', '检测记录无效'].includes(label), 'LATENCY_LABEL_UNRECOGNIZED');
  const durationMs = passed ? Number(passed[1]) : null;
  ensure(durationMs === null || durationMs <= 60000, 'LATENCY_DURATION_INVALID');
  const checkedAtLabel = parts[1] && /^[0-9/\-:.\s年月日上下午夜早晚APMapm]{1,80}$/.test(parts[1]) ? parts[1] : null;
  return { label, status: pending ? 'pending' : passed ? 'passed' : result ? (result[1] === '已取消' ? 'cancelled' : 'failed') : 'unmeasured', durationMs, checkedAtLabel };
}
function catalogState(nodes, requireEditable = false) {
  ensure(pageOf(nodes) === 'nodes', 'NODES_REQUIRED');
  const countMatch = /^共 (\d+) 个节点$/.exec(byId(nodes, 'nodeCount').text || '');
  ensure(countMatch && Number(countMatch[1]) === 2, 'EXPECTED_EXACTLY_TWO_NODES');
  ensure((byId(nodes, 'nodeSearch').text || '') === '', 'SEARCH_FILTER_MUST_BE_EMPTY');
  const ids = nodes.filter(node => /^nodeName-/.test(node.id || '')).map(node => node.id.slice('nodeName-'.length));
  ensure(ids.length === 2 && new Set(ids).size === 2 && ids.every(id => NODE_ID.test(id)), 'NODE_IDS_UNAVAILABLE');
  const selected = ids.filter(id => {
    const label = byId(nodes, `selectNode-${id}`).selectionLabel;
    ensure(['已选中', '选用'].includes(label), 'SELECTION_LABEL_UNAVAILABLE');
    return label === '已选中';
  });
  ensure(selected.length === 1, 'SELECTED_NODE_UNAVAILABLE');
  const rows = ids.map(id => ({ id, latency: latencyLabel(byId(nodes, `nodeLatency-${id}`).text),
    testEnabled: enabled(byId(nodes, `testNodeLatency-${id}`)) }));
  const cancellation = nodes.filter(node => node.id === 'cancelNodeLatency');
  ensure(cancellation.length <= 1, 'CANCEL_CONTROL_AMBIGUOUS');
  const cancelAvailable = cancellation.length === 1 && enabled(cancellation[0]);
  const editable = enabled(byId(nodes, 'addNodes')) && rows.every(row => row.testEnabled) && cancellation.length === 0;
  if (requireEditable) ensure(editable, 'NODE_TEST_OR_CONNECTION_BUSY');
  return { page: 'nodes', count: 2, ids, selectedId: selected[0], editable, cancelAvailable, rows };
}
function compareCatalog(before, after) {
  return { countUnchanged: before.count === after.count,
    idsUnchanged: before.ids.length === after.ids.length && before.ids.every(id => after.ids.includes(id)),
    selectionUnchanged: before.selectedId === after.selectedId };
}
function safeEvents(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const prefix = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+\d+\s+[A-Z]\s+[^\s]*HarmonyVpnLab:\s*(.*)$/.exec(line);
    if (!prefix) continue;
    const body = prefix[3], at = prefix[1], pid = Number(prefix[2]);
    let match = /^CONNECTION_ACTIVE runId=(\d{13}) scope=(application|all-applications) kind=(wifi|cellular|ethernet|other|unavailable|node-latency|connection|connection-test|connection-app-test) recoveries=(\d+)$/.exec(body);
    if (match) {
      events.push({ code: 'CONNECTION_ACTIVE', at, pid, runId: match[1], scope: match[2], kind: match[3], recoveries: Number(match[4]) });
      continue;
    }
    match = /^CONNECTION_STOPPED runId=(\d{13}) cleanup=(true|false)$/.exec(body);
    if (match) { events.push({ code: 'CONNECTION_STOPPED', at, pid, runId: match[1], cleanupConfirmed: match[2] === 'true' }); continue; }
    match = /^NODE_LATENCY_RESULT runId=(\d{13}) status=(passed|failed|cancelled) durationMs=(\d{1,5}) reason=([a-z-]*)\s*$/.exec(body);
    if (match && Number(match[3]) <= 60000 && REASONS.includes(match[4])) {
      events.push({ code: 'NODE_LATENCY_RESULT', at, pid, runId: match[1], status: match[2], durationMs: Number(match[3]), reason: match[4] });
    }
  }
  return events;
}
function journalState(nodes) {
  ensure(pageOf(nodes) === 'journal', 'JOURNAL_REQUIRED');
  const count = /^最近 (\d+) 条事件，最新记录在前$/.exec(byId(nodes, 'diagnosticEventCount').text || '');
  ensure(count && Number(count[1]) <= 200, 'JOURNAL_COUNT_UNRECOGNIZED');
  const labels = [];
  for (const node of nodes.filter(visible)) {
    const text = node.text;
    if (Object.hasOwn(JOURNAL_CATEGORIES, text)) labels.push({ type: 'event', code: JOURNAL_CATEGORIES[text] });
    else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text || '')) labels.push({ type: 'time', value: text });
    else if (['资源清理已确认', '资源清理尚未确认'].includes(text)) labels.push({ type: 'cleanup', confirmed: text === '资源清理已确认' });
    else {
      const metric = /^(本次连接网络版本|本次连接累计恢复|本次连接累计拒绝|本次连接累计丢弃|本次连接累计保护失败|HTTPS 耗时)：(\d+)(?: 次| ms)?$/.exec(text || '');
      if (metric) labels.push({ type: 'metric', label: metric[1], value: Number(metric[2]) });
    }
  }
  return { page: 'journal', eventCount: Number(count[1]), visibleLabels: labels, coverage: 'visible_fixed_labels_only' };
}
function createDriver(mode) {
  let device, deadline = Infinity;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve(__dirname, '..', 'build', 'node-latency-tests');
  const outputPath = path.join(outputDir, `${stamp}-${mode}.json`);
  const progress = { mode, startedAt: new Date().toISOString(), stage: 'starting' };
  const remote = `/data/local/tmp/harmonyvpnlab-node-latency-${process.pid}-${Date.now()}.json`;
  function checkpoint(values) {
    Object.assign(progress, values);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(progress, null, 2) + '\n', 'utf8');
  }
  function command(args, cleanup = false) {
    const remaining = cleanup ? 10000 : Math.min(10000, Math.ceil(deadline - performance.now()));
    ensure(remaining > 0, 'RESULT_WAIT_TIMEOUT');
    try {
      const value = cp.execFileSync(HDC, args, { encoding: 'utf8', windowsHide: true, timeout: remaining, maxBuffer: 8 * 1024 * 1024 });
      ensure(!/\[Fail\]|device.*not found|no connected device|\boffline\b/i.test(value), 'DEVICE_COMMAND_FAILED');
      return value;
    } catch (error) { if (error instanceof DriverError) throw error; throw new DriverError('DEVICE_COMMAND_FAILED'); }
  }
  const shell = (...args) => command(['-t', device, 'shell', ...args]);
  function verifyDevice() {
    const matches = command(['list', 'targets', '-v']).split(/\r?\n/).filter(line => /\sUSB\s+Connected\s/.test(line));
    ensure(matches.length === 1, 'EXPECTED_ONE_USB_CONNECTED_DEVICE');
    const next = matches[0].trim().split(/\s+/)[0];
    ensure(/^[A-Za-z0-9._:-]+$/.test(next) && (!device || device === next), 'DEVICE_CHANGED_OR_INVALID'); device = next;
  }
  function layout() {
    let raw;
    try { shell('uitest', 'dumpLayout', '-p', remote); raw = shell('cat', remote); }
    finally { command(['-t', device, 'shell', 'rm', '-f', remote], true); }
    let nodes;
    try { nodes = flatten(JSON.parse(raw)); } catch (_) { throw new DriverError('LAYOUT_UNAVAILABLE'); }
    pageOf(nodes); return nodes;
  }
  function rect(node) {
    const values = String(node.bounds).match(/-?\d+/g)?.map(Number);
    ensure(values?.length === 4 && values.every(Number.isSafeInteger) && values[2] > values[0] && values[3] > values[1], 'CONTROL_BOUNDS_INVALID');
    return values;
  }
  async function wait(ms) { await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, deadline - performance.now())))); }
  async function find(id, requireEnabled = true) {
    let nodes = layout(), page = pageOf(nodes);
    const match = () => nodes.find(node => node.id === id && visible(node));
    if (match()) { if (requireEnabled) ensure(enabled(match()), 'CONTROL_DISABLED'); return match(); }
    const directions = ['nodeCount', 'nodeSearch', 'addNodes', 'cancelNodeLatency', 'connectionState', 'toggleConnection',
      'openNodeConfig', 'settingsTitle', 'openSettingsDiagnostics', 'backFromDiagnosticJournal']
      .includes(id) ? [false, true] : [true, false];
    for (const towardBottom of directions) for (let index = 0; index < 5; index++) {
      const scrolls = nodes.filter(node => node.type === 'Scroll' && visible(node));
      ensure(scrolls.length === 1, 'SCROLL_UNAVAILABLE');
      const [left, top, right, bottom] = rect(scrolls[0]);
      const x = Math.round((left + right) / 2), a = Math.round(top + (bottom - top) * 0.2), b = Math.round(top + (bottom - top) * 0.8);
      shell('uitest', 'uiInput', 'swipe', String(x), String(towardBottom ? b : a), String(x), String(towardBottom ? a : b));
      await wait(120); nodes = layout(); ensure(pageOf(nodes) === page, 'PAGE_CHANGED_DURING_SCROLL');
      if (match()) { if (requireEnabled) ensure(enabled(match()), 'CONTROL_DISABLED'); return match(); }
    }
    throw new DriverError('CONTROL_NOT_VISIBLE');
  }
  async function click(id) {
    const [left, top, right, bottom] = rect(await find(id));
    shell('uitest', 'uiInput', 'click', String(Math.floor((left + right) / 2)), String(Math.floor((top + bottom) / 2)));
    await wait(150);
  }
  const events = () => safeEvents(shell('hilog', '-x', '-T', 'HarmonyVpnLab'));
  async function catalogSnapshot(requireEditable = false) {
    // AX contains only the current viewport. Never reuse a previous poll's tree
    // or enabled flags. Bracket every scroll sweep with the live header state;
    // if the test completed during the sweep, discard it and take a fresh one.
    function header(nodes) {
      ensure(pageOf(nodes) === 'nodes', 'PAGE_CHANGED_DURING_CATALOG');
      const cancel = nodes.filter(node => node.id === 'cancelNodeLatency');
      ensure(cancel.length <= 1, 'CANCEL_CONTROL_AMBIGUOUS');
      return JSON.stringify({ count: byId(nodes, 'nodeCount').text, search: byId(nodes, 'nodeSearch').text || '',
        editable: enabled(byId(nodes, 'addNodes')), cancelling: cancel.length === 1,
        cancelEnabled: cancel.length === 1 && enabled(cancel[0]) });
    }
    for (let retry = 0; retry < 3; retry++) {
      await find('nodeSearch', false);
      let nodes = layout(); const before = header(nodes), collected = new Map();
      function absorb(current) {
        ensure(pageOf(current) === 'nodes', 'PAGE_CHANGED_DURING_CATALOG');
        for (const node of current) {
          if (!['nodeCount', 'nodeSearch', 'addNodes', 'cancelNodeLatency'].includes(node.id) &&
            !/^(nodeName|nodeLatency|testNodeLatency|selectNode)-/.test(node.id || '')) continue;
          if (/^selectNode-/.test(node.id) && !node.selectionLabel) continue;
          if (/^selectNode-/.test(node.id) && collected.has(node.id)) {
            ensure(collected.get(node.id).selectionLabel === node.selectionLabel, 'SELECTION_CHANGED_DURING_CATALOG');
          }
          // flatten has already removed node names without accessing their text.
          collected.set(node.id, node);
        }
      }
      function complete() {
        const ids = [...collected.keys()].filter(id => id.startsWith('nodeName-')).map(id => id.slice(9));
        return ids.length === 2 && ids.every(id => ['selectNode-', 'nodeLatency-', 'testNodeLatency-'].every(prefix => collected.has(prefix + id)));
      }
      absorb(nodes);
      for (let scroll = 0; !complete() && scroll < 8; scroll++) {
        const panes = nodes.filter(node => node.type === 'Scroll' && visible(node));
        ensure(panes.length === 1, 'SCROLL_UNAVAILABLE');
        const [left, top, right, bottom] = rect(panes[0]), x = Math.round((left + right) / 2);
        shell('uitest', 'uiInput', 'swipe', String(x), String(Math.round(top + (bottom - top) * .75)),
          String(x), String(Math.round(top + (bottom - top) * .25)));
        await wait(100); nodes = layout(); absorb(nodes);
      }
      ensure(complete(), 'CATALOG_VIEWPORTS_INCOMPLETE');
      await find('nodeSearch', false);
      const afterNodes = layout();
      if (header(afterNodes) !== before) continue;
      absorb(afterNodes);
      return catalogState([...collected.values()], requireEditable);
    }
    throw new DriverError('CATALOG_STATE_CHANGED_DURING_READ');
  }
  async function ensureNodeEditingIdle() {
    ensure(pageOf(layout()) === 'nodes', 'NODES_REQUIRED');
    await catalogSnapshot(true); // Check add and both test controls without opening the menu.
  }
  async function homeSnapshot(requireDisconnected = false) {
    ensure(pageOf(layout()) === 'home', 'HOME_REQUIRED');
    await find('connectionState', false);
    await find('toggleConnection', false);
    return homeState(layout(), requireDisconnected);
  }
  async function openNodes() {
    const current = layout();
    if (pageOf(current) === 'nodes') return catalogSnapshot(true);
    await homeSnapshot(true); await click('openNodeConfig'); return catalogSnapshot(true);
  }
  async function readyForTest() {
    let current = layout(), prior;
    if (pageOf(current) === 'nodes') {
      prior = await catalogSnapshot(true);
      await click('backToConnection'); current = layout();
    }
    await homeSnapshot(true);
    const baseline = await openNodes();
    if (prior) ensure(Object.values(compareCatalog(prior, baseline)).every(Boolean), 'CATALOG_CHANGED_BEFORE_TEST');
    return baseline;
  }
  async function waitForResult(baseline, testedId, initialEvents, existingRun = null, cancellation = false) {
    deadline = performance.now() + 40000;
    const known = new Set(initialEvents.map(event => JSON.stringify(event)));
    let runId = existingRun;
    while (performance.now() < deadline) {
      verifyDevice();
      const state = await catalogSnapshot();
      const invariants = compareCatalog(baseline, state);
      ensure(Object.values(invariants).every(Boolean), 'CATALOG_OR_SELECTION_CHANGED');
      const captured = events();
      const fresh = captured.filter(event => !known.has(JSON.stringify(event)));
      // ACTIVE.kind is the physical network type. The fresh latency result is
      // the authoritative association of this application-only test with runId.
      const candidates = [...new Set(fresh.filter(event => event.code === 'NODE_LATENCY_RESULT').map(event => event.runId))];
      if (!runId && candidates.length === 1) runId = candidates[0];
      ensure(candidates.length <= 1 && (!runId || candidates.every(value => value === runId)), 'LATENCY_RUN_AMBIGUOUS');
      const directed = runId ? captured.filter(event => event.runId === runId) : [];
      const result = directed.findLast(event => event.code === 'NODE_LATENCY_RESULT');
      const stopped = directed.findLast(event => event.code === 'CONNECTION_STOPPED');
      const row = state.rows.find(item => item.id === testedId);
      checkpoint({ stage: 'waiting-for-result', baseline, testedId, runId, cancellationRequested: cancellation,
        after: state, invariants, safeEvents: directed, logCoverage: 'periodic_buffer_snapshot_fixed_markers_only' });
      if (result && stopped?.cleanupConfirmed && state.editable && row.latency.status === result.status &&
        (result.status !== 'passed' || row.latency.durationMs === result.durationMs)) {
        if (cancellation) ensure(result.status === 'cancelled', 'CANCELLATION_DID_NOT_WIN');
        deadline = Infinity;
        checkpoint({ stage: 'completed', completedAt: new Date().toISOString(), result,
          cleanupConfirmed: true, testControlsReenabled: true, invariants,
          passed: result.status === (cancellation ? 'cancelled' : 'passed') });
        return progress;
      }
      await wait(500);
    }
    throw new DriverError('RESULT_WAIT_TIMEOUT');
  }
  async function run() {
    verifyDevice();
    if (mode === 'Inspect') {
      const nodes = layout(), page = pageOf(nodes);
      checkpoint({ stage: 'completed', state: page === 'home' ? homeState(nodes) : page === 'nodes' ? await catalogSnapshot() :
        page === 'settings' ? { page: 'settings' } : journalState(nodes) });
    } else if (mode === 'OpenNodes') checkpoint({ stage: 'completed', state: await openNodes() });
    else if (['TestFirst', 'TestSecond', 'TestCancel'].includes(mode)) {
      const baseline = await readyForTest(), testedId = baseline.ids[mode === 'TestSecond' ? 1 : 0], before = events();
      checkpoint({ stage: 'before-test', homeDisconnectedVerified: true, baseline, testedId });
      await click(`testNodeLatency-${testedId}`);
      if (mode === 'TestCancel') {
        await click('cancelNodeLatency');
      }
      await waitForResult(baseline, testedId, before, null, mode === 'TestCancel');
    } else if (mode === 'Cancel') {
      const baseline = await catalogSnapshot();
      const pending = baseline.rows.filter(row => row.latency.status === 'pending');
      ensure(baseline.cancelAvailable && !baseline.editable && pending.length === 1, 'NO_EXISTING_LATENCY_TEST');
      const before = events();
      const running = before.filter(event => event.code === 'CONNECTION_ACTIVE' &&
        event.scope === 'application' && !before.some(stop => stop.code === 'CONNECTION_STOPPED' && stop.runId === event.runId));
      ensure(new Set(running.map(event => event.runId)).size <= 1, 'LATENCY_RUN_AMBIGUOUS');
      checkpoint({ stage: 'before-cancel', baseline, testedId: pending[0].id });
      await click('cancelNodeLatency');
      await waitForResult(baseline, pending[0].id, before, running.at(-1)?.runId || null, true);
    } else if (mode === 'Back') {
      await ensureNodeEditingIdle(); await click('backToConnection');
      checkpoint({ stage: 'completed', state: await homeSnapshot(true) });
    } else if (mode === 'Journal') {
      let current = layout();
      if (pageOf(current) === 'nodes') { await ensureNodeEditingIdle(); await click('backToConnection'); current = layout(); }
      if (pageOf(current) === 'home') { await homeSnapshot(true); await click('navSettings'); current = layout(); }
      if (pageOf(current) === 'settings') { await click('openSettingsDiagnostics'); }
      checkpoint({ stage: 'completed', state: journalState(layout()) });
    } else if (mode === 'JournalBack') {
      journalState(layout()); await click('backFromDiagnosticJournal');
      if (pageOf(layout()) === 'settings') await click('navHome');
      checkpoint({ stage: 'completed', state: await homeSnapshot(true) });
    }
    process.stdout.write(JSON.stringify(progress) + '\n');
  }
  return { run, fail(error) {
    deadline = Infinity;
    checkpoint({ stage: 'failed', failure: error instanceof DriverError ? error.code : 'DRIVER_FAILED',
      stoppedIssuingActions: true, note: 'Driver does not force-stop or change network settings; inspect current state before further action.' });
    process.stderr.write(JSON.stringify(progress) + '\n');
  } };
}
module.exports = { DriverError, flatten, pageOf, homeState, latencyLabel, catalogState, compareCatalog, safeEvents, journalState };
if (require.main === module) {
  const mode = process.argv[2] || 'Inspect';
  if (!MODES.includes(mode) || process.argv.length > 3) {
    process.stderr.write('Invalid mode. Use Inspect/OpenNodes/TestFirst/TestSecond/Cancel/TestCancel/Back/Journal/JournalBack.\n');
    process.exitCode = 1;
  } else {
    const driver = createDriver(mode);
    driver.run().catch(error => { driver.fail(error); process.exitCode = 1; });
  }
}
