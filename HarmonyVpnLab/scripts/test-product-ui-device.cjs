'use strict';

// Explicit product-UI actions only. No input, connection, test, node selection,
// save or deletion actions are supported. Theme modes change only appearance.
// Raw AX exists in memory and a short-lived device temp file, always removed.
// Screenshot is opt-in; its private image is never decoded or printed here.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const HDC = 'C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe';
const BUNDLE = 'com.example.harmonyvpnlab';
const MODES = ['Inspect', 'Nodes', 'Settings', 'Home', 'ThemeLight', 'ThemeDark', 'ThemeSystem',
  'OpenImport', 'ImportBack', 'OpenSubscriptions', 'SubscriptionsBack', 'Developer',
  'HomeFromDeveloper', 'Journal', 'JournalBack', 'About', 'AboutBack', 'Privacy', 'PrivacyBack', 'Screenshot'];
const HOME_STATES = ['未连接', '已连接', '正在连接', '正在恢复连接', '等待网络', '正在断开',
  '连接中断', '连接已结束', '正在验证'];
const PAGE_IDS = {
  home: ['homePage', 'connectionState', 'toggleConnection', 'openNodeConfig', 'connectionNetwork', 'connectionUplink',
    'connectionDownlink', 'checkConnection', 'connectionCheckResult', 'reconnectConnection', 'recoverConnection'],
  developer: ['backFromDeveloperTools', 'startConnectionTest', 'startConnectionAppTest', 'checkOtherApp',
    'checkConnectionIpv6', 'checkPhysicalResolver', 'ipv6BlockedCount', 'dnsRequestCount', 'connectionExitMarker', 'openDiagnostics'],
  nodes: ['backToConnection', 'nodeCount', 'addNodes', 'nodeSearch', 'nodeManagerResult', 'nodesEmptyState',
    'nodeSearchEmpty', 'showMoreNodes', 'cancelNodeLatency', 'importNodes', 'manageSubscriptions'],
  settings: ['settingsTitle', 'appearance-system', 'appearance-light', 'appearance-dark', 'openSettingsDiagnostics',
    'openAbout', 'openPrivacy', 'openDeveloperTools', 'settingsResult'],
  import: ['backToProbe', 'scanNode', 'nodeInput', 'saveNode', 'confirmPartialImport', 'nodeSaveResult',
    'nodeSaveReceipt', 'toggleNodeSaveDetails', 'toggleNodeAdvanced', 'currentNodeHost', 'nodeHostInput', 'updateNodeHost'],
  subscriptions: ['backToNodes', 'subscriptionName', 'subscriptionUrl', 'previewSubscription', 'subscriptionResult',
    'saveSubscription', 'cancelSubscriptionPreview', 'subscriptionEditNotice', 'subscriptionEmptyState',
    'confirmDeleteSubscription', 'cancelDeleteSubscription'],
  journal: ['backFromDiagnosticJournal', 'diagnosticEventCount', 'refreshDiagnosticJournal', 'diagnosticJournalMessage', 'diagnosticEmptyState'],
  about: ['aboutPage', 'backFromAbout', 'appVersion'],
  privacy: ['privacyPage', 'backFromPrivacy', 'privacyScope']
};
const TABS = { home: 'navHome', nodes: 'navNodes', settings: 'navSettings' };
const FIXED_IDS = new Set([...Object.values(PAGE_IDS).flat(), ...Object.values(TABS), 'openDiagnosticJournal']);
const CLICK_IDS = new Set([...Object.values(TABS), 'appearance-system', 'appearance-light', 'appearance-dark',
  'addNodes', 'importNodes', 'manageSubscriptions', 'backToProbe', 'backToNodes', 'openDeveloperTools',
  'backFromDeveloperTools', 'openSettingsDiagnostics', 'openDiagnosticJournal', 'backFromDiagnosticJournal',
  'openAbout', 'backFromAbout', 'openPrivacy', 'backFromPrivacy']);
