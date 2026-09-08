import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { ConnectionSnapshot } from './ConnectionSnapshot';

export const CONNECTION_UI_EPOCH: string = util.generateRandomUUID();

export function isConnectionKind(kind: string): boolean {
  return kind === 'connection' || kind === 'connection-test' || kind === 'connection-app-test' || kind === 'node-latency';
}

function writeAtomic(filesDir: string, name: string, text: string): void {
  const path = `${filesDir}/${name}`;
  const temporary = `${path}.${util.generateRandomUUID()}.tmp`;
  const bytes = new util.TextEncoder().encodeInto(text);
  try {
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const part = bytes.slice(offset);
        const written = fs.writeSync(file.fd, part.buffer);
        if (written <= 0) { throw new Error('无法保存连接状态'); }
        offset += written;
      }
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, path);
  }
  finally { if (fs.accessSync(temporary)) { fs.unlinkSync(temporary); } }
}

export class ConnectionCommand {
  runId: string;
  action: string;
  createdAt: number;
  ownerEpoch: string;
  constructor(runId: string, action: string, ownerEpoch: string = CONNECTION_UI_EPOCH) {
    this.runId = runId;
    this.action = action;
    this.createdAt = Date.now();
    this.ownerEpoch = ownerEpoch;
  }
}

// UI owns this file. Service heartbeats never overwrite the stop command.
export function writeConnectionCommand(filesDir: string, command: ConnectionCommand): void {
  writeAtomic(filesDir, 'connection-command.json', JSON.stringify(command));
}

export function readConnectionCommand(filesDir: string): ConnectionCommand | undefined {
  try {
    const value = JSON.parse(fs.readTextSync(`${filesDir}/connection-command.json`)) as ConnectionCommand;
    if (typeof value.runId !== 'string' || !['start', 'stop', 'reconnect'].includes(value.action) ||
      typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) { return undefined; }
    return value;
  } catch (_) { return undefined; }
}

export class ConnectionStatus {
  runId: string;
  phase: string;
  updatedAt: number;
  snapshot?: ConnectionSnapshot;
  cleanupConfirmed: boolean;
  servicePid: number;
  networkKind: string;
  reconnectCount: number;
  constructor(runId: string, phase: string, snapshot?: ConnectionSnapshot, cleanupConfirmed: boolean = false, servicePid: number = 0,
    networkKind: string = '', reconnectCount: number = 0) {
    this.runId = runId;
    this.phase = phase;
    this.updatedAt = Date.now();
    this.snapshot = snapshot;
    this.cleanupConfirmed = cleanupConfirmed;
    this.servicePid = servicePid;
    this.networkKind = networkKind;
    this.reconnectCount = reconnectCount;
  }
}

// Service owns this file, including the onDestroy acknowledgement.
export function writeConnectionStatus(filesDir: string, status: ConnectionStatus): void {
  writeAtomic(filesDir, 'connection-status.json', JSON.stringify(status));
}

export function readConnectionStatus(filesDir: string): ConnectionStatus | undefined {
  try {
    const value = JSON.parse(fs.readTextSync(`${filesDir}/connection-status.json`)) as ConnectionStatus;
    if (typeof value.runId !== 'string' || typeof value.phase !== 'string' ||
      typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) { return undefined; }
    if (value.networkKind !== undefined && !['', 'wifi', 'cellular', 'ethernet', 'other'].includes(value.networkKind)) { return undefined; }
    if (value.reconnectCount !== undefined && (!Number.isSafeInteger(value.reconnectCount) || value.reconnectCount < 0)) { return undefined; }
    if (value.snapshot && (typeof value.snapshot.uplink !== 'number' || !Number.isFinite(value.snapshot.uplink) ||
      typeof value.snapshot.downlink !== 'number' || !Number.isFinite(value.snapshot.downlink) ||
      typeof value.snapshot.startedAt !== 'number' || !Number.isFinite(value.snapshot.startedAt))) { return undefined; }
    return value;
  } catch (_) { return undefined; }
}
