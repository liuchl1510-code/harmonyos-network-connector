'use strict';
// Opt-in, bounded UI actions. Merely loading this module never contacts a phone.
// BatchStart starts app-only HTTPS tests; BlockCloudflareSave and
// RestoreNetworkDefaults explicitly save network settings. No connect/home
// switch, node edits, node selection, restore, or picker save action is exposed.
// AX is kept in memory; its unique device temporary file is removed immediately.
const cp = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const HDC = path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/toolchains/hdc.exe');
const BUNDLE = 'com.example.harmonyvpnlab';
const FIXTURE = 'full:www.cloudflare.com';
const DNS_FIXTURE = 'https://cloudflare-dns.com/dns-query';
const MODES = ['Inspect', 'Nodes', 'Settings', 'NetworkSettings', 'NetworkBack', 'RoutingGlobal', 'RoutingRules',
  'BypassLanOn', 'BypassLanOff', 'BypassLanToggle', 'SaveNetwork', 'BlockCloudflareSave', 'DirectCloudflare', 'DnsHostname', 'RestoreNetworkDefaults',
  'Backup', 'BackupBack', 'BackupSavePicker', 'EditorFirst', 'EditorBack', 'BatchStart', 'BatchCancel',
  'SortLatency', 'SortOriginal', 'SelfTest'];
const PAGES = {
  home: ['homePage', 'connectionState', 'toggleConnection'],
  settings: ['settingsTitle', 'openNetworkSettings', 'openNodeBackup', 'appearance-system'],
  nodes: ['nodeCount', 'nodeSearch', 'backToConnection', 'testFilteredNodes', 'sortNodeLatency', 'batchLatencyProgress', 'cancelNodeLatency'],
  network: ['backFromNetworkSettings', 'routingGlobal', 'routingRules', 'bypassLan', 'routingDirect', 'routingProxy',
    'routingBlock', 'dnsUrl', 'resetDns', 'saveNetworkSettings', 'networkSettingsResult'],
  backup: ['backFromNodeBackup', 'backupCurrentCount', 'exportNodeCatalog', 'exportSingleNode', 'previewNodeBackup', 'nodeBackupResult'],
  editor: ['backFromNodeEditor', 'editNodeProtocol', 'toggleNodeJsonEditor', 'saveNodeEditor']
};
const TABS = { home: 'navHome', nodes: 'navNodes', settings: 'navSettings' };
const FIXED = new Set([...Object.values(PAGES).flat(), ...Object.values(TABS)]);
const CLICK = new Set([...Object.values(TABS), 'openNetworkSettings', 'openNodeBackup', 'backFromNetworkSettings',
  'routingGlobal', 'routingRules', 'bypassLan', 'resetDns', 'saveNetworkSettings', 'backFromNodeBackup',
  'exportNodeCatalog', 'exportSingleNode', 'backFromNodeEditor', 'testFilteredNodes', 'cancelNodeLatency', 'sortNodeLatency']);
const RULE_INPUTS = new Set(['routingDirect', 'routingProxy', 'routingBlock']);
const INPUTS = new Set([...RULE_INPUTS, 'dnsUrl']);
const ROW = /^(nodeMore|editNode|exportNode|nodeName|testNodeLatency|selectNode)-([A-Za-z0-9_-]{1,96})$/;
const TOP = new Set(['routingGlobal', 'routingRules', 'bypassLan', 'backFromNetworkSettings', 'backFromNodeBackup',
  'backFromNodeEditor', 'testFilteredNodes', 'sortNodeLatency', 'nodeCount']);
class DriverError extends Error { constructor(code) { super(code); this.code = code; } }
const ensure = (condition, code) => { if (!condition) throw new DriverError(code); };
const flag = value => value === true || value === 'true';
const hashId = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);

function parseCommandLine(args) {
  let mode = 'Inspect', target = '', modeSeen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') {
      ensure(!target && i + 1 < args.length && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(args[i + 1]), 'INVALID_TARGET');
      target = args[++i];
    } else {
      ensure(!modeSeen && MODES.includes(args[i]), 'INVALID_MODE');
      mode = args[i]; modeSeen = true;
    }
  }
  return { mode, target };
}

function selectUsbTarget(listing, requested = '', current = '') {
  ensure(!requested || /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requested), 'INVALID_TARGET');
  const connected = listing.split(/\r?\n/).filter(line => /\sUSB\s+Connected\s/.test(line))
    .map(line => line.trim().split(/\s+/)[0]);
  const candidates = requested ? connected.filter(id => id === requested) : connected;
  ensure(candidates.length === 1, requested ? 'TARGET_NOT_USB_CONNECTED' : 'EXPECTED_ONE_USB_DEVICE');
  const next = candidates[0];
  ensure(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(next) && (!current || current === next), 'DEVICE_CHANGED');
  return next;
}

