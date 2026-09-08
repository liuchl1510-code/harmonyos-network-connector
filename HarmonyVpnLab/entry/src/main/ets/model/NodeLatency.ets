import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

const MAX_RESULTS: number = 500;
const MAX_FILE_BYTES: number = 256 * 1024;
const MAX_OUTBOUND_BYTES: number = 65536;
const READ_ERROR: string = '延迟记录损坏或无法读取，已保留原文件。';
const SAVE_ERROR: string = '延迟记录保存失败，原有记录未替换。';

export class NodeLatencyResult {
  nodeId: string;
  outboundFingerprint: string;
  runId: string;
  checkedAt: number;
  status: string;
  durationMs: number;
  reason: string;
  constructor(nodeId: string, outboundFingerprint: string, runId: string, status: string,
    durationMs: number, reason: string, checkedAt: number = Date.now()) {
    this.nodeId = nodeId;
    this.outboundFingerprint = outboundFingerprint;
    this.runId = runId;
    this.checkedAt = checkedAt;
    this.status = status;
    this.durationMs = durationMs;
    this.reason = reason;
  }
}

class NodeLatencyFile {
  schemaVersion: number = 1;
  results: NodeLatencyResult[] = [];
}

function exactKeys(value: Object, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || Object.keys(value).some((key: string) => !keys.includes(key))) {
    throw new Error(READ_ERROR);
  }
}

function validId(value: string): boolean {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value);
}

function validateResult(result: NodeLatencyResult): void {
  exactKeys(result, ['nodeId', 'outboundFingerprint', 'runId', 'checkedAt', 'status', 'durationMs', 'reason']);
  if (!validId(result.nodeId) || !validId(result.runId) || typeof result.outboundFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(result.outboundFingerprint) || !Number.isSafeInteger(result.checkedAt) ||
    result.checkedAt < 0 || !['passed', 'failed', 'cancelled'].includes(result.status) ||
    typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) ||
    result.durationMs < 0 || result.durationMs > 60000 ||
    !['', 'dns', 'https', 'timeout', 'network-changed', 'stopped', 'configuration', 'internal'].includes(result.reason) ||
    (result.status === 'passed' ? result.reason !== '' : result.reason === '')) {
    throw new Error(READ_ERROR);
  }
}

function validateFile(value: NodeLatencyFile): NodeLatencyResult[] {
  exactKeys(value, ['schemaVersion', 'results']);
  if (value.schemaVersion !== 1 || !Array.isArray(value.results) || value.results.length > MAX_RESULTS) {
    throw new Error(READ_ERROR);
  }
  const ids: Set<string> = new Set<string>();
  for (const result of value.results) {
    validateResult(result);
    if (ids.has(result.nodeId)) { throw new Error(READ_ERROR); }
    ids.add(result.nodeId);
  }
  return value.results;
}

// Exact outbound text is the identity: even a harmless formatting change requires
// a fresh test. Only its SHA-256 digest is stored, never the node configuration.
export async function fingerprintOutbound(outboundJson: string): Promise<string> {
  try {
    if (typeof outboundJson !== 'string' || outboundJson.length === 0 || outboundJson.length > MAX_OUTBOUND_BYTES) {
      throw new Error('invalid');
    }
    const bytes = new util.TextEncoder().encodeInto(outboundJson);
    if (bytes.byteLength > MAX_OUTBOUND_BYTES) { throw new Error('invalid'); }
    const digest = cryptoFramework.createMd('SHA256');
    await digest.update({ data: bytes });
    const value = await digest.digest();
    if (value.data.byteLength !== 32) { throw new Error('invalid'); }
    let hex = '';
    for (let index = 0; index < value.data.byteLength; index++) {
      hex += value.data[index].toString(16).padStart(2, '0');
    }
    return hex;
  } catch (_) { throw new Error('无法识别节点配置，未记录检测结果。'); }
}

export function readNodeLatencies(filesDir: string): NodeLatencyResult[] {
  try {
    const path = `${filesDir}/node-latency.json`;
    if (!fs.accessSync(path)) { return []; }
    const size = fs.statSync(path).size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) { throw new Error(READ_ERROR); }
    const text = fs.readTextSync(path);
    if (text.length > MAX_FILE_BYTES || new util.TextEncoder().encodeInto(text).byteLength > MAX_FILE_BYTES) {
      throw new Error(READ_ERROR);
    }
    return validateFile(JSON.parse(text) as NodeLatencyFile);
  } catch (_) { throw new Error(READ_ERROR); }
}

// Only the VPN service writes this file. UI readers see a complete old or new
// snapshot; an older asynchronous test cannot overwrite a newer result.
export function saveNodeLatency(filesDir: string, result: NodeLatencyResult): void {
  let temporary = '';
  try {
    validateResult(result);
    const current = readNodeLatencies(filesDir);
    const previous = current.find((entry: NodeLatencyResult) => entry.nodeId === result.nodeId);
    if (previous && previous.checkedAt > result.checkedAt) { return; }
    const next = new NodeLatencyFile();
    next.results = current.filter((entry: NodeLatencyResult) => entry.nodeId !== result.nodeId);
    // Copy fixed fields so a caller-supplied object cannot add a toJSON payload.
    next.results.push(new NodeLatencyResult(result.nodeId, result.outboundFingerprint, result.runId,
      result.status, result.durationMs, result.reason, result.checkedAt));
    next.results.sort((left: NodeLatencyResult, right: NodeLatencyResult) => right.checkedAt - left.checkedAt);
    next.results = next.results.slice(0, MAX_RESULTS);
    const bytes = new util.TextEncoder().encodeInto(JSON.stringify(next));
    if (bytes.byteLength > MAX_FILE_BYTES) { throw new Error(SAVE_ERROR); }
    const destination = `${filesDir}/node-latency.json`;
    temporary = `${destination}.${util.generateRandomUUID()}.tmp`;
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const part = bytes.slice(offset);
        const written = fs.writeSync(file.fd, part.buffer);
        if (!Number.isSafeInteger(written) || written <= 0 || written > part.byteLength) {
          throw new Error(SAVE_ERROR);
        }
        offset += written;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, destination);
  } catch (_) { throw new Error(SAVE_ERROR); }
  finally {
    try { if (temporary !== '' && fs.accessSync(temporary)) { fs.unlinkSync(temporary); } }
    catch (_) { /* Private temporary cleanup is best effort. */ }
  }
}

export function latencyLabel(result?: NodeLatencyResult): string {
  if (!result) { return '未检测'; }
  try { validateResult(result); } catch (_) { return '检测记录无效'; }
  if (result.status === 'passed') { return `HTTPS ${Math.round(result.durationMs)} ms`; }
  const prefix = result.status === 'cancelled' ? '已取消：' : '失败：';
  switch (result.reason) {
    case 'dns': return `${prefix}DNS 检查未通过`;
    case 'https': return `${prefix}HTTPS 检查未通过`;
    case 'timeout': return `${prefix}检测超时`;
    case 'network-changed': return `${prefix}网络已变化`;
    case 'stopped': return `${prefix}连接已停止`;
    case 'configuration': return `${prefix}节点配置无效或已变化`;
    default: return `${prefix}检测未完成`;
  }
}
