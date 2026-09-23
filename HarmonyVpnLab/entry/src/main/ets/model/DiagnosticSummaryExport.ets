import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { writeNodeBackupDocument } from './NodeBackup';

export const MAX_DIAGNOSTIC_SUMMARY_BYTES: number = 256 * 1024;
const READ_CHUNK_BYTES: number = 65536;

export class DiagnosticSummaryTransferResult {
  state: string;
  constructor(state: string) { this.state = state; }
}

function summaryBytes(text: string): Uint8Array {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_DIAGNOSTIC_SUMMARY_BYTES) {
    throw new Error('摘要内容不可用。');
  }
  const bytes = new util.TextEncoder().encodeInto(text);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DIAGNOSTIC_SUMMARY_BYTES) {
    throw new Error('摘要内容不可用。');
  }
  return bytes;
}

// Read only the URI just chosen by the user. Compare UTF-8 bytes, including EOF,
// rather than decoder-normalized text; do not report success after a short write.
function verifySavedDocument(uri: string, expected: Uint8Array): boolean {
  const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
  try {
    if (fs.statSync(file.fd).size !== expected.byteLength) { return false; }
    let offset: number = 0;
    while (offset < expected.byteLength) {
      const buffer = new ArrayBuffer(Math.min(READ_CHUNK_BYTES, expected.byteLength - offset));
      const count = fs.readSync(file.fd, buffer);
      if (!Number.isSafeInteger(count) || count <= 0 || count > buffer.byteLength) { return false; }
      const actual = new Uint8Array(buffer, 0, count);
      for (let index: number = 0; index < count; index++) {
        if (actual[index] !== expected[offset + index]) { return false; }
      }
      offset += count;
    }
    return fs.readSync(file.fd, new ArrayBuffer(1)) === 0 && fs.statSync(file.fd).size === expected.byteLength;
  } finally { fs.closeSync(file); }
}

export async function copyDiagnosticSummary(text: string,
  isCurrent: () => boolean): Promise<DiagnosticSummaryTransferResult> {
  try {
    summaryBytes(text);
    if (!isCurrent()) { return new DiagnosticSummaryTransferResult('stale'); }
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
    // This reads properties of our newly created payload, never the old clipboard.
    const property = data.getProperty();
    property.shareOption = pasteboard.ShareOption.LOCALDEVICE;
    data.setProperty(property);
    if (!isCurrent()) { return new DiagnosticSummaryTransferResult('stale'); }
    await pasteboard.getSystemPasteboard().setData(data);
    return new DiagnosticSummaryTransferResult(isCurrent() ? 'copied' : 'stale');
  } catch (_) { return new DiagnosticSummaryTransferResult(isCurrent() ? 'failed' : 'stale'); }
}

export async function saveDiagnosticSummary(context: common.UIAbilityContext, text: string,
  isCurrent: () => boolean): Promise<DiagnosticSummaryTransferResult> {
  let written: boolean = false;
  try {
    const bytes = summaryBytes(text);
    if (!isCurrent()) { return new DiagnosticSummaryTransferResult('stale'); }
    const options = new picker.DocumentSaveOptions();
    options.newFileNames = ['harmony-vpn-diagnostic-summary.txt'];
    options.fileSuffixChoices = ['TXT|.txt'];
    const uris = await new picker.DocumentViewPicker(context).save(options);
    if (!isCurrent()) { return new DiagnosticSummaryTransferResult('stale'); }
    if (uris.length === 0) { return new DiagnosticSummaryTransferResult('cancelled'); }
    if (uris.length !== 1 || typeof uris[0] !== 'string' || uris[0].length === 0) {
      return new DiagnosticSummaryTransferResult('failed');
    }
    // No async gap between the lifecycle check and the first file mutation.
    if (!isCurrent()) { return new DiagnosticSummaryTransferResult('stale'); }
    writeNodeBackupDocument(uris[0], text);
    written = true;
    const verified = verifySavedDocument(uris[0], bytes);
    return new DiagnosticSummaryTransferResult(verified ? 'saved' : 'verification-failed');
  } catch (_) {
    if (!isCurrent()) { return new DiagnosticSummaryTransferResult('stale'); }
    return new DiagnosticSummaryTransferResult(written ? 'verification-failed' : 'failed');
  }
}
