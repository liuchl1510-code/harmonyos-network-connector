import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

const JOURNAL_NAME: string = 'diagnostic-journal.json';
const MAX_EVENTS: number = 200;
const MAX_BYTES: number = 64 * 1024;
const EVENT_CODES: string[] = [
  'session-start', 'network-change', 'recovery-start', 'recovery-ok', 'recovery-failed',
  'waiting-network', 'protect-stale-before', 'protect-stale-after', 'protect-api-failed',
  'stop-requested', 'session-stopped', 'latency-start', 'latency-ok', 'latency-failed'
];
const EVENT_KINDS: string[] = ['', 'wifi', 'cellular', 'ethernet', 'other', 'unavailable', 'before', 'after'];
const EVENT_FIELDS: string[] = ['at', 'runId', 'code', 'kind', 'value'];

// Contains classifications and counts only. Never add arbitrary text, node names,
// addresses, URLs, credentials or raw errors to this persisted format.
export class DiagnosticEvent {
  at: number;
  runId: string;
  code: string;
  kind: string;
  value: number;

  constructor(at: number, runId: string, code: string, kind: string, value: number) {
    this.at = at;
    this.runId = runId;
    this.code = code;
    this.kind = kind;
    this.value = value;
  }
}

function validEvent(event: DiagnosticEvent): boolean {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) { return false; }
  const fields = Object.keys(event);
  return fields.length === EVENT_FIELDS.length && fields.every((field: string) => EVENT_FIELDS.includes(field)) &&
    typeof event.at === 'number' && Number.isSafeInteger(event.at) && event.at >= 0 &&
    typeof event.runId === 'string' && /^[0-9]{13}$/.test(event.runId) &&
    typeof event.code === 'string' && EVENT_CODES.includes(event.code) &&
    typeof event.kind === 'string' && EVENT_KINDS.includes(event.kind) &&
    typeof event.value === 'number' && Number.isFinite(event.value) && Number.isInteger(event.value) && event.value >= 0;
}

function byteLength(text: string): number {
  return new util.TextEncoder().encodeInto(text).length;
}

// One synchronous VPN service writer; all UI processes are read-only. Atomic
// rename provides complete snapshots to readers, but does not merge concurrent
// writers. Callers must catch these fixed errors so diagnostics cannot block VPN
// lifecycle/recovery. Missing or malformed files are empty; real read failures
// throw rather than allowing an append to erase previously persisted evidence.
export function readDiagnosticEvents(filesDir: string): DiagnosticEvent[] {
  const path = `${filesDir}/${JOURNAL_NAME}`;
  let content: string;
  try {
    if (!fs.accessSync(path)) { return []; }
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size < 0 || stat.size > MAX_BYTES) { return []; }
    content = fs.readTextSync(path, { length: MAX_BYTES + 1 });
  } catch (_) { throw new Error('DIAGNOSTIC_JOURNAL_READ_FAILED'); }
  try {
    if (byteLength(content) > MAX_BYTES) { return []; }
    const events = JSON.parse(content) as DiagnosticEvent[];
    if (!Array.isArray(events) || events.length > MAX_EVENTS) { return []; }
    const accepted: DiagnosticEvent[] = [];
    for (const event of events) {
      if (!validEvent(event)) { return []; }
      accepted.push(new DiagnosticEvent(event.at, event.runId, event.code, event.kind, event.value));
    }
    return accepted;
  } catch (_) { return []; }
}

export function appendDiagnosticEvent(filesDir: string, runId: string, code: string,
  kind: string = '', value: number = 0): void {
  const event = new DiagnosticEvent(Date.now(), runId, code, kind, value);
  if (!validEvent(event)) { throw new Error('DIAGNOSTIC_JOURNAL_INVALID_EVENT'); }
  const events = readDiagnosticEvents(filesDir);
  events.push(event);
  if (events.length > MAX_EVENTS) { events.splice(0, events.length - MAX_EVENTS); }
  let content = JSON.stringify(events);
  while (byteLength(content) > MAX_BYTES && events.length > 1) {
    events.shift();
    content = JSON.stringify(events);
  }
  if (byteLength(content) > MAX_BYTES) { throw new Error('DIAGNOSTIC_JOURNAL_INVALID_EVENT'); }
  const path = `${filesDir}/${JOURNAL_NAME}`;
  let temporary: string = '';
  let renamed: boolean = false;
  try {
    temporary = `${path}.${util.generateRandomUUID()}.tmp`;
    const bytes = new util.TextEncoder().encodeInto(content);
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const part = bytes.slice(offset);
        const written = fs.writeSync(file.fd, part.buffer);
        if (!Number.isInteger(written) || written <= 0 || written > part.length) {
          throw new Error('DIAGNOSTIC_JOURNAL_WRITE_FAILED');
        }
        offset += written;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, path);
    renamed = true;
  } catch (_) { throw new Error('DIAGNOSTIC_JOURNAL_WRITE_FAILED'); }
  finally {
    if (!renamed && temporary.length > 0) {
      try { if (fs.accessSync(temporary)) { fs.unlinkSync(temporary); } } catch (_) { /* Best-effort temporary cleanup. */ }
    }
  }
}
