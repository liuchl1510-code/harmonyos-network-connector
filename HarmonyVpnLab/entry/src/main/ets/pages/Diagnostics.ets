import { common } from '@kit.AbilityKit';
import { DiagnosticEvent, readDiagnosticEvents } from '../model/DiagnosticJournal';

@Entry
@Component
struct Diagnostics {
  @State events: DiagnosticEvent[] = [];
  @State message: string = '';

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  onPageShow(): void { this.reload(); }

  private reload(): void {
    try {
      this.events = readDiagnosticEvents(this.context().filesDir).slice().reverse();
      this.message = this.events.length === 0 ? '暂无诊断记录。' : '';
    } catch (_) {
      this.events = [];
      this.message = '诊断记录暂时无法读取，请稍后刷新。';
    }
  }

  private timeLabel(at: number): string {
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) { return '时间不可用'; }
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-` +
      `${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:` +
      `${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
  }

  private categoryLabel(code: string): string {
    switch (code) {
      case 'session-start': return '开始连接';
      case 'network-change': return '网络变化';
      case 'recovery-start': return '开始恢复连接';
      case 'recovery-ok': return '连接恢复成功';
      case 'recovery-failed': return '连接恢复失败';
      case 'waiting-network': return '等待网络恢复';
      case 'protect-stale-before': return '已拒绝过期连接请求';
      case 'protect-stale-after': return '已丢弃过期连接结果';
      case 'protect-api-failed': return '连接保护失败';
      case 'stop-requested': return '收到断开请求';
      case 'session-stopped': return '连接已停止';
      case 'latency-start': return '开始延迟检测';
      case 'latency-ok': return '延迟检测成功';
      case 'latency-failed': return '延迟检测未通过';
      default: return '其他诊断事件';
    }
  }

  private networkLabel(kind: string): string {
    switch (kind) {
      case 'wifi': return 'Wi-Fi';
      case 'cellular': return '移动数据';
      case 'ethernet': return '有线网络';
      case 'other': return '其他网络';
      case 'unavailable': return '暂无可用网络';
      default: return '未记录';
    }
  }

  private countLabel(event: DiagnosticEvent): string {
    switch (event.code) {
      case 'network-change': return `本次连接网络版本：${event.value}`;
      case 'recovery-ok': return `本次连接累计恢复：${event.value} 次`;
      case 'protect-stale-before': return `本次连接累计拒绝：${event.value} 次`;
      case 'protect-stale-after': return `本次连接累计丢弃：${event.value} 次`;
      case 'protect-api-failed': return `本次连接累计保护失败：${event.value} 次`;
      case 'session-stopped': return event.value === 1 ? '资源清理已确认' : '资源清理尚未确认';
      case 'latency-ok': return `HTTPS 耗时：${event.value} ms`;
      default: return '';
    }
  }

  build() {
    Column() {
      Row({ space: 14 }) {
        Button('‹ 返回', { type: ButtonType.Normal }).id('backFromDiagnosticJournal')
          .fontSize(16).fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface'))
          .borderRadius(12).constraintSize({ minHeight: 44 }).padding({ left: 12, right: 12 })
          .onClick(() => { this.getUIContext().getRouter().back(); });
        Text('连接诊断').fontSize(23).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1);
      }.width('100%').padding({ left: 20, right: 20, top: 12, bottom: 16 });
      Scroll() {
        Column({ space: 16 }) {
          Column({ space: 14 }) {
            Text('查看连接过程').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
            Text(`最近 ${this.events.length} 条事件，最新记录在前`).id('diagnosticEventCount')
              .fontSize(15).fontColor($r('app.color.text_secondary'));
            Text('这里仅展示事件、时间、网络类型及相关计数。')
              .fontSize(14).fontColor($r('app.color.text_secondary'));
            Button('刷新记录').id('refreshDiagnosticJournal').width('100%').constraintSize({ minHeight: 48 })
              .fontSize(16).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .onClick(() => { this.reload(); });
          }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
            .backgroundColor($r('app.color.surface')).borderRadius(20)
            .border({ width: 1, color: $r('app.color.border') });

          if (this.events.length === 0) {
            Column({ space: 10 }) {
              Text('还没有可展示的事件').fontSize(18).fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.text_primary'));
              if (this.message.length > 0) {
                Text(this.message).id('diagnosticJournalMessage').fontSize(14).fontColor($r('app.color.text_secondary'));
              }
              Text('连接、断开或检测延迟后，可点击“刷新记录”查看。')
                .fontSize(14).fontColor($r('app.color.text_secondary'));
            }.id('diagnosticEmptyState').width('100%').padding(24).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20)
              .border({ width: 1, color: $r('app.color.border') });
          }
          ForEach(this.events, (event: DiagnosticEvent) => {
            Column({ space: 10 }) {
              Text(this.timeLabel(event.at)).fontSize(12).fontColor($r('app.color.text_secondary'));
              Text(this.categoryLabel(event.code)).fontSize(17).fontWeight(FontWeight.Medium)
                .fontColor(event.code === 'recovery-failed' || event.code === 'protect-api-failed' || event.code === 'latency-failed' ?
                  $r('app.color.danger') : $r('app.color.text_primary')).width('100%');
              Column({ space: 6 }) {
                Text(`网络：${this.networkLabel(event.kind)}`).fontSize(13).fontColor($r('app.color.text_secondary'));
                if (this.countLabel(event).length > 0) {
                  Text(this.countLabel(event)).fontSize(13).fontColor($r('app.color.text_primary'));
                }
              }.width('100%').padding(12).alignItems(HorizontalAlign.Start)
                .backgroundColor($r('app.color.surface_secondary')).borderRadius(12);
            }.padding(18).width('100%').alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(18)
              .border({ width: 1, color: $r('app.color.border') });
          }, (event: DiagnosticEvent, index: number) => `${event.at}-${index}`)
        }.width('100%').padding({ left: 20, right: 20, bottom: 28 }).alignItems(HorizontalAlign.Start);
      }.width('100%').layoutWeight(1).align(Alignment.Top);
    }.width('100%').height('100%').backgroundColor($r('app.color.page_bg'));
  }
}
