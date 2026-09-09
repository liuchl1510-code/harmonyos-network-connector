// Pure queue state: it never starts a VPN, reads files, or changes node selection.
export class BatchLatencyTarget {
  nodeId: string;
  outboundFingerprint: string;
  constructor(nodeId: string, outboundFingerprint: string) {
    this.nodeId = nodeId; this.outboundFingerprint = outboundFingerprint;
  }
}

export class BatchLatencyObservation {
  activeNodeId: string = '';
  runId: string = '';
  kind: string = '';
  phase: string = '';
  commandRunId: string = '';
  commandAction: string = '';
  statusRunId: string = '';
  statusPhase: string = '';
  cleanupConfirmed: boolean = false;
  servicePid: number = 0;
  serviceExited: boolean = false;
  reconnectCount: number = 0;
  resultRunId: string = '';
  resultNodeId: string = '';
  resultFingerprint: string = '';
  resultStatus: string = '';
  resultReason: string = '';
}

export class BatchLatencyQueue {
  readonly targets: BatchLatencyTarget[];
  readonly activeNodeId: string;
  completed: number = 0;
  phase: string = 'ready';
  reason: string = '';
  private runId: string = '';
  private priorStatusRunId: string = '';
  private serviceObserved: boolean = false;
  private servicePid: number = 0;

  constructor(targets: BatchLatencyTarget[], activeNodeId: string) {
    const ids: Set<string> = new Set<string>();
    if (targets.length < 1 || targets.length > 500) { throw new Error('检测范围必须为 1 至 500 个节点。'); }
    for (const target of targets) {
      if (!/^[A-Za-z0-9_-]{1,96}$/.test(target.nodeId) || !/^[0-9a-f]{64}$/.test(target.outboundFingerprint) || ids.has(target.nodeId)) {
        throw new Error('检测快照无效，请重新开始。');
      }
      ids.add(target.nodeId);
    }
    this.targets = targets.map((target: BatchLatencyTarget) => new BatchLatencyTarget(target.nodeId, target.outboundFingerprint));
    this.activeNodeId = activeNodeId;
  }

  next(): BatchLatencyTarget | undefined {
    return this.phase === 'ready' ? this.targets[this.completed] : undefined;
  }

  claim(nodeId: string, runId: string, priorStatusRunId: string): boolean {
    if (this.next()?.nodeId !== nodeId || !/^[A-Za-z0-9_-]{1,96}$/.test(runId)) { return false; }
    this.runId = runId; this.priorStatusRunId = priorStatusRunId; this.serviceObserved = false; this.servicePid = 0;
    this.phase = 'running'; return true;
  }

  cancel(reason: string = 'cancelled'): void {
    if (this.phase === 'completed' || this.phase === 'aborted') { return; }
    this.phase = 'aborted'; this.reason = reason;
  }

  observe(value: BatchLatencyObservation): string {
    if (this.phase !== 'running') { return this.phase === 'aborted' ? 'aborted' : 'waiting'; }
    if (value.activeNodeId !== this.activeNodeId || value.runId !== this.runId || value.kind !== 'node-latency' ||
      value.commandRunId !== this.runId || value.commandAction !== 'start') {
      this.cancel('state-changed'); return 'aborted';
    }
    if (value.statusRunId !== this.runId) {
      // The preceding completed session's status remains until onCreate writes
      // this session's first heartbeat. Once observed, it may never revert.
      if (!this.serviceObserved && value.statusRunId === this.priorStatusRunId && value.phase === 'starting') { return 'waiting'; }
      this.cancel('state-changed'); return 'aborted';
    }
    this.serviceObserved = true;
    // During startup the last session's heartbeat may still be present. Its
    // reconnect count belongs to that run and must not cancel this request.
    if (value.reconnectCount > 0) { this.cancel('state-changed'); return 'aborted'; }
    if (Number.isSafeInteger(value.servicePid) && value.servicePid > 0) {
      if (this.servicePid > 0 && this.servicePid !== value.servicePid) { this.cancel('service-changed'); return 'aborted'; }
      this.servicePid = value.servicePid;
    }
    if (!['starting', 'active', 'stopping', 'stopped', 'failed'].includes(value.phase) ||
      !['starting', 'active', 'stopping', 'stopped', 'failed', 'destroying', 'destroyed'].includes(value.statusPhase)) {
      this.cancel('state-changed'); return 'aborted';
    }
    // onDestroy acknowledges resource cleanup before the process/environment
    // actually exits. The process-lived native module cannot be reused yet.
    // A missing later PID must not downgrade an already observed PID to the
    // legacy cleanup-only fallback.
    const released = this.servicePid > 0 ? value.servicePid === this.servicePid && value.serviceExited === true :
      value.statusPhase === 'destroyed' && value.cleanupConfirmed;
    if (!['stopped', 'failed'].includes(value.phase) || !released) { return 'waiting'; }
    const target = this.targets[this.completed];
    if (value.resultRunId !== this.runId || value.resultNodeId !== target.nodeId || value.resultFingerprint !== target.outboundFingerprint ||
      !(value.resultStatus === 'passed' && value.resultReason === '' ||
        value.resultStatus === 'failed' && ['dns', 'https', 'timeout'].includes(value.resultReason))) {
      this.cancel('result-unconfirmed'); return 'aborted';
    }
    this.completed++; this.runId = '';
    this.phase = this.completed === this.targets.length ? 'completed' : 'ready';
    return this.phase === 'completed' ? 'completed' : 'next';
  }
}

// The caller supplies only fingerprint-matched records. Missing/cancelled and
// failed records remain behind successful HTTPS results; ties stay stable.
export function latencySortRank(status: string, durationMs: number): number {
  return status === 'passed' && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : Number.POSITIVE_INFINITY;
}
