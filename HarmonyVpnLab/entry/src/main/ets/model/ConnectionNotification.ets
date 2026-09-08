import { notificationManager } from '@kit.NotificationKit';
import { common, wantAgent } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { ConnectionSnapshot } from './ConnectionSnapshot';

const NOTIFICATION_ID: number = 601;

export function formatBytes(value: number): string {
  const units: string[] = ['B', 'KB', 'MB', 'GB'];
  let amount = Math.max(0, value);
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++; }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export async function prepareConnectionNotifications(context: common.UIAbilityContext): Promise<boolean> {
  if (await notificationManager.isNotificationEnabled()) { return true; }
  const marker = `${context.filesDir}/notification-requested`;
  if (fs.accessSync(marker)) { return false; }
  const file = fs.openSync(marker, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY);
  fs.closeSync(file);
  try { await notificationManager.requestEnableNotification(context); } catch (_) { return false; }
  return notificationManager.isNotificationEnabled();
}

export async function publishConnectionNotification(snapshot: ConnectionSnapshot, runId: string, stillActive: () => boolean, phase: string = 'active'): Promise<void> {
  if (!stillActive()) { return; }
  if (!await notificationManager.isNotificationEnabled()) { return; }
  const target = await wantAgent.getWantAgent({
    wants: [{ bundleName: 'com.example.harmonyvpnlab', abilityName: 'EntryAbility' }],
    actionType: wantAgent.OperationType.START_ABILITY,
    requestCode: NOTIFICATION_ID,
    actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
  });
  if (!stillActive()) { return; }
  await notificationManager.publish({
    id: NOTIFICATION_ID,
    label: `vpn-${runId}`,
    tapDismissed: false,
    isAlertOnce: true,
    autoDeletedTime: Date.now() + 90000,
    wantAgent: target,
    content: {
      notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
      normal: {
        title: 'Harmony VPN · ' + (phase === 'waiting-network' ? '等待网络' : phase === 'active' ? '已连接' : '正在恢复连接'),
        text: snapshot ? `上行 ${formatBytes(snapshot.uplink)} · 下行 ${formatBytes(snapshot.downlink)}` : 'IPv4 代理已启动',
        additionalText: '点击返回应用，管理或断开连接'
      }
    }
  });
  if (!stillActive()) { await cancelConnectionNotification(runId); }
}

export async function cancelConnectionNotification(runId: string): Promise<void> {
  await notificationManager.cancel(NOTIFICATION_ID, `vpn-${runId}`);
}
