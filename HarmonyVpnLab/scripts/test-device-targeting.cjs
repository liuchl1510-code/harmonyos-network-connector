'use strict';
// Pure exported helpers and synthetic AX only. Never invoke a device driver.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const product = require('./test-product-ui-device.cjs');
const network = require('./test-network-tools-device.cjs');
const connected = id => `${id} USB Connected synthetic-device`;
const phone = 'SYNTHETIC_PHONE', tablet = 'SYNTHETIC_TABLET';
const listing = `${connected(phone)}\n${connected(tablet)}\n127.0.0.1:15555 TCP Connected emulator\nOFFLINE_USB USB Offline unavailable`;
const row = (id, type = 'Button', extra = {}, children = []) => ({ attributes: {
  id, type, visible: 'true', enabled: 'true', bounds: '[0,0][176,100]', ...extra }, children });
function layoutFixture(extraSide = []) {
  const tabs = ['navHome', 'navNodes', 'navSettings'].map(id => row(id, 'Button', {
    accessibilityDescription: id === 'navHome' ? '当前页面' : '' }));
  const secret = row('nodeInput', 'TextInput', { visible: 'false' });
  Object.defineProperty(secret.attributes, 'text', { get() { throw Error('Private text must not be read'); } });
  return row('appRoot', 'Column', { bundleName: 'com.example.harmonyvpnlab' }, [
    row('appSideNavigation', 'Scroll', {}, [row('nestedSideScroll', 'Scroll'), ...tabs, secret, ...extraSide]),
    row('bodyScroll', 'Scroll', { bounds: '[176,0][1280,900]' }, [row('homePage', 'Column')])
  ]);
}
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS ' + name); }
for (const [name, api] of [['product', product], ['network', network]]) {
  test(name + ': legacy CLI and explicit target in either order', () => {
    assert.deepEqual(api.parseCommandLine([]), { mode: 'Inspect', target: '' });
    assert.deepEqual(api.parseCommandLine(['Settings']), { mode: 'Settings', target: '' });
    assert.deepEqual(api.parseCommandLine(['Inspect', '--target', tablet]), { mode: 'Inspect', target: tablet });
    assert.deepEqual(api.parseCommandLine(['--target', tablet, 'Inspect']), { mode: 'Inspect', target: tablet });
    assert.deepEqual(api.parseCommandLine(['--target', tablet]), { mode: 'Inspect', target: tablet });
  });
  test(name + ': malformed or duplicate arguments are rejected', () => {
    for (const args of [['--target'], ['--target', ''], ['--target', '--target'], ['--target', 'bad id'],
      ['Inspect', 'Settings'], ['--unknown'], ['--target', tablet, '--target', tablet], ['Inspect', 'unused']]) {
      assert.throws(() => api.parseCommandLine(args));
    }
  });
  test(name + ': unique USB defaults; multi-USB requires a target', () => {
    assert.equal(api.selectUsbTarget(connected(tablet)), tablet);
    assert.throws(() => api.selectUsbTarget(listing));
    assert.throws(() => api.selectUsbTarget(''));
    assert.equal(api.selectUsbTarget(listing, tablet), tablet);
    assert.equal(api.selectUsbTarget(listing, phone), phone);
  });
  test(name + ': no offline/TCP/substring/case fallback or device switching', () => {
    for (const requested of ['OFFLINE_USB', '127.0.0.1:15555', 'TABLET', tablet.toLowerCase(), 'MISSING']) {
      assert.throws(() => api.selectUsbTarget(listing, requested));
    }
    assert.throws(() => api.selectUsbTarget(connected(phone), tablet, tablet));
    assert.throws(() => api.selectUsbTarget(connected(phone), '', tablet));
    assert.throws(() => api.selectUsbTarget(listing, tablet, phone));
    assert.throws(() => api.selectUsbTarget(`${connected(tablet)}\n${connected(tablet)}`, tablet));
    assert.equal(api.selectUsbTarget(listing, tablet, tablet), tablet);
  });
  test(name + ': exclude sidebar descendants while retaining nav and private-field protections', () => {
    const layout = api.projectLayout(layoutFixture());
    assert.equal(layout.scrolls.length, 1);
    assert.equal(layout.scrolls[0].bounds, '[176,0][1280,900]');
    assert.equal(layout.controls.filter(x => x.id.startsWith('nav')).length, 3);
    assert.equal(api.pageOf(layout), 'home');
    assert(!JSON.stringify(api.safeState(layout)).includes('Private'));
  });
  test(name + ': sidebar exclusion cannot hide a modal, lock screen, or foreign control', () => {
    for (const overlay of [row('modal', 'Dialog'), row('permissiondialog', 'Column'),
      row('navHome', 'Button', { bundleName: 'system.other' })]) {
      const layout = api.projectLayout(layoutFixture([overlay]));
      if (name === 'product') assert.throws(() => api.pageOf(layout));
      else assert(['blocked', 'dialog', 'external-foreground'].includes(api.pageOf(layout)));
    }
  });
  test(name + ': a phone retains its single body scroll; unrelated scroll ambiguity remains visible', () => {
    const phoneTree = row('root', 'Column', {}, [row('body', 'Scroll', {}, [row('homePage')])]);
    assert.equal(api.projectLayout(phoneTree).scrolls.length, 1);
    const ambiguous = layoutFixture(); ambiguous.children.push(row('unrelated', 'Scroll'));
    assert.equal(api.projectLayout(ambiguous).scrolls.length, 2);
  });
}
test('network existing modal/ownership/private-projection regression checks', () => {
  assert.equal(network.selfTest().projectionChecksPassed, true);
});
const psResult = cp.spawnSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'test-connection-targeting.ps1')],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(psResult.status, 0, psResult.stdout + psResult.stderr);
process.stdout.write(psResult.stdout);
console.log(JSON.stringify({ javascriptChecksPassed: passed, powershellChecksPassed: true, deviceContacted: false }));
