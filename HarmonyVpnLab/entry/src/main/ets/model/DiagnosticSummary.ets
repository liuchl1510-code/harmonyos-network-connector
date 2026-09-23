import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { DiagnosticEvent, inspectDiagnosticEvents } from './DiagnosticJournal';
import { inspectConnectionRecoveries } from './ConnectionRecoveryStore';
import { ConnectionFailure, failureFromDiagnosticEvent, failureStageLabel, validConnectionFailure } from './ConnectionFailure';

export const DIAGNOSTIC_SUMMARY_MAX_BYTES: number = 65536;
const MAX_STATE_BYTES: number = 32768;
const MAX_TIME: number = 253402300799999;
const MAX_COUNT: number = 1000000000;
const PHASES: string[] = ['idle', 'starting', 'active', 'recovering', 'waiting-network', 'stopping',
  'stop_requested', 'destroying', 'stopped', 'failed', 'passed', 'destroyed', 'unknown', 'interrupted', 'diagnostic'];
const KINDS: string[] = ['connection', 'connection-test', 'connection-app-test', 'node-latency', 'lifecycle'];
const NETWORKS: string[] = ['', 'wifi', 'cellular', 'ethernet', 'other', 'unavailable'];

export class DiagnosticSummarySnapshot {
  text: string = '';
  generatedAt: number = 0;
  eventCount: number = 0;
  recoveryCount: number = 0;
  sessionCount: number = 0;
  partial: boolean = false;
  journalStatus: string = 'missing';
  recoveryStatus: string = 'missing';
  lifecycleStatus: string = 'missing';
}

// This narrow type is never returned to the page or serialized. JSON may have
// other properties, but no detail/snapshot/PID/owner/configuration is copied.
interface StateInput {
  runId: string;
  phase: string;
  updatedAt: number;
  kind?: string;
  networkKind?: string;
  reconnectCount?: number;
  cleanupConfirmed?: boolean;
  failure?: ConnectionFailure;
  cleanupFailure?: ConnectionFailure;
  currentIssue?: ConnectionFailure;
}
class StateRead {
  status: string;
  value?: StateInput;
  constructor(status: string, value?: StateInput) { this.status = status; this.value = value; }
}
class TimelineLine {
  at: number;
  runId: string;
  label: string;
  constructor(at: number, runId: string, label: string) { this.at = at; this.runId = runId; this.label = label; }
}

function boundedTime(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME; }
function boundedCount(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT; }
function validRun(value: string): boolean { return typeof value === 'string' && /^[0-9]{13}$/.test(value); }
function timeText(value: number): string { return boundedTime(value) ? new Date(value).toISOString() : '时间超出范围'; }
function sourceText(status: string): string {
  switch (status) {
    case 'available': return '已读取';
    case 'empty': return '记录为空';
    case 'invalid': return '格式无效或超出读取范围，原记录未改动';
    case 'unreadable': return '读取失败，原记录未改动';
    case 'preview': return '界面预览无 VPN 核心，运行状态不可用';
    default: return '未找到记录';
  }
}
function incomplete(status: string): boolean { return status === 'invalid' || status === 'unreadable'; }
function networkText(kind: string): string {
  switch (kind) {
    case 'wifi': return 'Wi-Fi';
    case 'cellular': return '移动数据';
    case 'ethernet': return '有线网络';
    case 'other': return '其他网络';
    case 'unavailable': return '暂无可用网络';
    default: return '未记录';
  }
}
function reasonText(reason: string): string {
  switch (reason) {
    case 'timeout': return '超时';
    case 'connection': return '连接未建立';
    case 'tls': return 'TLS 校验未通过';
    case 'invalid-response': return '响应不符合要求';
    case 'unavailable': return '暂不可用';
    default: return '未完成';
  }
}
function failureText(failure: ConnectionFailure): string {
  return failureStageLabel(failure.stage) + '：' + reasonText(failure.reason) + '；记录于 ' + timeText(failure.at);
}

