import { http, socket } from '@kit.NetworkKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { deviceInfo, systemDateTime } from '@kit.BasicServicesKit';
import { readConnectionLifecycle } from './ConnectionLifecycle';
import { readNetworkPolicy } from './NetworkPolicyStore';
import { validDnsFaultRequestShape } from './DnsFaultTest';

const TARGETS: string[] = ['dns-baidu', 'dns-google', 'dns-cloudflare', 'https-baidu', 'https-cloudflare',
  'https-cloudflare-keepalive'];
const seenTokens: string[] = [];
let latestToken: string = '';
const REQUEST_MS: number = 8000;
const TOTAL_MS: number = 20000;

export function validDnsBenchmark(target: string, token: string): boolean {
  return typeof target === 'string' && typeof token === 'string' && TARGETS.includes(target) &&
    token.length >= 8 && token.length <= 40 && !/[^A-Za-z0-9]/.test(token);
}

export class BenchmarkSession {
  runId: string = '';
  servicePid: number = 0;
  reconnectCount: number = 0;
  mode: string = '';
  dnsMode: string = '';
  faultKind?: string;
  faultToken?: string;
}

// Read-only: no start/stop command, policy save, node import or core call.
export function readBenchmarkSession(filesDir: string): BenchmarkSession | undefined {
  try {
    const now = Date.now();
    const life = readConnectionLifecycle(filesDir, now);
    const status = life.status;
    if (life.phase !== 'active' || life.ownerChanged || !status || status.phase !== 'active' ||
      life.state.runId !== status.runId || life.state.phase !== 'active' ||
      !/^[0-9]{10,20}$/.test(status.runId) || !Number.isSafeInteger(status.servicePid) || status.servicePid < 1 ||
      !Number.isSafeInteger(status.reconnectCount) || status.reconnectCount < 0 ||
      now - status.updatedAt < 0 || now - status.updatedAt > 12000 ||
      now - life.state.updatedAt < 0 || now - life.state.updatedAt > 12000) { return undefined; }
    const policy = readNetworkPolicy(filesDir);
    if (!['global', 'whitelist', 'rules'].includes(policy.mode) || !['proxy', 'split'].includes(policy.dnsMode)) {
      return undefined;
    }
    const result = new BenchmarkSession();
    result.runId = status.runId; result.servicePid = status.servicePid; result.reconnectCount = status.reconnectCount;
    result.mode = status.effectiveMode ?? policy.mode; result.dnsMode = status.effectiveDnsMode ?? policy.dnsMode;
    if (status.dnsFault !== undefined) {
      if (!validDnsFaultRequestShape(status.dnsFault)) { return undefined; }
      result.faultKind = status.dnsFault.kind; result.faultToken = status.dnsFault.token;
    }
    return result;
  } catch (_) { return undefined; }
}

export function sameBenchmarkSession(left: BenchmarkSession, right?: BenchmarkSession): boolean {
  return right !== undefined && left.runId === right.runId && left.servicePid === right.servicePid &&
    left.reconnectCount === right.reconnectCount && left.mode === right.mode && left.dnsMode === right.dnsMode &&
    left.faultKind === right.faultKind && left.faultToken === right.faultToken;
}

export class BenchmarkTimings {
  dnsTiming?: number;
  tcpTiming?: number;
  tlsTiming?: number;
  firstSendTiming?: number;
  firstReceiveTiming?: number;
  totalFinishTiming?: number;
  redirectTiming?: number;
  responseHeaderTiming?: number;
  responseBodyTiming?: number;
  totalTiming?: number;
}

export class BenchmarkConnection {
  isReusedConnection?: boolean;
}

export class BenchmarkSample {
  stage: string;
  status: string = 'failed';
  reason: string = '';
  durationMs: number = 0;
  answerCount?: number;
  responseCode?: number;
  responseBytes?: number;
  timings?: BenchmarkTimings;
  connection?: BenchmarkConnection;
  constructor(stage: string) { this.stage = stage; }
}

