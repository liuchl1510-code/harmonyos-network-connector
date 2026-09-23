import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';

class RoutingAsset {
  name: string;
  bytes: number;
  sha256: string;
  constructor(name: string, bytes: number, sha256: string) {
    this.name = name; this.bytes = bytes; this.sha256 = sha256;
  }
}

// Fixed, complete category messages extracted from Loyalsoldier 202609222357.
// See rules/sources.lock.json and scripts/prepare-routing-assets.py.
const ASSETS: RoutingAsset[] = [
  new RoutingAsset('geoip.dat', 139274, 'a47866f5ea506b7b7f816c7f62e352567e4188fd276c1800dac2ab653415a43e'),
  new RoutingAsset('geosite.dat', 1994637, '269d13cde1a524973d43395c180452f1f0258be372105b28dde37c1fb8f161ae')
];

async function digest(bytes: Uint8Array): Promise<string> {
  const md = cryptoFramework.createMd('SHA256');
  await md.update({ data: bytes });
  const result = await md.digest();
  if (result.data.byteLength !== 32) { throw new Error('Routing asset digest failed'); }
  let hex = '';
  for (let index = 0; index < result.data.byteLength; index++) {
    hex += result.data[index].toString(16).padStart(2, '0');
  }
  return hex;
}

function matches(path: string, expected: Uint8Array): boolean {
  if (!fs.accessSync(path)) { return false; }
  const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
  try {
    if (fs.statSync(file.fd).size !== expected.byteLength) { return false; }
    let offset = 0;
    while (offset < expected.byteLength) {
      const buffer = new ArrayBuffer(Math.min(65536, expected.byteLength - offset));
      const count = fs.readSync(file.fd, buffer);
      if (!Number.isSafeInteger(count) || count <= 0 || count > buffer.byteLength) { return false; }
      const actual = new Uint8Array(buffer, 0, count);
      for (let index = 0; index < count; index++) {
        if (actual[index] !== expected[offset + index]) { return false; }
      }
      offset += count;
    }
    return fs.readSync(file.fd, new ArrayBuffer(1)) === 0 && fs.statSync(file.fd).size === expected.byteLength;
  } finally { fs.closeSync(file); }
}

// No downloads and no system/global settings. A bad bundled asset fails startup;
// an absent or stale sandbox copy is atomically replaced after byte verification.
export async function prepareRoutingAssets(context: common.Context): Promise<void> {
  for (const asset of ASSETS) {
    const bytes = await context.resourceManager.getRawFileContent(asset.name);
    if (bytes.byteLength !== asset.bytes || await digest(bytes) !== asset.sha256) {
      throw new Error('Bundled routing rules failed integrity verification');
    }
    const destination = `${context.filesDir}/${asset.name}`;
    if (matches(destination, bytes)) { continue; }
    const temporary = `${destination}.${util.generateRandomUUID(false)}.tmp`;
    let file: fs.File | undefined = undefined;
    try {
      file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      let written = 0;
      while (written < bytes.byteLength) {
        const part = bytes.slice(written, Math.min(bytes.byteLength, written + 65536));
        const count = fs.writeSync(file.fd, part.buffer, { offset: written });
        if (!Number.isSafeInteger(count) || count <= 0 || count > part.byteLength) {
          throw new Error('Routing asset write incomplete');
        }
        written += count;
      }
      fs.fsyncSync(file.fd);
      const owned = file; file = undefined; fs.closeSync(owned);
      if (!matches(temporary, bytes)) { throw new Error('Routing asset readback failed'); }
      fs.renameSync(temporary, destination);
      if (!matches(destination, bytes)) { throw new Error('Routing asset commit failed'); }
    } finally {
      try { if (file !== undefined) { const owned = file; file = undefined; fs.closeSync(owned); } }
      finally { if (fs.accessSync(temporary)) { fs.unlinkSync(temporary); } }
    }
  }
}
