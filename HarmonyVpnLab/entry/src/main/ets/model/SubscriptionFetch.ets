import { http } from '@kit.NetworkKit';
import { url, util } from '@kit.ArkTS';
import { systemDateTime } from '@kit.BasicServicesKit';

const MAX_URL_LENGTH: number = 4096;
const MAX_RESPONSE_BYTES: number = 1024 * 1024;
const TOTAL_TIMEOUT_MS: number = 12000;
const INVALID_URL: string = '订阅地址无效，请使用不含账号和片段的 HTTPS 链接（最多 4096 字符）';
const REQUEST_FAILED: string = '订阅请求失败，请检查网络或订阅服务';
const REQUEST_TIMEOUT: string = '订阅请求超时（总时限 12 秒）';

export function normalizeSubscriptionUrl(input: string): string {
  // Check the original length before trimming, and reject URL parser repairs.
  if (input.length > MAX_URL_LENGTH) { throw new Error(INVALID_URL); }
  const trimmed = input.trim();
  if (!/^https:\/\//i.test(trimmed) || /[\u0000-\u0020\u007f\\#]/.test(trimmed) ||
    /%(?![0-9a-fA-F]{2})/.test(trimmed)) {
    throw new Error(INVALID_URL);
  }
  const authority = trimmed.slice(8).split(/[/?]/)[0];
  if (authority.length === 0 || authority.includes('@')) { throw new Error(INVALID_URL); }
  try {
    const parsed = url.URL.parseURL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.hostname.length === 0 || parsed.username.length > 0 ||
      parsed.password.length > 0 || parsed.hash.length > 0 || parsed.href.length > MAX_URL_LENGTH) {
      throw new Error(INVALID_URL);
    }
    return parsed.href;
  } catch (_) {
    // URL parser exceptions can contain the complete subscription token.
    throw new Error(INVALID_URL);
  }
}

function uptimeMillis(): number {
  // STARTUP is monotonic elapsed time and includes device sleep, unlike wall time.
  return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
}

export async function fetchSubscription(input: string): Promise<string> {
  const normalized = normalizeSubscriptionUrl(input);
  let request: http.HttpRequest;
  let deadline: number;
  try {
    deadline = uptimeMillis() + TOTAL_TIMEOUT_MS;
    request = http.createHttp();
  } catch (_) {
    throw new Error(REQUEST_FAILED);
  }
  return new Promise<string>((resolve, reject) => {
    let settled: boolean = false;
    let ended: boolean = false;
    let statusAccepted: boolean = false;
    let receivedBytes: number = 0;
    let timer: number = -1;
    let storage: Uint8Array | undefined = undefined;

    const settle = (message: string, result: string = ''): void => {
      if (settled) { return; }
      settled = true;
      if (timer !== -1) { clearTimeout(timer); timer = -1; }
      storage = undefined;
      // Each cleanup is independent: an off() failure must not prevent destroy().
      try { request.off('dataReceive'); } catch (_) { /* No native error details. */ }
      try { request.off('dataEnd'); } catch (_) { /* No native error details. */ }
      let destroyed: boolean = true;
      try { request.destroy(); } catch (_) { destroyed = false; }
      if (message.length > 0) {
        reject(new Error(message));
      } else if (!destroyed) {
        reject(new Error(REQUEST_FAILED));
      } else {
        resolve(result);
      }
    };

    const stopped = (): boolean => {
      if (settled) { return true; }
      try {
        if (uptimeMillis() >= deadline) {
          settle(REQUEST_TIMEOUT);
          return true;
        }
      } catch (_) {
        settle(REQUEST_FAILED);
        return true;
      }
      return false;
    };

    const finish = (): void => {
      if (stopped() || !ended || !statusAccepted) { return; }
      let text: string;
      try {
        if (!storage) { settle(REQUEST_FAILED); return; }
        const decoder = util.TextDecoder.create('utf-8', { fatal: true });
        text = decoder.decodeToString(storage.subarray(0, receivedBytes));
        // Subscription formats are text. Reject binary control characters.
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
          settle('订阅响应必须是有效的 UTF-8 文本');
          return;
        }
        if (text.startsWith('\ufeff')) { text = text.slice(1); }
      } catch (_) {
        settle('订阅响应必须是有效的 UTF-8 文本');
        return;
      }
      // Decoding is part of the total deadline, even if a timer callback is delayed.
      if (!stopped()) { settle('', text); }
    };

    const receive = (data: ArrayBuffer): void => {
      if (stopped()) { return; }
      try {
        if (ended || !storage) { settle(REQUEST_FAILED); return; }
        if (data.byteLength > MAX_RESPONSE_BYTES - receivedBytes) {
          settle('订阅响应超过 1 MiB 上限');
          return;
        }
        // Copy only an accepted chunk into one bounded buffer; never retain it.
        storage.set(new Uint8Array(data), receivedBytes);
        receivedBytes += data.byteLength;
      } catch (_) {
        settle(REQUEST_FAILED);
      }
    };

    const end = (): void => {
      if (stopped()) { return; }
      ended = true;
      finish();
    };

    try {
      storage = new Uint8Array(MAX_RESPONSE_BYTES);
      if (stopped()) { return; }
      timer = setTimeout(() => { settle(REQUEST_TIMEOUT); }, Math.max(0, deadline - uptimeMillis()));
      request.on('dataReceive', receive);
      request.on('dataEnd', end);
      if (stopped()) { return; }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: { 'Accept': 'text/plain, application/json' },
        usingCache: false,
        // SDK 26 @ohos.net.http.d.ts: maxRedirects=0 disables redirects (API 23+).
        maxRedirects: 0,
        maxLimit: MAX_RESPONSE_BYTES,
        connectTimeout: TOTAL_TIMEOUT_MS,
        readTimeout: TOTAL_TIMEOUT_MS
      };
      // Leave all certificate / TLS options at their secure system defaults.
      request.requestInStream(normalized, options).then((status: number) => {
        if (stopped()) { return; }
        if (status !== 200) { settle('订阅服务器未返回 HTTP 200'); return; }
        statusAccepted = true;
        finish();
      }).catch(() => {
        if (!stopped()) { settle(REQUEST_FAILED); }
      });
    } catch (_) {
      if (!stopped()) { settle(REQUEST_FAILED); }
    }
  });
}