export class DnsBenchmarkResult {
  schemaVersion: number = 1;
  token: string;
  target: string;
  status: string = 'rejected';
  reason: string = '';
  startedAt: number = Date.now();
  finishedAt: number = 0;
  session?: BenchmarkSession;
  samples: BenchmarkSample[] = [];
  constructor(target: string, token: string) { this.target = target; this.token = token; }
}

function uptime(): number {
  const value = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
  if (!Number.isFinite(value) || value < 0) { throw new Error('clock'); }
  return value;
}

function numberField(value?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 60000 ? value : undefined;
}

export function safeBenchmarkTiming(response: http.HttpResponse): BenchmarkTimings {
  const result = new BenchmarkTimings();
  const timing = response.performanceTiming;
  if (!timing) { return result; }
  result.dnsTiming = numberField(timing.dnsTiming); result.tcpTiming = numberField(timing.tcpTiming);
  result.tlsTiming = numberField(timing.tlsTiming); result.firstSendTiming = numberField(timing.firstSendTiming);
  result.firstReceiveTiming = numberField(timing.firstReceiveTiming); result.totalFinishTiming = numberField(timing.totalFinishTiming);
  result.redirectTiming = numberField(timing.redirectTiming); result.responseHeaderTiming = numberField(timing.responseHeaderTiming);
  result.responseBodyTiming = numberField(timing.responseBodyTiming); result.totalTiming = numberField(timing.totalTiming);
  return result;
}

export function safeBenchmarkConnection(response: http.HttpResponse): BenchmarkConnection {
  const result = new BenchmarkConnection();
  const connection = response.connectionExtraInfo;
  if (!connection) { return result; }
  if (typeof connection.isReusedConnection === 'boolean') { result.isReusedConnection = connection.isReusedConnection; }
  return result;
}

export function validBenchmarkHttp(target: string, response: http.HttpResponse): boolean {
  if (response.responseCode !== 200 || !(response.result instanceof ArrayBuffer) ||
    response.result.byteLength < 1 || response.result.byteLength > 65536) { return false; }
  try {
    const text = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(new Uint8Array(response.result));
    if (target === 'https-baidu') {
      return /^User-agent:\s*\S+/im.test(text) && /^(?:Disallow|Allow):/im.test(text);
    }
    if (target !== 'https-cloudflare' && target !== 'https-cloudflare-keepalive') { return false; }
    const lines = text.split(/\r?\n/);
    const hosts = lines.filter((line: string) => line.startsWith('h='));
    const ips = lines.filter((line: string) => line.startsWith('ip='));
    const schemes = lines.filter((line: string) => line.startsWith('visit_scheme='));
    return hosts.length === 1 && hosts[0] === 'h=www.cloudflare.com' && ips.length === 1 &&
      /^ip=(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ips[0]) &&
      ips[0].substring(3).split('.').every((part: string) => Number(part) <= 255) &&
      schemes.length === 1 && schemes[0] === 'visit_scheme=https';
  } catch (_) { return false; }
}

function targetHost(target: string): string {
  if (target === 'dns-google') { return 'www.google.com'; }
  return target.endsWith('baidu') ? 'www.baidu.com' : 'www.cloudflare.com';
}

export function benchmarkQuery(id: number, host: string): Uint8Array {
  const result: number[] = [id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const label of host.split('.')) {
    result.push(label.length);
    for (let i = 0; i < label.length; i++) { result.push(label.charCodeAt(i)); }
  }
  result.push(0, 0, 1, 0, 1);
  return new Uint8Array(result);
}

class DnsName {
  name: string;
  next: number;
  constructor(name: string, next: number) { this.name = name; this.next = next; }
}

function dnsName(bytes: Uint8Array, start: number): DnsName {
  let cursor = start;
  let next = -1;
  const labels: string[] = [];
  for (let count = 0; count < 128; count++) {
    if (cursor >= bytes.length) { break; }
    const length = bytes[cursor++];
    if (length === 0) { return new DnsName(labels.join('.').toLowerCase(), next < 0 ? cursor : next); }
    if ((length & 192) === 192) {
      if (cursor >= bytes.length) { break; }
      if (next < 0) { next = cursor + 1; }
      cursor = ((length & 63) << 8) | bytes[cursor];
      continue;
    }
    if (length > 63 || cursor + length > bytes.length) { break; }
    let label = '';
    for (let index = 0; index < length; index++) { label += String.fromCharCode(bytes[cursor++]); }
    labels.push(label);
  }
  throw new Error('dns-response');
}

