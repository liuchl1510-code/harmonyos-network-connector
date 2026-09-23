import { bundleManager, common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { formContentWidth } from '../model/AdaptiveLayout';
import { VPN_CORE_AVAILABLE } from '../model/BuildCapabilities';
import { collectDiagnosticSummary, DiagnosticSummarySnapshot } from '../model/DiagnosticSummary';
import { copyDiagnosticSummary, saveDiagnosticSummary } from '../model/DiagnosticSummaryExport';

@Entry
@Component
struct DiagnosticSummary {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State previewText: string = '';
  @State previewTime: string = '';
  @State partial: boolean = false;
  @State busy: boolean = false;
  @State message: string = '';
  private epoch: number = 0;
  private alive: boolean = false;

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void { this.alive = true; this.refresh(); }
  onPageShow(): void {
    // Keep the displayed snapshot frozen, including after returning from the picker.
    // A cancelled back gesture may leave this page in the route stack. Re-enable
    // new actions without reviving the previous epoch or its pending callbacks.
    this.alive = true;
  }
  onPageHide(): void {
    // The system document picker hides this page. Only explicit back/disposal cancels.
  }
  aboutToDisappear(): void { this.cancelPending(); }
  onBackPress(): boolean { this.cancelPending(); return false; }
  private cancelPending(): void { this.alive = false; this.epoch++; this.busy = false; }
  private back(): void { this.cancelPending(); this.getUIContext().getRouter().back(); }
  private current(epoch: number): boolean { return this.alive && this.epoch === epoch; }

  private refresh(): void {
    if (!this.alive || this.busy) { return; }
    this.epoch++;
    try {
      let versionName: string = '';
      let versionCode: number = 0;
      let api: number = 0;
      try {
        const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
        const suffix = '-ui-preview';
        versionName = !VPN_CORE_AVAILABLE && info.versionName.endsWith(suffix) ?
          info.versionName.substring(0, info.versionName.length - suffix.length) : info.versionName;
        versionCode = info.versionCode;
      } catch (_) { /* The summary labels unavailable metadata explicitly. */ }
      try { api = deviceInfo.sdkApiVersion; } catch (_) { /* Keep unavailable metadata. */ }
      const snapshot: DiagnosticSummarySnapshot = collectDiagnosticSummary(this.context().filesDir,
        versionName, versionCode, api, VPN_CORE_AVAILABLE);
      this.previewText = snapshot.text;
      this.previewTime = this.timeLabel(snapshot.generatedAt);
      this.partial = snapshot.partial;
      this.message = '预览已生成。复制和保存将使用这份内容；需要最新记录时请点刷新。';
    } catch (_) {
      // A failed refresh must not leave an earlier preview looking like fresh data.
      this.previewText = ''; this.previewTime = ''; this.partial = false;
      this.message = '摘要暂时无法生成，请稍后刷新。原记录已保留。';
    }
  }

  private timeLabel(at: number): string {
    if (!Number.isSafeInteger(at) || at <= 0) { return '生成时间不可用'; }
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) { return '生成时间不可用'; }
    return '生成于 ' + date.toLocaleString();
  }

  private async copy(): Promise<void> {
    if (!this.alive || this.busy || this.previewText.length === 0) { return; }
    const epoch = ++this.epoch;
    const text = this.previewText;
    this.busy = true;
    try {
      const result = await copyDiagnosticSummary(text, (): boolean => this.current(epoch));
      if (!this.current(epoch) || result.state === 'stale') { return; }
      this.message = result.state === 'copied' ? '已复制当前预览，仅在本机剪贴板可用。' : '复制未完成，请重试。';
    } catch (_) {
      if (this.current(epoch)) { this.message = '复制未完成，请重试。'; }
    } finally { if (this.current(epoch)) { this.busy = false; } }
  }

  private async save(): Promise<void> {
    if (!this.alive || this.busy || this.previewText.length === 0) { return; }
    const epoch = ++this.epoch;
    const text = this.previewText;
    this.busy = true;
    try {
      const result = await saveDiagnosticSummary(this.context(), text, (): boolean => this.current(epoch));
      if (!this.current(epoch) || result.state === 'stale') { return; }
      switch (result.state) {
        case 'saved': this.message = 'TXT 已保存，并核对为当前预览的完整内容。'; break;
        case 'cancelled': this.message = '已取消保存，预览仍然保留。'; break;
        case 'verification-failed': this.message = '文件已写入，但保存后核对未通过。请重新选择位置保存。'; break;
        default: this.message = '保存未完成，文件可能不完整，请重新选择位置重试。'; break;
      }
    } catch (_) {
      if (this.current(epoch)) { this.message = '保存未完成，文件可能不完整，请重新选择位置重试。'; }
    } finally { if (this.current(epoch)) { this.busy = false; } }
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回', { type: ButtonType.Normal }).id('backFromDiagnosticSummary').constraintSize({ minHeight: 44 })
          .fontSize(15).fontColor($r('app.color.accent')).backgroundColor(Color.Transparent)
          .onClick(() => { this.back(); });
        Text('诊断摘要').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1);
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 12, right: 20, top: 12, bottom: 12 });
      Scroll() {
        Column({ space: 16 }) {
          Column({ space: 12 }) {
            Text('先预览，再分享').fontSize(20).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Text('汇总已保存的连接过程、失败阶段、网络变化和清理结果，不代表实时联网检测。不包含节点地址、名称、密钥、订阅链接或完整配置。')
              .fontSize(14).lineHeight('22fp').fontColor($r('app.color.text_secondary'));
            Text('摘要会包含记录时间和网络类型，请核对下方内容后再分享。')
              .fontSize(14).lineHeight('22fp').fontColor($r('app.color.text_secondary'));
            Button('刷新摘要').id('refreshDiagnosticSummary').width('100%').constraintSize({ minHeight: 48 })
              .fontSize(15).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .enabled(!this.busy).onClick(() => { this.refresh(); });
            Button('复制当前预览').id('copyDiagnosticSummary').width('100%').constraintSize({ minHeight: 48 })
              .fontSize(15).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .enabled(!this.busy && this.previewText.length > 0).onClick(() => { void this.copy(); });
            Button(this.busy ? '正在处理…' : '保存为 TXT').id('saveDiagnosticSummary').width('100%')
              .constraintSize({ minHeight: 48 }).fontSize(15).fontColor($r('app.color.on_accent')).backgroundColor($r('app.color.accent'))
              .enabled(!this.busy && this.previewText.length > 0).onClick(() => { void this.save(); });
          }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
            .backgroundColor($r('app.color.surface')).borderRadius(20);
          if (this.message) {
            Text(this.message).id('diagnosticSummaryResult').fontSize(14).lineHeight('22fp').width('100%')
              .fontColor($r('app.color.text_primary')).padding(16)
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(14);
          }
          if (this.previewText.length > 0) {
            Column({ space: 12 }) {
              Text(this.previewTime).id('diagnosticSummaryTime').fontSize(13).fontColor($r('app.color.text_secondary'));
              if (this.partial) {
                Text('部分内容不可用、超出范围或在读取期间发生变化，详情已写入摘要；这不代表已经确定故障原因。')
                  .id('diagnosticSummaryPartial').fontSize(14).lineHeight('22fp').fontColor($r('app.color.warning'));
              }
              Text(this.previewText).id('diagnosticSummaryPreview').fontSize(14).lineHeight('23fp').width('100%')
                .fontColor($r('app.color.text_primary')).wordBreak(WordBreak.BREAK_ALL);
            }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20);
          }
        }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, bottom: 28 })
          .alignItems(HorizontalAlign.Start);
      }.id('diagnosticSummaryScroll').width('100%').layoutWeight(1).align(Alignment.Top);
    }.id('diagnosticSummaryPage').width('100%').height('100%').alignItems(HorizontalAlign.Center)
      .background($r('app.color.page_bg'));
  }
}