// Do not call the general lifecycle reader here: it reads unrestricted legacy
// text and may probe the native PID. This report is a bounded persisted snapshot.
function readState(filesDir: string, name: string, probe: boolean): StateRead {
  let content: string;
  try {
    const path = `${filesDir}/${name}`;
    if (!fs.accessSync(path)) { return new StateRead('missing'); }
    const stat = fs.statSync(path);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_STATE_BYTES) {
      return new StateRead('invalid');
    }
    content = fs.readTextSync(path, { length: MAX_STATE_BYTES + 1 });
  } catch (_) { return new StateRead('unreadable'); }
  try {
    if (new util.TextEncoder().encodeInto(content).length > MAX_STATE_BYTES) { return new StateRead('invalid'); }
    const value = JSON.parse(content) as StateInput;
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !validRun(value.runId) ||
      typeof value.phase !== 'string' || !PHASES.includes(value.phase) || !boundedTime(value.updatedAt) ||
      probe && (typeof value.kind !== 'string' || !KINDS.includes(value.kind))) { return new StateRead('invalid'); }
    return new StateRead('available', value);
  } catch (_) { return new StateRead('invalid'); }
}

function sessionLabel(runId: string, sessions: string[]): string {
  let position = sessions.indexOf(runId);
  if (position < 0) { sessions.push(runId); position = sessions.length - 1; }
  return '会话 ' + (position + 1).toString();
}
function counterText(value: number, snapshot: DiagnosticSummarySnapshot): string {
  if (!boundedCount(value)) { snapshot.partial = true; return '计数超出范围'; }
  return value.toString();
}
function eventText(event: DiagnosticEvent, snapshot: DiagnosticSummarySnapshot): string {
  const failure = failureFromDiagnosticEvent(event.code, event.value, event.at);
  if (failure) { return '操作未完成；' + failureText(failure); }
  switch (event.code) {
    case 'session-start': return '开始连接；网络：' + networkText(event.kind);
    case 'network-change': return '网络变化：' + networkText(event.kind) + '；网络版本 ' + counterText(event.value, snapshot);
    case 'recovery-start': return '开始恢复连接；网络：' + networkText(event.kind);
    case 'recovery-ok': return '恢复步骤成功；累计恢复 ' + counterText(event.value, snapshot) + ' 次';
    case 'recovery-failed': return '恢复连接未完成；具体原因尚未确认';
    case 'waiting-network': return '等待可用网络';
    case 'protect-stale-before': return '拒绝过期连接请求；累计 ' + counterText(event.value, snapshot) + ' 次';
    case 'protect-stale-after': return '丢弃过期连接结果；累计 ' + counterText(event.value, snapshot) + ' 次';
    case 'protect-api-failed': return '连接保护未完成；累计 ' + counterText(event.value, snapshot) + ' 次';
    case 'stop-requested': return '收到断开请求';
    case 'session-stopped': return event.value === 1 ? '连接停止；该次事件记录清理已确认' : '连接停止；该次事件未确认清理完成';
    case 'latency-start': return '开始延迟检测';
    case 'latency-ok': return '延迟检测成功；HTTPS 耗时 ' + counterText(event.value, snapshot) + ' ms';
    case 'latency-failed': return '延迟检测未通过；具体原因尚未确认';
    default: snapshot.partial = true; return '无法识别的事件已省略';
  }
}

function appendFailure(lines: string[], name: string, failure: ConnectionFailure | undefined,
  snapshot: DiagnosticSummarySnapshot): void {
  if (failure === undefined) { return; }
  if (!validConnectionFailure(failure) || !boundedTime(failure.at)) {
    snapshot.partial = true; lines.push(name + '：分类无效，已省略'); return;
  }
  lines.push(name + '：' + failureText(failure));
}