// The return value contains counts only, never DNS answer addresses or packets.
export function validateBenchmarkDns(bytes: Uint8Array, id: number, host: string): number {
  if (bytes.length < 12 || bytes.length > 4096 || ((bytes[0] << 8) | bytes[1]) !== id ||
    (bytes[2] & 128) === 0 || (bytes[2] & 120) !== 0 || (bytes[2] & 2) !== 0 ||
    (bytes[3] & 15) !== 0 || bytes[4] !== 0 || bytes[5] !== 1) { throw new Error('dns-response'); }
  const question = dnsName(bytes, 12);
  let offset = question.next;
  if (question.name !== host || offset + 4 > bytes.length || bytes[offset] !== 0 || bytes[offset + 1] !== 1 ||
    bytes[offset + 2] !== 0 || bytes[offset + 3] !== 1) { throw new Error('dns-response'); }
  offset += 4;
  const answers = (bytes[6] << 8) | bytes[7];
  let count = 0;
  for (let index = 0; index < answers; index++) {
    offset = dnsName(bytes, offset).next;
    if (offset + 10 > bytes.length) { throw new Error('dns-response'); }
    const type = (bytes[offset] << 8) | bytes[offset + 1];
    const klass = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const size = (bytes[offset + 8] << 8) | bytes[offset + 9];
    offset += 10;
    if (offset + size > bytes.length) { throw new Error('dns-response'); }
    if (type === 1 && klass === 1) {
      if (size !== 4) { throw new Error('dns-response'); }
      count++;
    }
    offset += size;
  }
  if (count < 1) { throw new Error('dns-response'); }
  return count;
}

async function closeBenchmarkSocket(udp: socket.UDPSocket): Promise<boolean> {
  let timer: number = -1;
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (closed: boolean): void => {
        if (settled) { return; }
        settled = true;
        resolve(closed);
      };
      timer = setTimeout(() => finish(false), 1000);
      try { udp.close().then(() => finish(true), () => finish(false)); }
      catch (_) { finish(false); }
    });
  } catch (_) { return false; }
  finally { if (timer >= 0) { clearTimeout(timer); } }
}

// ArkTS control-flow analysis does not treat assignments inside a Promise
// callback as assignments to outer nullable locals. Keep ownership explicit in
// a typed holder that is shared by callbacks and the unconditional finally.
class BenchmarkResources {
  udp?: socket.UDPSocket;
  request?: http.HttpRequest;
  bindPending: boolean = false;
}

class BenchmarkRetainedHttp {
  request: http.HttpRequest;
  sample: BenchmarkSample;
  constructor(request: http.HttpRequest, sample: BenchmarkSample) { this.request = request; this.sample = sample; }
}

export class DnsBenchmarkRun {
  private cancelled: boolean = false;
  private abortPending?: () => void;
  cancel(): void { this.cancelled = true; this.abortPending?.(); }

