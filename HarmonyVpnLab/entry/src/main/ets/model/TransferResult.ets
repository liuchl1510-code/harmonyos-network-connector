import { fileIo as fs } from '@kit.CoreFileKit';

export class TransferResult {
  runId: string;
  status: string;
  detail: string;
  bodyBytes: number;

  constructor(runId: string = '', status: string = 'pending', detail: string = '', bodyBytes: number = 0) {
    this.runId = runId;
    this.status = status;
    this.detail = detail;
    this.bodyBytes = bodyBytes;
  }
}

export function writeTransferResult(filesDir: string, result: TransferResult): void {
  const destination = `${filesDir}/transfer-result.json`;
  const temporary = `${destination}.${Date.now()}.tmp`;
  const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
  try {
    fs.writeSync(file.fd, JSON.stringify(result));
  } finally {
    fs.closeSync(file);
  }
  fs.renameSync(temporary, destination);
}

export function readTransferResult(filesDir: string): TransferResult {
  try {
    const path = `${filesDir}/transfer-result.json`;
    if (!fs.accessSync(path)) {
      return new TransferResult();
    }
    const parsed = JSON.parse(fs.readTextSync(path)) as TransferResult;
    if (typeof parsed.runId !== 'string' || typeof parsed.status !== 'string' ||
      typeof parsed.detail !== 'string' || typeof parsed.bodyBytes !== 'number') {
      throw new Error('流量验证记录格式无效');
    }
    return new TransferResult(parsed.runId, parsed.status, parsed.detail, parsed.bodyBytes);
  } catch (error) {
    return new TransferResult('', 'failed', String(error));
  }
}