const TOP_IDS = new Set(['backToProbe', 'backToNodes', 'backFromDeveloperTools', 'backFromDiagnosticJournal',
  'backFromAbout', 'backFromPrivacy', 'addNodes', 'appearance-system', 'appearance-light', 'appearance-dark']);

class DriverError extends Error { constructor(code) { super(code); this.code = code; } }
function ensure(value, code) { if (!value) throw new DriverError(code); }
const flag = value => value === true || value === 'true';

// Project immediately to fixed UI metadata. In particular, never access text
// on node names, addresses, input fields, results, receipts, or dynamic row IDs.
function projectLayout(tree) {
  const controls = [], scrolls = [];
  let blocked = false;
  function visit(node) {
    const a = node?.attributes;
    if (a) {
      const visible = flag(a.visible);
      if (visible && (['Dialog', 'AlertDialog', 'SystemDialog'].includes(a.type) ||
          /keyguard|screenlock|lockscreen|biometric|permissiondialog/i.test(String(a.id || '')) ||
          ['renameNodeInput', 'confirmDeleteNode', 'startVpnProbe'].includes(a.id))) blocked = true;
      if (a.type === 'Scroll' && visible) scrolls.push({ bounds: a.bounds });
      if (FIXED_IDS.has(a.id)) {
        const item = { id: a.id, visible, enabled: flag(a.enabled), bounds: a.bounds };
        if (a.bundleName && a.bundleName !== BUNDLE) blocked = true;
        if (a.id === 'connectionState' && HOME_STATES.includes(a.text)) item.state = a.text;
        if (Object.values(TABS).includes(a.id)) {
          item.selected = [a.description, a.accessibilityDescription].includes('当前页面');
        }
        if (a.id.startsWith('appearance-')) {
          const label = { 'appearance-system': '跟随系统', 'appearance-light': '浅色', 'appearance-dark': '深色' }[a.id];
          const labels = [a.text, a.accessibilityText, a.description];
          function appearanceLabels(child) {
            if (child?.attributes) labels.push(child.attributes.text);
            for (const nested of child?.children || []) appearanceLabels(nested);
          }
          for (const child of node.children || []) appearanceLabels(child);
          item.selected = labels.includes('已选择') || labels.includes(`${label}，已选择`);
        }
        controls.push(item);
      }
    }
    for (const child of node?.children || []) visit(child);
  }
  visit(tree);
  return { controls, scrolls, blocked };
}

function pageOf(layout) {
  ensure(!layout.blocked, 'BLOCKING_OR_UNSUPPORTED_FOREGROUND');
  const ids = new Set(layout.controls.filter(control => control.visible).map(control => control.id));
  const candidates = Object.entries(PAGE_IDS).filter(([, markers]) => markers.some(id => ids.has(id))).map(([page]) => page);
  const selectedTabs = Object.entries(TABS).filter(([, id]) => layout.controls.some(control =>
    control.id === id && control.visible && control.selected)).map(([page]) => page);
  if (candidates.includes('developer')) {
    const others = candidates.filter(page => !['developer', 'home'].includes(page));
    ensure(others.length === 0 && !Object.values(TABS).some(id => ids.has(id)), 'FOREGROUND_PAGE_AMBIGUOUS');
    return 'developer';
  }
  if (candidates.length === 1) {
    ensure(selectedTabs.length <= 1 && (selectedTabs.length === 0 || selectedTabs[0] === candidates[0]), 'FOREGROUND_PAGE_AMBIGUOUS');
    if (candidates[0] === 'home') {
      // Developer tools share the connection hero but have no bottom tabs.
      if (ids.has('homePage') && !Object.values(TABS).some(id => ids.has(id))) return 'developer';
      ensure(Object.values(TABS).every(id => ids.has(id)), 'HOME_TAB_BAR_UNAVAILABLE');
    }
    return candidates[0];
  }
  ensure(candidates.length === 0 && selectedTabs.length === 1, 'UNEXPECTED_FOREGROUND_PAGE');
  return selectedTabs[0];
}