function appendLifecycle(lines: string[], filesDir: string, coreAvailable: boolean, sessions: string[],
  snapshot: DiagnosticSummarySnapshot): void {
  lines.push('', '最近持久化状态（不代表实时联网）');
  if (!coreAvailable) {
    snapshot.lifecycleStatus = 'preview'; lines.push(sourceText('preview')); return;
  }
  const probe = readState(filesDir, 'vpn-probe.json', true);
  const status = readState(filesDir, 'connection-status.json', false);
  const after = readState(filesDir, 'vpn-probe.json', true);
  const statusAfter = readState(filesDir, 'connection-status.json', false);
  snapshot.lifecycleStatus = incomplete(probe.status) ? probe.status : incomplete(status.status) ? status.status :
    probe.status === 'available' || status.status === 'available' ? 'available' : 'missing';
  if (incomplete(probe.status) || incomplete(status.status) || incomplete(after.status) || incomplete(statusAfter.status)) { snapshot.partial = true; }
  lines.push('应用状态来源：' + sourceText(probe.status), '服务回执来源：' + sourceText(status.status));
  if (probe.status !== after.status || probe.value?.runId !== after.value?.runId ||
    probe.value?.phase !== after.value?.phase || probe.value?.updatedAt !== after.value?.updatedAt ||
    probe.value?.kind !== after.value?.kind || status.status !== statusAfter.status ||
    status.value?.runId !== statusAfter.value?.runId || status.value?.phase !== statusAfter.value?.phase ||
    status.value?.updatedAt !== statusAfter.value?.updatedAt || status.value?.cleanupConfirmed !== statusAfter.value?.cleanupConfirmed) {
    snapshot.partial = true; snapshot.lifecycleStatus = 'invalid';
    lines.push('采集期间状态发生变化，本次未关联状态与服务回执；请刷新摘要。'); return;
  }
  if (probe.value) {
    lines.push(sessionLabel(probe.value.runId, sessions) + '；应用记录阶段：' + probe.value.phase +
      '；类型：' + probe.value.kind + '；更新于 ' + timeText(probe.value.updatedAt));
  }
  const receipt = status.value;
  if (!receipt) { lines.push('未获得有效服务回执，不能据此确认连接或资源清理。'); return; }
  const label = sessionLabel(receipt.runId, sessions);
  lines.push(label + '；服务记录阶段：' + receipt.phase + '；更新于 ' + timeText(receipt.updatedAt));
  if (!probe.value || receipt.runId !== probe.value.runId) {
    snapshot.partial = true; snapshot.lifecycleStatus = 'invalid';
    lines.push('服务回执与应用会话未能关联，未合并清理及失败信息；请刷新摘要。'); return;
  }
  if (probe.value.phase !== receipt.phase &&
    !(['stopped', 'destroyed'].includes(probe.value.phase) && ['stopped', 'destroyed'].includes(receipt.phase))) {
    snapshot.partial = true;
    lines.push('同一会话的两个来源阶段尚未一致，以下仅描述各自保存的记录；请刷新摘要。');
  }
  if (receipt.networkKind !== undefined) {
    if (NETWORKS.includes(receipt.networkKind)) { lines.push(label + '；记录网络：' + networkText(receipt.networkKind)); }
    else { snapshot.partial = true; lines.push(label + '；网络分类无效，已省略'); }
  }
  if (receipt.reconnectCount !== undefined) {
    lines.push(label + '；累计恢复：' + counterText(receipt.reconnectCount, snapshot) + ' 次');
  }
  lines.push(label + '；清理回执：' + (receipt.cleanupConfirmed === true && ['stopped', 'destroyed'].includes(receipt.phase) ?
    '该会话记录了清理完成回执' : '未确认清理完成'));
  if (receipt.cleanupConfirmed !== undefined && typeof receipt.cleanupConfirmed !== 'boolean') { snapshot.partial = true; }
  appendFailure(lines, label + '失败阶段', receipt.failure, snapshot);
  appendFailure(lines, label + '清理阶段问题', receipt.cleanupFailure, snapshot);
  appendFailure(lines, label + '该回执的未完成步骤', receipt.currentIssue, snapshot);
  lines.push('未执行进程探测或联网检测；历史服务退出观察不等于收到清理回执。');
}

