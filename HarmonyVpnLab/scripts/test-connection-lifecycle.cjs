'use strict';
// Exercise the authored resolver with synthetic receipts and process probes.
// No device, node configuration, native library, filesystem mutation or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const relative = 'entry/src/main/ets/model/ConnectionLifecycle.ets';
const source = fs.readFileSync(path.join(root, relative), 'utf8');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(compiled.diagnostics.length, 0);
const NOW = 1780000000000, RUN = '1780000000000', OTHER = '1770000000000', EPOCH = 'current-ui';
const baseState = change => ({ runId: RUN, kind: 'connection', phase: 'active', detail: 'private raw detail', updatedAt: NOW, ...change });
const baseCommand = change => ({ runId: RUN, action: 'start', ownerEpoch: EPOCH, createdAt: NOW, ...change });
const baseStatus = change => ({ runId: RUN, phase: 'active', servicePid: 1234, cleanupConfirmed: false, updatedAt: NOW, ...change });
const io = { state: baseState(), command: baseCommand(), status: baseStatus(), probe: () => true, calls: [], reads: [] };
const context = { exports: {}, require(name) {
  if (name === 'libvpnbridge.so') return { default: { processAlive(pid) { io.calls.push(pid); return io.probe(pid); } } };
  if (name === './ProbeState') return { readProbeState(dir) { io.reads.push(['state', dir]); return io.state; } };
  if (name === './ConnectionControl') return {
    CONNECTION_UI_EPOCH: EPOCH,
    isConnectionKind: kind => ['connection', 'connection-test', 'connection-app-test', 'node-latency'].includes(kind),
    readConnectionCommand(dir) { io.reads.push(['command', dir]); return io.command; },
    readConnectionStatus(dir) { io.reads.push(['status', dir]); return io.status; }
  };
  throw new Error('Unexpected dependency: ' + name);
} };
vm.runInNewContext(compiled.outputText, context, { filename: relative });
const { assessConnectionLifecycle: assess, readConnectionLifecycle: read } = context.exports;
const cases = [];
const test = (name, run) => { run(); cases.push({ name, passed: true }); };
function check(change = {}) {
  const state = Object.freeze(baseState(change.state));
  const command = change.noCommand ? undefined : Object.freeze(baseCommand(change.command));
  const status = change.noStatus ? undefined : Object.freeze(baseStatus(change.status));
  const before = JSON.stringify([state, command, status]);
  const result = assess(state, command, status, change.presence ?? 'present-or-unknown', EPOCH, change.now ?? NOW);
  assert.equal(result.state, state); assert.equal(result.command, command); assert.equal(result.status, status);
  assert.equal(JSON.stringify([state, command, status]), before, 'never modify persisted receipts');
  assert.equal(result.managementAllowed, result.closed);
  assert(!result.detail.includes('private raw detail')); assert(!result.detail.includes(RUN));
  assert(!result.detail.includes('1234'));
  return result;
}
test('current active session remains active and cannot overlap', () => {
  const value = check(); assert.equal(value.phase, 'active'); assert.equal(value.closed, false);
  assert.equal(value.ownerChanged, false); assert.equal(value.interruptionObserved, false);
});
for (const kind of ['connection', 'connection-test', 'connection-app-test', 'node-latency']) {
  test('absent process permits recovery without a forged cleanup receipt: ' + kind, () => {
    const value = check({ state: { kind }, status: { phase: 'destroying' }, presence: 'absent' });
    assert.equal(value.phase, 'interrupted'); assert.equal(value.closed, true); assert.equal(value.serviceExited, true);
    assert.equal(value.cleanupConfirmed, false); assert.equal(value.interruptionObserved, true);
    assert.equal(value.status.phase, 'destroying'); assert.equal(value.status.cleanupConfirmed, false);
  });
}
for (const presence of ['present-or-unknown', 'unknown']) {
  test('new UI owner cannot substitute for service exit: ' + presence, () => {
    const value = check({ command: { ownerEpoch: 'old-ui' }, presence });
    assert.equal(value.ownerChanged, true); assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false);
    assert.equal(value.serviceExited, false); assert.equal(value.interruptionObserved, false);
  });
  test('incomplete destroying receipt suppresses active display: ' + presence, () => {
    const value = check({ status: { phase: 'destroying' }, presence });
    assert.equal(value.phase, 'stopping'); assert.equal(value.closed, false);
  });
}
test('old owner plus absent service is a recoverable interruption', () => {
  const value = check({ command: { ownerEpoch: 'old-ui' }, presence: 'absent' });
  assert.equal(value.phase, 'interrupted'); assert.equal(value.closed, true); assert.equal(value.ownerChanged, true);
});
for (const phase of ['active', 'failed', 'stopped']) {
  test('completed cleanup survives UI recreation and contradictory old probe phase: ' + phase, () => {
    const value = check({ state: { phase }, command: { ownerEpoch: 'old-ui' }, status: { phase: 'destroyed', cleanupConfirmed: true } });
    assert.equal(value.phase, phase === 'failed' ? 'failed' : 'stopped'); assert.equal(value.closed, true);
    assert.equal(value.cleanupConfirmed, true); assert.equal(value.interruptionObserved, false);
    assert.equal(value.serviceExited, false, 'onDestroy acknowledgement does not prove PID absence');
  });
}
test('stopped cleanup receipt plus process absence is normal completion', () => {
  const value = check({ status: { phase: 'stopped', cleanupConfirmed: true }, presence: 'absent', command: { ownerEpoch: 'old-ui' } });
  assert.equal(value.phase, 'stopped'); assert.equal(value.cleanupConfirmed, true); assert.equal(value.interruptionObserved, false);
});
for (const phase of ['stopped', 'failed', 'passed', 'idle']) {
  test('terminal UI state cannot override a live service: ' + phase, () => {
    const value = check({ state: { phase } }); assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false);
  });
}
test('same run stop command restores stopping action despite terminal UI state', () => {
  const value = check({ state: { phase: 'failed' }, command: { action: 'stop' } });
  assert.equal(value.phase, 'stopping'); assert.equal(value.closed, false);
});
for (const phase of ['stopping', 'destroying']) {
  test('expired cleanup updates expose recovery without permitting overlap: ' + phase, () => {
    const value = check({ state: { phase: 'failed' }, status: { phase }, now: NOW + 12001 });
    assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false); assert.equal(value.serviceExited, false);
    assert.equal(value.interruptionObserved, false);
  });
  test('fresh service update retains normal cleanup waiting: ' + phase, () => {
    const value = check({ state: { phase: 'failed', updatedAt: NOW - 20000 }, status: { phase } });
    assert.equal(value.phase, 'stopping'); assert.equal(value.closed, false);
  });
}
test('foreign command does not alter ownership or stop this session', () => {
  const value = check({ command: { runId: OTHER, action: 'stop', ownerEpoch: 'old-ui' } });
  assert.equal(value.phase, 'active'); assert.equal(value.ownerChanged, false);
});
for (const presence of ['present-or-unknown', 'unknown']) {
  for (const complete of [false, true]) {
    test('foreign recorded PID cannot overlap pending service: ' + presence + ' cleanup=' + complete, () => {
      const value = check({ state: { phase: 'starting' }, status: { runId: OTHER, phase: complete ? 'destroyed' : 'destroying', cleanupConfirmed: complete }, presence });
      assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false); assert.equal(value.cleanupConfirmed, false);
      assert.equal(value.serviceExited, false); assert.equal(value.interruptionObserved, false);
      assert.equal(value.priorServiceUnresolved, true);
    });
  }
}
test('foreign absent status does not falsely close a current pending request', () => {
  const value = check({ state: { phase: 'starting' }, status: { runId: OTHER, phase: 'destroying' }, presence: 'absent' });
  assert.equal(value.phase, 'starting'); assert.equal(value.closed, false); assert.equal(value.serviceExited, false);
});
test('legacy completed foreign receipt without a PID does not block a pending request', () => {
  const value = check({ state: { phase: 'starting' }, status: { runId: OTHER, phase: 'destroyed', cleanupConfirmed: true, servicePid: 0 } });
  assert.equal(value.phase, 'starting'); assert.equal(value.closed, false);
});
test('foreign incomplete legacy receipt remains blocked without PID evidence', () => {
  const value = check({ state: { phase: 'stopped' }, status: { runId: OTHER, phase: 'destroying', servicePid: 0 } });
  assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false);
});
for (const pid of [2147483648, -1, '1234', NaN]) {
  test('foreign malformed PID cannot downgrade to cleanup-only legacy fallback: ' + String(pid), () => {
    const value = check({ state: { phase: 'stopped' }, status: { runId: OTHER, phase: 'destroyed', cleanupConfirmed: true, servicePid: pid } });
    assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false); assert.equal(value.priorServiceUnresolved, true);
  });
}
for (const age of [12001, 100000000, -1, NaN]) {
  test('stale or invalid heartbeat cannot establish service death: ' + String(age), () => {
    const value = check({ now: NOW + age }); assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false);
    assert.equal(value.serviceExited, false); assert.equal(value.interruptionObserved, false);
  });
}
test('missing service receipt stays blocked beyond admission deadline', () => {
  const value = check({ state: { phase: 'starting' }, noStatus: true, now: NOW + 30000, presence: 'absent' });
  assert.equal(value.closed, false); assert.equal(value.servicePresence, 'unknown'); assert.equal(value.serviceExited, false);
  assert.equal(value.priorServiceUnresolved, false, 'caller can distinguish ordinary authorization expiry');
});
for (const phase of ['starting', 'recovering', 'waiting-network']) {
  test('new service transition hides preceding active probe state: ' + phase, () => {
    const value = check({ status: { phase } }); assert.equal(value.phase, phase); assert.equal(value.closed, false);
  });
  test('active receipt alone cannot end preceding probe transition: ' + phase, () => {
    const value = check({ state: { phase } }); assert.equal(value.phase, phase); assert.equal(value.closed, false);
  });
}
test('unrecognized service phase cannot display an active connection', () => {
  const value = check({ status: { phase: 'malformed' } }); assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false);
});
test('explicit cancelled admission with no receipt allows retry', () => {
  const value = check({ state: { phase: 'failed' }, command: { action: 'stop' }, noStatus: true });
  assert.equal(value.phase, 'failed'); assert.equal(value.closed, true); assert.equal(value.interruptionObserved, false);
});
test('explicit cancelled admission survives UI recreation without claiming cleanup', () => {
  const value = check({ state: { phase: 'failed' }, command: { action: 'stop', ownerEpoch: 'old-ui' }, noStatus: true });
  assert.equal(value.phase, 'failed'); assert.equal(value.closed, true); assert.equal(value.ownerChanged, true);
  assert.equal(value.serviceExited, false); assert.equal(value.cleanupConfirmed, false); assert.equal(value.interruptionObserved, false);
});
test('old UI failed request without an explicit stop is not considered cancelled', () => {
  const value = check({ state: { phase: 'failed' }, command: { ownerEpoch: 'old-ui' }, noStatus: true });
  assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false);
});
test('old pending request cannot expire itself without explicit cancellation', () => {
  const value = check({ state: { phase: 'starting' }, command: { ownerEpoch: 'old-ui' }, noStatus: true, now: NOW + 100000 });
  assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false);
});
test('cancelled admission cannot bypass an unresolved foreign service', () => {
  const value = check({ state: { phase: 'failed' }, command: { action: 'stop', ownerEpoch: 'old-ui' }, status: { runId: OTHER } });
  assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false); assert.equal(value.priorServiceUnresolved, true);
});
test('active probe without a matching service receipt never displays connected', () => {
  const value = check({ noStatus: true }); assert.equal(value.phase, 'unknown'); assert.equal(value.closed, false);
  assert.equal(value.serviceExited, false);
});
for (const pid of [undefined, 0, -1, 1.25, NaN, Infinity, '1234', 2147483648, Number.MAX_SAFE_INTEGER + 1]) {
  test('invalid PID cannot produce false absence or invoke native: ' + String(pid), () => {
    const value = check({ status: { servicePid: pid }, presence: 'absent' });
    assert.equal(value.servicePresence, 'unknown'); assert.equal(value.serviceExited, false); assert.equal(value.closed, false);
    io.state = baseState(); io.command = baseCommand(); io.status = baseStatus({ servicePid: pid });
    io.calls = []; io.probe = () => false;
    assert.equal(read('/synthetic', NOW).servicePresence, 'unknown'); assert.equal(io.calls.length, 0);
  });
}
for (const pid of [1, 2147483647]) {
  test('valid PID boundary is probed exactly once: ' + pid, () => {
    io.state = baseState(); io.command = baseCommand(); io.status = baseStatus({ servicePid: pid });
    io.calls = []; io.reads = []; io.probe = () => false;
    const value = read('/synthetic', NOW);
    assert.equal(value.phase, 'interrupted'); assert.deepEqual(io.calls, [pid]);
    assert.deepEqual(io.reads, [['state', '/synthetic'], ['command', '/synthetic'], ['status', '/synthetic']]);
  });
}
for (const answer of [true, undefined, 0, 'false']) {
  test('native results other than strict false cannot confirm death: ' + String(answer), () => {
    io.state = baseState(); io.command = baseCommand(); io.status = baseStatus(); io.probe = () => answer;
    const value = read('/synthetic', NOW);
    assert.equal(value.servicePresence, answer === true ? 'present-or-unknown' : 'unknown');
    assert.equal(value.closed, false); assert.equal(value.serviceExited, false);
  });
}
test('native exception is unknown and cannot escape into UI', () => {
  io.probe = () => { throw new Error('synthetic permission failure'); };
  const value = read('/synthetic', NOW); assert.equal(value.servicePresence, 'unknown'); assert.equal(value.closed, false);
});
for (const cleanup of [1, 'true', undefined]) {
  test('truthy cleanup flag cannot forge acknowledgement: ' + String(cleanup), () => {
    const value = check({ status: { phase: 'destroyed', cleanupConfirmed: cleanup } });
    assert.equal(value.cleanupConfirmed, false); assert.equal(value.closed, false);
  });
}
test('impossible active cleanup flag is not accepted as a terminal receipt', () => {
  const value = check({ status: { cleanupConfirmed: true }, presence: 'absent' });
  assert.equal(value.phase, 'interrupted'); assert.equal(value.cleanupConfirmed, false);
});
test('empty identities do not match each other as a session', () => {
  const value = check({ state: { runId: '', phase: 'starting' }, status: { runId: '', phase: 'destroyed', cleanupConfirmed: true, servicePid: 0 }, command: { runId: '', ownerEpoch: 'old-ui' } });
  assert.equal(value.ownerChanged, false); assert.equal(value.cleanupConfirmed, false); assert.equal(value.closed, false);
});
for (const phase of ['starting', 'active', 'stopping', 'stop_requested']) {
  test('legacy developer probe remains protected: ' + phase, () => {
    const value = check({ state: { kind: 'lifecycle', phase }, noStatus: true });
    assert.equal(value.phase, 'diagnostic'); assert.equal(value.closed, false);
  });
}
test('idle developer probe allows normal node management', () => {
  const value = check({ state: { kind: 'lifecycle', phase: 'idle', runId: '' }, noStatus: true, noCommand: true });
  assert.equal(value.phase, 'idle'); assert.equal(value.closed, true);
});
const report = { scope: 'authored ArkTS lifecycle resolver with synthetic receipts and process probes; no device validation',
  source: relative, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  passed: cases.length, failed: 0, cases };
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/connection-lifecycle-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`PASS ${cases.length} connection lifecycle cases`);
