import { common } from '@kit.AbilityKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

export const MAX_NODE_BACKUP_BYTES: number = 5 * 1024 * 1024;
const CHUNK_BYTES: number = 65536;
const READ_ERROR: string = '文件无法读取、编码无效或超过 5 MiB，请选择有效的 JSON 备份。';
const WRITE_ERROR: string = '文件未完整保存，请重新选择位置保存。';

export class BackupDocumentResult {
  state: string;
  text: string;
  constructor(state: string, text: string = '') { this.state = state; this.text = text; }
}

function validSize(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_NODE_BACKUP_BYTES;
}

function encodedDocument(text: string): Uint8Array {
  if (typeof text !== 'string' || !validSize(text.length)) { throw new Error(WRITE_ERROR); }
  const bytes = new util.TextEncoder().encodeInto(text);
  if (!validSize(bytes.byteLength)) { throw new Error(WRITE_ERROR); }
  return bytes;
}

// Only caller-selected document URIs reach this function. Use the open descriptor
// for size checks; reject truncation, growth, invalid UTF-8 and partial read errors.
export function readNodeBackupDocument(uri: string): string {
  try {
    const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    try {
      const size = fs.statSync(file.fd).size;
      if (!validSize(size)) { throw new Error(READ_ERROR); }
      const bytes = new Uint8Array(size);
      let offset: number = 0;
      while (offset < size) {
        const chunk = new ArrayBuffer(Math.min(CHUNK_BYTES, size - offset));
        const count = fs.readSync(file.fd, chunk);
        if (!Number.isSafeInteger(count) || count <= 0 || count > chunk.byteLength) { throw new Error(READ_ERROR); }
        bytes.set(new Uint8Array(chunk, 0, count), offset);
        offset += count;
      }
      if (fs.readSync(file.fd, new ArrayBuffer(1)) !== 0 || fs.statSync(file.fd).size !== size) {
        throw new Error(READ_ERROR);
      }
      return util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(bytes);
    } finally { fs.closeSync(file); }
  } catch (_) { throw new Error(READ_ERROR); }
}

export function writeNodeBackupDocument(uri: string, text: string): void {
  try {
    const bytes = encodedDocument(text);
    const file = fs.openSync(uri, fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset: number = 0;
      while (offset < bytes.byteLength) {
        const chunk = bytes.slice(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
        const written = fs.writeSync(file.fd, chunk.buffer);
        if (!Number.isSafeInteger(written) || written <= 0 || written > chunk.byteLength) { throw new Error(WRITE_ERROR); }
        offset += written;
      }
      fs.fsyncSync(file.fd);
    } finally { fs.closeSync(file); }
  } catch (_) { throw new Error(WRITE_ERROR); }
}

export async function saveNodeBackupDocument(context: common.UIAbilityContext, text: string,
  singleNode: boolean, isCurrent: () => boolean): Promise<BackupDocumentResult> {
  try {
    encodedDocument(text);
    if (!isCurrent()) { return new BackupDocumentResult('stale'); }
    const options = new picker.DocumentSaveOptions();
    options.newFileNames = [singleNode ? 'harmony-vpn-node.json' : 'harmony-vpn-nodes-backup.json'];
    options.fileSuffixChoices = ['JSON|.json'];
    const uris = await new picker.DocumentViewPicker(context).save(options);
    if (!isCurrent()) { return new BackupDocumentResult('stale'); }
    if (uris.length === 0) { return new BackupDocumentResult('cancelled'); }
    if (uris.length !== 1 || typeof uris[0] !== 'string' || uris[0].length === 0) { throw new Error(WRITE_ERROR); }
    writeNodeBackupDocument(uris[0], text);
    return new BackupDocumentResult('saved');
  } catch (_) {
    if (!isCurrent()) { return new BackupDocumentResult('stale'); }
    throw new Error(WRITE_ERROR);
  }
}

export async function selectNodeBackupDocument(context: common.UIAbilityContext,
  isCurrent: () => boolean): Promise<BackupDocumentResult> {
  try {
    if (!isCurrent()) { return new BackupDocumentResult('stale'); }
    const options = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    options.fileSuffixFilters = ['JSON|.json'];
    const uris = await new picker.DocumentViewPicker(context).select(options);
    if (!isCurrent()) { return new BackupDocumentResult('stale'); }
    if (uris.length === 0) { return new BackupDocumentResult('cancelled'); }
    if (uris.length !== 1 || typeof uris[0] !== 'string' || uris[0].length === 0) { throw new Error(READ_ERROR); }
    return new BackupDocumentResult('selected', readNodeBackupDocument(uris[0]));
  } catch (_) {
    if (!isCurrent()) { return new BackupDocumentResult('stale'); }
    throw new Error(READ_ERROR);
  }
}
