import { readConnectionLifecycle } from './ConnectionLifecycle';

export function isNodeManagementAllowed(filesDir: string): boolean {
  return readConnectionLifecycle(filesDir).managementAllowed;
}

export function assertNodeManagementAllowed(filesDir: string): void {
  if (!isNodeManagementAllowed(filesDir)) { throw new Error('请先断开连接并等待清理完成，再修改节点。'); }
}
