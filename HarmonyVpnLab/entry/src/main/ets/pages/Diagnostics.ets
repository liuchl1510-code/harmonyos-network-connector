import { common } from '@kit.AbilityKit';
import { DiagnosticEvent, inspectDiagnosticEvents } from '../model/DiagnosticJournal';
import { inspectConnectionRecoveries } from '../model/ConnectionRecoveryStore';
import { readConnectionLifecycle } from '../model/ConnectionLifecycle';
import { formContentWidth } from '../model/AdaptiveLayout';
import { ConnectionFailure, failureFromDiagnosticEvent, failureStageLabel, failureProblem, failureSuggestion } from '../model/ConnectionFailure';
import { FailureNotice } from '../components/FailureNotice';

@Entry
@Component
struct Diagnostics {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State events: DiagnosticEvent[] = [];
  @State message: string = '';
  @State connectionLabel: string = '状态待刷新';
  @State connectionHint: string = '';
  @State serviceFailure: ConnectionFailure | undefined = undefined;
  @State cleanupFailure: ConnectionFailure | undefined = undefined;
  @State currentIssue: ConnectionFailure | undefined = undefined;
  @State recordsUnavailable: boolean = false;
  @State openingSummary: boolean = false;

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  onPageShow(): void { this.reload(); }

  private reload(): void {
    const filesDir = this.context().filesDir;
    const events: DiagnosticEvent[] = [];
    const messages: string[] = [];
    this.recordsUnavailable = false;
    try {
      const journal = inspectDiagnosticEvents(filesDir);
      for (const event of journal.events) { events.push(event); }
      if (journal.status === 'invalid') {
        this.recordsUnavailable = true; messages.push('服务诊断记录格式异常，原记录已保留。');
      } else if (journal.status === 'unreadable') {
        this.recordsUnavailable = true; messages.push('服务诊断记录暂时无法读取，请稍后刷新。');
      }
    } catch (_) { this.recordsUnavailable = true; messages.push('服务诊断记录暂时无法读取，请稍后刷新。'); }
    try {
      const recovery = inspectConnectionRecoveries(filesDir);
      for (const observation of recovery.observations) {
        events.push(new DiagnosticEvent(observation.at, observation.runId, 'service-exit-observed', '', 0));
      }
      if (recovery.status === 'invalid') {
        this.recordsUnavailable = true; messages.push('恢复观察记录格式异常，原记录已保留。');
      } else if (recovery.status === 'unreadable') {
        this.recordsUnavailable = true; messages.push('恢复观察记录暂时无法读取，原记录已保留。');
      }
    } catch (_) { this.recordsUnavailable = true; messages.push('恢复观察记录暂时无法读取，原记录已保留。'); }
    this.events = events.sort((left: DiagnosticEvent, right: DiagnosticEvent) => right.at - left.at);
    this.message = messages.join(' ');
    try {
      const assessment = readConnectionLifecycle(filesDir);
      const status = assessment.status?.runId === assessment.state.runId ? assessment.status : undefined;
      this.serviceFailure = status?.failure; this.cleanupFailure = status?.cleanupFailure;
      this.currentIssue = assessment.closed ? undefined : status?.currentIssue;
      const diagnostic = !['connection', 'connection-test', 'connection-app-test'].includes(assessment.state.kind);
      this.connectionLabel = diagnostic && !assessment.closed &&
        ['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'stop_requested'].includes(assessment.phase) ?
        '正在验证' : this.phaseLabel(assessment.phase);
      this.connectionHint = assessment.cleanupConfirmed ? '已收到服务的清理完成回执。' :
        assessment.serviceExited ? '记录的服务进程已结束，尚未收到清理完成回执。' :
        assessment.phase === 'unknown' ? '当前服务状态尚未确认，可返回首页恢复清理。' :
        assessment.closed ? '当前没有进行中的连接。' : '点击刷新可同步当前状态和记录。';
    } catch (_) {
      this.connectionLabel = '状态暂不可用'; this.connectionHint = '请稍后刷新，或返回首页查看。';
      this.serviceFailure = undefined; this.cleanupFailure = undefined; this.currentIssue = undefined;
    }
  }

  private async openSummary(): Promise<void> {
    if (this.openingSummary) { return; }
    this.openingSummary = true;
    try { await this.getUIContext().getRouter().pushUrl({ url: 'pages/DiagnosticSummary' }); }
    catch (_) { this.message = '诊断摘要暂时无法打开，请重试。'; }
    finally { this.openingSummary = false; }
  }

  private phaseLabel(phase: string): string {
    switch (phase) {
      case 'active': return '已连接';
      case 'starting': return '正在连接';
      case 'recovering': return '正在恢复连接';
      case 'waiting-network': return '等待网络';
      case 'stopping': case 'stop_requested': case 'destroying': return '正在断开';
      case 'interrupted': return '连接已结束';
      case 'failed': return '连接中断';
      case 'unknown': return '连接状态未知';
      case 'diagnostic': return '正在验证';
      default: return '未连接';
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
    const failure = failureFromDiagnosticEvent(code, 0, 0);
    if (failure) { return '未完成：' + failureStageLabel(failure.stage); }
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
      case 'service-exit-observed': return '观察到服务已结束';
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
    const failure = failureFromDiagnosticEvent(event.code, event.value, event.at);
    if (failure) { return failureProblem(failure); }
    switch (event.code) {
      case 'network-change': return `本次连接网络版本：${event.value}`;
      case 'recovery-ok': return `本次连接累计恢复：${event.value} 次`;
      case 'protect-stale-before': return `本次连接累计拒绝：${event.value} 次`;
      case 'protect-stale-after': return `本次连接累计丢弃：${event.value} 次`;
      case 'protect-api-failed': return `本次连接累计保护失败：${event.value} 次`;
      case 'session-stopped': return event.value === 1 ? '资源清理已确认' : '资源清理尚未确认';
      case 'service-exit-observed': return '检测时未收到清理完成回执；此记录不说明服务退出的具体原因。';
      case 'latency-ok': return `HTTPS 耗时：${event.value} ms`;
      default: return '';
    }
  }

  private eventSuggestion(event: DiagnosticEvent): string {
    const failure = failureFromDiagnosticEvent(event.code, event.value, event.at);
    return failure ? failureSuggestion(failure) : '';
  }

  build() {
    Column() {
      Row({ space: 14 }) {
        Button('‹ 返回', { type: ButtonType.Normal }).id('backFromDiagnosticJournal')
          .fontSize(16).fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface'))
          .borderRadius(12).constraintSize({ minHeight: 44 }).padding({ left: 12, right: 12 })
          .onClick(() => { this.getUIContext().getRouter().back(); });
        Text('连接诊断').fontSize(23).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1);
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, top: 12, bottom: 16 });
      Scroll() {
        Column({ space: 16 }) {
          Column({ space: 14 }) {
            Text('查看连接过程').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
            Text(`最近 ${this.events.length} 条事件，最新记录在前`).id('diagnosticEventCount')
              .fontSize(15).fontColor($r('app.color.text_secondary'));
            Text('这里仅展示事件、时间、网络类型及相关计数。')
              .fontSize(14).fontColor($r('app.color.text_secondary'));
            Column({ space: 8 }) {
              Text(this.connectionLabel).id('diagnosticConnectionState').fontSize(17).fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.text_primary')).width('100%');
              Text(this.connectionHint).id('diagnosticConnectionHint').fontSize(13)
                .fontColor($r('app.color.text_secondary')).width('100%');
            }.width('100%').padding(14).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(12);
            Button('刷新记录').id('refreshDiagnosticJournal').width('100%').constraintSize({ minHeight: 48 })
              .fontSize(16).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .onClick(() => { this.reload(); });
            Button('预览诊断摘要').id('openDiagnosticSummary').width('100%').constraintSize({ minHeight: 48 })
              .fontSize(16).fontColor($r('app.color.on_accent')).backgroundColor($r('app.color.accent'))
              .enabled(!this.openingSummary).onClick(() => { void this.openSummary(); });
            Text('整理可分享的记录，先预览再复制或保存。').fontSize(13).lineHeight('21fp')
              .fontColor($r('app.color.text_secondary')).width('100%');
          }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
            .backgroundColor($r('app.color.surface')).borderRadius(20)
            .border({ width: 1, color: $r('app.color.border') });

          if (this.message.length > 0) {
            Text(this.message).id('diagnosticJournalMessage').fontSize(14).width('100%')
              .fontColor($r('app.color.warning'));
          }
          if (this.serviceFailure) {
            FailureNotice({ title: '最近会话的失败阶段', stage: this.serviceFailure.stage,
              reason: this.serviceFailure.reason, idPrefix: 'diagnosticServiceFailure' });
          } else if (this.currentIssue) {
            FailureNotice({ title: '当前步骤尚未完成', stage: this.currentIssue.stage,
              reason: this.currentIssue.reason, idPrefix: 'diagnosticCurrentIssue' });
          }
          if (this.cleanupFailure) {
            FailureNotice({ title: '清理阶段的独立问题', stage: this.cleanupFailure.stage,
              reason: this.cleanupFailure.reason, idPrefix: 'diagnosticCleanupFailure' });
          }
          if (this.events.length === 0) {
            Column({ space: 10 }) {
              Text(this.recordsUnavailable ? '记录暂不可用' : '暂无可展示的记录').fontSize(18).fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.text_primary'));
              Text(this.recordsUnavailable ? '无法完整读取记录，请刷新后重试；这不表示连接没有发生问题。' :
                '连接、断开或检测延迟后，可点击“刷新记录”查看。记录为空不代表连接一定正常。')
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
                Text(event.code === 'service-exit-observed' ? '来源：应用状态检查' : `网络：${this.networkLabel(event.kind)}`)
                  .fontSize(13).fontColor($r('app.color.text_secondary'));
                if (this.countLabel(event).length > 0) {
                  Text(this.countLabel(event)).fontSize(13).fontColor($r('app.color.text_primary'));
                }
                if (this.eventSuggestion(event).length > 0) {
                  Text('建议：' + this.eventSuggestion(event)).fontSize(13).fontColor($r('app.color.text_secondary'));
                }
              }.width('100%').padding(12).alignItems(HorizontalAlign.Start)
                .backgroundColor($r('app.color.surface_secondary')).borderRadius(12);
            }.padding(18).width('100%').alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(18)
              .border({ width: 1, color: $r('app.color.border') });
          }, (event: DiagnosticEvent, index: number) => `${event.at}-${index}`)
        }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, bottom: 28 })
          .alignItems(HorizontalAlign.Start);
      }.width('100%').layoutWeight(1).align(Alignment.Top);
    }.width('100%').height('100%').alignItems(HorizontalAlign.Center).background($r('app.color.page_bg'));
  }
}
