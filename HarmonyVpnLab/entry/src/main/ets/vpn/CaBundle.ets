import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';

// Install the packaged CA snapshot in this application's sandbox. The caller
// sets SSL_CERT_FILE before the first libxray load in the VPN extension process.
export async function prepareCaBundle(context: common.Context): Promise<string> {
  const bytes: Uint8Array = await context.resourceManager.getRawFileContent('mozilla-ca.pem');
  if (bytes.byteLength === 0) {
    throw new Error('Bundled CA store is empty');
  }
  const path = `${context.filesDir}/mozilla-ca.pem`;
  const temporaryPath = `${path}.${Date.now()}-${Math.floor(Math.random() * 1000000000)}.tmp`;
  let file: fs.File | undefined = undefined;
  try {
    file = fs.openSync(temporaryPath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    let written = 0;
    while (written < bytes.byteLength) {
      // slice makes a tightly sized buffer and supports short native writes.
      const remaining = bytes.slice(written).buffer;
      const count = fs.writeSync(file.fd, remaining, { offset: written });
      if (count <= 0 || count > remaining.byteLength) {
        throw new Error('Could not finish writing bundled CA store');
      }
      written += count;
    }
    const ownedFile = file;
    file = undefined;
    fs.closeSync(ownedFile);
    fs.renameSync(temporaryPath, path);
    return path;
  } finally {
    try {
      if (file !== undefined) {
        const ownedFile = file;
        file = undefined;
        fs.closeSync(ownedFile);
      }
    } finally {
      if (fs.accessSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    }
  }
}
