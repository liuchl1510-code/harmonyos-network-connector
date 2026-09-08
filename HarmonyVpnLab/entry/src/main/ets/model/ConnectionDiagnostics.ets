import { socket } from '@kit.NetworkKit';

export function connectionExitMarker(ip: string, runId: string): string {
  const text = `${runId}|${ip.trim()}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function queryBytes(id: number, type: number): Uint8Array {
  const host = 'www.cloudflare.com';
  const bytes: number[] = [id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const label of host.split('.')) {
    bytes.push(label.length);
    for (let i = 0; i < label.length; i++) { bytes.push(label.charCodeAt(i)); }
  }
  bytes.push(0, 0, type, 0, 1);
  return new Uint8Array(bytes);
}

function skipName(bytes: Uint8Array, start: number): number {
  let offset = start;
  for (let steps = 0; steps < 128; steps++) {
    if (offset >= bytes.length) { break; }
    const length = bytes[offset++];
    if (length === 0) { return offset; }
    if ((length & 192) === 192) {
      if (offset >= bytes.length) { break; }
      return offset + 1;
    }
    if (length > 63 || offset + length > bytes.length) { break; }
    offset += length;
  }
  throw new Error('DNS 名称数据无效');
}

export function validateDnsResponse(bytes: Uint8Array, id: number, type: number): number {
  if (bytes.length < 12 || ((bytes[0] << 8) | bytes[1]) !== id || (bytes[2] & 128) === 0 ||
    (bytes[2] & 2) !== 0 || (bytes[3] & 15) !== 0 || bytes[4] !== 0 || bytes[5] !== 1) {
    throw new Error('DNS 响应头无效');
  }
  let offset = skipName(bytes, 12);
  if (offset + 4 > bytes.length || ((bytes[offset] << 8) | bytes[offset + 1]) !== type ||
    bytes[offset + 2] !== 0 || bytes[offset + 3] !== 1) { throw new Error('DNS 问题字段不匹配'); }
  offset += 4;
  const answers = (bytes[6] << 8) | bytes[7];
  let matching = 0;
  for (let i = 0; i < answers; i++) {
    offset = skipName(bytes, offset);
    if (offset + 10 > bytes.length) { throw new Error('DNS 回答被截断'); }
    const rrType = (bytes[offset] << 8) | bytes[offset + 1];
    const rrClass = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const length = (bytes[offset + 8] << 8) | bytes[offset + 9];
    offset += 10;
    if (offset + length > bytes.length) { throw new Error('DNS 回答长度无效'); }
    if (rrType === type && rrClass === 1 && length === (type === 1 ? 4 : 16)) { matching++; }
    offset += length;
  }
  if (type === 1 && matching < 1) { throw new Error('DNS 未返回 IPv4 地址'); }
  if (type === 28 && answers !== 0) { throw new Error('IPv4 模式不应返回 AAAA 回答'); }
  return matching;
}

async function query(type: number): Promise<number> {
  const udp = socket.constructUDPSocketInstance();
  const id = Math.floor(Math.random() * 65536);
  let timer: number = -1;
  try {
    await udp.bind({ address: '0.0.0.0', port: 0, family: 1 });
    const response = new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('代理 DNS 检查超时')), 6000);
      udp.on('message', (info: socket.SocketMessageInfo) => {
        if (info.remoteInfo.address !== '198.18.0.1' || info.remoteInfo.port !== 53) { return; }
        try { resolve(validateDnsResponse(new Uint8Array(info.message), id, type)); }
        catch (_) { reject(new Error('代理 DNS 返回无效响应')); }
      });
      udp.on('error', () => reject(new Error('代理 DNS socket 错误')));
    });
    const packet = queryBytes(id, type);
    const results = await Promise.all([
      response,
      udp.send({ data: packet.buffer, address: { address: '198.18.0.1', family: 1, port: 53 } }).then(() => 0)
    ]);
    return results[0];
  } finally {
    if (timer >= 0) { clearTimeout(timer); }
    udp.off('message'); udp.off('error');
    try { await udp.close(); } catch (_) {}
  }
}

export async function checkProxyDns(): Promise<void> {
  await query(1);
  await query(28);
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
