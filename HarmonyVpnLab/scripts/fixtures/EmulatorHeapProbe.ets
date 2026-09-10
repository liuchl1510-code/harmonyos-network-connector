// Temporary emulator diagnostic template. Copy into the isolated stage's model
// directory only; this file is not imported by the ordinary application.
import { common, Want } from '@kit.AbilityKit';
import { hidebug, hilog } from '@kit.PerformanceAnalysisKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { VPN_CORE_AVAILABLE } from './BuildCapabilities';

interface HeapProbeReceipt {
  schemaVersion: number;
  recordType: string;
  label: string;
  state: string;
  requestNumber: number;
  requestedAt: string;
  finishedAt?: string;
  api: string;
  rawApiAvailable: boolean;
  legacyApiAvailable: boolean;
  requestedNeedGC: boolean;
  gcMode: string;
  needGC?: boolean;
  needClean: boolean;
  snapshotFileBase?: string;
  snapshotPath?: string;
  snapshotSizeBytes?: number;
  errorCode?: number;
  errorName?: string;
  failureStage?: string;
}

interface ProbeErrorFields {
  code?: number | string;
  name?: string;
}

const LABELS: string[] = ['before', 'after01', 'after02', 'idle'];
const MAX_REQUESTS: number = 4;
const MAX_RECEIPT_BYTES: number = 8192;
const ERROR_NAMES: string[] = ['Error', 'TypeError', 'BusinessError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'URIError', 'EvalError'];
// All state is bounded and belongs to the UIAbility's main-thread VM. No timer,
// worker, taskpool, listener, snapshot-content cache or automatic retry is used.
let inFlight: boolean = false;
let acceptedRequests: number = 0;
const acceptedLabels: string[] = [];

function writeReceipt(cacheDir: string, receipt: HeapProbeReceipt): void {
  const destination: string = `${cacheDir}/heap-probe-${receipt.label}.json`;
  const temporary: string = `${destination}.tmp`;
  const bytes: Uint8Array = new util.TextEncoder().encodeInto(JSON.stringify(receipt));
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error('HEAP_PROBE_RECEIPT_SIZE');
  }
  let renamed: boolean = false;
  try {
    const file: fs.File = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset: number = 0;
      while (offset < bytes.length) {
        const part: Uint8Array = bytes.slice(offset);
        const written: number = fs.writeSync(file.fd, part.buffer);
        if (!Number.isInteger(written) || written <= 0 || written > part.length) {
          throw new Error('HEAP_PROBE_RECEIPT_WRITE');
        }
        offset += written;
      }
      fs.fsyncSync(file.fd);
    } finally {
      fs.closeSync(file);
    }
    // The complete, flushed temporary file replaces the earlier receipt.
    fs.renameSync(temporary, destination);
    renamed = true;
  } finally {
    if (!renamed) {
      try { if (fs.accessSync(temporary)) { fs.unlinkSync(temporary); } }
      catch (_) { /* Never replace the original error with temporary cleanup. */ }
    }
  }
}

function legacyCandidates(context: common.UIAbilityContext, filename: string): string[] {
  const application: common.ApplicationContext = context.getApplicationContext();
  // Official SDK/API docs specify filesDir. Cache paths are additional exact
  // probes for this diagnostic runtime, never a directory enumeration.
  const directories: string[] = [context.filesDir, application.filesDir,
    context.cacheDir, application.cacheDir];
  const candidates: string[] = [];
  for (const directory of directories) {
    const candidate: string = `${directory}/${filename}.heapsnapshot`;
    if (!candidates.includes(candidate)) { candidates.push(candidate); }
  }
  return candidates;
}

function snapshotSize(path: string): number {
  const stat: fs.Stat = fs.statSync(path);
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) {
    throw new Error('HEAP_PROBE_OUTPUT_EMPTY_OR_INVALID');
  }
  return stat.size;
}

