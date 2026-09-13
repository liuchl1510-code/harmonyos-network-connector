import native from 'libvpnbridge.so';
import { ProbeState, readProbeState } from './ProbeState';
import { CONNECTION_UI_EPOCH, ConnectionCommand, ConnectionStatus, isConnectionKind,
  readConnectionCommand, readConnectionStatus } from './ConnectionControl';

const BUSY_PHASES: string[] = ['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'stop_requested', 'destroying'];
const TERMINAL_PHASES: string[] = ['idle', 'stopped', 'failed', 'passed', 'destroyed'];

// These are UI observations, not service receipts. In particular, an absent
// process cannot retrospectively acknowledge asynchronous resource cleanup.
export class ConnectionLifecycleAssessment {
  state: ProbeState;
  command?: ConnectionCommand;
  status?: ConnectionStatus;
  phase: string = 'idle';
  detail: string = '';
  closed: boolean = false;
  managementAllowed: boolean = false;
  serviceExited: boolean = false;
  servicePresence: string = 'unknown';
  ownerChanged: boolean = false;
  cleanupConfirmed: boolean = false;
  interruptionObserved: boolean = false;
  priorServiceUnresolved: boolean = false;

  constructor(state: ProbeState, command?: ConnectionCommand, status?: ConnectionStatus) {
    this.state = state; this.command = command; this.status = status;
  }
}

function validPid(status?: ConnectionStatus): boolean {
  return status !== undefined && Number.isSafeInteger(status.servicePid) && status.servicePid > 0 && status.servicePid <= 2147483647;
}

function phaseDetail(phase: string): string {
  if (phase === 'starting') { return '正在建立 VPN 和代理 DNS。'; }
  if (phase === 'active') { return 'VPN 代理已启动。'; }
  if (phase === 'recovering') { return '正在恢复代理连接，已有请求可能需要重试。'; }
  if (phase === 'waiting-network') { return '等待可用网络，VPN 保持接管。'; }
  if (phase === 'stopping') { return '正在结束连接，等待服务确认清理。'; }
  if (phase === 'failed') { return '本次连接未完成，可以重新连接。'; }
  if (phase === 'stopped') { return '连接已结束。'; }
  return '';
}

function finish(value: ConnectionLifecycleAssessment, phase: string, detail: string, closed: boolean): ConnectionLifecycleAssessment {
  value.phase = phase; value.detail = detail;
  value.closed = closed; value.managementAllowed = closed;
  return value;
}

export function assessConnectionLifecycle(state: ProbeState, command: ConnectionCommand | undefined,
  status: ConnectionStatus | undefined, presence: string, currentEpoch: string,
  now: number): ConnectionLifecycleAssessment {
  const value = new ConnectionLifecycleAssessment(state, command, status);
  const hasRun = typeof state.runId === 'string' && state.runId.length > 0;
  const matchingCommand = hasRun && command?.runId === state.runId;
  const matchingStatus = hasRun && status?.runId === state.runId;
  value.servicePresence = validPid(status) && ['absent', 'present-or-unknown'].includes(presence) ? presence : 'unknown';
  value.ownerChanged = matchingCommand && typeof command?.ownerEpoch === 'string' && command.ownerEpoch.length > 0 &&
    command.ownerEpoch !== currentEpoch;
  value.cleanupConfirmed = matchingStatus && status?.cleanupConfirmed === true && ['stopped', 'destroyed'].includes(status.phase);
  value.serviceExited = matchingStatus && value.servicePresence === 'absent';

  // A status for an earlier run is never evidence that this run has ended.
  // Conversely, an unresolved earlier service must not be overlapped by a new
  // request. Known PIDs require absence even after the earlier cleanup receipt.
  if (status && !matchingStatus && value.servicePresence !== 'absent' &&
    (status.servicePid !== undefined && status.servicePid !== 0 ||
      !(status.phase === 'destroyed' && status.cleanupConfirmed === true))) {
    value.priorServiceUnresolved = true;
    return finish(value, 'unknown', '上次 VPN 服务尚未确认结束，请先恢复清理。', false);
  }

  if (!isConnectionKind(state.kind)) {
    const busy = BUSY_PHASES.includes(state.phase);
    return finish(value, busy ? 'diagnostic' : 'idle', busy ? '开发验证正在运行，请等待它结束。' : '', !busy);
  }

  if (matchingStatus && status?.phase === 'destroyed' && value.cleanupConfirmed) {
    return finish(value, state.phase === 'failed' ? 'failed' : 'stopped', 'VPN 已结束，核心和网卡清理已确认。', true);
  }
  if (value.serviceExited) {
    if (value.cleanupConfirmed) {
      return finish(value, state.phase === 'failed' ? 'failed' : 'stopped', 'VPN 已结束，核心和网卡清理已确认。', true);
    }
    value.interruptionObserved = true;
    return finish(value, 'interrupted', '上次连接已结束；未收到完整清理回执，可重新连接。', true);
  }
  // Explicitly cancelled admission is a UI-owned terminal request, including
  // after UI recreation. No matching service receipt was observed, so this
  // permits retry without claiming service exit or successful resource cleanup.
  if (!matchingStatus && matchingCommand && command?.action === 'stop' && state.phase === 'failed') {
    return finish(value, 'failed', '本次连接请求已取消，可以重新连接。', true);
  }
  // A different UI epoch identifies the requester, not the service process.
  // Do not infer process death from it, a stale heartbeat, or a probe error.
  if (value.ownerChanged) {
    return finish(value, 'unknown', '上次应用已退出，VPN 服务状态尚未确认，请先恢复清理。', false);
  }
  if (!matchingStatus && state.phase === 'active') {
    return finish(value, 'unknown', '缺少当前服务状态，请先断开或恢复清理。', false);
  }
  let observedPhase = state.phase;
  if (matchingStatus && status) {
    if (['destroying', 'stopping'].includes(status.phase) || matchingCommand && command?.action === 'stop') {
      const stateAge = now - state.updatedAt;
      const statusAge = now - status.updatedAt;
      if (!Number.isFinite(stateAge) || !Number.isFinite(statusAge) || stateAge < 0 || statusAge < 0 ||
        stateAge > 12000 && statusAge > 12000) {
        return finish(value, 'unknown', '连接清理状态更新中断，请恢复清理并等待服务结束。', false);
      }
      return finish(value, 'stopping', phaseDetail('stopping'), false);
    }
    if (TERMINAL_PHASES.includes(state.phase) || ['stopped', 'destroyed', 'failed'].includes(status.phase)) {
      return finish(value, 'unknown', '连接收尾尚未确认，请先恢复清理。', false);
    }
    // The service writes these two files separately. A newer recovery receipt
    // must hide the preceding active probe state immediately; returning to
    // active requires both files to agree, never a mixed transition snapshot.
    if (['starting', 'recovering', 'waiting-network'].includes(status.phase) &&
      ['starting', 'active', 'recovering', 'waiting-network'].includes(state.phase)) {
      observedPhase = status.phase;
    } else if (state.phase === 'active' && status.phase !== 'active') {
      return finish(value, 'unknown', '连接状态尚未确认，请先恢复清理。', false);
    }
  }
  if (BUSY_PHASES.includes(observedPhase)) {
    if (matchingCommand && command?.action === 'stop') {
      return finish(value, 'stopping', phaseDetail('stopping'), false);
    }
    // Authorization admission/cancellation belongs to Home. Missing status and
    // an expired clock alone must never release a pending request here.
    const maximumAge = observedPhase === 'starting' ? 25000 : 12000;
    const age = now - state.updatedAt;
    if (!Number.isFinite(age) || age < 0 || age > maximumAge) {
      return finish(value, 'unknown', '连接状态更新中断，请先断开或恢复清理。', false);
    }
    const phase = ['stop_requested', 'destroying'].includes(observedPhase) ? 'stopping' : observedPhase;
    return finish(value, phase, phaseDetail(phase), false);
  }
  if (!matchingStatus && TERMINAL_PHASES.includes(state.phase)) {
    const phase = state.phase === 'failed' ? 'failed' : state.phase === 'idle' ? 'idle' : 'stopped';
    return finish(value, phase, phaseDetail(phase), true);
  }
  return finish(value, 'unknown', '连接状态尚未确认，请先恢复清理。', false);
}

export function readConnectionLifecycle(filesDir: string, now: number = Date.now()): ConnectionLifecycleAssessment {
  const state = readProbeState(filesDir);
  const command = readConnectionCommand(filesDir);
  const status = readConnectionStatus(filesDir);
  let presence = 'unknown';
  if (status && validPid(status)) {
    try {
      const result = native.processAlive(status.servicePid);
      if (result === false) { presence = 'absent'; }
      else if (result === true) { presence = 'present-or-unknown'; }
    } catch (_) { /* Permission and probe failures cannot establish exit. */ }
  }
  return assessConnectionLifecycle(state, command, status, presence, CONNECTION_UI_EPOCH, now);
}
