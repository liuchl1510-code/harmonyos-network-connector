import { fileIo as fs } from '@kit.CoreFileKit';

export class ProbeState {
  phase: string;
  detail: string;
  updatedAt: number;
  runId: string;
  kind: string;

  constructor(phase: string = 'idle', detail: string = '', runId: string = '', kind: string = 'lifecycle') {
    this.phase = phase;
    this.detail = detail;
    this.updatedAt = Date.now();
    this.runId = runId;
    this.kind = kind;
  }
}

// A rename keeps the UI from reading a partially written JSON document.
export function writeProbeState(filesDir: string, state: ProbeState): void {
  const path = `${filesDir}/vpn-probe.json`;
  const temporaryPath = `${path}.${Date.now()}-${Math.floor(Math.random() * 1000000000)}.tmp`;
  let file: fs.File | undefined = undefined;
  try {
    file = fs.openSync(temporaryPath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    fs.writeSync(file.fd, JSON.stringify(state));
    const ownedFile = file;
    file = undefined;
    fs.closeSync(ownedFile);
    fs.renameSync(temporaryPath, path);
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

export function readProbeState(filesDir: string): ProbeState {
  const path = `${filesDir}/vpn-probe.json`;
  try {
    if (!fs.accessSync(path)) {
      return new ProbeState();
    }
    const parsed = JSON.parse(fs.readTextSync(path)) as ProbeState;
    if (typeof parsed.phase !== 'string' || typeof parsed.detail !== 'string' ||
      typeof parsed.runId !== 'string' || typeof parsed.updatedAt !== 'number') {
      throw new Error('探针状态文件格式无效');
    }
    const state = new ProbeState(parsed.phase, parsed.detail, parsed.runId,
      typeof parsed.kind === 'string' ? parsed.kind : 'lifecycle');
    state.updatedAt = parsed.updatedAt;
    return state;
  } catch (error) {
    return new ProbeState('failed', `无法读取 VPN 探针状态：${String(error)}`);
  }
}