async function captureHeap(context: common.UIAbilityContext, receipt: HeapProbeReceipt): Promise<void> {
  let stage: string = 'start-receipt';
  try {
    writeReceipt(context.cacheDir, receipt);
    hilog.info(0x0000, 'HarmonyVpnLab', 'HEAP_PROBE_STARTED label=%{public}s', receipt.label);
    let snapshotPath: string = '';
    if (receipt.api === 'legacy') {
      stage = 'legacy-preflight';
      if (!receipt.legacyApiAvailable) { throw new TypeError('HEAP_PROBE_API_UNAVAILABLE'); }
      const filename: string = receipt.snapshotFileBase || '';
      const candidates: string[] = legacyCandidates(context, filename);
      for (const candidate of candidates) {
        if (fs.accessSync(candidate)) { throw new Error('HEAP_PROBE_OUTPUT_ALREADY_EXISTS'); }
      }
      stage = 'capture';
      // Synchronous, main-thread, SDK-default GC behavior. false is needClean,
      // not a GC switch. This branch is explicitly requested, never a fallback.
      hidebug.dumpJsHeapData(filename, false);
      stage = 'verify-output';
      for (const candidate of candidates) {
        if (!fs.accessSync(candidate)) { continue; }
        if (snapshotPath.length > 0) { throw new Error('HEAP_PROBE_OUTPUT_AMBIGUOUS'); }
        receipt.snapshotSizeBytes = snapshotSize(candidate);
        snapshotPath = candidate;
      }
    } else {
      stage = 'capture';
      if (!receipt.rawApiAvailable) { throw new TypeError('HEAP_PROBE_API_UNAVAILABLE'); }
      // Executes on the UIAbility/main thread before this await suspends.
      snapshotPath = await hidebug.dumpJsRawHeapData(receipt.requestedNeedGC, false);
      if (typeof snapshotPath !== 'string' || snapshotPath.length === 0) {
        throw new Error('HEAP_PROBE_PATH_UNAVAILABLE');
      }
      stage = 'verify-output';
      receipt.snapshotSizeBytes = snapshotSize(snapshotPath);
    }
    if (snapshotPath.length === 0) { throw new Error('HEAP_PROBE_PATH_UNAVAILABLE'); }
    stage = 'complete-receipt';
    receipt.state = 'completed';
    receipt.finishedAt = new Date().toISOString();
    receipt.snapshotPath = snapshotPath;
    writeReceipt(context.cacheDir, receipt);
    hilog.info(0x0000, 'HarmonyVpnLab', 'HEAP_PROBE_COMPLETED label=%{public}s', receipt.label);
  } catch (error) {
    // Numeric SDK codes and strict integer strings are allowed. Other values
    // become -1. Error names are a closed set, never arbitrary runtime text;
    // neither error.message nor raw heap/configuration contents are serialized.
    const fields: ProbeErrorFields | undefined = error as ProbeErrorFields | undefined;
    const code: number | string | undefined = fields?.code;
    let numericCode: number = -1;
    if (typeof code === 'number' && Number.isSafeInteger(code)) { numericCode = code; }
    if (typeof code === 'string' && /^(0|-?[1-9][0-9]*)$/.test(code) &&
      Number.isSafeInteger(Number(code))) { numericCode = Number(code); }
    const name: string | undefined = fields?.name;
    receipt.state = 'failed';
    receipt.finishedAt = new Date().toISOString();
    receipt.snapshotPath = undefined;
    receipt.snapshotSizeBytes = undefined;
    receipt.errorCode = numericCode;
    receipt.errorName = typeof name === 'string' && ERROR_NAMES.includes(name) ? name : 'UnknownError';
    receipt.failureStage = stage;
    try { writeReceipt(context.cacheDir, receipt); }
    catch (_) { hilog.error(0x0000, 'HarmonyVpnLab', 'HEAP_PROBE_RECEIPT_FAILED label=%{public}s', receipt.label); }
    hilog.error(0x0000, 'HarmonyVpnLab', 'HEAP_PROBE_FAILED label=%{public}s', receipt.label);
  } finally {
    inFlight = false;
  }
}

// Invoke only from the UIAbility main-thread onNewWant (or onCreate). The host
// must establish a fresh, synthetic-only preview before issuing any request.
export function handleHeapCapture(want: Want, context: common.UIAbilityContext): void {
  if (!context.applicationInfo.debug || VPN_CORE_AVAILABLE ||
    !deviceInfo.abiList.split(',').includes('x86_64')) { return; }
  const label = want.parameters?.['uiHeapCapture'];
  const gc = want.parameters?.['uiHeapGc'];
  const requestedApi = want.parameters?.['uiHeapApi'];
  const api = requestedApi === undefined ? 'raw' : requestedApi;
  if (typeof label !== 'string' || !LABELS.includes(label) ||
    typeof gc !== 'string' || (gc !== 'true' && gc !== 'false') ||
    typeof api !== 'string' || (api !== 'raw' && api !== 'legacy') ||
    (api === 'legacy' && gc !== 'true')) { return; }
  if (inFlight || acceptedRequests >= MAX_REQUESTS || acceptedLabels.includes(label)) {
    hilog.warn(0x0000, 'HarmonyVpnLab', 'HEAP_PROBE_REJECTED label=%{public}s', label);
    return;
  }
  // A failed request still consumes its label and quota; the caller must never
  // silently retry it. Across process restarts the host owns run separation.
  inFlight = true;
  acceptedRequests += 1;
  acceptedLabels.push(label);
  const receipt: HeapProbeReceipt = {
    schemaVersion: 2,
    recordType: 'emulator-heap-probe-receipt',
    label: label,
    state: 'started',
    requestNumber: acceptedRequests,
    requestedAt: new Date().toISOString(),
    api: api,
    rawApiAvailable: typeof hidebug.dumpJsRawHeapData === 'function',
    legacyApiAvailable: typeof hidebug.dumpJsHeapData === 'function',
    requestedNeedGC: gc === 'true',
    gcMode: api === 'legacy' ? 'platform-default' : 'explicit-boolean',
    needGC: api === 'raw' ? gc === 'true' : undefined,
    needClean: false
  };
  if (api === 'legacy') {
    receipt.snapshotFileBase = `heap-probe-${label}-${receipt.requestedAt.replace(/[^0-9]/g, '')}-${acceptedRequests}`;
  }
  void captureHeap(context, receipt);
}
