/*
 * Offline checks of the real NodeEditGuard.ets with synthetic state readers and
 * native.processAlive. No app state files, private files, device or network access.
 * Usage: node scripts/test-node-edit-guard.cjs
 */
const fs = require('fs'), path = require('path'), Module = require('module'), assert = require('assert');
const project = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const filename = path.join(project, 'entry/src/main/ets/model/NodeEditGuard.ets');
const source = fs.readFileSync(filename, 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true
});
assert.equal(output.diagnostics.length, 0, 'Guard must transpile without diagnostics');

const FILES = '/synthetic/safe-state';
const RUN = 'synthetic-current-run';
const OLD_RUN = 'synthetic-previous-run';
const DENIED = '请先断开连接并等待清理完成，再修改节点。';
const NATIVE_ERROR = new Error('synthetic-native-query-error-must-not-escape');
const PROBE_BUSY = ['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'stop_requested'];
const SERVICE_BUSY = ['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'destroying'];

class ProbeState {
  constructor(phase = 'idle', runId = RUN) {
    this.phase = phase;
    this.detail = 'synthetic state';
    this.updatedAt = 1000;
    this.runId = runId;
    this.kind = 'connection';
    Object.freeze(this);
  }
}
class ConnectionStatus {
  constructor(phase, { runId = RUN, cleanupConfirmed = false, servicePid = 0 } = {}) {
    this.runId = runId;
    this.phase = phase;
    this.updatedAt = 1000;
    this.cleanupConfirmed = cleanupConfirmed;
    this.servicePid = servicePid;
    Object.freeze(this);
  }
}

function harness(state, status, processResult = true) {
  const calls = { probeReads: [], statusReads: [], pids: [] };
  const imports = {
    './ProbeState': { readProbeState(filesDir) { calls.probeReads.push(filesDir); return state; } },
    './ConnectionControl': { readConnectionStatus(filesDir) { calls.statusReads.push(filesDir); return status; } },
    'libvpnbridge.so': { default: { processAlive(pid) {
      calls.pids.push(pid);
      if (processResult === 'throws') throw NATIVE_ERROR;
      return processResult;
    } } }
  };
  const module = new Module(filename);
  module.require = name => {
    assert(Object.hasOwn(imports, name), 'Unexpected production dependency in guard test');
    return imports[name];
  };
  module._compile(output.outputText, filename);
  return { api: module.exports, calls };
}

let cases = 0;
function verify(state, status, allowed, processResult = true, queriedPid = undefined) {
  const h = harness(state, status, processResult);
  assert.equal(h.api.isNodeManagementAllowed(FILES), allowed);
  if (allowed) {
    assert.doesNotThrow(() => h.api.assertNodeManagementAllowed(FILES));
  } else {
    assert.throws(() => h.api.assertNodeManagementAllowed(FILES), error => {
      assert.equal(error.message, DENIED);
      assert(!error.stack.includes(NATIVE_ERROR.message));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.deepEqual(h.calls.probeReads, [FILES, FILES]);
  assert.deepEqual(h.calls.statusReads, [FILES, FILES]);
  assert.deepEqual(h.calls.pids, queriedPid === undefined ? [] : [queriedPid, queriedPid]);
  cases++;
}

let groups = 0;
function check(name, test) { test(); groups++; console.log('PASS ' + name); }

check('all busy probe states including recovery and network waiting deny without service status', () => {
  for (const phase of PROBE_BUSY) {
    verify(new ProbeState(phase), undefined, false);
  }
});
check('all matching busy service states including recovery and network waiting deny', () => {
  for (const phase of SERVICE_BUSY) {
    for (const probePhase of ['idle', 'failed', 'stopped']) {
      verify(new ProbeState(probePhase), new ConnectionStatus(phase), false);
      verify(new ProbeState(probePhase), new ConnectionStatus(phase, { servicePid: 321 }), false, true, 321);
    }
  }
});
check('confirmed destroyed for this run permits editing without probing the PID', () => {
  for (const phase of [...PROBE_BUSY, 'failed']) {
    verify(new ProbeState(phase),
      new ConnectionStatus('destroyed', { cleanupConfirmed: true, servicePid: 321 }), true, 'throws');
  }
});
check('confirmed PID death permits recovery from stale busy state', () => {
  for (const phase of SERVICE_BUSY) {
    for (const probePhase of [...PROBE_BUSY, 'failed']) {
      verify(new ProbeState(probePhase), new ConnectionStatus(phase, { servicePid: 321 }), true, false, 321);
    }
  }
});
check('PID query exception never counts as confirmed death', () => {
  for (const phase of SERVICE_BUSY) {
    for (const probePhase of ['active', 'recovering', 'waiting-network', 'failed', 'idle']) {
      verify(new ProbeState(probePhase), new ConnectionStatus(phase, { servicePid: 321 }), false, 'throws', 321);
    }
  }
});
check('invalid or absent PID cannot authorize recovery', () => {
  for (const servicePid of [0, -1, 1.5, NaN, Infinity, undefined, '321']) {
    for (const phase of ['active', 'recovering', 'waiting-network']) {
      verify(new ProbeState(phase), new ConnectionStatus(phase, { servicePid }), false, false);
    }
  }
});
check('destroyed without cleanup acknowledgement cannot override active, recovery or waiting probe state', () => {
  for (const phase of ['active', 'recovering', 'waiting-network']) {
    verify(new ProbeState(phase), new ConnectionStatus('destroyed'), false);
    verify(new ProbeState(phase), new ConnectionStatus('destroyed', { servicePid: 321 }), false, true, 321);
    verify(new ProbeState(phase), new ConnectionStatus('destroyed', { servicePid: 321 }), false, 'throws', 321);
  }
});
check('different-run active status cannot block a new idle state or query its PID', () => {
  for (const phase of SERVICE_BUSY) {
    verify(new ProbeState('idle'), new ConnectionStatus(phase, { runId: OLD_RUN, servicePid: 321 }), true, 'throws');
  }
});
check('old-run cleanup acknowledgement or dead PID cannot authorize editing a new busy run', () => {
  for (const phase of PROBE_BUSY) {
    verify(new ProbeState(phase),
      new ConnectionStatus('destroyed', { runId: OLD_RUN, cleanupConfirmed: true, servicePid: 321 }), false, false);
    verify(new ProbeState(phase),
      new ConnectionStatus('active', { runId: OLD_RUN, servicePid: 321 }), false, false);
  }
});
check('failed probe still denies while service reports active for the same run', () => {
  verify(new ProbeState('failed'), new ConnectionStatus('active'), false);
  verify(new ProbeState('failed'), new ConnectionStatus('active', { servicePid: 321 }), false, true, 321);
  verify(new ProbeState('failed'), new ConnectionStatus('active', { servicePid: 321 }), false, 'throws', 321);
});
check('new idle state with no service record permits editing', () => {
  verify(new ProbeState('idle', ''), undefined, true);
  verify(new ProbeState('idle'), undefined, true);
});

console.log(`PASS ${groups} offline node-edit-guard groups (${cases} state cases, both exports checked); no device or app files accessed`);
