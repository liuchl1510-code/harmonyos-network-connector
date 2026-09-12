import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { systemDateTime } from '@kit.BasicServicesKit';
import { LatencyRequest, LatencyProof, validLatencyRequest } from './LatencyProtocol';

const REQUEST_TIMEOUT_MS: number = 8000;
const TOTAL_TIMEOUT_MS: number = 16000;
const MAX_RESPONSE_BYTES: number = 4096;

function uptimeMillis(): number {
  const value = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
  if (!Number.isFinite(value) || value < 0) { throw new Error('LATENCY_CLOCK_FAILED'); }
  return value;
}

function validTrace(response: http.HttpResponse): boolean {
  if (!response || response.responseCode !== 200 || typeof response.result !== 'string' ||
    response.result.length > MAX_RESPONSE_BYTES ||
    new util.TextEncoder().encodeInto(response.result).byteLength > MAX_RESPONSE_BYTES) { return false; }
  const lines = response.result.split(/\r?\n/);
  const host = lines.filter((line: string) => line.startsWith('h='));
  const ip = lines.filter((line: string) => line.startsWith('ip='));
  const scheme = lines.filter((line: string) => line.startsWith('visit_scheme='));
  return host.length === 1 && host[0] === 'h=www.cloudflare.com' &&
    ip.length === 1 && /^ip=[0-9a-fA-F:.]+$/.test(ip[0]) &&
    scheme.length === 1 && scheme[0] === 'visit_scheme=https';
}

class HttpsSample {
  status: string;
  durationMs: number;
  reason: string;
  connection: string;
  receivedAt: number;
  cleanupFailed: boolean = false;
  constructor(status: string, durationMs: number, reason: string, connection: string, receivedAt: number) {
    this.status = status; this.durationMs = durationMs; this.reason = reason;
    this.connection = connection; this.receivedAt = receivedAt;
  }
}

function connectionKind(response: http.HttpResponse): string {
  try {
    const reused = response.connectionExtraInfo?.isReusedConnection;
    return reused === true ? 'reused' : reused === false ? 'new' : 'unknown';
  } catch (_) { return 'unknown'; }
}

async function measureRequest(request: http.HttpRequest, url: string, current: () => boolean,
  startedAt: number, totalDeadline: number, inspectConnection: boolean): Promise<HttpsSample | undefined> {
  let deadlineTimer: number = -1;
  let cancellationTimer: number = -1;
  let sample: HttpsSample | undefined = undefined;
  let cleanupFailed: boolean = false;
  try {
    if (!current()) { return undefined; }
    const budget = Math.min(REQUEST_TIMEOUT_MS, totalDeadline - startedAt);
    if (budget <= 0) { return new HttpsSample('failed', 0, 'timeout', 'unknown', startedAt); }
    const deadline = startedAt + budget;
    sample = await new Promise<HttpsSample | undefined>((resolve) => {
      let settled: boolean = false;
      const finish = (status: string, reason: string, sampledAt: number, connection: string = 'unknown'): void => {
        if (settled) { return; }
        settled = true;
        if (!current()) { resolve(undefined); return; }
        const elapsed = sampledAt - startedAt;
        if (!Number.isFinite(elapsed) || elapsed < 0) {
          resolve(new HttpsSample('failed', 0, 'https', 'unknown', startedAt));
        } else {
          resolve(new HttpsSample(status, Math.min(budget, elapsed), reason, connection, sampledAt));
        }
      };
      const cancel = (): boolean => {
        if (settled) { return true; }
        if (!current()) { settled = true; resolve(undefined); return true; }
        return false;
      };
      const accept = (response?: http.HttpResponse): void => {
        if (cancel()) { return; }
        try {
          // request() resolves after the entire bounded response has arrived.
          // Sample before validation: UI parsing is not counted as HTTPS time.
          const receivedAt = uptimeMillis();
          if (receivedAt >= deadline) { finish('failed', 'timeout', receivedAt); return; }
          if (!response || !validTrace(response)) { finish('failed', 'https', receivedAt); return; }
          finish('passed', '', receivedAt, inspectConnection ? connectionKind(response) : 'unknown');
        } catch (_) { finish('failed', 'https', startedAt); }
      };
      const pollCancellation = (): void => {
        if (cancel()) { return; }
        try { cancellationTimer = setTimeout(pollCancellation, 100); }
        catch (_) { finish('failed', 'https', startedAt); }
      };
      try {
        deadlineTimer = setTimeout(() => {
          if (!cancel()) { finish('failed', 'timeout', deadline); }
        }, budget);
        cancellationTimer = setTimeout(pollCancellation, 100);
        if (cancel()) { return; }
        const options: http.HttpRequestOptions = {
          method: http.RequestMethod.GET,
          header: { 'Accept': 'text/plain', 'Cache-Control': 'no-cache' },
          expectDataType: http.HttpDataType.STRING,
          usingCache: false,
          maxRedirects: 0,
          maxLimit: MAX_RESPONSE_BYTES,
          connectTimeout: REQUEST_TIMEOUT_MS,
          readTimeout: REQUEST_TIMEOUT_MS
        };
        // Attach both handlers immediately: a timeout/cancellation may destroy
        // the native request before its promise rejects. Late results are inert.
        request.request(url, options)
          .then((response: http.HttpResponse) => { accept(response); }, () => { accept(); });
      } catch (_) { accept(); }
    });
  } catch (_) {
    if (current()) { sample = new HttpsSample('failed', 0, 'https', 'unknown', startedAt); }
  } finally {
    // Attempt both cleanups even if one native timer call throws. Polling uses
    // one-shot timers, so an uncleared callback becomes inert instead of looping.
    try { if (deadlineTimer !== -1) { clearTimeout(deadlineTimer); } } catch (_) { cleanupFailed = true; }
    try { if (cancellationTimer !== -1) { clearTimeout(cancellationTimer); } } catch (_) { cleanupFailed = true; }
  }
  if (sample) { sample.cleanupFailed = cleanupFailed; }
  return current() ? sample : undefined;
}

