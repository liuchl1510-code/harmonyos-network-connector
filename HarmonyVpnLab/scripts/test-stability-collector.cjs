'use strict';

// Offline only: deterministic HDC output and a monotonic clock, no device access.
const assert = require('node:assert/strict');
const collector = require('./measure-device-stability.cjs');
const RUN = '1789000000000';
const ok = stdout => ({ exitCode: 0, stdout, stderr: '' });
function stat(pid, ticks = 10, start = 1000) {
  const fields = Array(30).fill('0');
  fields[0] = 'S'; fields[11] = String(ticks); fields[12] = '2'; fields[17] = '3'; fields[19] = String(start);
  return `${pid} (private ) process name) ${fields.join(' ')}`;
}
function status(pid, rss = 8192) { return `Name:\tprivate-process\nPid:\t${pid}\nVmRSS:\t${rss} kB\nThreads:\t3\n`; }
function line(body, time = '00:00:00.000', pid = 101) {
  return `09-08 ${time} ${pid} ${pid} I A00000/com.example.harmonyvpnlab/HarmonyVpnLab: ${body}`;
}
function harness(overrides = {}) {
  let elapsed = 0, rounds = 0, statCalls = 0;
  const persisted = [], printed = [], argsSeen = [];
  return {
    persisted, printed, argsSeen,
    dependencies: {
      now: () => elapsed, wallNow: () => new Date(1789000000000 + elapsed).toISOString(),
      sleep: async ms => { elapsed += ms; }, output: text => printed.push(text),
      writeSample: sample => persisted.push(sample), writeSummary: summary => persisted.push(summary),
      command: async args => {
        argsSeen.push(args); elapsed += 10;
        if (args[0] === 'list') {
          rounds++;
          return overrides.targets?.(rounds) || ok('TEST_DEVICE USB Connected device\n');
        }
        assert.deepEqual(args.slice(0, 3), ['-t', 'TEST_DEVICE', 'shell']);
        if (args[3] === 'hilog') {
          assert.deepEqual(args.slice(3), ['hilog', '-x', '-T', 'HarmonyVpnLab']);
          return overrides.logs?.(rounds) || ok(line(`CONNECTION_ACTIVE runId=${RUN}`) + '\n' +
            (rounds > 1 ? line('PHYSICAL_NETWORK_CHANGED reason=safe', '00:00:01.000') + '\n' : '') +
            line('UNRELATED_ERROR_TEXT https://secret.synthetic.invalid/?token=never-persist', '00:00:02.000', 999));
        }
        const match = /^\/proc\/(101|202)\/(stat|status|fd)$/.exec(args[args.length - 1]);
        assert(match, 'Only the two supplied PID proc paths may be read.');
        const pid = Number(match[1]), file = match[2];
        if (file === 'stat') { statCalls++; return overrides.stat?.({ pid, rounds, statCalls }) || ok(stat(pid, rounds * 10)); }
        if (file === 'status') return overrides.status?.({ pid, rounds }) || ok(status(pid, 8192 + rounds));
        assert.deepEqual(args.slice(3, -1), ['ls', '-1']);
        return overrides.fd?.({ pid, rounds }) || ok('0\n1\n2\n');
      }
    }
  };
}
const options = { pid: 101, uiPid: 202, runId: RUN, minutes: 2 / 60, intervalSeconds: 0.5 };
let passed = 0;
async function test(name, fn) { await fn(); passed++; process.stdout.write(`PASS ${name}\n`); }
(async () => {
  await test('CLI validation rejects shell syntax and invalid duration', () => {
    assert.throws(() => collector.parseArgs(['--pid', '1;rm', '--ui-pid', '2', '--run-id', RUN]));
    assert.throws(() => collector.parseArgs(['--pid', '1', '--ui-pid', '2', '--run-id', '../bad']));
    assert.throws(() => collector.parseArgs(['--pid', '1', '--ui-pid', '2', '--run-id', RUN, '--minutes', '0']));
    assert.deepEqual(collector.parseArgs(['--pid', '101', '--ui-pid', '202', '--run-id', RUN]),
      { pid: 101, uiPid: 202, runId: RUN, minutes: 30, intervalSeconds: 30 });
  });
  await test('stat field offsets tolerate spaces and parentheses without preserving comm', () => {
    assert.deepEqual(collector.parseStat(stat(101, 42, 777), 101), {
      pid: 101, state: 'S', startTimeTicks: 777, userTicks: 42, systemTicks: 2, totalTicks: 44 });
    assert.throws(() => collector.parseStat(stat(101), 202));
    assert.throws(() => collector.parseStat('101 (bad) S 1', 101));
  });
  await test('missing RSS or mismatched status PID fails instead of inventing zero', () => {
    assert.deepEqual(collector.parseStatus(status(101), 101), { rssKiB: 8192, threads: 3 });
    assert.throws(() => collector.parseStatus('Pid:\t101\nThreads:\t3\n', 101));
    assert.throws(() => collector.parseStatus(status(202), 101));
  });
  await test('FD permission, missing and malformed outputs stay null', () => {
    assert.deepEqual(collector.parseFd({ exitCode: 1, stdout: '', stderr: 'Permission denied' }),
      { fdCount: null, fdCategory: 'unavailable_permission' });
    assert.equal(collector.parseFd(ok('No such file or directory')).fdCount, null);
    assert.equal(collector.parseFd(ok('private unexpected output')).fdCount, null);
    assert.equal(collector.parseFd(ok('')).fdCount, 0);
    assert.equal(collector.parseFd(ok('0\n1\n5\n')).fdCount, 3);
  });
  await test('unique device selection rejects ambiguity and changed device', () => {
    assert.equal(collector.uniqueUsbTarget(ok('A USB Connected model\n')), 'A');
    assert.throws(() => collector.uniqueUsbTarget(ok('A USB Offline model\n')), /DEVICE_DISCONNECTED/);
    assert.throws(() => collector.uniqueUsbTarget(ok('A USB Connected x\nB USB Connected y\n')), /MULTIPLE_USB_DEVICES/);
    assert.throws(() => collector.uniqueUsbTarget(ok('B USB Connected x\n'), 'A'), /DEVICE_CHANGED/);
  });
  await test('log allowlist filters PID and run ID and returns only fixed codes', () => {
    assert.equal(collector.classifyLogLine(line(`CONNECTION_ACTIVE runId=${RUN}`), [101, 202], RUN), 'CONNECTION_ACTIVE');
    assert.equal(collector.classifyLogLine(line('ERROR code=1 private-secret'), [101], RUN), 'ERROR');
    assert.equal(collector.classifyLogLine(line('CONNECTION_ACTIVE runId=1789000000001'), [101], RUN), null);
    assert.equal(collector.classifyLogLine(line('ERROR private-secret', undefined, 999), [101], RUN), null);
    assert.equal(collector.classifyLogLine(line('OTHER https://secret.synthetic.invalid/'), [101], RUN), null);
  });
  await test('fixed monotonic window persists each sample and computes raw CPU deltas', async () => {
    const h = harness();
    const summary = await collector.runCollector(options, h.dependencies);
    assert.equal(summary.status, 'completed'); assert.equal(summary.samples, 5);
    assert(summary.actualElapsedSeconds >= 2 && summary.actualElapsedSeconds < 2.2);
    assert.equal(summary.processes.service.totalTicks.delta, 40);
    assert.equal(summary.processes.service.userTicks.first, 10);
    assert.equal(summary.processes.service.userTicks.last, 50);
    assert(summary.processes.service.cpuPercentSingleCoreAssumingHz100 > 0);
    assert.equal(summary.logs.totalsAfterInitialSnapshot.PHYSICAL_NETWORK_CHANGED, 1);
    assert.equal(summary.logs.totalsAfterInitialSnapshot.CONNECTION_ACTIVE, 0);
    assert.equal(summary.logs.activeMarkerInInitialBuffer, true);
    assert.equal(h.persisted.filter(x => x.kind === 'sample').length, 5);
    assert.equal(h.persisted.at(-1), summary);
    const serialized = JSON.stringify(h.persisted);
    assert(!/private|secret|synthetic\.invalid|https:/.test(serialized));
  });
  await test('FD denial throughout is summarized unavailable, never zero', async () => {
    const h = harness({ fd: () => ({ exitCode: 1, stdout: '', stderr: 'Permission denied private path' }) });
    const summary = await collector.runCollector(options, h.dependencies);
    assert.equal(summary.status, 'completed');
    assert.deepEqual(summary.processes.service.fdCount,
      { first: null, last: null, min: null, max: null, availableSamples: 0, unavailableSamples: 5 });
    assert.deepEqual(summary.processes.service.fdCategories, ['unavailable_permission']);
  });
  await test('PID reuse between samples fails and preserves preceding samples', async () => {
    const h = harness({ stat: ({ pid, rounds }) => ok(stat(pid, rounds * 10, rounds > 1 ? 2000 : 1000)) });
    const summary = await collector.runCollector(options, h.dependencies);
    assert.equal(summary.status, 'failed'); assert.equal(summary.failure.code, 'PID_REUSED');
    assert.equal(summary.failure.role, 'service'); assert.equal(summary.samples, 1);
    assert.equal(h.persisted.at(-2).kind, 'failure');
  });
  await test('PID reuse within one proc observation also fails', async () => {
    const h = harness({ stat: ({ pid, statCalls }) => ok(stat(pid, 10, statCalls === 2 ? 2000 : 1000)) });
    const summary = await collector.runCollector(options, h.dependencies);
    assert.equal(summary.failure.code, 'PID_REUSED'); assert.equal(summary.samples, 0);
  });
  await test('device disconnection exits with fixed failure code', async () => {
    const h = harness({ targets: round => round > 1 ? ok('TEST_DEVICE USB Offline device\n') : undefined });
    const summary = await collector.runCollector(options, h.dependencies);
    assert.equal(summary.failure.code, 'DEVICE_DISCONNECTED'); assert.equal(summary.samples, 1);
  });
  await test('process disappearance exits and does not expose raw command output', async () => {
    const h = harness({ stat: ({ rounds }) => rounds > 1 ? ok('cat: /private-token: No such file or directory') : undefined });
    const summary = await collector.runCollector(options, h.dependencies);
    assert.equal(summary.failure.code, 'PROCESS_MISSING'); assert.equal(summary.samples, 1);
    assert(!JSON.stringify(h.persisted).includes('private-token'));
  });
  await test('hilog denial is recorded as a coverage limitation and sampling continues', async () => {
    const h = harness({ logs: () => ({ exitCode: 1, stdout: '', stderr: 'Permission denied' }) });
    const summary = await collector.runCollector(options, h.dependencies);
    assert.equal(summary.status, 'completed'); assert.equal(summary.logs.availableSamples, 0);
    assert.equal(summary.logs.unavailableSamples, 5);
  });
  await test('command timeout and caller interruption generate distinct summaries', async () => {
    const timeout = harness(); timeout.dependencies.command = async () => { throw new collector.CollectorError('HDC_COMMAND_TIMEOUT'); };
    assert.equal((await collector.runCollector(options, timeout.dependencies)).failure.code, 'HDC_COMMAND_TIMEOUT');
    const interrupted = harness(); interrupted.dependencies.interrupted = () => true;
    assert.equal((await collector.runCollector(options, interrupted.dependencies)).status, 'interrupted');
  });
  await test('CPU tick regression is rejected for the same process identity', async () => {
    const h = harness({ stat: ({ pid, rounds }) => ok(stat(pid, rounds > 1 ? 1 : 10)) });
    const summary = await collector.runCollector(options, h.dependencies);
    assert.equal(summary.failure.code, 'CPU_TICKS_REGRESSED');
  });
  process.stdout.write(`stability collector offline tests: ${passed}/${passed} passed\n`);
})().catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; });
