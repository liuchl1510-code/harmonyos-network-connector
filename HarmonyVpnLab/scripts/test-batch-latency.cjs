'use strict';
// Actual pure ArkTS queue; synthetic identities/status only, no network or VPN.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(process.env.DEVECO_STUDIO_HOME || 'C:/Program Files/Huawei/DevEco Studio',
  'sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript'));
const source = fs.readFileSync(path.join(root, 'entry/src/main/ets/model/BatchLatency.ets'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(code.diagnostics.length, 0);
const context = { exports: {} }; vm.runInNewContext(code.outputText, context);
const { BatchLatencyQueue: Queue, BatchLatencyTarget: Target, BatchLatencyObservation: Observation, latencySortRank } = context.exports;
const digest = 'a'.repeat(64), secondDigest = 'b'.repeat(64);
const targets = () => [new Target('one', digest), new Target('two', secondDigest)];
const queue = () => { const q = new Queue(targets(), 'selected'); assert(q.claim('one', 'run-one', 'old-run')); return q; };
const observation = changes => Object.assign(new Observation(), { activeNodeId: 'selected', runId: 'run-one', kind: 'node-latency',
  phase: 'stopped', commandRunId: 'run-one', commandAction: 'start', statusRunId: 'run-one', statusPhase: 'destroyed',
  cleanupConfirmed: true, resultRunId: 'run-one', resultNodeId: 'one', resultFingerprint: digest, resultStatus: 'passed', resultReason: '' }, changes);
const passed = [];
function test(name, fn) { fn(); passed.push(name); }
test('snapshot copied without keeping caller target objects', () => {
  const input = targets(), q = new Queue(input, 'selected'); input[0].nodeId = 'changed'; input.push(new Target('three', digest));
  assert.equal(q.targets.length, 2); assert.equal(q.next().nodeId, 'one'); assert.equal(q.activeNodeId, 'selected');
});
test('snapshot bounds and identities reject malformed or duplicate targets', () => {
  for (const input of [[], Array.from({ length: 501 }, (_, i) => new Target('node-' + i, digest)),
    [new Target('one', digest), new Target('one', digest)], [new Target('../bad', digest)], [new Target('one', 'bad')]]) {
    assert.throws(() => new Queue(input, 'selected'));
  }
  assert.equal(new Queue(Array.from({ length: 500 }, (_, i) => new Target('n-' + i, digest)), '').targets.length, 500);
});
test('only next target can be claimed and overlapping claims are rejected', () => {
  const q = new Queue(targets(), 'selected'); assert.equal(q.claim('two', 'run-two', ''), false);
  assert(q.claim('one', 'run-one', '')); assert.equal(q.claim('two', 'run-two', ''), false); assert.equal(q.next(), undefined);
});
test('preceding heartbeat is accepted only until first own service heartbeat', () => {
  const q = queue(); assert.equal(q.observe(observation({ phase: 'starting', statusRunId: 'old-run' })), 'waiting');
  assert.equal(q.observe(observation({ phase: 'active', statusPhase: 'active' })), 'waiting');
  assert.equal(q.observe(observation({ phase: 'starting', statusRunId: 'old-run' })), 'aborted');
});
test('prior destroyed heartbeat reconnect count is ignored until current run is observed', () => {
  const q = queue();
  const prior = observation({ phase: 'starting', statusRunId: 'old-run', statusPhase: 'destroyed',
    cleanupConfirmed: true, servicePid: 555, serviceExited: true, reconnectCount: 3 });
  assert.equal(q.observe(prior), 'waiting'); assert.equal(q.observe(prior), 'waiting');
  assert.equal(q.phase, 'running'); assert.equal(q.completed, 0);
  assert.equal(q.observe(observation({ phase: 'active', statusPhase: 'active', servicePid: 123, reconnectCount: 0 })), 'waiting');
  assert.equal(q.observe(observation({ phase: 'active', statusPhase: 'active', servicePid: 123, reconnectCount: 1 })), 'aborted');
});
test('prior heartbeat is not a valid startup transition after current run status was seen', () => {
  const q = queue();
  assert.equal(q.observe(observation({ phase: 'starting', statusPhase: 'starting', reconnectCount: 0 })), 'waiting');
  assert.equal(q.observe(observation({ phase: 'starting', statusRunId: 'old-run', statusPhase: 'destroyed', reconnectCount: 1 })), 'aborted');
});
for (const phase of ['active', 'stopping', 'stopped', 'destroying']) test('terminal result waits while service is ' + phase, () => {
  const q = queue(); assert.equal(q.observe(observation({ statusPhase: phase })), 'waiting'); assert.equal(q.completed, 0);
});
test('destroyed without confirmed cleanup remains blocked until known process exit', () => {
  const q = queue(); assert.equal(q.observe(observation({ servicePid: 123, cleanupConfirmed: false })), 'waiting');
  assert.equal(q.observe(observation({ servicePid: 123, cleanupConfirmed: false, serviceExited: true })), 'next');
});
test('known live PID cannot advance on destroyed plus cleanup; actual exit advances once', () => {
  const q = queue(); assert.equal(q.observe(observation({ servicePid: 123 })), 'waiting');
  assert.equal(q.completed, 0); assert.equal(q.next(), undefined);
  assert.equal(q.observe(observation({ servicePid: 123, serviceExited: true })), 'next'); assert.equal(q.completed, 1);
  assert.equal(q.observe(observation({ servicePid: 123, serviceExited: true })), 'waiting'); assert.equal(q.completed, 1);
});
test('missing or invalid PID cannot downgrade known-PID release requirement', () => {
  const q = queue(); assert.equal(q.observe(observation({ servicePid: 123, phase: 'active', statusPhase: 'active' })), 'waiting');
  for (const servicePid of [0, undefined, -1, NaN, 1.5]) {
    assert.equal(q.observe(observation({ servicePid, serviceExited: true })), 'waiting'); assert.equal(q.completed, 0);
  }
  assert.equal(q.observe(observation({ servicePid: 123, serviceExited: true })), 'next');
});
test('unknown exit observation stays blocked and different PID aborts', () => {
  const q = queue(); assert.equal(q.observe(observation({ servicePid: 123, serviceExited: undefined })), 'waiting');
  assert.equal(q.observe(observation({ servicePid: 456, serviceExited: true })), 'aborted');
});
test('never-observed PID retains explicit destroyed and cleanup legacy fallback', () => {
  assert.equal(queue().observe(observation({ servicePid: 0 })), 'next');
  assert.equal(queue().observe(observation({ servicePid: 0, cleanupConfirmed: false, serviceExited: true })), 'waiting');
});
test('successful cleanup advances once and cannot reuse a duplicate observation', () => {
  const q = queue(); assert.equal(q.observe(observation()), 'next'); assert.equal(q.completed, 1);
  assert.equal(q.observe(observation()), 'waiting'); assert.equal(q.completed, 1);
  assert(q.claim('two', 'run-two', 'run-one'));
  assert.equal(q.observe(observation({ runId: 'run-two', commandRunId: 'run-two', statusRunId: 'run-two',
    resultRunId: 'run-two', resultNodeId: 'two', resultFingerprint: secondDigest })), 'completed');
  assert.equal(q.completed, 2); assert.equal(q.next(), undefined);
});
for (const reason of ['dns', 'https', 'timeout']) test('ordinary ' + reason + ' result can continue only after cleanup', () => {
  assert.equal(queue().observe(observation({ resultStatus: 'failed', resultReason: reason })), 'next');
});
for (const change of [{ activeNodeId: 'other' }, { runId: 'foreign' }, { kind: 'connection' }, { commandRunId: 'foreign' },
  { commandAction: 'stop' }, { commandAction: 'reconnect' }, { statusRunId: 'foreign' }, { phase: 'recovering' },
  { statusPhase: 'recovering' }, { reconnectCount: 1 }, { resultRunId: 'old' }, { resultFingerprint: secondDigest },
  { resultNodeId: 'two' }, { resultStatus: '' }, { resultStatus: 'cancelled', resultReason: 'stopped' },
  { resultStatus: 'failed', resultReason: 'configuration' }, { resultStatus: 'failed', resultReason: 'network-changed' }]) {
  test('mismatch aborts permanently: ' + JSON.stringify(change), () => {
    const q = queue(); assert.equal(q.observe(observation(change)), 'aborted'); assert.equal(q.next(), undefined);
    assert.equal(q.observe(observation()), 'aborted'); assert.equal(q.completed, 0);
  });
}
test('cancel before claim and late cleanup cannot resurrect queue', () => {
  const q = new Queue(targets(), 'selected'); q.cancel(); assert.equal(q.claim('one', 'run-one', ''), false);
  const running = queue(); running.cancel(); assert.equal(running.observe(observation()), 'aborted'); assert.equal(running.next(), undefined);
});
test('failed/missing values sort after positive HTTPS durations including real zero', () => {
  assert.equal(latencySortRank('passed', 0), 0); assert.equal(latencySortRank('passed', 250), 250);
  for (const status of ['failed', 'cancelled', '']) assert.equal(latencySortRank(status, 0), Infinity);
  assert.equal(latencySortRank('passed', NaN), Infinity);
});
const report = { passed: passed.length, failed: 0, sourceSHA256: crypto.createHash('sha256').update(source).digest('hex'),
  scope: 'Real pure ArkTS queue, synthetic run identities and cleanup observations; no device/network/private data.', tests: passed };
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/batch-latency-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Batch latency queue: ${passed.length}/${passed.length} passed.`);
