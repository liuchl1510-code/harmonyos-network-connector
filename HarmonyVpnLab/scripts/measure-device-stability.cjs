#!/usr/bin/env node
'use strict';

// Read-only device observations. No raw proc text or hilog lines are persisted.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');

const HDC = 'C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe';
const HZ_ASSUMED = 100;
const COMMAND_TIMEOUT_MS = 10000;
const LOG_CODES = ['CONNECTION_ACTIVE', 'CONNECTION_STOPPED', 'PHYSICAL_NETWORK_CHANGED', 'ERROR'];

class CollectorError extends Error {
  constructor(code, role) { super(code); this.code = code; this.role = role || null; }
}
function integer(value, name, minimum = 0) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new CollectorError(name);
  }
  return Number(value);
}
function parseArgs(argv) {
  const result = {};
  const allowed = new Set(['--pid', '--ui-pid', '--run-id', '--minutes', '--interval-seconds']);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || argv[i + 1] === undefined || result[argv[i]] !== undefined) {
      throw new CollectorError('INVALID_ARGUMENTS');
    }
    result[argv[i]] = argv[i + 1];
  }
  const options = {
    pid: integer(result['--pid'], 'INVALID_SERVICE_PID', 1),
    uiPid: integer(result['--ui-pid'], 'INVALID_UI_PID', 1),
    runId: result['--run-id'],
    minutes: integer(result['--minutes'] ?? 30, 'INVALID_DURATION', 1),
    intervalSeconds: integer(result['--interval-seconds'] ?? 30, 'INVALID_INTERVAL', 1)
  };
  if (!/^\d{13}$/.test(options.runId || '')) throw new CollectorError('INVALID_RUN_ID');
  if (options.minutes > 180 || options.intervalSeconds > 120 || options.intervalSeconds > options.minutes * 60) {
    throw new CollectorError('INVALID_DURATION_OR_INTERVAL');
  }
  return options;
}
function defaultCommand(args) {
  return new Promise((resolve, reject) => {
    execFile(HDC, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && (error.killed || error.signal)) return reject(new CollectorError('HDC_COMMAND_TIMEOUT'));
      if (error && typeof error.code !== 'number') return reject(new CollectorError('HDC_COMMAND_UNAVAILABLE'));
      resolve({ exitCode: error ? error.code : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
function disconnected(result) {
  return /\b(?:offline|disconnected)\b|device.*not found|target.*not found|no connected device|channel.*closed/i
    .test(`${result.stdout}\n${result.stderr}`);
}
function uniqueUsbTarget(result, expected) {
  if (result.exitCode !== 0) throw new CollectorError('HDC_TARGET_LIST_FAILED');
  const targets = result.stdout.split(/\r?\n/).filter(line => /\sUSB\s+Connected\s/.test(line))
    .map(line => line.trim().split(/\s+/)[0]);
  if (targets.length !== 1) throw new CollectorError(targets.length === 0 ? 'DEVICE_DISCONNECTED' : 'MULTIPLE_USB_DEVICES');
  if (!/^[A-Za-z0-9._:-]+$/.test(targets[0])) throw new CollectorError('INVALID_DEVICE_IDENTIFIER');
  if (expected && targets[0] !== expected) throw new CollectorError('DEVICE_CHANGED');
  return targets[0];
}
function checkedProcText(result, role) {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (disconnected(result)) throw new CollectorError('DEVICE_DISCONNECTED', role);
  if (/no such file|not found/i.test(combined)) throw new CollectorError('PROCESS_MISSING', role);
  if (/permission denied|operation not permitted/i.test(combined)) throw new CollectorError('PROC_PERMISSION_DENIED', role);
  if (result.exitCode !== 0 || /\[Fail\]/i.test(combined)) throw new CollectorError('PROC_READ_FAILED', role);
  return result.stdout.trim();
}
function parseStat(text, expectedPid) {
  // comm may contain spaces or ')'; the final ') ' separates field 3 onward.
  const match = /^(\d+) \((.*)\) ([A-Za-z])\s+(.+)$/.exec(text.trim());
  if (!match || Number(match[1]) !== expectedPid) throw new CollectorError('PROC_STAT_INVALID');
  const fields = [match[3], ...match[4].trim().split(/\s+/)];
  if (fields.length < 22) throw new CollectorError('PROC_STAT_INVALID');
  const userTicks = integer(fields[11], 'PROC_STAT_INVALID');
  const systemTicks = integer(fields[12], 'PROC_STAT_INVALID');
  const startTimeTicks = integer(fields[19], 'PROC_STAT_INVALID');
  const totalTicks = userTicks + systemTicks;
  if (!Number.isSafeInteger(totalTicks)) throw new CollectorError('PROC_STAT_INVALID');
  return { pid: expectedPid, state: fields[0], startTimeTicks, userTicks, systemTicks, totalTicks };
}
function parseStatus(text, expectedPid) {
  const pid = /^Pid:\s+(\d+)\s*$/m.exec(text);
  const rss = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(text);
  const threads = /^Threads:\s+(\d+)\s*$/m.exec(text);
  if (!pid || Number(pid[1]) !== expectedPid || !rss || !threads) throw new CollectorError('PROC_STATUS_INVALID');
  return { rssKiB: integer(rss[1], 'PROC_STATUS_INVALID'), threads: integer(threads[1], 'PROC_STATUS_INVALID', 1) };
}
function parseFd(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (disconnected(result)) throw new CollectorError('DEVICE_DISCONNECTED');
  if (/permission denied|operation not permitted/i.test(text)) return { fdCount: null, fdCategory: 'unavailable_permission' };
  if (/no such file|not found/i.test(text)) return { fdCount: null, fdCategory: 'unavailable_missing' };
  if (result.exitCode !== 0 || /\[Fail\]/i.test(text)) return { fdCount: null, fdCategory: 'unavailable_read_error' };
  const entries = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : [];
  if (entries.some(entry => !/^\d+$/.test(entry)) || result.stderr.trim()) {
    return { fdCount: null, fdCategory: 'unavailable_format' };
  }
  return { fdCount: new Set(entries).size, fdCategory: 'readable' };
}
function emptyCounts() { return Object.fromEntries(LOG_CODES.map(code => [code, 0])); }
function classifyLogLine(line, pids, runId) {
  const match = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+\d+\s+[A-Z]\s+[^\s]*HarmonyVpnLab:\s*(.*)$/.exec(line);
  if (!match || !pids.includes(Number(match[1]))) return null;
  const body = match[2];
  const loggedRun = /\brunId=(\d+)\b/.exec(body);
  if (loggedRun && loggedRun[1] !== runId) return null;
  for (const code of LOG_CODES.slice(0, 3)) if (new RegExp(`^${code}\\b`).test(body)) return code;
  if (/^[A-Z_]*ERROR[A-Z_]*\b/.test(body)) return 'ERROR';
  return null;
}
async function readLogs(command, device, state, pids, runId, baseline) {
  const result = await command(['-t', device, 'shell', 'hilog', '-x', '-T', 'HarmonyVpnLab']);
  if (disconnected(result)) throw new CollectorError('DEVICE_DISCONNECTED');
  if (result.exitCode !== 0 || /\[Fail\]|permission denied|operation not permitted/i.test(`${result.stdout}\n${result.stderr}`)) {
    state.unavailableSamples++;
    return { available: false, category: 'unavailable_read_error', newEvents: emptyCounts() };
  }
  const newEvents = emptyCounts();
  for (const line of result.stdout.split(/\r?\n/)) {
    const code = classifyLogLine(line, pids, runId);
    if (!code) continue;
    const hash = createHash('sha256').update(line).digest('hex');
    if (state.seen.has(hash)) continue;
    if (state.seen.size >= 100000) {
      state.dedupCapacityExceeded = true;
      continue;
    }
    state.seen.add(hash);
    if (baseline) {
      if (code === 'CONNECTION_ACTIVE' && new RegExp(`\\brunId=${runId}\\b`).test(line)) state.activeMarkerInInitialBuffer = true;
    } else { newEvents[code]++; state.totals[code]++; }
  }
  state.availableSamples++;
  return { available: true, category: baseline ? 'initial_buffer_excluded' : 'buffer_snapshot_only', newEvents };
}
async function readProcess(command, device, pid, role, prior, now, start) {
  const shell = (...args) => command(['-t', device, 'shell', ...args]);
  try {
    const before = parseStat(checkedProcText(await shell('cat', `/proc/${pid}/stat`), role), pid);
    if (prior && before.startTimeTicks !== prior.startTimeTicks) throw new CollectorError('PID_REUSED', role);
    const status = parseStatus(checkedProcText(await shell('cat', `/proc/${pid}/status`), role), pid);
    const fd = parseFd(await shell('ls', '-1', `/proc/${pid}/fd`));
    const after = parseStat(checkedProcText(await shell('cat', `/proc/${pid}/stat`), role), pid);
    if (before.startTimeTicks !== after.startTimeTicks || (prior && prior.startTimeTicks !== after.startTimeTicks)) {
      throw new CollectorError('PID_REUSED', role);
    }
    if (['Z', 'X', 'x'].includes(after.state)) throw new CollectorError('PROCESS_NOT_RUNNING', role);
    const observedAtMs = now() - start;
    const elapsedSeconds = prior ? (observedAtMs - prior.observedAtMs) / 1000 : null;
    const deltaTicks = prior ? after.totalTicks - prior.totalTicks : null;
    if (deltaTicks !== null && deltaTicks < 0) throw new CollectorError('CPU_TICKS_REGRESSED', role);
    return { ...after, ...status, ...fd, observedAtMs, deltaTicks, elapsedSeconds,
      cpuPercentSingleCoreAssumingHz100: elapsedSeconds > 0 ? 100 * deltaTicks / HZ_ASSUMED / elapsedSeconds : null };
  } catch (error) {
    if (error instanceof CollectorError) { if (!error.role) error.role = role; throw error; }
    throw new CollectorError('PROCESS_SAMPLE_FAILED', role);
  }
}
function range(values) {
  const valid = values.filter(value => value !== null);
  return { first: values.length ? values[0] : null, last: values.length ? values[values.length - 1] : null,
    min: valid.length ? Math.min(...valid) : null, max: valid.length ? Math.max(...valid) : null,
    availableSamples: valid.length, unavailableSamples: values.length - valid.length };
}
function processSummary(samples, role) {
  const values = samples.map(sample => sample.processes?.[role]).filter(Boolean);
  if (!values.length) return null;
  const first = values[0], last = values[values.length - 1];
  const observationSeconds = (last.observedAtMs - first.observedAtMs) / 1000;
  const deltaTicks = last.totalTicks - first.totalTicks;
  return { pid: first.pid, startTimeTicks: first.startTimeTicks, samples: values.length,
    observationSeconds, userTicks: { first: first.userTicks, last: last.userTicks, delta: last.userTicks - first.userTicks },
    systemTicks: { first: first.systemTicks, last: last.systemTicks, delta: last.systemTicks - first.systemTicks },
    totalTicks: { first: first.totalTicks, last: last.totalTicks, delta: deltaTicks },
    cpuPercentSingleCoreAssumingHz100: observationSeconds > 0 ? 100 * deltaTicks / HZ_ASSUMED / observationSeconds : null,
    intervalCpuPercentSingleCoreAssumingHz100: range(values.map(value => value.cpuPercentSingleCoreAssumingHz100)),
    rssKiB: range(values.map(value => value.rssKiB)), threads: range(values.map(value => value.threads)),
    fdCount: range(values.map(value => value.fdCount)),
    fdCategories: [...new Set(values.map(value => value.fdCategory))] };
}
async function runCollector(options, dependencies = {}) {
  const command = dependencies.command || defaultCommand;
  const now = dependencies.now || (() => performance.now());
  const wallNow = dependencies.wallNow || (() => new Date().toISOString());
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const output = dependencies.output || (line => process.stdout.write(line + '\n'));
  const interrupted = dependencies.interrupted || (() => false);
  const writeSample = dependencies.writeSample || (() => {});
  const writeSummary = dependencies.writeSummary || (() => {});
  const start = now(), startedAt = wallNow();
  const durationMs = options.minutes * 60000, intervalMs = options.intervalSeconds * 1000;
  const samples = [], previous = {}, logState = { seen: new Set(), totals: emptyCounts(), availableSamples: 0,
    unavailableSamples: 0, activeMarkerInInitialBuffer: false, dedupCapacityExceeded: false };
  let device, failure = null, status = 'completed', nextSampleAt = start, nextProgressAt = start;
  output(`stability started minutes=${options.minutes} intervalSeconds=${options.intervalSeconds}`);
  try {
    while (true) {
      if (interrupted()) throw new CollectorError('COLLECTION_INTERRUPTED');
      const waitMs = nextSampleAt - now();
      if (waitMs > 0) await sleep(waitMs);
      if (interrupted()) throw new CollectorError('COLLECTION_INTERRUPTED');
      device = uniqueUsbTarget(await command(['list', 'targets', '-v']), device);
      const sample = { kind: 'sample', index: samples.length, recordedAt: wallNow(), elapsedMs: now() - start, processes: {} };
      for (const [role, pid] of [['service', options.pid], ['ui', options.uiPid]]) {
        sample.processes[role] = await readProcess(command, device, pid, role, previous[role], now, start);
        previous[role] = sample.processes[role];
      }
      sample.logs = await readLogs(command, device, logState, [options.pid, options.uiPid], options.runId, samples.length === 0);
      sample.completedElapsedMs = now() - start;
      writeSample(sample); samples.push(sample);
      if (now() >= nextProgressAt) {
        output(`stability elapsedSeconds=${Math.floor((now() - start) / 1000)} samples=${samples.length} serviceRssKiB=${sample.processes.service.rssKiB} uiRssKiB=${sample.processes.ui.rssKiB}`);
        nextProgressAt = start + (Math.floor((now() - start) / 60000) + 1) * 60000;
      }
      if (now() - start >= durationMs) break;
      // Fixed monotonic deadlines avoid accumulating command time into a 30-minute drift.
      const nextInterval = Math.floor((now() - start) / intervalMs) + 1;
      nextSampleAt = Math.min(start + nextInterval * intervalMs, start + durationMs);
    }
  } catch (error) {
    failure = { code: error instanceof CollectorError ? error.code : 'COLLECTION_FAILED',
      role: error instanceof CollectorError ? error.role : null };
    status = failure.code === 'COLLECTION_INTERRUPTED' ? 'interrupted' : 'failed';
    writeSample({ kind: 'failure', recordedAt: wallNow(), elapsedMs: now() - start, failure });
  }
  const summary = { schemaVersion: 1, runId: options.runId, status, failure, startedAt, finishedAt: wallNow(),
    scheduledDurationSeconds: durationMs / 1000, actualElapsedSeconds: (now() - start) / 1000,
    intervalSeconds: options.intervalSeconds, samples: samples.length, commandTimeoutMs: COMMAND_TIMEOUT_MS,
    cpuClock: { ticksPerSecond: HZ_ASSUMED, basis: 'assumption_100_from_prior_device_fault_record_not_measured_by_this_script',
      percentBasis: 'one_cpu_core_100_percent_multithread_process_can_exceed_100' },
    processes: { service: processSummary(samples, 'service'), ui: processSummary(samples, 'ui') },
    logs: { totalsAfterInitialSnapshot: logState.totals, availableSamples: logState.availableSamples,
      unavailableSamples: logState.unavailableSamples, activeMarkerInInitialBuffer: logState.activeMarkerInInitialBuffer,
      initialBufferExcluded: true, dedupCapacityExceeded: logState.dedupCapacityExceeded,
      coverage: 'tag_and_pid_filtered_periodic_buffer_snapshots_not_lossless_no_raw_logs_saved' },
    limitations: ['Read-only process observations do not prove end-to-end connectivity.',
      'FD counts are null when access is unavailable; unavailable does not mean zero.',
      'A single observation window is not a battery-life or long-term reliability conclusion.',
      'Sampling uses host monotonic time; command latency is included in CPU observation intervals.',
      'The collector does not operate UI, change network settings, disconnect VPN, or stop processes.'] };
  writeSummary(summary);
  output(`stability finished status=${status} elapsedSeconds=${Math.floor(summary.actualElapsedSeconds)} samples=${summary.samples}${failure ? ' code=' + failure.code : ''}`);
  return summary;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const directory = path.resolve(__dirname, '..', 'build', 'stability', options.runId);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try { fs.mkdirSync(directory); } catch (error) {
    throw new CollectorError(error.code === 'EEXIST' ? 'OUTPUT_ALREADY_EXISTS' : 'OUTPUT_CREATE_FAILED');
  }
  let stopRequested = false;
  process.on('SIGINT', () => { stopRequested = true; });
  process.on('SIGTERM', () => { stopRequested = true; });
  const summary = await runCollector(options, {
    interrupted: () => stopRequested,
    writeSample: sample => fs.appendFileSync(path.join(directory, 'samples.jsonl'), JSON.stringify(sample) + '\n', 'utf8'),
    writeSummary: summary => fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
  });
  if (summary.status !== 'completed') process.exitCode = 1;
}
module.exports = { CollectorError, parseArgs, parseStat, parseStatus, parseFd, uniqueUsbTarget,
  classifyLogLine, readProcess, runCollector };
if (require.main === module) main().catch(error => {
  // Exception messages and command output may contain private device data. Persist fixed codes only.
  process.stderr.write(`stability failed code=${error instanceof CollectorError ? error.code : 'UNEXPECTED_FAILURE'}\n`);
  process.exitCode = 1;
});
