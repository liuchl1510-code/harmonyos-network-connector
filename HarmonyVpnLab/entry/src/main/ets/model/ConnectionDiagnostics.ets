import { socket } from '@kit.NetworkKit';
import { systemDateTime } from '@kit.BasicServicesKit';
import { ConnectionFailureError } from './ConnectionFailure';

const DNS_QUERY_MS: number = 6000;
const DNS_CLOSE_MS: number = 1000;
const DNS_CANCEL_POLL_MS: number = 100;
const PROXY_CHECK_HOST: string = 'www.cloudflare.com';
const DIRECT_CHECK_HOST: string = 'www.baidu.com';

export function connectionExitMarker(ip: string, runId: string): string {
  const text = `${runId}|${ip.trim()}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function queryBytes(id: number, type: number, host: string = PROXY_CHECK_HOST): Uint8Array {
  const bytes: number[] = [id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const label of host.split('.')) {
    bytes.push(label.length);
    for (let i = 0; i < label.length; i++) { bytes.push(label.charCodeAt(i)); }
  }
  bytes.push(0, 0, type, 0, 1);
  return new Uint8Array(bytes);
}

class DiagnosticDnsName {
  name: string;
  next: number;
  constructor(name: string, next: number) { this.name = name; this.next = next; }
}

class DiagnosticDnsResponseError extends Error {
  readonly reason: string;
  constructor(reason: string = 'invalid-response') { super('DNS_CHECK_RESPONSE_FAILED'); this.reason = reason; }
}

function readName(bytes: Uint8Array, start: number): DiagnosticDnsName {
  let offset = start;
  let next = -1;
  const labels: string[] = [];
  const seen: number[] = [];
  for (let steps = 0; steps < 256; steps++) {
    if (offset >= bytes.length) { break; }
    if (seen.includes(offset)) { break; }
    seen.push(offset);
    const length = bytes[offset++];
    if (length === 0) { return new DiagnosticDnsName(labels.join('.').toLowerCase(), next >= 0 ? next : offset); }
    if ((length & 192) === 192) {
      if (offset >= bytes.length) { break; }
      if (next < 0) { next = offset + 1; }
      offset = ((length & 63) << 8) | bytes[offset];
      continue;
    }
    if ((length & 192) !== 0 || length > 63 || offset + length > bytes.length) { break; }
    let label = '';
    for (let i = 0; i < length; i++) { label += String.fromCharCode(bytes[offset + i]); }
    labels.push(label);
    offset += length;
  }
  throw new DiagnosticDnsResponseError();
}

// Returns counts only. No answer address, raw packet or input is persisted.
export function validateDnsResponse(bytes: Uint8Array, id: number, type: number,
  host: string = PROXY_CHECK_HOST): number {
  if (bytes.length < 12 || ((bytes[0] << 8) | bytes[1]) !== id || (bytes[2] & 128) === 0 ||
    (bytes[2] & 120) !== 0 || (bytes[2] & 2) !== 0 || bytes[4] !== 0 || bytes[5] !== 1) {
    throw new DiagnosticDnsResponseError();
  }
  const question = readName(bytes, 12);
  let offset = question.next;
  if (question.name !== host.toLowerCase() || offset + 4 > bytes.length ||
    ((bytes[offset] << 8) | bytes[offset + 1]) !== type ||
    bytes[offset + 2] !== 0 || bytes[offset + 3] !== 1) { throw new DiagnosticDnsResponseError(); }
  if ((bytes[3] & 15) !== 0) { throw new DiagnosticDnsResponseError('failed'); }
  offset += 4;
  const answers = (bytes[6] << 8) | bytes[7];
  let matching = 0;
  for (let i = 0; i < answers; i++) {
    offset = readName(bytes, offset).next;
    if (offset + 10 > bytes.length) { throw new DiagnosticDnsResponseError(); }
    const rrType = (bytes[offset] << 8) | bytes[offset + 1];
    const rrClass = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const length = (bytes[offset + 8] << 8) | bytes[offset + 9];
    offset += 10;
    if (offset + length > bytes.length) { throw new DiagnosticDnsResponseError(); }
    if (rrType === type && rrClass === 1 && length !== (type === 1 ? 4 : 16)) {
      throw new DiagnosticDnsResponseError();
    }
    if (rrType === type && rrClass === 1 && length === (type === 1 ? 4 : 16)) { matching++; }
    offset += length;
  }
  if (type === 1 && matching < 1) { throw new DiagnosticDnsResponseError('failed'); }
  if (type === 28 && answers !== 0) { throw new DiagnosticDnsResponseError(); }
  return matching;
}

class DiagnosticSocketOwner {
  udp?: socket.UDPSocket;
  bindPending: boolean = false;
  closePending: boolean = false;
  lateCloseRequired: boolean = false;
  closed: boolean = false;
}

// Keep ownership while native bind/close outcomes are uncertain. A later check
// must not accumulate more sockets before an earlier check finishes cleanup.
const retainedDiagnosticSockets: DiagnosticSocketOwner[] = [];

function releaseDiagnosticSocket(owner: DiagnosticSocketOwner): void {
  if (!owner.closed || owner.bindPending || owner.closePending || owner.lateCloseRequired) { return; }
  const index = retainedDiagnosticSockets.indexOf(owner);
  if (index >= 0) { retainedDiagnosticSockets.splice(index, 1); }
}

async function closeDiagnosticSocket(owner: DiagnosticSocketOwner): Promise<boolean> {
  const udp = owner.udp;
  if (!udp) { return true; }
  if (owner.closePending) { return false; }
  if (owner.closed && !owner.bindPending) { releaseDiagnosticSocket(owner); return true; }
  let timer: number = -1;
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (confirmed: boolean): void => {
        if (settled) { return; }
        settled = true; resolve(confirmed);
      };
      timer = setTimeout(() => finish(false), DNS_CLOSE_MS);
      owner.closePending = true;
      try {
        udp.close().then(() => {
          owner.closePending = false;
          if (owner.lateCloseRequired) {
            owner.lateCloseRequired = false; owner.closed = false;
            finish(false);
            void closeDiagnosticSocket(owner);
          } else {
            owner.closed = true; releaseDiagnosticSocket(owner);
            finish(!owner.bindPending);
          }
        }, () => { owner.closePending = false; finish(false); });
      } catch (_) { owner.closePending = false; finish(false); }
    });
  } catch (_) { return false; }
  finally { if (timer >= 0) { clearTimeout(timer); } }
}

async function query(type: number, host: string, stage: string, current: () => boolean): Promise<number> {
  const owner = new DiagnosticSocketOwner();
  let deadlineTimer = -1;
  let pollTimer = -1;
  let operationFailure: ConnectionFailureError | undefined = undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      let finished = false;
      let answerCount = -1;
      let sent = false;
      const fail = (reason: string): void => {
        if (finished) { return; }
        finished = true; operationFailure = new ConnectionFailureError(stage, reason); reject(operationFailure);
      };
      let deadline: number = 0;
      const guard = (): boolean => {
        if (finished) { return false; }
        try {
          if (!current()) { fail('failed'); return false; }
          if (systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false) >= deadline) { fail('timeout'); return false; }
          return true;
        } catch (_) { fail('failed'); return false; }
      };
      const complete = (): void => {
        if (!guard() || !sent || answerCount < 0) { return; }
        finished = true; resolve(answerCount);
      };
      const poll = (): void => {
        pollTimer = -1;
        if (guard()) { pollTimer = setTimeout(poll, DNS_CANCEL_POLL_MS); }
      };
      try {
        deadline = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false) + DNS_QUERY_MS;
        if (!guard()) { return; }
        if (retainedDiagnosticSockets.length > 0) { fail('failed'); return; }
        deadlineTimer = setTimeout(() => fail('timeout'), DNS_QUERY_MS);
        pollTimer = setTimeout(poll, DNS_CANCEL_POLL_MS);
        const udp = socket.constructUDPSocketInstance();
        owner.udp = udp; retainedDiagnosticSockets.push(owner);
        const id = Math.floor(Math.random() * 65536);
        udp.on('error', () => fail('failed'));
        udp.on('message', (info: socket.SocketMessageInfo) => {
          if (!guard() || info.remoteInfo.address !== '198.18.0.1' || info.remoteInfo.port !== 53) { return; }
          try {
            const bytes = new Uint8Array(info.message);
            answerCount = validateDnsResponse(bytes, id, type, host);
            complete();
          } catch (error) {
            // Only the authored validator can classify a well-formed negative
            // reply. Arbitrary socket/error messages never determine a cause.
            fail(error instanceof DiagnosticDnsResponseError ? error.reason : 'invalid-response');
          }
        });
        owner.bindPending = true;
        udp.bind({ address: '0.0.0.0', port: 0, family: 1 }).then(async () => {
          owner.bindPending = false; owner.closed = false;
          if (!guard()) {
            if (owner.closePending) { owner.lateCloseRequired = true; }
            else { await closeDiagnosticSocket(owner); }
            return;
          }
          const packet = queryBytes(id, type, host);
          await udp.send({ data: packet.buffer, address: { address: '198.18.0.1', family: 1, port: 53 } });
          sent = true; complete();
        }, () => { owner.bindPending = false; releaseDiagnosticSocket(owner); fail('failed'); })
          .then(() => {}, () => fail('failed'));
      } catch (_) { owner.bindPending = false; fail('failed'); }
    });
  } finally {
    if (deadlineTimer >= 0) { clearTimeout(deadlineTimer); }
    if (pollTimer >= 0) { clearTimeout(pollTimer); }
    let detached = true;
    const udp = owner.udp;
    if (udp) {
      try { udp.off('message'); } catch (_) { detached = false; }
      try { udp.off('error'); } catch (_) { detached = false; }
      const closed = await closeDiagnosticSocket(owner);
      if (operationFailure === undefined) {
        let stillCurrent = false;
        try { stillCurrent = current(); } catch (_) {}
        if (!closed || owner.bindPending || !detached || !stillCurrent) {
          throw new ConnectionFailureError(stage, 'failed');
        }
      }
    }
  }
}

export async function checkProxyDns(current: () => boolean = () => true): Promise<void> {
  await query(1, PROXY_CHECK_HOST, 'proxy-dns', current);
  await query(28, PROXY_CHECK_HOST, 'proxy-dns', current);
}

export async function checkDirectDns(current: () => boolean = () => true): Promise<void> {
  await query(1, DIRECT_CHECK_HOST, 'direct-dns', current);
}

export async function probeIpv6Datagram(): Promise<boolean> {
  const udp = socket.constructUDPSocketInstance();
  const id = Math.floor(Math.random() * 65536);
  let timer: number = -1;
  try {
    await udp.bind({ address: '::', family: 2, port: 0 });
    const response = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 1500);
      udp.on('message', (info: socket.SocketMessageInfo) => {
        const bytes = new Uint8Array(info.message);
        if (bytes.length >= 12 && ((bytes[0] << 8) | bytes[1]) === id) { resolve(true); }
      });
    });
    const packet = queryBytes(id, 1);
    await udp.send({ data: packet.buffer, address: { address: '2606:4700:4700::1111', family: 2, port: 53 } });
    return await response;
  } finally {
    if (timer >= 0) { clearTimeout(timer); }
    udp.off('message');
    try { await udp.close(); } catch (_) {}
  }
}
