import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { NetworkPolicy, validateNetworkPolicy } from './NetworkPolicy';
import { assertNodeManagementAllowed } from './NodeEditGuard';

const MAX_BYTES: number = 32768;

export function readNetworkPolicy(filesDir: string): NetworkPolicy {
  const path = `${filesDir}/network-policy.json`;
  try {
    if (!fs.accessSync(path)) { return new NetworkPolicy(); }
    const size = fs.statSync(path).size;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) { throw new Error('size'); }
    const text = fs.readTextSync(path, { length: MAX_BYTES + 1 });
    if (new util.TextEncoder().encodeInto(text).byteLength > MAX_BYTES) { throw new Error('size'); }
    return validateNetworkPolicy(JSON.parse(text) as NetworkPolicy);
  } catch (_) { throw new Error('网络设置损坏或无法读取，请在设置页重新保存；当前连接未启动。'); }
}

export function saveNetworkPolicy(filesDir: string, value: NetworkPolicy): void {
  assertNodeManagementAllowed(filesDir);
  const policy = validateNetworkPolicy(value);
  const data = new util.TextEncoder().encodeInto(JSON.stringify(policy));
  if (data.byteLength > MAX_BYTES) { throw new Error('网络设置超过 32 KiB，未保存。'); }
  const destination = `${filesDir}/network-policy.json`;
  const temporary = `${destination}.${util.generateRandomUUID()}.tmp`;
  try {
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < data.byteLength) {
        const part = data.slice(offset);
        const written = fs.writeSync(file.fd, part.buffer);
        if (!Number.isSafeInteger(written) || written < 1 || written > part.byteLength) { throw new Error('write'); }
        offset += written;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, destination);
  } catch (_) { throw new Error('网络设置未保存，原设置已保留。'); }
  finally { try { if (fs.accessSync(temporary)) { fs.unlinkSync(temporary); } } catch (_) {} }
}