function appHasFocus(dump) {
  // Read only the known WindowManager table schema. Never return any row text,
  // names or PIDs; the caller receives one boolean for this app's process.
  if (!/^\s*WindowName\s+DisplayId\s+Pid\s+WinId\b/m.test(dump)) return false;
  const focused = [...dump.matchAll(/^\s*Focus window:\s*(\d+)\s*$/gm)].map(match => Number(match[1]));
  if (focused.length !== 1) return false;
  const rows = dump.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts =>
    parts.length >= 4 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]) && /^\d+$/.test(parts[3]));
  const appPids = [...new Set(rows.filter(parts => /^harmonyvpnlab\d+$/.test(parts[0])).map(parts => Number(parts[2])))];
  const focusedRows = rows.filter(parts => Number(parts[3]) === focused[0]);
  return appPids.length === 1 && appPids[0] > 0 && focusedRows.length === 1 && Number(focusedRows[0][2]) === appPids[0];
}

function projectLayout(tree, appFocused = false, expectedMenuNodeId = '') {
  const controls = [], rows = [], scrolls = [], foreign = new Set(), dataMenuItems = [];
  const expectedMenu = /^[A-Za-z0-9_-]{1,96}$/.test(expectedMenuNodeId);
  const menuLabels = ['编辑节点', '导出节点 JSON', '改名', '删除'];
  let critical = false, dialog = false, embeddedPicker = false, nodeCount, sceneDecoration = false, appControlsVisible = false;
  function visit(node, parentOwned = false, parentSidebar = false) {
    const a = node?.attributes;
    const inSidebar = parentSidebar || a?.id === 'appSideNavigation';
    let owned = parentOwned;
    if (a) {
      const visible = flag(a.visible), id = String(a.id || ''), bundle = String(a.bundleName || '');
      if (bundle) owned = bundle === BUNDLE;
      if (visible) {
        if (/keyguard|screenlock|lockscreen|biometric|permissiondialog/i.test(id)) critical = true;
        // Document pickers can be hosted inside our own bundle; their modal
        // layer still occludes all underlying application controls.
        if (['Dialog', 'AlertDialog', 'SystemDialog', 'UIExtensionComponent', 'ModalPage', 'SheetWrapper', 'SheetPage'].includes(a.type)) dialog = true;
        if (['PathSelectTreeHeader', 'PathSelectTreeScroll'].includes(id) ||
          ['PathSelectTreeHeader', 'PathSelectTreeScroll'].includes(a.type)) embeddedPicker = true;
        if (bundle === 'com.ohos.sceneboard' && a.type === 'WindowScene') sceneDecoration = true;
        else if (bundle && bundle !== BUNDLE && !/inputmethod|keyboard|\.ime(?:\.|$)/i.test(bundle)) foreign.add(bundle);
        if (a.type === 'Scroll' && !inSidebar) scrolls.push({ bounds: a.bounds });
        if (expectedMenu && owned && ['MenuItem', 'Option'].includes(a.type) && !ROW.test(id)) {
          // Data-driven MenuElement entries have no authored id. Only retain
          // the four fixed action labels, never arbitrary menu or Text content.
          const labels = new Set();
          if (menuLabels.includes(a.text)) labels.add(a.text);
          function collectMenuLabel(child) {
            const childAttributes = child?.attributes;
            if (childAttributes?.type === 'Text' && menuLabels.includes(childAttributes.text)) labels.add(childAttributes.text);
            for (const nested of child?.children || []) collectMenuLabel(nested);
          }
          for (const child of node.children || []) collectMenuLabel(child);
          if (labels.size === 1) dataMenuItems.push({ label: [...labels][0], visible, enabled: flag(a.enabled), bounds: a.bounds });
        }
      }
      if (FIXED.has(id) || ROW.test(id)) {
        if (FIXED.has(id) && visible && owned) appControlsVisible = true;
        const control = { id, visible, enabled: flag(a.enabled), bounds: a.bounds };
        // Only approved synthetic routing inputs are ever retained for internal
        // verification. Node names, credentials, editor values are never read.
        if (INPUTS.has(id)) control.inputValue = typeof a.text === 'string' ? a.text : '';
        if (id === 'nodeCount' && /^共\s*\d+\s*个节点$/.test(String(a.text))) nodeCount = Number(String(a.text).match(/\d+/)[0]);
        if (id === 'networkSettingsResult') control.saved = a.text === '网络设置已保存，下次连接时生效。';
        if (id === 'batchLatencyProgress') {
          const progress = /^已完成 (\d+)\/(\d+)/.exec(String(a.text));
          if (progress) control.progress = { completed: Number(progress[1]), total: Number(progress[2]) };
        }
        if (['routingGlobal', 'routingRules', 'sortNodeLatency'].includes(id)) {
          const labels = [];
          function collectLabel(n) {
            if (n?.attributes && typeof n.attributes.text === 'string') labels.push(n.attributes.text);
            for (const child of n?.children || []) collectLabel(child);
          }
          collectLabel(node);
          if (id === 'sortNodeLatency') control.sorted = labels.includes('恢复原顺序') ? true : labels.includes('按 HTTPS 耗时排序') ? false : undefined;
          else control.selected = labels.includes(id === 'routingGlobal' ? '✓ 全部代理' : '✓ 规则分流');
        }
        if (id === 'bypassLan') {
          for (const key of ['checked', 'selected', 'isOn']) {
            if (a[key] === true || a[key] === 'true' || a[key] === false || a[key] === 'false') { control.checked = flag(a[key]); break; }
          }
        }
        if (Object.values(TABS).includes(id)) control.selected = [a.description, a.accessibilityDescription].includes('当前页面');
        (ROW.test(id) ? rows : controls).push(control);
      }
    }
    // Keep ownership/modal/private-field handling for every sidebar descendant.
    for (const child of node?.children || []) visit(child, owned, inSidebar);
  }
  visit(tree);
  // Mapping is scoped to the row whose More button this driver just clicked,
  // and requires the complete known node-actions menu inside our own app.
  // Existing authored editNode-* ids remain the preferred compatible path.
  if (expectedMenu && !critical && !dialog && !embeddedPicker && foreign.size === 0 &&
    rows.some(item => item.id === 'nodeMore-' + expectedMenuNodeId && item.visible) &&
    menuLabels.every(label => dataMenuItems.filter(item => item.label === label).length === 1) &&
    !rows.some(item => item.id === 'editNode-' + expectedMenuNodeId)) {
    const edit = dataMenuItems.find(item => item.label === '编辑节点');
    rows.push({ id: 'editNode-' + expectedMenuNodeId, visible: edit.visible, enabled: edit.enabled, bounds: edit.bounds });
  }
  // The only observed decoration exception is SceneBoard/WindowScene, and it
  // requires both controls under our app root and WindowManager focus evidence.
  if (sceneDecoration && !(appFocused && appControlsVisible)) foreign.add('com.ohos.sceneboard');
  const external = [...foreign];
  return { controls, rows, scrolls, nodeCount, critical, dialog, sceneDecoration, appControlsVisible,
    external: external.length > 0, picker: embeddedPicker || external.some(bundle => /filepicker|filemanager|documentpicker/i.test(bundle)) };
}
function pageOf(layout) {
  if (layout.critical) return 'blocked';
  if (layout.picker) return 'system-file-picker';
  if (layout.external) return 'external-foreground';
  if (layout.dialog) return 'dialog';
  const ids = new Set(layout.controls.filter(item => item.visible).map(item => item.id));
  const candidates = Object.entries(PAGES).filter(([, markers]) => markers.some(id => ids.has(id))).map(([page]) => page);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    if (layout.rows.some(item => item.visible)) return 'nodes';
    const selected = Object.entries(TABS).filter(([, id]) => layout.controls.some(item => item.id === id && item.visible && item.selected));
    if (selected.length === 1) return selected[0][0];
  }
  return candidates.length > 1 ? 'ambiguous' : 'unknown';
}
function requirePage(layout, page) { ensure(pageOf(layout) === page, 'UNEXPECTED_ACTION_PAGE'); }
function safeState(layout) {
  const page = pageOf(layout);
  if (['blocked', 'dialog', 'unknown', 'ambiguous', 'external-foreground', 'system-file-picker'].includes(page)) {
    return { page, actionsAllowed: false, pickerSaveAttempted: false };
  }
  const result = { page, coverage: 'current_viewport_only', controls: layout.controls.filter(item => item.visible).map(item => ({
    id: item.id, visible: item.visible, enabled: item.enabled,
    ...(typeof item.selected === 'boolean' ? { selected: item.selected } : {}),
    ...(typeof item.checked === 'boolean' ? { checked: item.checked } : {}),
    ...(typeof item.sorted === 'boolean' ? { sorted: item.sorted } : {}),
    ...(typeof item.saved === 'boolean' ? { saved: item.saved } : {}),
    ...(item.progress ? { progress: item.progress } : {})
  })) };
  if (page === 'nodes') {
    if (Number.isSafeInteger(layout.nodeCount)) result.nodeCount = layout.nodeCount;
    const ids = [...new Set(layout.rows.filter(item => item.visible).map(item => ROW.exec(item.id)[2]))];
    result.visibleRows = ids.map((id, index) => ({ ordinal: index + 1, key: hashId(id),
      controls: layout.rows.filter(item => item.visible && ROW.exec(item.id)[2] === id)
        .map(item => ({ kind: ROW.exec(item.id)[1], enabled: item.enabled })) }));
  }
  return result;
}
function rect(item) {
  const value = String(item.bounds).match(/-?\d+/g)?.map(Number);
  ensure(value?.length === 4 && value.every(Number.isSafeInteger) && value[0] >= 0 && value[1] >= 0 && value[2] > value[0] && value[3] > value[1], 'INVALID_BOUNDS');
  return value;
}
function createDriver(mode, targetDevice = '') {
  ensure(MODES.includes(mode) && mode !== 'SelfTest', 'INVALID_MODE');
  const deadline = performance.now() + (mode === 'RestoreNetworkDefaults' ? 120000 : 60000);
  const remote = `/data/local/tmp/harmonyvpnlab-network-ui-${process.pid}-${Date.now()}.json`;
  let device, expectedMenuNodeId = '';
  function command(args, cleanup = false) {
    const timeout = cleanup ? 10000 : Math.min(10000, Math.ceil(deadline - performance.now()));
    ensure(timeout > 0, 'OPERATION_TIMEOUT');
    try {
      const out = cp.execFileSync(HDC, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] });
      ensure(!/\[Fail\]|no connected device|device.*not found|\boffline\b/i.test(out), 'DEVICE_COMMAND_FAILED'); return out;
    } catch (error) { if (error instanceof DriverError) throw error; throw new DriverError('DEVICE_COMMAND_FAILED'); }
  }
  const shell = (...args) => command(['-t', device, 'shell', ...args]);
  function readLayout() {
    device = selectUsbTarget(command(['list', 'targets', '-v']), targetDevice, device);
    let raw;
    try { shell('uitest', 'dumpLayout', '-p', remote); raw = shell('cat', remote); }
    finally { command(['-t', device, 'shell', 'rm', '-f', remote], true); }
    try {
      const tree = JSON.parse(raw);
      const layout = projectLayout(tree, false, expectedMenuNodeId);
      if (layout.sceneDecoration && layout.appControlsVisible) {
        const focused = appHasFocus(shell('hidumper', '-s', 'WindowManagerService', '-a', '-a'));
        return projectLayout(tree, focused, expectedMenuNodeId);
      }
      return layout;
    } catch (error) { if (error instanceof DriverError) throw error; throw new DriverError('LAYOUT_UNAVAILABLE'); }
    finally { raw = undefined; }
  }
  async function pause(ms = 180) { ensure(performance.now() < deadline, 'OPERATION_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, ms)); }
  function match(layout, id, enabled = true) {
    const matches = [...layout.controls, ...layout.rows].filter(item => item.id === id && item.visible);
    ensure(matches.length <= 1, 'CONTROL_AMBIGUOUS');
    if (!matches.length) return undefined;
    if (enabled) ensure(matches[0].enabled, 'CONTROL_DISABLED'); rect(matches[0]); return matches[0];
  }
  async function find(id, page, enabled = true) {
    let layout = readLayout(); requirePage(layout, page);
    let found = match(layout, id, enabled); if (found) return found;
    ensure(!Object.values(TABS).includes(id), 'TAB_NOT_VISIBLE');
    for (const top of TOP.has(id) ? [true, false] : [false, true]) for (let i = 0; i < 5; i++) {
      ensure(layout.scrolls.length === 1, 'SCROLL_UNAVAILABLE');
      const [l, t, r, b] = rect(layout.scrolls[0]), x = Math.round(l + Math.min(12, (r - l) * .04));
      const upper = Math.round(t + (b - t) * .22), lower = Math.round(t + (b - t) * .78);
      shell('uitest', 'uiInput', 'swipe', String(x), String(top ? upper : lower), String(x), String(top ? lower : upper));
      await pause(120); layout = readLayout(); requirePage(layout, page);
      found = match(layout, id, enabled); if (found) return found;
    }
    throw new DriverError('CONTROL_NOT_VISIBLE');
  }
  async function click(id, page) {
    ensure(CLICK.has(id) || /^(nodeMore|editNode)-[A-Za-z0-9_-]{1,96}$/.test(id), 'ACTION_NOT_ALLOWED');
    await find(id, page); const layout = readLayout(); requirePage(layout, page);
    const item = match(layout, id); ensure(item, 'CONTROL_CHANGED');
    const [l, t, r, b] = rect(item); shell('uitest', 'uiInput', 'click', String(Math.floor((l + r) / 2)), String(Math.floor((t + b) / 2)));
    await pause();
  }
  async function awaitPage(pages) {
    const end = Math.min(deadline, performance.now() + 7000); let last;
    while (performance.now() < end) {
      last = readLayout(); const page = pageOf(last);
      if (pages.includes(page)) return last;
      ensure(!['blocked', 'external-foreground', 'system-file-picker', 'dialog'].includes(page), 'BLOCKING_FOREGROUND'); await pause(250);
    }
    throw new DriverError('NAVIGATION_NOT_COMPLETED');
  }
  async function mainTab(target) {
    const page = pageOf(readLayout()); ensure(Object.hasOwn(TABS, page), 'MAIN_PAGE_REQUIRED');
    if (page !== target) { await click(TABS[target], page); await awaitPage([target]); }
  }
  async function network() {
    if (pageOf(readLayout()) === 'network') return;
    await mainTab('settings'); await click('openNetworkSettings', 'settings'); await awaitPage(['network']);
  }
  async function backup() {
    if (pageOf(readLayout()) === 'backup') return;
    await mainTab('settings'); await click('openNodeBackup', 'settings'); await awaitPage(['backup']);
  }
  async function chooseRouting(id) {
    await network(); await click(id, 'network');
    ensure((await find(id, 'network')).selected === true, 'ROUTING_SELECTION_UNCONFIRMED');
  }
  async function bypass(value) {
    await chooseRouting('routingRules');
    const before = await find('bypassLan', 'network');
    ensure(typeof before.checked === 'boolean', 'TOGGLE_STATE_UNAVAILABLE');
    const desired = value === undefined ? !before.checked : value;
    if (before.checked !== desired) await click('bypassLan', 'network');
    ensure((await find('bypassLan', 'network')).checked === desired, 'TOGGLE_UNCONFIRMED');
  }
  async function fill(id, value) {
    ensure(INPUTS.has(id) && (value === '' || (['routingBlock', 'routingDirect'].includes(id) && value === FIXTURE) ||
      (id === 'dnsUrl' && value === DNS_FIXTURE)), 'INPUT_NOT_ALLOWED');
    await find(id, 'network'); let layout = readLayout(); requirePage(layout, 'network');
    let item = match(layout, id); ensure(item, 'INPUT_CHANGED');
    let touched = false;
    if (item.inputValue !== '') {
      touched = true;
      const [l, t, r, b] = rect(item);
      shell('uitest', 'uiInput', 'click', String(Math.floor((l + r) / 2)), String(Math.floor((t + b) / 2)));
      shell('uitest', 'uiInput', 'keyEvent', '2072', '2017'); shell('uitest', 'uiInput', 'keyEvent', '2055'); await pause();
      item = await find(id, 'network'); ensure(item.inputValue === '', 'INPUT_CLEAR_UNCONFIRMED');
    }
    if (value) {
      touched = true;
      layout = readLayout(); requirePage(layout, 'network'); item = match(layout, id); ensure(item, 'INPUT_CHANGED');
      const [l, t, r, b] = rect(item);
      shell('uitest', 'uiInput', 'inputText', String(Math.floor((l + r) / 2)), String(Math.floor((t + b) / 2)), value);
      await pause();
    }
    ensure((await find(id, 'network')).inputValue === value, 'INPUT_READBACK_UNCONFIRMED');
    // Only dismiss a keyboard after an input interaction; an untouched empty
    // field must not trigger a Back that leaves the settings page.
    if (touched) { shell('uitest', 'uiInput', 'keyEvent', 'Back'); await pause(); }
  }
  async function saveNetwork() {
    await click('saveNetworkSettings', 'network');
    ensure((await find('networkSettingsResult', 'network', false)).saved === true, 'NETWORK_SAVE_UNCONFIRMED');
  }
  async function sort(desired) {
    await mainTab('nodes'); const item = await find('sortNodeLatency', 'nodes');
    ensure(typeof item.sorted === 'boolean', 'SORT_STATE_UNAVAILABLE');
    if (item.sorted !== desired) await click('sortNodeLatency', 'nodes');
    ensure((await find('sortNodeLatency', 'nodes')).sorted === desired, 'SORT_UNCONFIRMED');
  }
  async function run() {
    const initial = readLayout();
    if (mode === 'Inspect') return { mode, stage: 'completed', state: safeState(initial) };
    ensure(Object.keys(PAGES).includes(pageOf(initial)), 'UNSUPPORTED_FOREGROUND');
    if (mode === 'Nodes') await mainTab('nodes');
    else if (mode === 'Settings') await mainTab('settings');
    else if (mode === 'NetworkSettings') await network();
    else if (mode === 'NetworkBack') { await click('backFromNetworkSettings', 'network'); await awaitPage(['settings']); }
    else if (mode === 'RoutingGlobal' || mode === 'RoutingRules') await chooseRouting(mode === 'RoutingGlobal' ? 'routingGlobal' : 'routingRules');
    else if (mode.startsWith('BypassLan')) await bypass(mode === 'BypassLanToggle' ? undefined : mode === 'BypassLanOn');
    else if (mode === 'SaveNetwork') { await network(); await saveNetwork(); }
    else if (mode === 'BlockCloudflareSave') {
      await chooseRouting('routingRules'); await fill('routingBlock', FIXTURE); await saveNetwork();
    } else if (mode === 'DirectCloudflare') {
      await chooseRouting('routingRules'); await fill('routingBlock', ''); await fill('routingDirect', FIXTURE); await saveNetwork();
    } else if (mode === 'DnsHostname') {
      await network(); await fill('dnsUrl', DNS_FIXTURE); await saveNetwork();
    } else if (mode === 'RestoreNetworkDefaults') {
      await chooseRouting('routingRules');
      for (const id of RULE_INPUTS) await fill(id, '');
      await bypass(false); await chooseRouting('routingGlobal'); await click('resetDns', 'network'); await saveNetwork();
    } else if (mode === 'Backup') await backup();
    else if (mode === 'BackupBack') { await click('backFromNodeBackup', 'backup'); await awaitPage(['settings', 'nodes']); }
    else if (mode === 'BackupSavePicker') {
      await backup(); await click('exportNodeCatalog', 'backup');
      const result = await awaitPage(['system-file-picker', 'external-foreground', 'dialog']);
      return { mode, stage: 'stopped-at-system-ui', pickerSaveAttempted: false, state: safeState(result) };
    } else if (mode === 'EditorFirst') {
      await mainTab('nodes'); await find('nodeCount', 'nodes', false);
      const layout = readLayout(); requirePage(layout, 'nodes');
      const row = layout.rows.find(item => item.visible && item.enabled && item.id.startsWith('nodeMore-'));
      ensure(row, 'NO_VISIBLE_EDITABLE_NODE'); const id = ROW.exec(row.id)[2];
      expectedMenuNodeId = id;
      try {
        await click('nodeMore-' + id, 'nodes'); await find('editNode-' + id, 'nodes'); await click('editNode-' + id, 'nodes'); await awaitPage(['editor']);
      } finally { expectedMenuNodeId = ''; }
    } else if (mode === 'EditorBack') { await click('backFromNodeEditor', 'editor'); await awaitPage(['nodes']); }
    else if (mode === 'BatchStart') { await mainTab('nodes'); await click('testFilteredNodes', 'nodes'); await find('cancelNodeLatency', 'nodes'); }
    else if (mode === 'BatchCancel') { await mainTab('nodes'); await click('cancelNodeLatency', 'nodes'); }
    else if (mode === 'SortLatency' || mode === 'SortOriginal') await sort(mode === 'SortLatency');
    return { mode, stage: 'completed', state: safeState(readLayout()) };
  }
  return { run };
}

function selfTest() {
  const assert = require('node:assert/strict');
  const item = (id, text, extra = {}) => ({ attributes: { id, text, visible: 'true', enabled: 'true', bounds: '[1,2][101,52]', bundleName: BUNDLE, ...extra } });
  const secret = 'DO-NOT-OUTPUT-secret-node-password.example';
  const tree = { children: [item('nodeCount', '共 2 个节点'), item('nodeName-private-id', secret), item('nodeMore-private-id', secret),
    item('nodeSearch', secret), item('batchLatencyProgress', '已完成 1/2 · 正在检测第 2 个')] };
  const output = JSON.stringify(safeState(projectLayout(tree)));
  assert(!output.includes(secret)); assert(!output.includes('private-id')); assert(output.includes('nodeCount'));
  const network = projectLayout({ children: [item('routingRules', '✓ 规则分流'), item('routingBlock', secret), item('dnsUrl', secret)] });
  assert.equal(network.controls.find(control => control.id === 'routingBlock').inputValue, secret);
  assert(!JSON.stringify(safeState(network)).includes(secret));
  assert.equal(pageOf(projectLayout({ children: [item('save', secret, { bundleName: 'com.huawei.hmos.filemanager' })] })), 'system-file-picker');
  assert.equal(pageOf(projectLayout({ children: [item('permissiondialog', secret, { bundleName: 'system.permission' })] })), 'blocked');
  assert.equal(pageOf(projectLayout({ children: [item('backFromNodeEditor', '返回'), item('editNodeJson', secret)] })), 'editor');
  const ownRoot = { attributes: { bundleName: BUNDLE, type: 'root' }, children: [item('homePage', '', { bundleName: '' })] };
  const decoration = item('', '', { bundleName: 'com.ohos.sceneboard', type: 'WindowScene' });
  const decorated = { children: [ownRoot, decoration] };
  const focus = 'WindowName DisplayId Pid WinId Type Mode Flag\nharmonyvpnlab0 0 41494 339 1 1 0\nother-app 0 22 11 1 1 0\nFocus window: 339\nAll Focus window:\n';
  assert.equal(appHasFocus(focus), true);
  assert.equal(appHasFocus(focus.replace('Focus window: 339', 'Focus window: 11')), false);
  assert.equal(appHasFocus(focus.replace('Focus window: 339', 'unknown focus schema')), false);
  assert.equal(pageOf(projectLayout(decorated, appHasFocus(focus))), 'home');
  assert.equal(pageOf(projectLayout(decorated)), 'external-foreground');
  assert.equal(pageOf(projectLayout({ children: [decoration] }, true)), 'external-foreground');
  assert.equal(pageOf(projectLayout({ children: [ownRoot, item('', '', { bundleName: 'com.ohos.sceneboard', type: 'UnobservedType' })] }, true)), 'external-foreground');
  assert.equal(pageOf(projectLayout({ children: [ownRoot, decoration, item('save', secret, { bundleName: 'com.huawei.hmos.filemanager' })] }, true)), 'system-file-picker');
  assert.equal(pageOf(projectLayout({ children: [ownRoot, decoration, item('warning', secret, { type: 'Dialog' })] }, true)), 'dialog');
  const backupRoot = { attributes: { bundleName: BUNDLE, type: 'root' }, children: [item('backFromNodeBackup', '返回'), item('exportNodeCatalog', '备份整个节点库')] };
  for (const type of ['UIExtensionComponent', 'ModalPage', 'SheetWrapper', 'SheetPage']) {
    const modal = projectLayout({ children: [backupRoot, item('', secret, { type })] }, true);
    assert.equal(pageOf(modal), 'dialog');
    assert.throws(() => requirePage(modal, 'backup'), error => error.code === 'UNEXPECTED_ACTION_PAGE');
    assert.equal(safeState(modal).actionsAllowed, false);
    assert.equal(pageOf(projectLayout({ children: [backupRoot, item('', secret, { type, visible: false })] }, true)), 'backup');
  }
  for (const marker of ['PathSelectTreeHeader', 'PathSelectTreeScroll']) {
    const modal = item('', '', { type: 'ModalPage' });
    modal.children = [item('', '', { type: 'UIExtensionComponent' }), item(marker, secret),
      item('dialog_confirm', '保存'), item('file://synthetic-private-location/secret.json', secret), item('SAFE_BOX_CLASSIFICATION_TITLE', secret)];
    const picker = projectLayout({ children: [backupRoot, decoration, modal] }, true);
    assert.equal(picker.external, false); assert.equal(pageOf(picker), 'system-file-picker');
    assert.throws(() => requirePage(picker, 'backup'), error => error.code === 'UNEXPECTED_ACTION_PAGE');
    assert.equal(safeState(picker).actionsAllowed, false);
    const serialized = JSON.stringify(safeState(picker));
    for (const forbidden of [secret, 'file://', 'secret.json', 'dialog_confirm', 'exportNodeCatalog']) assert(!serialized.includes(forbidden));
    assert(!JSON.stringify(picker).includes('file://')); assert(!CLICK.has('dialog_confirm'));
  }
  const dataMenu = (labels, bundleName = BUNDLE) => ({ attributes: { type: 'Menu', bundleName, visible: true }, children: labels.map((label, index) => ({
    attributes: { type: 'MenuItem', id: '', text: index % 2 ? label : '', visible: true, enabled: true, bounds: '[200,100][400,150]' },
    children: index % 2 ? [] : [item('', label, { type: 'Text', bundleName: '' })]
  })) });
  const nodeRoot = { attributes: { bundleName: BUNDLE, type: 'root' }, children: [item('nodeCount', '共 1 个节点'), item('nodeMore-private-id', secret)] };
  const nodeMenuLabels = ['编辑节点', '导出节点 JSON', '改名', '删除'];
  const dataMenuTree = { children: [nodeRoot, dataMenu(nodeMenuLabels)] };
  const mapped = projectLayout(dataMenuTree, true, 'private-id');
  assert.equal(pageOf(mapped), 'nodes'); requirePage(mapped, 'nodes');
  assert.deepEqual(mapped.rows.find(row => row.id === 'editNode-private-id'), {
    id: 'editNode-private-id', visible: true, enabled: true, bounds: '[200,100][400,150]'
  });
  assert(!JSON.stringify(safeState(mapped)).includes(secret)); assert(!JSON.stringify(safeState(mapped)).includes('private-id'));
  const optionMenu = dataMenu(nodeMenuLabels);
  for (const [index, option] of optionMenu.children.entries()) {
    option.attributes.type = 'Option'; option.attributes.text = nodeMenuLabels[index];
    option.children = [item('', nodeMenuLabels[index], { type: 'Text', bundleName: '' })];
  }
  const mappedOptions = projectLayout({ children: [nodeRoot, optionMenu] }, true, 'private-id');
  assert.equal(mappedOptions.rows.filter(row => row.id === 'editNode-private-id').length, 1);
  assert.equal(mappedOptions.rows.find(row => row.id === 'editNode-private-id').bounds, '[200,100][400,150]');
  assert(!projectLayout(dataMenuTree, true).rows.some(row => row.id.startsWith('editNode-')));
  assert(!projectLayout(dataMenuTree, true, 'different-node').rows.some(row => row.id.startsWith('editNode-')));
  assert(!projectLayout({ children: [nodeRoot, dataMenu(['编辑节点'])] }, true, 'private-id').rows.some(row => row.id.startsWith('editNode-')));
  const foreignMenu = projectLayout({ children: [nodeRoot, dataMenu(nodeMenuLabels, 'system.other')] }, true, 'private-id');
  assert.equal(pageOf(foreignMenu), 'external-foreground'); assert(!foreignMenu.rows.some(row => row.id.startsWith('editNode-')));
  const blockedMenu = projectLayout({ children: [nodeRoot, dataMenu(nodeMenuLabels), item('', secret, { type: 'ModalPage' })] }, true, 'private-id');
  assert.equal(pageOf(blockedMenu), 'dialog'); assert.throws(() => requirePage(blockedMenu, 'nodes'), error => error.code === 'UNEXPECTED_ACTION_PAGE');
  assert(!blockedMenu.rows.some(row => row.id.startsWith('editNode-')));
  const oldMenu = projectLayout({ children: [nodeRoot, item('editNode-private-id', '编辑节点', { type: 'MenuItem' }), dataMenu(nodeMenuLabels)] }, true, 'private-id');
  assert.equal(oldMenu.rows.filter(row => row.id === 'editNode-private-id').length, 1);
  assert(!CLICK.has('saveNodeEditor')); assert(!CLICK.has('confirmNodeBackupRestore')); assert(!CLICK.has('toggleConnection'));
  assert.throws(() => rect({ bounds: 'invalid' }), error => error.code === 'INVALID_BOUNDS');
  return { mode: 'SelfTest', stage: 'completed', phoneContacted: false, projectionChecksPassed: true };
}
module.exports = { MODES, DriverError, appHasFocus, projectLayout, pageOf, safeState, rect, selfTest, parseCommandLine, selectUsbTarget };
if (require.main === module) {
  let options;
  try { options = parseCommandLine(process.argv.slice(2)); }
  catch (_) {
    process.stderr.write('Usage: node test-network-tools-device.cjs [Mode] [--target USB_DEVICE_ID]\n'); process.exitCode = 1;
  }
  if (options?.mode === 'SelfTest') {
    try { process.stdout.write(JSON.stringify(selfTest()) + '\n'); }
    catch (_) { process.stderr.write('{"failure":"SELF_TEST_FAILED","phoneContacted":false}\n'); process.exitCode = 1; }
  } else if (options) {
    const { mode, target } = options;
    createDriver(mode, target).run().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ mode, stage: 'failed', stoppedIssuingActions: true,
      failure: error instanceof DriverError ? error.code : 'DRIVER_FAILED' }) + '\n'); process.exitCode = 1;
    });
  }
}