  private async measure(target: string, stage: string, token: string, current: () => boolean,
    totalDeadline: number, retainedHttp: BenchmarkRetainedHttp[]): Promise<BenchmarkSample> {
    const sample = new BenchmarkSample(stage);
    const startedAt = uptime();
    const budget = Math.max(0, Math.min(REQUEST_MS, totalDeadline - startedAt));
    let deadlineTimer: number = -1;
    let pollingTimer: number = -1;
    const resources = new BenchmarkResources();
    try {
      return await new Promise<BenchmarkSample>((resolve) => {
        let finished = false;
        const finish = (reason: string, receivedAt?: number): void => {
          if (finished) { return; }
          finished = true;
          sample.reason = this.cancelled ? 'cancelled' : !current() ? 'session-changed' : reason;
          sample.status = sample.reason.length === 0 ? 'passed' : 'failed';
          try { sample.durationMs = Math.max(0, Math.min(budget, (receivedAt ?? uptime()) - startedAt)); }
          catch (_) { sample.reason = 'clock'; sample.status = 'failed'; }
          resolve(sample);
        };
        this.abortPending = (): void => finish('cancelled');
        const guard = (): boolean => {
          if (finished) { return false; }
          if (this.cancelled || !current()) { finish('session-changed'); return false; }
          if (uptime() - startedAt >= budget) { finish('timeout'); return false; }
          return true;
        };
        const poll = (): void => {
          try { if (guard()) { pollingTimer = setTimeout(poll, 100); } }
          catch (_) { finish('clock'); }
        };
        try {
          if (!guard()) { return; }
          deadlineTimer = setTimeout(() => finish('timeout'), budget);
          pollingTimer = setTimeout(poll, 100);
          if (target.startsWith('dns-')) {
            const host = targetHost(target);
            const id = Math.floor(Math.random() * 65536);
            const ownedUdp = socket.constructUDPSocketInstance();
            resources.udp = ownedUdp;
            ownedUdp.on('error', () => finish('dns-socket'));
            ownedUdp.on('message', (info: socket.SocketMessageInfo) => {
              try {
                const receivedAt = uptime();
                if (!guard() || info.remoteInfo.address !== '198.18.0.1' || info.remoteInfo.port !== 53) { return; }
                sample.answerCount = validateBenchmarkDns(new Uint8Array(info.message), id, host);
                finish('', receivedAt);
              } catch (_) { finish('dns-response'); }
            });
            resources.bindPending = true;
            ownedUdp.bind({ address: '0.0.0.0', family: 1, port: 0 }).then(async () => {
              resources.bindPending = false;
              if (!guard()) {
                // A native bind can complete after cancellation/timeout and
                // after the first close attempt. Close that late socket again;
                // never send a late query or change an already written receipt.
                await closeBenchmarkSocket(ownedUdp);
                return;
              }
              const packet = benchmarkQuery(id, host);
              await ownedUdp.send({ data: packet.buffer, address: { address: '198.18.0.1', family: 1, port: 53 } });
            }, () => { resources.bindPending = false; finish('dns-socket'); }).then(() => {}, () => finish('dns-socket'));
          } else {
            const ownedRequest = http.createHttp();
            resources.request = ownedRequest;
            const keepalive = target === 'https-cloudflare-keepalive';
            // SDK createHttp() requires one instance per request. Retain both
            // instances until the serial pair finishes; reuse is observed only
            // from the SDK response, never assumed from the request order.
            if (keepalive) { retainedHttp.push(new BenchmarkRetainedHttp(ownedRequest, sample)); }
            const path = target === 'https-baidu' ? '/robots.txt' : '/cdn-cgi/trace';
            const url = `https://${targetHost(target)}${path}?dnsbenchmark=${token}`;
            const options: http.HttpRequestOptions = {
              method: http.RequestMethod.GET, expectDataType: http.HttpDataType.ARRAY_BUFFER,
              usingProtocol: http.HttpProtocol.HTTP1_1, usingCache: false, maxRedirects: 0,
              header: { 'Connection': keepalive ? 'keep-alive' : 'close', 'Cache-Control': 'no-cache', 'Accept': 'text/plain' },
              maxLimit: 65536, connectTimeout: REQUEST_MS, readTimeout: REQUEST_MS
            };
            if (keepalive && deviceInfo.sdkApiVersion >= 26) { options.reuseConnections = true; }
            ownedRequest.request(url, options).then((response: http.HttpResponse) => {
              try {
                // request() has received the full body. Exclude validation and
                // receipt serialization from the timed request duration.
                const receivedAt = uptime();
                if (!guard()) { return; }
                if (!(response.result instanceof ArrayBuffer) || response.result.byteLength > 65536) {
                  finish('https-response'); return;
                }
                sample.responseCode = response.responseCode; sample.responseBytes = response.result.byteLength;
                sample.timings = safeBenchmarkTiming(response); sample.connection = safeBenchmarkConnection(response);
                finish(validBenchmarkHttp(target, response) ? '' : 'https-response', receivedAt);
              } catch (_) { finish('https-response'); }
            }, () => finish('https-request'));
          }
        } catch (_) { finish(target.startsWith('dns-') ? 'dns-socket' : 'https-request'); }
      });
    } finally {
      this.abortPending = undefined;
      if (deadlineTimer >= 0) { clearTimeout(deadlineTimer); }
      if (pollingTimer >= 0) { clearTimeout(pollingTimer); }
      try { resources.udp?.off('message'); } catch (_) {}
      try { resources.udp?.off('error'); } catch (_) {}
      if (resources.udp) {
        const closed = await closeBenchmarkSocket(resources.udp);
        // An unresolved bind may create a socket later. Even a successful
        // close call now cannot prove that all resources have been released.
        if (!closed || resources.bindPending) { sample.status = 'failed'; sample.reason = 'cleanup'; }
      }
      if (target !== 'https-cloudflare-keepalive') {
        try { resources.request?.destroy(); } catch (_) { sample.status = 'failed'; sample.reason = 'cleanup'; }
      }
    }
  }

