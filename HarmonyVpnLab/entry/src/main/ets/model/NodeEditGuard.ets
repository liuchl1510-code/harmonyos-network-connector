import native from 'libvpnbridge.so';
import { readProbeState } from './ProbeState';
import { readConnectionStatus } from './ConnectionControl';

export function isNodeManagementAllowed(filesDir: string): boolean {
  const state = readProbeState(filesDir);
  const status = readConnectionStatus(filesDir);
  if (status?.runId === state.runId) {
    if (status.phase === 'destroyed' && status.cleanupConfirmed) { return true; }
    if (Number.isInteger(status.servicePid) && status.servicePid > 0) {
      try { if (!native.processAlive(status.servicePid)) { return true; } } catch (_) {}
    }
    if (['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'destroying'].includes(status.phase)) { return false; }
  }
  return !['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'stop_requested'].includes(state.phase);
}

export function assertNodeManagementAllowed(filesDir: string): void {
  if (!isNodeManagementAllowed(filesDir)) { throw new Error('请先断开连接并等待清理完成，再修改节点。'); }
}
