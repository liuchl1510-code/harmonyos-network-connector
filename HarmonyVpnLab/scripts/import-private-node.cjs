'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');

const RECEIPT_PATTERN = /^保存回执：[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUCCESS_PATTERN = /^已新增 \d+ 个节点，跳过 \d+ 个已有节点。/;
const quote = value => "'" + String(value).replace(/'/g, "'\"'\"'") + "'";

function flatten(node, result = []) {
  if (node.attributes) result.push(node.attributes);
  for (const child of node.children || []) flatten(child, result);
  return result;
}

function bounds(node) {
  const numbers = String(node.bounds).match(/-?\d+/g)?.map(Number);
  if (!numbers || numbers.length !== 4 || numbers[2] <= numbers[0] || numbers[3] <= numbers[1]) {
    throw new Error('invalid-control-bounds');
  }
  return numbers;
}

function flag(value) { return value === true || value === 'true'; }
function isEmptyInput(node) {
  return !!node && flag(node.visible) && ['TextArea', 'TextInput'].includes(node.type) &&
    node.text === '';
}

function expectedServer(outbound) {
  if (!outbound || typeof outbound !== 'object' || Array.isArray(outbound) ||
      typeof outbound.protocol !== 'string' || !outbound.settings || outbound.outbounds) {
    throw new Error('invalid-outbound-shape');
  }
  const servers = ['vless', 'vmess'].includes(outbound.protocol) ? outbound.settings.vnext : outbound.settings.servers;
  if (!Array.isArray(servers) || servers.length !== 1 || typeof servers[0]?.address !== 'string' ||
      servers[0].address.length === 0) {
    throw new Error('invalid-single-server');
  }
  return servers[0].address;
}

// Injectable command/wait functions permit synthetic testing without reading
// private files or operating a real device. The production adapter is below.
async function importOutboundText(original, io) {
  const wait = io.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const onStage = io.onStage || (() => {});
  const remoteLayout = '/data/local/tmp/harmonyvpnlab-private-import-' + crypto.randomUUID() + '.json';
  let device = '';
  const shell = text => io.command(['-t', device, 'shell', text]);

  function layout(expectedPages) {
    try {
      shell('uitest dumpLayout -p ' + quote(remoteLayout));
      const nodes = flatten(JSON.parse(shell('cat ' + quote(remoteLayout))));
      // An unfiltered dump works while a VPN is active. Refuse controls from an
      // unrelated foreground screen; off-screen page markers still identify it.
      const signatures = {
        home: ['openNodeConfig', 'toggleConnection'],
        nodes: ['nodeCount', 'importNodes', 'backToConnection'],
        form: ['saveNode', 'nodeSaveReceipt', 'backToProbe']
      };
      const pages = Object.entries(signatures).filter(([, ids]) =>
        ids.every(id => nodes.filter(node => node.id === id).length === 1)).map(([page]) => page);
      if (pages.length !== 1 || !expectedPages.includes(pages[0])) throw new Error('unexpected-foreground-page');
      return { nodes, page: pages[0] };
    } finally {
      // Snapshots can contain pasted secrets. Never keep them locally/remotely,
      // including when dump/cat/JSON parsing fails midway.
      shell('rm -f ' + quote(remoteLayout));
    }
  }

  function match(nodes, id, enabled) {
    const found = nodes.filter(node => node.id === id && flag(node.visible) && (!enabled || flag(node.enabled)));
    if (found.length > 1) throw new Error('ambiguous-control');
    if (found.length === 1) { bounds(found[0]); return found[0]; }
    return null;
  }

  function scroll(nodes, towardTop) {
    const scrollView = nodes.find(node => node.type === 'Scroll' && flag(node.visible));
    if (!scrollView) throw new Error('scroll-view-unavailable');
    const rect = bounds(scrollView);
    const x = Math.floor((rect[0] + rect[2]) / 2);
    const upper = Math.floor(rect[1] + 0.25 * (rect[3] - rect[1]));
    const lower = Math.floor(rect[1] + 0.80 * (rect[3] - rect[1]));
    const output = shell(`uitest uiInput swipe ${x} ${towardTop ? upper : lower} ${x} ${towardTop ? lower : upper}`);
    if (!output.includes('No Error')) throw new Error('scroll-failed');
  }

  async function findVisible(id, enabled = true, page = 'form') {
    let { nodes } = layout([page]);
    let found = match(nodes, id, enabled);
    if (found) return found;
    // Search both directions. An off-screen/missing textarea is not empty.
    for (const towardTop of [true, false]) {
      for (let attempt = 0; attempt < 4; attempt++) {
        scroll(nodes, towardTop);
        await wait(100);
        nodes = layout([page]).nodes;
        found = match(nodes, id, enabled);
        if (found) return found;
      }
    }
    throw new Error('visible-control-not-found');
  }

  async function click(id, page = 'form') {
    const rect = bounds(await findVisible(id, true, page));
    const output = shell(`uitest uiInput click ${Math.floor((rect[0] + rect[2]) / 2)} ${Math.floor((rect[1] + rect[3]) / 2)}`);
    if (!output.includes('No Error')) throw new Error('click-failed');
  }

  onStage('read-input');
  const outbound = JSON.parse(original.replace(/^\uFEFF/, ''));
  expectedServer(outbound); // Validate the single-outbound shape, not selection.
  const text = JSON.stringify(outbound);
  if (Buffer.byteLength(text, 'utf8') > 65536) throw new Error('input-too-long');
  const targets = io.command(['list', 'targets', '-v']).split(/\r?\n/).filter(line => /\sUSB\s+Connected\s/.test(line));
  if (targets.length !== 1) throw new Error('single-connected-device-required');
  device = targets[0].trim().split(/\s+/)[0];
  onStage('open-visible-form');
  await click('openNodeConfig', 'home');
  await wait(250);
  if (layout(['nodes', 'form']).page === 'nodes') {
    await click('importNodes', 'nodes');
    await wait(250);
  }
  const beforeReceipt = (await findVisible('nodeSaveReceipt', false)).text;
  const input = await findVisible('nodeInput');
  if (!isEmptyInput(input)) throw new Error('unsaved-input');
  onStage('enter-private-outbound');
  // Refresh immediately before sending credentials, including after navigation.
  const currentInput = await findVisible('nodeInput');
  if (!isEmptyInput(currentInput)) throw new Error('unsaved-input');
  const rect = bounds(currentInput);
  const reply = shell(`uitest uiInput inputText ${Math.floor((rect[0] + rect[2]) / 2)} ${Math.floor((rect[1] + rect[3]) / 2)} ${quote(text)}`);
  if (!reply.includes('No Error')) throw new Error('input-failed');
  const entered = await findVisible('nodeInput');
  if (entered.text !== text) throw new Error('input-mismatch');
  shell('uitest uiInput keyEvent Back');
  onStage('save-private-outbound');
  await click('saveNode');

  onStage('verify-fresh-save-receipt');
  let receipt = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    await wait(250);
    const current = (await findVisible('nodeSaveReceipt', false)).text;
    if (typeof current === 'string' && RECEIPT_PATTERN.test(current) && current !== beforeReceipt) {
      receipt = current;
      break;
    }
  }
  if (!receipt) throw new Error('fresh-save-not-confirmed');
  onStage('verify-save-ui-result');
  if (!SUCCESS_PATTERN.test((await findVisible('nodeSaveResult', false)).text || '')) {
    throw new Error('save-ui-not-confirmed');
  }
  onStage('verify-input-cleared');
  const cleared = await findVisible('nodeInput', false);
  if (!isEmptyInput(cleared)) throw new Error('input-not-cleared');
  // This receipt is generated by NodeConfig only after every imported outbound
  // is found in the catalog read-back. It does not prove current-node selection.
  // Edits/address changes invalidate it; recheck after inspecting the textarea.
  onStage('verify-receipt-still-current');
  if ((await findVisible('nodeSaveReceipt', false)).text !== receipt) throw new Error('save-receipt-changed');
  if (!SUCCESS_PATTERN.test((await findVisible('nodeSaveResult', false)).text || '')) {
    throw new Error('save-ui-not-confirmed');
  }
  onStage('return-to-main');
  await click('backToProbe');
  await wait(250);
  if (layout(['nodes', 'home']).page === 'nodes') {
    await click('backToConnection', 'nodes');
    await wait(250);
  }
  await findVisible('openNodeConfig', true, 'home');
  // saved/saveReceiptFresh remain compatibility aliases. Their meaning is
  // confirmed catalog persistence, never that this node is selected or active.
  return { saved: true, savedToCatalog: true, readbackReceiptVerified: true,
    saveReceiptFresh: true, inputCleared: true, returnedToMain: true };
}

async function main() {
  let stage = 'read-input';
  try {
    const fileIndex = process.argv.indexOf('--file');
    if (fileIndex < 0 || !process.argv[fileIndex + 1]) throw new Error('file-required');
    const hdc = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
    const original = fs.readFileSync(path.resolve(process.argv[fileIndex + 1]), 'utf8');
    const result = await importOutboundText(original, {
      command: args => cp.execFileSync(hdc, args, { encoding: 'utf8', windowsHide: true,
        timeout: 15000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }),
      onStage: value => { stage = value; }
    });
    // Booleans only; node content and receipt remain private.
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (_) {
    // Never print an exception or subprocess stderr: either can contain input.
    process.stderr.write(JSON.stringify({ saved: false, savedToCatalog: false, readbackReceiptVerified: false, stage,
      detail: 'Private import did not complete; no credentials printed.' }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { importOutboundText, isEmptyInput, expectedServer };
if (require.main === module) main();
