import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

const MAX_BYTES: number = 512;
const SAVE_ERROR: string = '外观设置未保存，请重试。';
const APPLY_ERROR: string = '外观暂时无法切换，请重试。';

class AppearancePreference {
  schemaVersion: number = 1;
  mode: string;
  constructor(mode: string) { this.mode = mode; }
}

function validMode(mode: string): boolean {
  return typeof mode === 'string' && ['system', 'light', 'dark'].includes(mode);
}

// A missing, unreadable or malformed preference leaves the system appearance in
// charge. Reading never rewrites the original file or includes it in an error.
export function readAppearance(filesDir: string): string {
  try {
    const path = `${filesDir}/appearance.json`;
    if (!fs.accessSync(path)) { return 'system'; }
    const stat = fs.statSync(path);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_BYTES) {
      return 'system';
    }
    const text = fs.readTextSync(path, { length: MAX_BYTES + 1 });
    if (new util.TextEncoder().encodeInto(text).byteLength > MAX_BYTES) { return 'system'; }
    const value = JSON.parse(text) as AppearancePreference;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return 'system'; }
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes('schemaVersion') || !keys.includes('mode') ||
      value.schemaVersion !== 1 || !validMode(value.mode)) { return 'system'; }
    return value.mode;
  } catch (_) { return 'system'; }
}

// Call on the UI thread after the window's loadContent has completed. This API
// changes this application's configuration, never the device's color setting.
export function applyAppearance(context: common.Context, mode: string): void {
  try {
    if (!validMode(mode)) { throw new Error(APPLY_ERROR); }
    let colorMode = ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
    if (mode === 'light') { colorMode = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT; }
    if (mode === 'dark') { colorMode = ConfigurationConstant.ColorMode.COLOR_MODE_DARK; }
    context.getApplicationContext().setColorMode(colorMode);
  } catch (_) { throw new Error(APPLY_ERROR); }
}

// Only the UI writes preferences. Readers see the complete previous or next
// version; failed writes leave the destination intact and remove the temporary.
export function saveAppearance(filesDir: string, mode: string): void {
  let temporary = '';
  try {
    if (!validMode(mode)) { throw new Error(SAVE_ERROR); }
    const bytes = new util.TextEncoder().encodeInto(JSON.stringify(new AppearancePreference(mode)));
    const destination = `${filesDir}/appearance.json`;
    temporary = `${destination}.${util.generateRandomUUID()}.tmp`;
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const part = bytes.slice(offset);
        const written = fs.writeSync(file.fd, part.buffer);
        if (!Number.isSafeInteger(written) || written <= 0 || written > part.byteLength) { throw new Error(SAVE_ERROR); }
        offset += written;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, destination);
  } catch (_) { throw new Error(SAVE_ERROR); }
  finally {
    try { if (temporary.length > 0 && fs.accessSync(temporary)) { fs.unlinkSync(temporary); } }
    catch (_) { /* Best-effort cleanup of this write's private temporary file. */ }
  }
}
