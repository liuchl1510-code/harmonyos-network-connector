import { ConnectionLifecycleAssessment, readConnectionLifecycle } from './ConnectionLifecycle';

const REQUEST_LIFETIME_MS: number = 5000;

export class DockConnectionRequest {
  action: string;
  runId: string;
  sequence: number;
  createdAt: number;
  constructor(action: string, runId: string, sequence: number, createdAt: number) {
    this.action = action; this.runId = runId; this.sequence = sequence; this.createdAt = createdAt;
  }
}

// This is a short-lived, UI-only intent. Home remains the single owner of
// authorization, node validation and start/stop commands. Nothing is persisted.
let pending: DockConnectionRequest | undefined = undefined;
let pendingFilesDir: string = '';
let lastIssued: DockConnectionRequest | undefined = undefined;
let nextSequence: number = 0;

export function dockActionForLifecycle(value: ConnectionLifecycleAssessment, coreAvailable: boolean): string {
  if (!coreAvailable) { return ''; }
  if (value.closed) { return 'connect'; }
  if (value.state.kind === 'connection' && value.state.runId.length > 0 &&
    ['starting', 'active', 'recovering', 'waiting-network'].includes(value.phase)) { return 'disconnect'; }
  return '';
}

function isFresh(value: DockConnectionRequest, now: number): boolean {
  const age = now - value.createdAt;
  return Number.isFinite(now) && Number.isFinite(age) && age >= 0 && age < REQUEST_LIFETIME_MS;
}

function copyRequest(value: DockConnectionRequest): DockConnectionRequest {
  return new DockConnectionRequest(value.action, value.runId, value.sequence, value.createdAt);
}

export function queueDockConnectionAction(filesDir: string, coreAvailable: boolean,
  intendedAction: string, observedRunId: string, now: number = Date.now()): DockConnectionRequest | undefined {
  if (!coreAvailable || !Number.isFinite(now) || !['connect', 'disconnect'].includes(intendedAction)) { return undefined; }
  const lifecycle = readConnectionLifecycle(filesDir, now);
  const action = dockActionForLifecycle(lifecycle, coreAvailable);
  if (action !== intendedAction || lifecycle.state.runId !== observedRunId) { return undefined; }
  if (pending && isFresh(pending, now)) { return undefined; }
  // A second tap after immediate consumption must not repeat the same intent
  // while an authorization request or stop command is still taking effect.
  if (lastIssued && isFresh(lastIssued, now) && lastIssued.action === action &&
    lastIssued.runId === lifecycle.state.runId) { return undefined; }
  const request = new DockConnectionRequest(action, lifecycle.state.runId, ++nextSequence, now);
  pending = request; pendingFilesDir = filesDir; lastIssued = request;
  return copyRequest(request);
}

export function cancelDockConnectionAction(sequence: number): void {
  if (pending?.sequence === sequence) { pending = undefined; pendingFilesDir = ''; }
  if (lastIssued?.sequence === sequence) { lastIssued = undefined; }
}

export function consumeDockConnectionAction(filesDir: string, coreAvailable: boolean,
  now: number = Date.now()): DockConnectionRequest | undefined {
  const request = pending;
  const sameStore = pendingFilesDir === filesDir;
  // Clear before validation so any rejection, exception or subsequent page
  // appearance cannot replay this request.
  pending = undefined; pendingFilesDir = '';
  if (!request || !sameStore || !coreAvailable || !isFresh(request, now)) { return undefined; }
  const lifecycle = readConnectionLifecycle(filesDir, now);
  if (request.runId !== lifecycle.state.runId || request.action !== dockActionForLifecycle(lifecycle, coreAvailable)) {
    return undefined;
  }
  return copyRequest(request);
}