// A frozen, read-only observation assembled from bounded local sources. Only
// authored strings, validated classifications/times/counters and version fields
// enter text. Session identities exist solely for internal correlation.
export function collectDiagnosticSummary(filesDir: string, versionName: string, versionCode: number,
  sdkApiVersion: number, coreAvailable: boolean): DiagnosticSummarySnapshot {
  const snapshot = new DiagnosticSummarySnapshot();
  const now = Date.now(); snapshot.generatedAt = boundedTime(now) && now > 0 ? now : 0;
  if (snapshot.generatedAt === 0) { snapshot.partial = true; }
  const safeVersion = typeof versionName === 'string' && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(versionName);
  const safeCode = boundedCount(versionCode) && versionCode > 0; const safeApi = Number.isSafeInteger(sdkApiVersion) && sdkApiVersion > 0 && sdkApiVersion <= 1000;
  if (!safeVersion || !safeCode || !safeApi) { snapshot.partial = true; }
  const journal = inspectDiagnosticEvents(filesDir), recoveries = inspectConnectionRecoveries(filesDir);
  snapshot.journalStatus = journal.status; snapshot.recoveryStatus = recoveries.status;
  snapshot.eventCount = journal.events.length; snapshot.recoveryCount = recoveries.observations.length;
  if (incomplete(journal.status) || incomplete(recoveries.status)) { snapshot.partial = true; }
  const lines: string[] = ['Harmony VPN 诊断摘要', '摘要格式：1', '生成时间（UTC）：' +
    (snapshot.generatedAt > 0 ? timeText(snapshot.generatedAt) : '生成时间不可用'),
    '应用版本：' + (safeVersion ? versionName : '未提供有效版本') + '；版本号：' + (safeCode ? versionCode.toString() : '不可用'),
    '系统 API：' + (safeApi ? sdkApiVersion.toString() : '不可用'),
    '本摘要是点击生成时的只读快照，不持续监听，也不验证当前联网。',
    '仅包含固定分类、时间和计数；不包含节点、地址、密钥、链接、配置、应用列表或原始错误。',
    '失败阶段表示未完成的操作，不能单凭该阶段判定根本原因。',
    '', '记录来源', '服务诊断：' + sourceText(journal.status) + '；事件 ' + snapshot.eventCount.toString() + ' 条',
    '恢复观察：' + sourceText(recoveries.status) + '；观察 ' + snapshot.recoveryCount.toString() + ' 条',
    '未找到记录或记录为空，不表示连接正常、没有故障或已完成清理。',
    '最多读取最近 200 条服务事件及 50 条恢复观察；记录可能轮换，时间线并非完整历史。'];
  const timeline: TimelineLine[] = []; let filtered: number = 0;
  for (const event of journal.events) {
    if (!boundedTime(event.at)) { snapshot.partial = true; filtered++; continue; }
    timeline.push(new TimelineLine(event.at, event.runId, eventText(event, snapshot)));
  }
  for (const observation of recoveries.observations) {
    if (!boundedTime(observation.at)) { snapshot.partial = true; filtered++; continue; }
    timeline.push(new TimelineLine(observation.at, observation.runId,
      '应用观察到服务退出；检测时未收到清理完成回执；退出原因尚未确认'));
  }
  timeline.sort((left: TimelineLine, right: TimelineLine) => left.at - right.at);
  if (timeline.length > 0) {
    lines.push('有效事件记录范围（UTC）：' + timeText(timeline[0].at) + ' 至 ' + timeText(timeline[timeline.length - 1].at));
  }
  if (filtered > 0) { lines.push('时间超出可展示范围，省略 ' + filtered.toString() + ' 条记录。'); }
  const sessions: string[] = [];
  // Assign numbers using the retained chronology, then reuse those numbers for
  // service snapshots; a previous run's failures cannot become the current run.
  for (const item of timeline) { sessionLabel(item.runId, sessions); }
  appendLifecycle(lines, filesDir, coreAvailable, sessions, snapshot);
  lines.push('', '保留的事件时间线（从早到晚；会话编号仅在本摘要内有效）');
  if (timeline.length === 0) { lines.push('没有可展示的有效事件；不能据此判断是否发生过问题。'); }
  for (const item of timeline) { lines.push(timeText(item.at) + ' | ' + sessionLabel(item.runId, sessions) + ' | ' + item.label); }
  snapshot.sessionCount = sessions.length;
  const encoder = new util.TextEncoder(); let text: string = ''; let textBytes: number = 0; let omitted: number = 0;
  for (const line of lines) {
    const next = line + '\n';
    // OHOS may return no byte array for an empty string. Each new line is
    // nonempty, and cumulative byte accounting avoids encoding the empty
    // accumulator or repeatedly allocating its entire growing contents.
    const nextBytes = encoder.encodeInto(next).length;
    if (textBytes + nextBytes > DIAGNOSTIC_SUMMARY_MAX_BYTES - 512) { omitted++; }
    else { text += next; textBytes += nextBytes; }
  }
  if (omitted > 0) { snapshot.partial = true; text += '达到摘要大小上限，省略 ' + omitted.toString() + ' 行。\n'; }
  text += snapshot.partial ? '\n摘要存在不可用或超出范围的内容，请结合来源提示判断。\n' : '\n已完成本次可用记录的汇总；这不代表联网验证通过。\n';
  snapshot.text = text; return snapshot;
}