function safeState(layout) {
  return { page: pageOf(layout), coverage: 'current_viewport_fixed_controls_only',
    controls: layout.controls.filter(control => control.visible).map(control => ({
      id: control.id, enabled: control.enabled,
      ...(control.state ? { state: control.state } : {}),
      ...(typeof control.selected === 'boolean' ? { selected: control.selected } : {})
    })) };
}

function rect(node) {
  const values = String(node.bounds).match(/-?\d+/g)?.map(Number);
  ensure(values?.length === 4 && values.every(Number.isSafeInteger) && values[0] >= 0 && values[1] >= 0 &&
    values[2] > values[0] && values[3] > values[1], 'CONTROL_BOUNDS_INVALID');
  return values;
}

function createDriver(mode) {
  ensure(MODES.includes(mode), 'INVALID_MODE');
  let device;
  const deadline = performance.now() + 60000;
  let observationDeadline = Infinity;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const remoteBase = `/data/local/tmp/harmonyvpnlab-product-ui-${process.pid}-${Date.now()}`;
  const remoteLayout = remoteBase + '.json', remoteScreen = remoteBase + '.jpeg';
  const screenDir = path.resolve(__dirname, '..', '..', '.private', 'phase10-screens');
  function command(args, cleanup = false) {
    const remaining = cleanup ? 10000 : Math.min(10000, Math.ceil(Math.min(deadline, observationDeadline) - performance.now()));
    ensure(remaining > 0, 'UI_OPERATION_TIMEOUT');
    try {
      const value = cp.execFileSync(HDC, args, { encoding: 'utf8', windowsHide: true,
        timeout: remaining, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      ensure(!/\[Fail\]|device.*not found|no connected device|\boffline\b/i.test(value), 'DEVICE_COMMAND_FAILED');
      return value;
    } catch (error) { if (error instanceof DriverError) throw error; throw new DriverError('DEVICE_COMMAND_FAILED'); }
  }
  const shell = (...args) => command(['-t', device, 'shell', ...args]);
  function verifyDevice() {
    const matches = command(['list', 'targets', '-v']).split(/\r?\n/).filter(line => /\sUSB\s+Connected\s/.test(line));
    ensure(matches.length === 1, 'EXPECTED_ONE_USB_CONNECTED_DEVICE');
    const next = matches[0].trim().split(/\s+/)[0];
    ensure(/^[A-Za-z0-9._:-]+$/.test(next) && (!device || device === next), 'DEVICE_CHANGED_OR_INVALID');
    device = next;
  }
  function readLayout() {
    verifyDevice();
    let raw;
    try { shell('uitest', 'dumpLayout', '-p', remoteLayout); raw = shell('cat', remoteLayout); }
    finally { command(['-t', device, 'shell', 'rm', '-f', remoteLayout], true); }
    let layout;
    try { layout = projectLayout(JSON.parse(raw)); } catch (_) { throw new DriverError('LAYOUT_UNAVAILABLE'); }
    raw = undefined;
    pageOf(layout);
    return layout;
  }
  async function wait(ms) {
    ensure(performance.now() < deadline, 'UI_OPERATION_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, Math.min(ms, Math.max(0, deadline - performance.now()))));
  }
  function match(layout, id, requireEnabled) {
    const matches = layout.controls.filter(control => control.id === id && control.visible);
    ensure(matches.length <= 1, 'CONTROL_AMBIGUOUS');
    if (!matches.length) return null;
    if (requireEnabled) ensure(matches[0].enabled, 'CONTROL_DISABLED');
    rect(matches[0]);
    return matches[0];
  }
  async function find(id, expectedPage, requireEnabled = true) {
    let layout = readLayout();
    ensure(pageOf(layout) === expectedPage, 'UNEXPECTED_ACTION_PAGE');
    let found = match(layout, id, requireEnabled);
    if (found) return found;
    // Tabs are outside Scroll; never swipe hoping to reveal a missing tab.
    ensure(!Object.values(TABS).includes(id), 'FIXED_TAB_NOT_VISIBLE');
    for (const towardTop of TOP_IDS.has(id) ? [true, false] : [false, true]) {
      for (let attempt = 0; attempt < 5; attempt++) {
        ensure(layout.scrolls.length === 1, 'SCROLL_UNAVAILABLE');
        const [left, top, right, bottom] = rect(layout.scrolls[0]);
        // The page margin avoids swiping inside an editable text area's scroll.
        const x = Math.round(left + Math.min(12, (right - left) * .04));
        const upper = Math.round(top + (bottom - top) * .22), lower = Math.round(top + (bottom - top) * .78);
        shell('uitest', 'uiInput', 'swipe', String(x), String(towardTop ? upper : lower), String(x), String(towardTop ? lower : upper));
        await wait(120);
        layout = readLayout();
        ensure(pageOf(layout) === expectedPage, 'PAGE_CHANGED_DURING_SCROLL');
        found = match(layout, id, requireEnabled);
        if (found) return found;
      }
    }
    throw new DriverError('CONTROL_NOT_VISIBLE');
  }
  async function click(id, expectedPage) {
    ensure(CLICK_IDS.has(id), 'ACTION_NOT_ALLOWED');
    await find(id, expectedPage);
    // Refresh after any scroll; never reuse a previous tree's enabled/bounds.
    const current = readLayout();
    ensure(pageOf(current) === expectedPage, 'PAGE_CHANGED_BEFORE_CLICK');
    const control = match(current, id, true);
    ensure(control, 'CONTROL_CHANGED_BEFORE_CLICK');
    const [left, top, right, bottom] = rect(control);
    shell('uitest', 'uiInput', 'click', String(Math.floor((left + right) / 2)), String(Math.floor((top + bottom) / 2)));
  }
  async function awaitPage(allowedTargets, failure = 'NAVIGATION_NOT_COMPLETED', controlId = '', requireSelected = false) {
    const previousDeadline = observationDeadline;
    const until = Math.min(deadline, performance.now() + 5000);
    observationDeadline = until;
    let stablePage = '', stableCount = 0;
    try {
      while (performance.now() < until) {
        try {
          const layout = readLayout(), page = pageOf(layout);
          const controls = controlId ? layout.controls.filter(control => control.id === controlId && control.visible) : [];
          const ready = allowedTargets.includes(page) && (!controlId ||
            (controls.length === 1 && (!requireSelected || controls[0].selected)));
          if (ready) {
            stableCount = stablePage === page ? stableCount + 1 : 1;
            stablePage = page;
            if (stableCount >= 2) return layout;
          } else { stablePage = ''; stableCount = 0; }
        } catch (error) {
          // Only AX transition shapes may be retried. In particular, blocked
          // foreground, foreign bundle, device, parsing and control errors stop.
          if (!(error instanceof DriverError) || !['UNEXPECTED_FOREGROUND_PAGE',
            'FOREGROUND_PAGE_AMBIGUOUS', 'HOME_TAB_BAR_UNAVAILABLE'].includes(error.code)) throw error;
          stablePage = ''; stableCount = 0;
        }
        if (performance.now() < until) await wait(Math.min(300, until - performance.now()));
      }
      throw new DriverError(failure);
    } finally { observationDeadline = previousDeadline; }
  }
  async function mainTab(target) {
    const page = pageOf(readLayout());
    ensure(Object.hasOwn(TABS, page), 'MAIN_TAB_PAGE_REQUIRED');
    await click(TABS[target], page);
    await awaitPage([target]);
  }
  async function openFromNodes(id, target) {
    if (pageOf(readLayout()) !== 'nodes') await mainTab('nodes');
    await click('addNodes', 'nodes');
    await awaitPage(['nodes'], 'ADD_MENU_NOT_COMPLETED', id);
    await click(id, 'nodes');
    await awaitPage([target]);
  }
  async function settingsPage(id, target) {
    if (pageOf(readLayout()) !== 'settings') await mainTab('settings');
    await click(id, 'settings');
    await awaitPage([target]);
  }
  async function back(id, from, allowedTargets) {
    await click(id, from);
    await awaitPage(allowedTargets, 'UNEXPECTED_RETURN_PAGE');
  }
  async function screenshot() {
    const before = readLayout(), page = pageOf(before);
    const output = path.join(screenDir, `${stamp}-${page}.jpeg`);
    fs.mkdirSync(screenDir, { recursive: true });
    try {
      shell('snapshot_display', '-f', remoteScreen);
      ensure(pageOf(readLayout()) === page, 'PAGE_CHANGED_DURING_SCREENSHOT');
      command(['-t', device, 'file', 'recv', remoteScreen, output]);
      ensure(fs.existsSync(output) && fs.statSync(output).size > 8, 'SCREENSHOT_UNAVAILABLE');
      const fd = fs.openSync(output, 'r'), signature = Buffer.alloc(8);
      try { fs.readSync(fd, signature, 0, 8, 0); } finally { fs.closeSync(fd); }
      ensure(signature.subarray(0, 3).equals(Buffer.from([255, 216, 255])), 'SCREENSHOT_FORMAT_INVALID');
      return { page, path: output };
    } catch (error) {
      if (fs.existsSync(output)) fs.unlinkSync(output);
      throw error;
    } finally { command(['-t', device, 'shell', 'rm', '-f', remoteScreen], true); }
  }
  async function run() {
    verifyDevice();
    readLayout(); // No launch/unlock fallback on an unknown foreground.
    if (mode === 'Screenshot') return { mode, stage: 'completed', ...await screenshot() };
    if (mode === 'Nodes') await mainTab('nodes');
    else if (mode === 'Settings') await mainTab('settings');
    else if (mode === 'Home') await mainTab('home');
    else if (['ThemeLight', 'ThemeDark', 'ThemeSystem'].includes(mode)) {
      if (pageOf(readLayout()) !== 'settings') await mainTab('settings');
      const id = 'appearance-' + mode.slice('Theme'.length).toLowerCase();
      await click(id, 'settings');
      await awaitPage(['settings'], 'APPEARANCE_SELECTION_NOT_CONFIRMED', id, true);
    } else if (mode === 'OpenImport') await openFromNodes('importNodes', 'import');
    else if (mode === 'ImportBack') await back('backToProbe', 'import', ['nodes']);
    else if (mode === 'OpenSubscriptions') await openFromNodes('manageSubscriptions', 'subscriptions');
    else if (mode === 'SubscriptionsBack') await back('backToNodes', 'subscriptions', ['nodes']);
    else if (mode === 'Developer') await settingsPage('openDeveloperTools', 'developer');
    else if (mode === 'HomeFromDeveloper') await back('backFromDeveloperTools', 'developer', ['home']);
    else if (mode === 'Journal') {
      const page = pageOf(readLayout());
      if (page === 'developer') {
        await click('openDiagnosticJournal', 'developer');
        await awaitPage(['journal']);
      } else await settingsPage('openSettingsDiagnostics', 'journal');
    } else if (mode === 'JournalBack') await back('backFromDiagnosticJournal', 'journal', ['home', 'settings', 'developer']);
    else if (mode === 'About') await settingsPage('openAbout', 'about');
    else if (mode === 'AboutBack') await back('backFromAbout', 'about', ['settings']);
    else if (mode === 'Privacy') await settingsPage('openPrivacy', 'privacy');
    else if (mode === 'PrivacyBack') await back('backFromPrivacy', 'privacy', ['settings']);
    return { mode, stage: 'completed', state: safeState(readLayout()) };
  }
  return { run };
}

module.exports = { DriverError, MODES, PAGE_IDS, CLICK_IDS, projectLayout, pageOf, safeState, rect };
if (require.main === module) {
  const mode = process.argv[2] || 'Inspect';
  if (!MODES.includes(mode) || process.argv.length > 3) {
    process.stderr.write('Invalid mode. See MODES in test-product-ui-device.cjs.\n');
    process.exitCode = 1;
  } else {
    createDriver(mode).run().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
      process.stderr.write(JSON.stringify({ mode, stage: 'failed', stoppedIssuingActions: true,
        failure: error instanceof DriverError ? error.code : 'DRIVER_FAILED' }) + '\n');
      process.exitCode = 1;
    });
  }
}
