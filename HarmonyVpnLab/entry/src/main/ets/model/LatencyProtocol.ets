import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

const MAX_BYTES: number = 8 * 1024;
const READ_ERROR: string = 'LATENCY_PROTOCOL_READ_FAILED';
const WRITE_ERROR: string = 'LATENCY_PROTOCOL_WRITE_FAILED';

export class LatencyRequest {
  runId: string;
  nodeId: string;
  outboundFingerprint: string;
  createdAt: number;
  constructor(runId: string, nodeId: string, outboundFingerprint: string, createdAt: number = Date.now()) {
    this.runId = runId;
    this.nodeId = nodeId;
    this.outboundFingerprint = outboundFingerprint;
    this.createdAt = createdAt;
  }
}

export class LatencyProof {
  runId: string;
  nodeId: string;
  outboundFingerprint: string;
  status: string;
  durationMs: number;
  reason: string;
  checkedAt: number;
  constructor(runId: string, nodeId: string, outboundFingerprint: string, status: string,
    durationMs: number, reason: string, checkedAt: number = Date.now()) {
    this.runId = runId;
    this.nodeId = nodeId;
    this.outboundFingerprint = outboundFingerprint;
    this.status = status;
    this.durationMs = durationMs;
    this.reason = reason;
    this.checkedAt = checkedAt;
  }
}

function exactKeys(value: Object, keys: string[]): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every((key: string) => keys.includes(key));
}

function validIdentity(runId: string, nodeId: string, fingerprint: string): boolean {
  return typeof runId === 'string' && runId.length === 13 && /^[0-9]{13}$/.test(runId) &&
    typeof nodeId === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(nodeId) &&
    typeof fingerprint === 'string' && fingerprint.length === 64 && /^[0-9a-f]{64}$/.test(fingerprint);
}

export function validLatencyRequest(value: LatencyRequest): boolean {
  return exactKeys(value, ['runId', 'nodeId', 'outboundFingerprint', 'createdAt']) &&
    validIdentity(value.runId, value.nodeId, value.outboundFingerprint) &&
    typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0;
}

function validProof(value: LatencyProof): boolean {
  return exactKeys(value, ['runId', 'nodeId', 'outboundFingerprint', 'status', 'durationMs', 'reason', 'checkedAt']) &&
    validIdentity(value.runId, value.nodeId, value.outboundFingerprint) &&
    typeof value.checkedAt === 'number' && Number.isSafeInteger(value.checkedAt) && value.checkedAt >= 0 &&
    typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 60000 &&
    typeof value.status === 'string' && ['passed', 'failed', 'cancelled'].includes(value.status) &&
    typeof value.reason === 'string' && ['', 'dns', 'https', 'timeout', 'network-changed', 'stopped', 'configuration', 'internal'].includes(value.reason) &&
    (value.status === 'passed' ? value.reason === '' : value.reason !== '');
}

function readText(filesDir: string, name: string): string | undefined {
  try {
    const path = `${filesDir}/${name}`;
    if (!fs.accessSync(path)) { return undefined; }
    const stat = fs.statSync(path);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_BYTES) { throw new Error(READ_ERROR); }
    const text = fs.readTextSync(path, { length: MAX_BYTES + 1 });
    if (new util.TextEncoder().encodeInto(text).byteLength > MAX_BYTES) { throw new Error(READ_ERROR); }
    return text;
  } catch (_) { throw new Error(READ_ERROR); }
}

function writeText(filesDir: string, name: string, text: string): void {
  let temporary = '';
  try {
    const bytes = new util.TextEncoder().encodeInto(text);
    if (bytes.byteLength > MAX_BYTES) { throw new Error(WRITE_ERROR); }
    const path = `${filesDir}/${name}`;
    temporary = `${path}.${util.generateRandomUUID()}.tmp`;
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const part = bytes.slice(offset);
        const written = fs.writeSync(file.fd, part.buffer);
        if (!Number.isSafeInteger(written) || written <= 0 || written > part.byteLength) { throw new Error(WRITE_ERROR); }
        offset += written;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, path);
  } catch (_) { throw new Error(WRITE_ERROR); }
  finally {
    try { if (temporary !== '' && fs.accessSync(temporary)) { fs.unlinkSync(temporary); } }
    catch (_) { /* Never expose native filesystem errors. */ }
  }
}

// UI is the sole writer of both files; the VPN service reads complete snapshots.
// A proof is evidence of this bounded HTTPS request, not proof of proxy routing.
// The service must also validate current node/hash/run, network generation and
// core traffic before recording a result or finishing its temporary VPN.
export function writeLatencyRequest(filesDir: string, request: LatencyRequest): void {
  try {
    if (!validLatencyRequest(request)) { throw new Error(WRITE_ERROR); }
    writeText(filesDir, 'latency-request.json', JSON.stringify(new LatencyRequest(request.runId,
      request.nodeId, request.outboundFingerprint, request.createdAt)));
  } catch (_) { throw new Error(WRITE_ERROR); }
}

export function readLatencyRequest(filesDir: string): LatencyRequest | undefined {
  try {
    const text = readText(filesDir, 'latency-request.json');
    if (text === undefined) { return undefined; }
    const request = JSON.parse(text) as LatencyRequest;
    if (!validLatencyRequest(request)) { throw new Error(READ_ERROR); }
    return new LatencyRequest(request.runId, request.nodeId, request.outboundFingerprint, request.createdAt);
  } catch (_) { throw new Error(READ_ERROR); }
}

export function writeLatencyProof(filesDir: string, proof: LatencyProof): void {
  try {
    if (!validProof(proof)) { throw new Error(WRITE_ERROR); }
    writeText(filesDir, 'latency-proof.json', JSON.stringify(new LatencyProof(proof.runId,
      proof.nodeId, proof.outboundFingerprint, proof.status, proof.durationMs, proof.reason, proof.checkedAt)));
  } catch (_) { throw new Error(WRITE_ERROR); }
}

export function readLatencyProof(filesDir: string): LatencyProof | undefined {
  try {
    const text = readText(filesDir, 'latency-proof.json');
    if (text === undefined) { return undefined; }
    const proof = JSON.parse(text) as LatencyProof;
    if (!validProof(proof)) { throw new Error(READ_ERROR); }
    return new LatencyProof(proof.runId, proof.nodeId, proof.outboundFingerprint,
      proof.status, proof.durationMs, proof.reason, proof.checkedAt);
  } catch (_) { throw new Error(READ_ERROR); }
}
