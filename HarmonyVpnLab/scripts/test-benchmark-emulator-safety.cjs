'use strict';
// Actual benchmark controller with simulated commands, monotonic time and an
// in-memory filesystem. Never invokes HDC, a child process or real build paths.
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseArgs, runBenchmark, failureCode, BenchmarkError, TOTAL_TIMEOUT_MS } = require('./benchmark-emulator-list.cjs');
const TARGET = '127.0.0.1:15558', LABEL = 'synthetic-candidate', HASH = 'a'.repeat(64);
const SECRET = 'synthetic-private-uri-and-credential';
function fixture() {
  const root = path.resolve('synthetic-benchmark-root');
  const dir = path.join(root, 'build/phase14-list-benchmark', LABEL);
  const qaDir = path.join(root, 'build/phase14-emulators');
  const installFile = path.join(qaDir, 'install-15558.json');
  const projectionFile = path.join(qaDir, 'pc-' + LABEL + '.json');
  const files = new Map(), directories = new Set(), handles = new Map();
  const state = { clock: 0, commands: [], writes: [], nextFd: 1, closed: 0,
    helperCalls: 0, snapshots: 0, cleanups: 0, clicks: 0, sorted: false, stop: false,
    guest: { 'const.product.model': 'emulator', 'const.product.name': 'emulator', 'const.product.cpu.abilist': 'x86_64' },
    info: { versionName: '0.14.0-ui-preview', versionCode: 35, applicationInfo: { cpuAbi: 'x86_64' } },
    record: { target: TARGET, versionName: '0.14.0-ui-preview', versionCode: 35, sha256: HASH },
    count: '共 500 个节点', sentinel: true, bounds: '[10,20][110,70]', pid: '120',
    captureHash: HASH, captureTarget: TARGET, captureMode: 'Nodes',
    invalidJson: false, deepTree: false, commandFailure: false, parseFailure: false,
    stopAfterDump: false, expireAfterHelper: false, swapAfterHelper: false,
    swapAfterClick: false, restartAfterClick: false, stopAfterClick: false,
    malformedRead: false, shortRead: 65537, failFailureWrite: false, nativeTime: 10 };
  function put(file, value) { files.set(file, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); }
  function updateRecord() { put(installFile, state.record); }
  updateRecord();
  const io = {
    existsSync(file) { return file === path.join(dir, 'STOP') && state.stop || files.has(file) || directories.has(file); },
    mkdirSync(file) { assert.equal(file, dir); directories.add(file); },
    openSync(file, mode) { assert.equal(mode, 'r'); if (!files.has(file)) throw Error(SECRET); const fd = state.nextFd++; handles.set(fd, file); return fd; },
    readSync(fd, output, offset, length, position) {
      assert(output.length <= 65537); assert(handles.has(fd));
      if (state.malformedRead) return -1;
      const data = files.get(handles.get(fd));
      const count = Math.max(0, Math.min(length, state.shortRead, data.length - position));
      data.copy(output, offset, position, position + count); return count;
    },
    closeSync(fd) { assert(handles.delete(fd)); state.closed++; },
    writeFileSync(file, text) {
      assert([path.join(dir, 'result.json'), path.join(dir, 'failure.json')].includes(file));
      if (state.failFailureWrite && file.endsWith('failure.json')) throw Error(SECRET);
      state.writes.push(file); files.set(file, Buffer.from(text));
    }
  };
  function tree() {
    const item = (id, text = '', extra = {}) => ({ attributes: { id, text, visible: 'true', enabled: 'true',
      bounds: '[10,20][110,70]', ...extra }, children: [] });
    if (state.deepTree) return { attributes: {}, children: Array.from({ length: 20001 }, () => item('synthetic')) };
    const children = [item('nodeCount', state.count), item('sortNodeLatency', '', { bounds: state.bounds }),
      item(state.sorted ? 'nodeName-qa-load-500' : 'nodeName-qa-load-001')];
    if (state.sentinel) children.push(item('nodeLatency-qa-load-001', 'HTTPS 500 ms'));
    return { attributes: { bundleName: 'com.example.harmonyvpnlab', visible: 'true' }, children };
  }
  const execFileSync = (file, args, options) => {
    state.clock += state.nativeTime; state.commands.push({ file, args, options });
    assert.equal(options.windowsHide, true); assert(options.timeout > 0 && options.timeout <= 90000);
    assert.equal(options.maxBuffer, 8 * 1024 * 1024);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    if (state.commandFailure) throw Error('native failed: ' + SECRET);
    if (file === process.execPath) {
      state.helperCalls++; assert.deepEqual(args.slice(1), [TARGET, 'Nodes', 'pc-' + LABEL, 'phase14']);
      assert.equal(options.env.HARMONY_UI_QA_CAPTURE_IMAGE, '0', 'No screenshot before fixture validation');
      put(projectionFile, { target: state.captureTarget, label: 'pc-' + LABEL, mode: state.captureMode, artifactSHA256: state.captureHash });
      if (state.expireAfterHelper) state.clock += TOTAL_TIMEOUT_MS;
      if (state.swapAfterHelper) { state.record.sha256 = 'b'.repeat(64); updateRecord(); }
      return '{}';
    }
    assert.deepEqual(args.slice(0, 3), ['-t', TARGET, 'shell']);
    const shell = args.slice(3);
    if (shell[0] === 'param') return state.guest[shell[2]];
    if (shell[0] === 'bm') return JSON.stringify(state.info);
    if (shell[0] === 'pidof') return state.pid;
    if (shell[0] === 'uitest' && shell[1] === 'dumpLayout') {
      state.snapshots++; if (state.stopAfterDump) state.stop = true; return '';
    }
    if (shell[0] === 'cat' && shell[1].startsWith('/data/local/tmp/harmony-list-benchmark-')) {
      return state.invalidJson ? SECRET : JSON.stringify(tree());
    }
    if (shell[0] === 'cat' && shell[1] === '/proc/120/stat') {
      return JSON.stringify({ startTimeTicks: state.restartAfterClick && state.clicks ? 999 : 123,
        totalTicks: Math.floor(state.clock / 10) });
    }
    if (shell[0] === 'uitest' && shell[1] === 'uiInput' && shell[2] === 'click') {
      state.clicks++; state.sorted = !state.sorted;
      if (state.stopAfterClick) state.stop = true;
      if (state.swapAfterClick) { state.record.sha256 = 'c'.repeat(64); updateRecord(); }
      return '';
    }
    if (shell[0] === 'rm') {
      assert.equal(shell[1], '-f'); assert(/^\/data\/local\/tmp\/harmony-list-benchmark-\d+\.json$/.test(shell[2]));
      assert.equal(options.timeout, 3000); state.cleanups++; return '';
    }
    throw Error('Unexpected synthetic command');
  };
  const adapters = { root, fs: io, execFileSync, now: () => state.clock, sleep: async ms => { state.clock += ms; },
    parseStat: text => { if (state.parseFailure) throw Error(SECRET); return JSON.parse(text); } };
  return { state, files, directories, handles, dir, installFile, projectionFile, updateRecord, put,
    run: () => runBenchmark({ target: TARGET, label: LABEL }, adapters),
    failure: () => files.has(path.join(dir, 'failure.json')) ? JSON.parse(files.get(path.join(dir, 'failure.json'))) : undefined };
}
const passed = [];
async function test(name, run) { await run(); passed.push(name); }
async function rejects(f, expected) {
  await assert.rejects(f.run(), error => error.message === expected && error.code === expected);
  assert(!f.files.has(path.join(f.dir, 'result.json')));
  assert.equal(f.handles.size, 0);
  for (const file of f.state.writes) assert(!f.files.get(file).toString('utf8').includes(SECRET));
}
async function main() {
  await test('CLI accepts only an explicit emulator and bounded new label', () => {
    assert.deepEqual(parseArgs([TARGET, LABEL]), { target: TARGET, label: LABEL });
    for (const args of [[], [TARGET], [TARGET, LABEL, 'extra'], ['usb-device', LABEL], ['127.0.0.1:25558', LABEL],
      [TARGET, '../escape'], [TARGET, 'A'], [TARGET, 'a'.repeat(65)]]) assert.throws(() => parseArgs(args), e => e.code === 'INVALID_ARGUMENTS');
  });
  await test('six bounded sort observations bind installation hash, bm version/code and projection', async () => {
    const f = fixture(); const result = await f.run();
    assert.equal(result.results.length, 6); assert.equal(result.artifactSHA256, HASH); assert.equal(result.versionCode, 35);
    assert.equal(result.version, '0.14.0-ui-preview'); assert.equal(result.networkRequestsObserved, null);
    assert.equal(result.initiatedNetworkActions, 0); assert.equal(result.totalTimeoutMs, TOTAL_TIMEOUT_MS);
    assert.equal(f.state.helperCalls, 1); assert.equal(f.state.snapshots, f.state.cleanups); assert.equal(f.handles.size, 0);
    assert(f.state.commands.slice(0, 3).every(c => c.args[3] === 'param'));
    assert(f.state.commands.every(c => c.file === process.execPath || c.args[1] === TARGET));
    assert(!f.state.commands.some(c => c.args.includes('file') || c.args.includes('send') || c.args.includes('install')));
  });
  for (const property of ['const.product.model', 'const.product.name', 'const.product.cpu.abilist']) {
    await test(property + ' rejects a non-emulator before any UI work', async () => {
      const f = fixture(); f.state.guest[property] = 'physical-device'; await rejects(f, 'EMULATOR_REQUIRED');
      assert.equal(f.state.helperCalls, 0); assert.equal(f.state.snapshots, 0); assert.equal(f.directories.size, 0);
    });
  }
  for (const change of ['release', 'arm64', 'unsafe version']) {
    await test(change + ' package fails before navigation or AX capture', async () => {
      const f = fixture();
      if (change === 'release') f.state.info.versionName = '0.14.0';
      if (change === 'arm64') f.state.info.applicationInfo.cpuAbi = 'arm64-v8a';
      if (change === 'unsafe version') f.state.info.versionName = SECRET + '-ui-preview';
      await rejects(f, 'UI_PREVIEW_REQUIRED'); assert.equal(f.state.helperCalls, 0); assert.equal(f.state.snapshots, 0);
    });
  }
  for (const change of ['missing', 'target', 'hash', 'oversized', 'invalid read count']) {
    await test(change + ' installation record is rejected with bounded closed reads', async () => {
      const f = fixture();
      if (change === 'missing') f.files.delete(f.installFile);
      if (change === 'target') { f.state.record.target = '127.0.0.1:15555'; f.updateRecord(); }
      if (change === 'hash') { f.state.record.sha256 = ''; f.updateRecord(); }
      if (change === 'oversized') f.put(f.installFile, ' '.repeat(65537));
      if (change === 'invalid read count') f.state.malformedRead = true;
      await rejects(f, 'INSTALLATION_RECORD_INVALID'); assert.equal(f.state.helperCalls, 0);
    });
  }
  await test('short local metadata reads are reassembled without unbounded allocation', async () => {
    const f = fixture(); f.state.shortRead = 7; assert.equal((await f.run()).artifactSHA256, HASH); assert.equal(f.handles.size, 0);
  });
  for (const field of ['versionName', 'versionCode']) {
    await test(field + ' mismatch between installation record and bm cannot be attributed to a candidate', async () => {
      const f = fixture(); f.state.record[field] = field === 'versionName' ? '0.13.0-ui-preview' : 34; f.updateRecord();
      await rejects(f, 'ARTIFACT_CHANGED'); assert.equal(f.state.helperCalls, 0);
    });
  }
  for (const field of ['captureHash', 'captureTarget', 'captureMode']) {
    await test(field + ' mismatch rejects helper output before benchmark clicks', async () => {
      const f = fixture(); f.state[field] = 'mismatch'; await rejects(f, 'CAPTURE_ARTIFACT_MISMATCH'); assert.equal(f.state.clicks, 0);
    });
  }
  for (const change of ['swapAfterHelper', 'swapAfterClick']) {
    await test(change + ' prevents candidate mixing even with the same version and code', async () => {
      const f = fixture(); f.state[change] = true; await rejects(f, 'ARTIFACT_CHANGED');
    });
  }
  for (const conflict of ['run directory', 'QA json', 'QA jpeg']) {
    await test('existing ' + conflict + ' is never overwritten, including failed observations', async () => {
      const f = fixture();
      if (conflict === 'run directory') f.directories.add(f.dir);
      else f.put(conflict === 'QA json' ? f.projectionFile : f.projectionFile.replace(/\.json$/, '.jpeg'), 'original evidence');
      await rejects(f, 'ARTIFACT_LABEL_EXISTS'); assert.equal(f.state.commands.length, 0); assert.equal(f.state.writes.length, 0);
    });
  }
  await test('a non-500 catalog fails without sorting or exporting a screenshot', async () => {
    const f = fixture(); f.state.count = '共 2 个节点'; await rejects(f, 'SYNTHETIC_500_NODES_REQUIRED');
    assert.equal(f.state.clicks, 0); assert.equal(f.state.snapshots, f.state.cleanups);
  });
  await test('missing synthetic sentinel reaches the bounded UI deadline', async () => {
    const f = fixture(); f.state.sentinel = false; f.state.nativeTime = 1000;
    await rejects(f, 'UI_CONDITION_TIMEOUT'); assert.equal(f.state.clicks, 0); assert(f.state.clock < TOTAL_TIMEOUT_MS);
  });
  await test('global deadline stops work after helper completion before AX commands', async () => {
    const f = fixture(); f.state.expireAfterHelper = true; await rejects(f, 'TOTAL_TIMEOUT'); assert.equal(f.state.snapshots, 0);
  });
  for (const stop of ['stopAfterDump', 'stopAfterClick']) {
    await test(stop + ' honors STOP and still cleans the run-owned raw AX file', async () => {
      const f = fixture(); f.state[stop] = true; await rejects(f, 'STOP_REQUESTED');
      assert.equal(f.state.snapshots, f.state.cleanups);
      if (stop === 'stopAfterDump') assert.equal(f.state.clicks, 0); else assert.equal(f.state.clicks, 1);
    });
  }
  for (const fault of ['invalidJson', 'commandFailure', 'parseFailure']) {
    await test(fault + ' returns only fixed errors and never writes private-looking exception text', async () => {
      const f = fixture(); f.state[fault] = true; await rejects(f, 'HDC_OR_UI_FAILURE');
      if (fault === 'invalidJson') assert.equal(f.state.snapshots, f.state.cleanups);
    });
  }
  await test('failure-report write failure cannot leak the secondary exception', async () => {
    const f = fixture(); f.state.invalidJson = true; f.state.failFailureWrite = true; await rejects(f, 'HDC_OR_UI_FAILURE');
  });
  await test('unknown exception text and forged code properties are not an output channel', () => {
    for (const error of [Error(SECRET), { message: SECRET, code: 'STOP_REQUESTED' }, undefined,
      Object.assign(Error(SECRET), { code: 'STOP_REQUESTED' })]) assert.equal(failureCode(error), 'HDC_OR_UI_FAILURE');
    assert.equal(failureCode(new BenchmarkError('STOP_REQUESTED')), 'STOP_REQUESTED');
  });
  await test('oversized tree and invalid coordinates fail before clicks', async () => {
    const f = fixture(); f.state.deepTree = true; await rejects(f, 'UI_TREE_LIMIT'); assert.equal(f.state.clicks, 0);
    const second = fixture(); second.state.bounds = '[20,20][10,40]'; await rejects(second, 'INVALID_BOUNDS'); assert.equal(second.state.clicks, 0);
  });
  await test('PID reuse fails instead of mixing CPU counters from another process', async () => {
    const f = fixture(); f.state.restartAfterClick = true; await rejects(f, 'PROCESS_RESTARTED');
  });
  console.log(JSON.stringify({ suite: 'benchmark-emulator-safety', passed: passed.length,
    scope: 'Simulated HDC/helper commands, in-memory files and monotonic time; no device or build artifacts touched.', cases: passed }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
