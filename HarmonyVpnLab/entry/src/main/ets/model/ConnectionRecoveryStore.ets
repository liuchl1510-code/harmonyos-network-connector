import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { ConnectionLifecycleAssessment, readConnectionLifecycle } from './ConnectionLifecycle';

const FILE_NAME: string = 'connection-recovery.json';
const MAX_RECORDS: number = 50;
const MAX_BYTES: number = 32768;
const KINDS: string[] = ['connection', 'connection-test', 'connection-app-test', 'node-latency'];
const FIELDS: string[] = ['at', 'runId', 'kind', 'servicePid', 'serviceStatusAt', 'reason'];

// UI observations are separate from service-owned cleanup receipts and journal.
// These fields cannot contain node names, endpoints, credentials or raw errors.
export class ConnectionRecoveryObservation {
  at: number;
  runId: string;
  kind: string;
  servicePid: number;
  serviceStatusAt: number;
  reason: string = 'service-exited';

  constructor(at: number, runId: string, kind: string, servicePid: number, serviceStatusAt: number) {
    this.at = at; this.runId = runId; this.kind = kind;
    this.servicePid = servicePid; this.serviceStatusAt = serviceStatusAt;
  }
}

class RecoveryFile {
  schemaVersion: number = 1;
  observations: ConnectionRecoveryObservation[];
  constructor(observations: ConnectionRecoveryObservation[]) { this.observations = observations; }
}

function valid(record: ConnectionRecoveryObservation): boolean {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) { return false; }
  const fields = Object.keys(record);
  return fields.length === FIELDS.length && fields.every((field: string) => FIELDS.includes(field)) &&
    Number.isSafeInteger(record.at) && record.at >= 0 &&
    typeof record.runId === 'string' && /^[0-9]{13}$/.test(record.runId) && KINDS.includes(record.kind) &&
    Number.isSafeInteger(record.servicePid) && record.servicePid > 0 && record.servicePid <= 2147483647 &&
    Number.isSafeInteger(record.serviceStatusAt) && record.serviceStatusAt >= 0 && record.reason === 'service-exited';
}

function sameObservation(left: ConnectionRecoveryObservation, right: ConnectionRecoveryObservation): boolean {
  return left.runId === right.runId && left.servicePid === right.servicePid && left.serviceStatusAt === right.serviceStatusAt;
}

export function readConnectionRecoveries(filesDir: string): ConnectionRecoveryObservation[] {
  const path = `${filesDir}/${FILE_NAME}`;
  let content: string;
  try {
    if (!fs.accessSync(path)) { return []; }
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size < 0 || stat.size > MAX_BYTES) { throw new Error('size'); }
    content = fs.readTextSync(path, { length: MAX_BYTES + 1 });
  } catch (_) { throw new Error('CONNECTION_RECOVERY_READ_FAILED'); }
  try {
    if (new util.TextEncoder().encodeInto(content).length > MAX_BYTES) { throw new Error('size'); }
    const file = JSON.parse(content) as RecoveryFile;
    if (file === null || typeof file !== 'object' || Array.isArray(file) ||
      Object.keys(file).length !== 2 || !Object.keys(file).every((key: string) => ['schemaVersion', 'observations'].includes(key)) ||
      file.schemaVersion !== 1 || !Array.isArray(file.observations) || file.observations.length > MAX_RECORDS) { throw new Error('format'); }
    const accepted: ConnectionRecoveryObservation[] = [];
    for (const entry of file.observations) {
      if (!valid(entry) || accepted.some((previous: ConnectionRecoveryObservation) => sameObservation(previous, entry))) { throw new Error('record'); }
      accepted.push(new ConnectionRecoveryObservation(entry.at, entry.runId, entry.kind, entry.servicePid, entry.serviceStatusAt));
    }
    return accepted;
  } catch (_) { throw new Error('CONNECTION_RECOVERY_INVALID_FILE'); }
}

function observationFor(assessment: ConnectionLifecycleAssessment): ConnectionRecoveryObservation | undefined {
  const status = assessment.status;
  if (!assessment.interruptionObserved || !assessment.serviceExited || assessment.servicePresence !== 'absent' ||
    assessment.cleanupConfirmed || !status || status.runId !== assessment.state.runId ||
    status.cleanupConfirmed === true || !KINDS.includes(assessment.state.kind)) { return undefined; }
  const record = new ConnectionRecoveryObservation(Date.now(), assessment.state.runId,
    assessment.state.kind, status.servicePid, status.updatedAt);
  return valid(record) ? record : undefined;
}

// One UI process writes this file synchronously. Service writers never touch it.
// Re-read the effective session before publishing an observation so an old page
// callback cannot record a superseded run as the current recovery. No stop/start
// or service-state mutation occurs here; callers can safely catch fixed errors.
export function recordConnectionRecovery(filesDir: string, assessment: ConnectionLifecycleAssessment): void {
  const record = observationFor(assessment);
  if (!record) { return; }
  let current: ConnectionLifecycleAssessment;
  try { current = readConnectionLifecycle(filesDir); }
  catch (_) { throw new Error('CONNECTION_RECOVERY_READ_FAILED'); }
  const checked = observationFor(current);
  if (!checked || !sameObservation(record, checked) || current.state.updatedAt !== assessment.state.updatedAt ||
    current.state.kind !== assessment.state.kind) { return; }
  const observations = readConnectionRecoveries(filesDir);
  if (observations.some((entry: ConnectionRecoveryObservation) => sameObservation(entry, record))) { return; }
  observations.push(record);
  if (observations.length > MAX_RECORDS) { observations.splice(0, observations.length - MAX_RECORDS); }
  const bytes = new util.TextEncoder().encodeInto(JSON.stringify(new RecoveryFile(observations)));
  if (bytes.length > MAX_BYTES) { throw new Error('CONNECTION_RECOVERY_INVALID_FILE'); }
  const destination = `${filesDir}/${FILE_NAME}`;
  let temporary: string = '';
  let renamed: boolean = false;
  try {
    temporary = `${destination}.${util.generateRandomUUID()}.tmp`;
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const part = bytes.slice(offset);
        const count = fs.writeSync(file.fd, part.buffer);
        if (!Number.isInteger(count) || count <= 0 || count > part.length) { throw new Error('write'); }
        offset += count;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
    const latest = readConnectionLifecycle(filesDir);
    const last = observationFor(latest);
    if (!last || !sameObservation(record, last) || latest.state.updatedAt !== assessment.state.updatedAt ||
      latest.state.kind !== assessment.state.kind) { return; }
    fs.renameSync(temporary, destination);
    renamed = true;
  } catch (_) { throw new Error('CONNECTION_RECOVERY_WRITE_FAILED'); }
  finally {
    if (!renamed && temporary.length > 0) {
      try { if (fs.accessSync(temporary)) { fs.unlinkSync(temporary); } } catch (_) { /* Preserve the original observation file. */ }
    }
  }
}