// Both complete HTTPS requests are timed independently over the same HttpRequest
// and URL. The first remains durationMs; the second is not assumed to reuse a
// connection. Startup, response parsing and response contents are not recorded.
export async function measureNodeLatency(input: LatencyRequest,
  isCurrent: () => boolean): Promise<LatencyProof | undefined> {
  const current = (): boolean => { try { return isCurrent(); } catch (_) { return false; } };
  if (!current() || !validLatencyRequest(input)) { return undefined; }
  const identity = new LatencyRequest(input.runId, input.nodeId, input.outboundFingerprint, input.createdAt);
  const failed = (duration: number = 0, reason: string = 'https'): LatencyProof =>
    new LatencyProof(identity.runId, identity.nodeId, identity.outboundFingerprint,
      'failed', duration, reason, Date.now(), 2);
  let request: http.HttpRequest | undefined = undefined;
  let proof: LatencyProof | undefined = undefined;
  try {
    request = http.createHttp();
    if (!current()) { return undefined; }
    const startedAt = uptimeMillis();
    const deadline = startedAt + TOTAL_TIMEOUT_MS;
    const url = `https://www.cloudflare.com/cdn-cgi/trace?latency=${identity.runId}`;
    const first = await measureRequest(request, url, current, startedAt, deadline, false);
    if (!first || !current()) { return undefined; }
    if (first.cleanupFailed) { proof = failed(); }
    else if (first.status !== 'passed') { proof = failed(first.durationMs, first.reason); }
    else {
      let second: HttpsSample | undefined = undefined;
      try {
        const secondStartedAt = uptimeMillis();
        if (secondStartedAt < first.receivedAt) { throw new Error('LATENCY_CLOCK_FAILED'); }
        second = await measureRequest(request, url, current, secondStartedAt, deadline, true);
      } catch (_) { second = new HttpsSample('failed', 0, 'https', 'unknown', first.receivedAt); }
      if (!second || !current()) { return undefined; }
      proof = second.cleanupFailed ? failed() : new LatencyProof(identity.runId, identity.nodeId,
        identity.outboundFingerprint, 'passed', first.durationMs, '', Date.now(), 2,
        second.status, second.status === 'passed' ? second.durationMs : 0,
        second.reason, second.status === 'passed' ? second.connection : 'unknown');
    }
  } catch (_) {
    if (current()) { proof = failed(); }
  } finally {
    try { request?.destroy(); }
    catch (_) {
      if (current()) { proof = failed(); }
    }
  }
  return current() ? proof : undefined;
}