  async run(filesDir: string, target: string, token: string, allowed: boolean): Promise<DnsBenchmarkResult> {
    const result = new DnsBenchmarkResult(target, token);
    if (!allowed || !validDnsBenchmark(target, token)) { result.reason = 'unavailable'; return result; }
    if (seenTokens.includes(token) || seenTokens.length >= 256) { result.reason = 'duplicate-token'; return result; }
    seenTokens.push(token); latestToken = token;
    const session = readBenchmarkSession(filesDir);
    result.session = session;
    if (!session) { result.reason = 'no-active-session'; }
    else {
      const current = (): boolean => latestToken === token && sameBenchmarkSession(session, readBenchmarkSession(filesDir));
      const retainedHttp: BenchmarkRetainedHttp[] = [];
      try {
        const deadline = uptime() + TOTAL_MS;
        const stages: string[] = target.startsWith('dns-') ? ['first', 'repeat'] :
          target === 'https-cloudflare-keepalive' ? ['first-get', 'repeat-get'] : ['get'];
        for (const stage of stages) {
          if (this.cancelled || !current()) { result.reason = this.cancelled ? 'cancelled' : 'session-changed'; break; }
          const sample = await this.measure(target, stage, token, current, deadline, retainedHttp);
          result.samples.push(sample);
          if (sample.status !== 'passed') { result.reason = sample.reason; break; }
        }
        if (!result.reason && !current()) { result.reason = 'session-changed'; }
        if (this.cancelled && result.reason !== 'cleanup') { result.reason = 'cancelled'; }
      } catch (_) { result.status = 'failed'; result.reason = 'internal'; }
      finally {
        // Cleanup precedes the receipt. A failed destroy cannot be reported as
        // a successful pair; still attempt to release every retained instance.
        for (const owned of retainedHttp) {
          try { owned.request.destroy(); }
          catch (_) { owned.sample.status = 'failed'; owned.sample.reason = 'cleanup'; result.reason = 'cleanup'; }
        }
      }
      if (result.reason !== 'cleanup') {
        if (this.cancelled) { result.reason = 'cancelled'; }
        else if (!current()) { result.reason = 'session-changed'; }
      }
      result.status = result.reason.length === 0 ? 'passed' : 'failed';
    }
    result.finishedAt = Date.now();
    // A superseded page may finish cancellation after the next run has begun.
    // It must never replace the new token's receipt.
    if (latestToken === token) {
      try { saveResult(filesDir, result); }
      catch (_) { result.status = 'failed'; result.reason = 'receipt-write'; }
    }
    return result;
  }
}

function saveResult(filesDir: string, result: DnsBenchmarkResult): void {
  const path = `${filesDir}/dns-benchmark-result.json`;
  const temporary = `${path}.${result.token}.tmp`;
  const bytes = new util.TextEncoder().encodeInto(JSON.stringify(result));
  if (bytes.byteLength > 16384) { throw new Error('receipt-write'); }
  try {
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const part = bytes.slice(offset);
        const size = fs.writeSync(file.fd, part.buffer);
        if (!Number.isSafeInteger(size) || size < 1 || size > part.byteLength) { throw new Error('receipt-write'); }
        offset += size;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, path);
  } finally {
    try { if (fs.accessSync(temporary)) { fs.unlinkSync(temporary); } } catch (_) {}
  }
}
