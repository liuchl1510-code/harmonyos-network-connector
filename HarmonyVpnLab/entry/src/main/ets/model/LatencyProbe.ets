import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { systemDateTime } from '@kit.BasicServicesKit';
import { LatencyRequest, LatencyProof, validLatencyRequest } from './LatencyProtocol';

const TOTAL_TIMEOUT_MS: number = 8000;
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

// Invoked by the UI process while its temporary VPN is active. Measures only
// one complete HTTPS request, including that request's DNS/TLS, with secure TLS
// defaults. No preliminary DNS test, VPN startup time or response data is saved.
export async function measureNodeLatency(input: LatencyRequest,
  isCurrent: () => boolean): Promise<LatencyProof | undefined> {
  const current = (): boolean => { try { return isCurrent(); } catch (_) { return false; } };
  if (!current() || !validLatencyRequest(input)) { return undefined; }
  // Freeze identity so caller mutation during a request cannot relabel evidence.
  const identity = new LatencyRequest(input.runId, input.nodeId, input.outboundFingerprint, input.createdAt);
  let request: http.HttpRequest | undefined = undefined;
  let deadlineTimer: number = -1;
  let cancellationTimer: number = -1;
  let startedAt: number = 0;
  let proof: LatencyProof | undefined = undefined;
  try {
    request = http.createHttp();
    if (!current()) { return undefined; }
    startedAt = uptimeMillis();
    const deadline = startedAt + TOTAL_TIMEOUT_MS;
    proof = await new Promise<LatencyProof | undefined>((resolve) => {
      let settled: boolean = false;
      const finish = (status: string, reason: string, sampledAt: number): void => {
        if (settled) { return; }
        settled = true;
        if (!current()) { resolve(undefined); return; }
        const elapsed = sampledAt - startedAt;
        if (!Number.isFinite(elapsed) || elapsed < 0) {
          resolve(new LatencyProof(identity.runId, identity.nodeId, identity.outboundFingerprint, 'failed', 0, 'https'));
        } else {
          resolve(new LatencyProof(identity.runId, identity.nodeId, identity.outboundFingerprint,
            status, Math.min(TOTAL_TIMEOUT_MS, elapsed), reason));
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
          finish('passed', '', receivedAt);
        } catch (_) { finish('failed', 'https', startedAt); }
      };
      try {
        deadlineTimer = setTimeout(() => {
          if (!cancel()) { finish('failed', 'timeout', deadline); }
        }, TOTAL_TIMEOUT_MS);
        cancellationTimer = setInterval(() => { cancel(); }, 100);
        if (cancel()) { return; }
        const options: http.HttpRequestOptions = {
          method: http.RequestMethod.GET,
          header: { 'Accept': 'text/plain', 'Cache-Control': 'no-cache' },
          expectDataType: http.HttpDataType.STRING,
          usingCache: false,
          maxRedirects: 0,
          maxLimit: MAX_RESPONSE_BYTES,
          connectTimeout: TOTAL_TIMEOUT_MS,
          readTimeout: TOTAL_TIMEOUT_MS
        };
        // Attach both handlers immediately: a timeout/cancellation may destroy
        // the native request before its promise rejects. Late results are inert.
        request?.request(`https://www.cloudflare.com/cdn-cgi/trace?latency=${identity.runId}`, options)
          .then((response: http.HttpResponse) => { accept(response); }, () => { accept(); });
      } catch (_) { accept(); }
    });
  } catch (_) {
    if (current()) {
      proof = new LatencyProof(identity.runId, identity.nodeId, identity.outboundFingerprint, 'failed', 0, 'https');
    }
  } finally {
    if (deadlineTimer !== -1) { clearTimeout(deadlineTimer); }
    if (cancellationTimer !== -1) { clearInterval(cancellationTimer); }
    try { request?.destroy(); }
    catch (_) {
      if (current()) {
        proof = new LatencyProof(identity.runId, identity.nodeId, identity.outboundFingerprint, 'failed', 0, 'https');
      }
    }
  }
  return current() ? proof : undefined;
}
