'use strict';
// Explicit emulator/UI-preview observation. Fixture creation/restoration belongs
// to its separate workflow; this script never replaces a node catalog.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { parseStat } = require('./measure-device-stability.cjs');
const TOTAL_TIMEOUT_MS = 180000;
const MAX_METADATA_BYTES = 65536;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CODES = new Set(['INVALID_ARGUMENTS', 'ARTIFACT_LABEL_EXISTS', 'INSTALLATION_RECORD_INVALID',
  'EMULATOR_REQUIRED', 'ARTIFACT_CHANGED', 'UI_PREVIEW_REQUIRED', 'CAPTURE_ARTIFACT_MISMATCH', 'STOP_REQUESTED',
  'TOTAL_TIMEOUT', 'UI_CONDITION_TIMEOUT', 'INPUT_METHOD_CONSENT', 'CONTROL_UNAVAILABLE',
  'INVALID_BOUNDS', 'UI_TREE_LIMIT', 'SYNTHETIC_500_NODES_REQUIRED', 'PID_INVALID',
  'PROCESS_RESTARTED', 'PROCESS_COUNTER_INVALID', 'HDC_OR_UI_FAILURE']);
class BenchmarkError extends Error {
  constructor(code) { super(CODES.has(code) ? code : 'HDC_OR_UI_FAILURE'); this.code = this.message; }
}
function failureCode(error) {
  return error instanceof BenchmarkError && CODES.has(error.code) ? error.code : 'HDC_OR_UI_FAILURE';
}
function parseArgs(args) {
  if (args.length !== 2 || !/^127\.0\.0\.1:15\d{3}$/.test(args[0] || '') ||
    !/^[a-z0-9-]{1,64}$/.test(args[1] || '')) throw new BenchmarkError('INVALID_ARGUMENTS');
  return { target: args[0], label: args[1] };
}
function packageIdentity(info) {
  if (typeof info.versionName !== 'string' || info.versionName.length > 64 ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?-ui-preview$/.test(info.versionName) ||
    !Number.isSafeInteger(info.versionCode) || info.versionCode < 1 ||
    info.applicationInfo?.cpuAbi !== 'x86_64') throw new BenchmarkError('UI_PREVIEW_REQUIRED');
  return { versionName: info.versionName, versionCode: info.versionCode };
}
async function runBenchmark(options, adapters = {}) {
  const { target, label } = parseArgs([options.target, options.label]);
  const io = adapters.fs || fs, command = adapters.execFileSync || cp.execFileSync;
  const now = adapters.now || (() => performance.now());
  const pause = adapters.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const readStat = adapters.parseStat || parseStat;
  const root = adapters.root || path.resolve(__dirname, '..');
  const bundle = 'com.example.harmonyvpnlab';
  const hdc = path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
    'sdk/default/openharmony/toolchains/hdc.exe');
  const dir = path.join(root, 'build/phase14-list-benchmark', label);
  const stopFile = path.join(dir, 'STOP');
  const qaDir = path.join(root, 'build/phase14-emulators');
  const qaLabel = 'pc-' + label;
  const projectionFile = path.join(qaDir, qaLabel + '.json');
  const installationFile = path.join(qaDir, 'install-' + target.split(':')[1] + '.json');
  const remote = '/data/local/tmp/harmony-list-benchmark-' + process.pid + '.json';
  const deadline = now() + TOTAL_TIMEOUT_MS;
  let created = false;
  function check() {
    if (io.existsSync(stopFile)) throw new BenchmarkError('STOP_REQUESTED');
    if (now() >= deadline) throw new BenchmarkError('TOTAL_TIMEOUT');
  }
  function remaining(maximum) { check(); return Math.max(1, Math.min(maximum, Math.floor(deadline - now()))); }
  function run(args, cleanup = false) {
    return command(hdc, ['-t', target, ...args], { encoding: 'utf8', windowsHide: true,
      timeout: cleanup ? 3000 : remaining(12000), maxBuffer: MAX_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const shell = (...args) => run(['shell', ...args]);
  function jsonFile(file) {
    const fd = io.openSync(file, 'r');
    try {
      const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = io.readSync(fd, bytes, count, bytes.length - count, count);
        if (!Number.isSafeInteger(read) || read < 0 || read > bytes.length - count) {
          throw new BenchmarkError('INSTALLATION_RECORD_INVALID');
        }
        if (read === 0) break;
        count += read;
      }
      if (count === 0 || count > MAX_METADATA_BYTES) throw new BenchmarkError('INSTALLATION_RECORD_INVALID');
      return JSON.parse(bytes.subarray(0, count).toString('utf8'));
    } finally { io.closeSync(fd); }
  }
  function installation() {
    let record;
    try { record = jsonFile(installationFile); }
    catch (_) { throw new BenchmarkError('INSTALLATION_RECORD_INVALID'); }
    if (record?.target !== target || !/^[a-f0-9]{64}$/i.test(record.sha256 || '') ||
      typeof record.versionName !== 'string' || !Number.isSafeInteger(record.versionCode)) {
      throw new BenchmarkError('INSTALLATION_RECORD_INVALID');
    }
    return { target, sha256: record.sha256.toLowerCase(), versionName: record.versionName, versionCode: record.versionCode };
  }
  function installedPackage() {
    const raw = shell('bm', 'dump', '-n', bundle);
    return packageIdentity(JSON.parse(raw.slice(raw.indexOf('{'))));
  }
  function sameCandidate(expected) {
    check();
    const record = installation(), actual = installedPackage();
    if (record.sha256 !== expected.sha256 || record.versionName !== expected.versionName ||
      record.versionCode !== expected.versionCode || actual.versionName !== expected.versionName ||
      actual.versionCode !== expected.versionCode) throw new BenchmarkError('ARTIFACT_CHANGED');
  }
  function snap() {
    let tree;
    try {
      shell('uitest', 'dumpLayout', '-p', remote);
      tree = JSON.parse(shell('cat', remote));
    } finally {
      // Cleanup remains bounded after deadline/STOP and only targets this run.
      run(['shell', 'rm', '-f', remote], true);
    }
    const all = [], queue = [{ node: tree, owner: '' }];
    let seen = 0;
    while (queue.length) {
      if (++seen > 20000) throw new BenchmarkError('UI_TREE_LIMIT');
      const { node, owner: parent } = queue.pop();
      if (!node || typeof node !== 'object') throw new BenchmarkError('UI_TREE_LIMIT');
      const a = node.attributes || {}, owner = a.bundleName || parent;
      if (a.visible === true || a.visible === 'true') {
        if (typeof a.id === 'string' && a.id.startsWith('Paf.Permission.')) throw new BenchmarkError('INPUT_METHOD_CONSENT');
        if (owner === bundle) all.push(a);
      }
      const children = node.children || [];
      if (!Array.isArray(children) || children.length > 20000 || queue.length + children.length > 20000) {
        throw new BenchmarkError('UI_TREE_LIMIT');
      }
      for (let i = children.length - 1; i >= 0; i--) queue.push({ node: children[i], owner });
    }
    return all;
  }
  function click(control) {
    if (!control || (control.enabled !== true && control.enabled !== 'true')) throw new BenchmarkError('CONTROL_UNAVAILABLE');
    const bounds = String(control.bounds || '').match(/-?\d+/g)?.map(Number);
    if (!bounds || bounds.length !== 4 || bounds.some(value => !Number.isSafeInteger(value)) ||
      bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new BenchmarkError('INVALID_BOUNDS');
    shell('uitest', 'uiInput', 'click', String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2)));
  }
  function stat(pid) { return readStat(shell('cat', `/proc/${pid}/stat`), pid); }
  async function sleep(ms) { await pause(remaining(ms)); check(); }
  async function until(condition) {
    const end = Math.min(deadline, now() + 20000);
    do {
      check(); const controls = snap();
      if (condition(controls)) return controls;
      await sleep(100);
    } while (now() < end);
    check(); throw new BenchmarkError('UI_CONDITION_TIMEOUT');
  }
  try {
    if (io.existsSync(dir) || io.existsSync(projectionFile) || io.existsSync(path.join(qaDir, qaLabel + '.jpeg'))) {
      throw new BenchmarkError('ARTIFACT_LABEL_EXISTS');
    }
    check();
    if (shell('param', 'get', 'const.product.model').trim() !== 'emulator' ||
      shell('param', 'get', 'const.product.name').trim() !== 'emulator' ||
      shell('param', 'get', 'const.product.cpu.abilist').trim() !== 'x86_64') {
      throw new BenchmarkError('EMULATOR_REQUIRED');
    }
    const expected = installation();
    sameCandidate(expected);
    io.mkdirSync(dir, { recursive: true }); created = true;
    command(process.execPath, [path.join(__dirname, 'test-adaptive-emulator.cjs'), target, 'Nodes', qaLabel, 'phase14'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: remaining(90000), maxBuffer: MAX_OUTPUT_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HARMONY_UI_QA_CAPTURE_IMAGE: '0' } });
    check();
    const capture = jsonFile(projectionFile);
    if (capture?.target !== target || capture.label !== qaLabel || capture.mode !== 'Nodes' ||
      typeof capture.artifactSHA256 !== 'string' || capture.artifactSHA256.toLowerCase() !== expected.sha256) {
      throw new BenchmarkError('CAPTURE_ARTIFACT_MISMATCH');
    }
    sameCandidate(expected);
    let controls = await until(items => items.some(item => item.id === 'nodeLatency-qa-load-001' &&
      typeof item.text === 'string' && item.text.startsWith('首次 HTTPS 500 ms')));
    if (!controls.some(item => item.id === 'nodeCount' && item.text === '共 500 个节点')) {
      throw new BenchmarkError('SYNTHETIC_500_NODES_REQUIRED');
    }
    const pidText = shell('pidof', bundle).trim();
    if (!/^\d{1,10}$/.test(pidText) || !Number.isSafeInteger(Number(pidText)) || Number(pidText) < 1) {
      throw new BenchmarkError('PID_INVALID');
    }
    const pid = Number(pidText), birth = stat(pid).startTimeTicks, results = [];
    for (let i = 0; i < 6; i++) {
      sameCandidate(expected);
      const before = stat(pid), start = now();
      click(controls.find(item => item.id === 'sortNodeLatency'));
      const optionId = i % 2 === 0 ? 'sortNodesFirstHttps' : 'sortNodesOriginal';
      controls = await until(items => ['sortNodesOriginal', 'sortNodesFirstHttps', 'sortNodesReused']
        .every(id => items.some(item => item.id === id)));
      sameCandidate(expected);
      click(controls.find(item => item.id === optionId));
      const expectedFirstNode = i % 2 === 0 ? 'nodeName-qa-load-500' : 'nodeName-qa-load-001';
      controls = await until(items => items.find(item => item.id?.startsWith('nodeName-qa-load-'))?.id === expectedFirstNode);
      const after = stat(pid);
      if (before.startTimeTicks !== birth || after.startTimeTicks !== birth) throw new BenchmarkError('PROCESS_RESTARTED');
      const cpuTicks = after.totalTicks - before.totalTicks;
      if (!Number.isSafeInteger(cpuTicks) || cpuTicks < 0) throw new BenchmarkError('PROCESS_COUNTER_INVALID');
      results.push({ sortedBySyntheticLatency: i % 2 === 0, expectedFirstNode,
        elapsedMs: Number((now() - start).toFixed(2)), uiCpuTicks: cpuTicks });
      await sleep(400);
    }
    sameCandidate(expected);
    const result = { target, label, version: expected.versionName, versionCode: expected.versionCode,
      artifactSHA256: expected.sha256, artifactSource: 'Matching emulator installation record and UI projection; bm version/code rechecked',
      nodes: 500, historySynthetic: true, fixtureValidation: 'UI count and sentinel rows; complete fixture validation belongs to the fixture workflow',
      initiatedNetworkActions: 0, networkRequestsObserved: null, totalTimeoutMs: TOTAL_TIMEOUT_MS,
      stopMarker: path.relative(root, stopFile), results,
      scope: 'Sort menu open and selection to expected first row via UI inspector; includes HDC overhead. CPU units are OS clock ticks. No VPN/network measurement.' };
    check(); io.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const code = failureCode(error);
    if (created) {
      try { io.writeFileSync(path.join(dir, 'failure.json'), JSON.stringify({ error: code, at: new Date().toISOString() })); }
      catch (_) { /* Failure-report storage errors must not expose native details. */ }
    }
    throw new BenchmarkError(code);
  }
}
module.exports = { parseArgs, runBenchmark, failureCode, BenchmarkError, TOTAL_TIMEOUT_MS };
if (require.main === module) {
  Promise.resolve().then(() => runBenchmark(parseArgs(process.argv.slice(2))))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(failureCode(error)); process.exitCode = 1; });
}
