import { common } from '@kit.AbilityKit';
import { NodeCatalog, SavedNode, readNodeCatalog, exportCatalogNode, exportNodeCatalogBackup,
  previewNodeCatalogBackup, restoreNodeCatalogBackup } from '../model/NodeCatalog';
import { assertNodeManagementAllowed, isNodeManagementAllowed } from '../model/NodeEditGuard';
import { saveNodeBackupDocument, selectNodeBackupDocument } from '../model/NodeBackup';
import { formContentWidth } from '../model/AdaptiveLayout';

interface NodeBackupRouteParams { nodeId?: string; }

@Entry
@Component
struct NodeBackup {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State nodeId: string = '';
  @State nodeName: string = '';
  @State currentCount: number = 0;
  @State currentSourceCount: number = 0;
  @State currentSelection: string = '无节点';
  @State message: string = '';
  @State busy: boolean = false;
  @State readable: boolean = false;
  @State editable: boolean = false;
  @State previewReady: boolean = false;
  @State previewCount: number = 0;
  @State previewSourceCount: number = 0;
  @State previewSelection: string = '';
  private epoch: number = 0;
  private pendingText: string = '';
  private pendingRevision: number = -1;

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void {
    const params = this.getUIContext().getRouter().getParams() as NodeBackupRouteParams | undefined;
    this.nodeId = typeof params?.nodeId === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(params.nodeId) ? params.nodeId : '';
    this.reload();
  }
  onPageShow(): void { this.reload(); }
  onPageHide(): void {
    // Hiding also includes ordinary app backgrounding, including a system file
    // picker taking focus. Explicit back/disposal cancels; visibility alone does
    // not discard a pending document operation or an unconfirmed preview.
  }
  aboutToDisappear(): void { this.cancelPending(); }
  onBackPress(): boolean { this.cancelPending(); return false; }
  private clearPreview(): void {
    this.pendingText = ''; this.pendingRevision = -1; this.previewReady = false;
    this.previewCount = 0; this.previewSourceCount = 0; this.previewSelection = '';
  }
  private cancelPending(): void { this.epoch++; this.busy = false; this.clearPreview(); }
  private back(): void { this.cancelPending(); this.getUIContext().getRouter().back(); }
  private selectedName(catalog: NodeCatalog): string {
    return catalog.nodes.find((node: SavedNode) => node.id === catalog.activeNodeId)?.name ?? '无节点';
  }
  private reload(): void {
    try {
      const catalog = readNodeCatalog(this.context().filesDir);
      this.currentCount = catalog.nodes.length; this.currentSourceCount = catalog.subscriptions.length;
      this.currentSelection = this.selectedName(catalog);
      this.nodeName = catalog.nodes.find((node: SavedNode) => node.id === this.nodeId)?.name ?? '';
      this.readable = true; this.editable = isNodeManagementAllowed(this.context().filesDir);
    } catch (_) {
      this.readable = false; this.editable = false;
      this.message = '节点库暂时无法读取，原数据已保留。';
    }
  }
  private async save(singleNode: boolean): Promise<void> {
    if (this.busy || !this.readable || (singleNode && (!this.nodeId || !this.nodeName))) { return; }
    const epoch = ++this.epoch;
    this.busy = true; this.clearPreview();
    this.message = '文件包含连接凭据，请选择可信位置并妥善保存。';
    try {
      const filesDir = this.context().filesDir;
      const text = singleNode ? exportCatalogNode(filesDir, this.nodeId) : exportNodeCatalogBackup(filesDir);
      const result = await saveNodeBackupDocument(this.context(), text, singleNode, (): boolean => this.epoch === epoch);
      if (this.epoch !== epoch || result.state === 'stale') { return; }
      this.message = result.state === 'cancelled' ? '已取消保存。' : '文件已保存，其中包含连接凭据，请妥善保存。';
    } catch (_) {
      if (this.epoch === epoch) { this.message = '导出未完成，文件可能未完整保存，请重新选择位置重试。'; }
    } finally { if (this.epoch === epoch) { this.busy = false; this.reload(); } }
  }
  private async preview(): Promise<void> {
    if (this.busy) { return; }
    const epoch = ++this.epoch;
    this.clearPreview(); this.busy = true; this.message = '请选择节点库 JSON 备份。';
    try {
      assertNodeManagementAllowed(this.context().filesDir);
      const result = await selectNodeBackupDocument(this.context(), (): boolean => this.epoch === epoch);
      if (this.epoch !== epoch || result.state === 'stale') { return; }
      if (result.state === 'cancelled') { this.message = '已取消选择，原节点已保留。'; return; }
      assertNodeManagementAllowed(this.context().filesDir);
      const catalog = previewNodeCatalogBackup(result.text);
      const current = readNodeCatalog(this.context().filesDir);
      this.pendingText = result.text; this.pendingRevision = current.revision;
      this.previewCount = catalog.nodes.length; this.previewSourceCount = catalog.subscriptions.length;
      this.previewSelection = this.selectedName(catalog); this.previewReady = true;
      this.message = '请核对预览。确认恢复后，整个节点库及当前选择将替换为备份内容。';
    } catch (_) {
      if (this.epoch === epoch) {
        this.clearPreview();
        this.message = '备份无法预览。请先断开连接，再选择有效且不超过 5 MiB 的节点库 JSON 备份。';
      }
    } finally { if (this.epoch === epoch) { this.busy = false; this.reload(); } }
  }
  private restore(): void {
    if (!this.previewReady || this.busy || this.pendingRevision < 0) { return; }
    try {
      assertNodeManagementAllowed(this.context().filesDir);
      restoreNodeCatalogBackup(this.context().filesDir, this.pendingText, this.pendingRevision);
      this.clearPreview(); this.reload();
      this.message = this.readable ? '节点库已恢复，连接前请核对当前节点。' : '恢复已提交，但列表读取未确认，请返回核对。';
    } catch (_) {
      this.clearPreview(); this.reload();
      this.message = '恢复未完成，原节点已保留。请先断开连接；节点库有变化时需要重新选择文件并预览。';
    }
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回', { type: ButtonType.Normal }).id('backFromNodeBackup').constraintSize({ minHeight: 44 })
          .fontSize(15).fontColor($r('app.color.accent')).backgroundColor(Color.Transparent)
          .onClick(() => { this.back(); });
        Text('导出与恢复').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1);
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 12, right: 20, top: 12, bottom: 12 });
      Scroll() {
        Column({ space: 16 }) {
          Text(`当前节点库 · ${this.currentCount} 个节点 · ${this.currentSourceCount} 个订阅`)
            .id('backupCurrentCount').fontSize(14).fontColor($r('app.color.text_secondary')).width('100%');
          Text(`当前选择：${this.currentSelection}`).id('backupCurrentSelection').fontSize(14)
            .fontColor($r('app.color.text_primary')).width('100%').wordBreak(WordBreak.BREAK_ALL);
          this.exportCard();
          this.restoreCard();
          if (this.message) {
            Text(this.message).id('nodeBackupResult').fontSize(14).lineHeight('21fp')
              .fontColor($r('app.color.text_primary')).width('100%').padding(16)
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(14);
          }
        }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, bottom: 28 }).alignItems(HorizontalAlign.Start);
      }.width('100%').layoutWeight(1).align(Alignment.Top);
    }.width('100%').height('100%').alignItems(HorizontalAlign.Center).backgroundColor($r('app.color.page_bg'));
  }

  @Builder
  private exportCard() {
    Column({ space: 14 }) {
      Text('保存到文件').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
      Text('导出文件包含连接凭据和订阅地址，请妥善保存，仅与可信的人分享。')
        .fontSize(14).fontColor($r('app.color.warning')).lineHeight('21fp');
      if (this.nodeId) {
        Text(this.nodeName ? `单节点：${this.nodeName}` : '该节点已不存在，请返回节点列表。')
          .id('backupSingleNodeName').fontSize(14).fontColor($r('app.color.text_secondary')).wordBreak(WordBreak.BREAK_ALL);
        Button('导出此节点 JSON').id('exportSingleNode').width('100%').constraintSize({ minHeight: 48 })
          .fontSize(15).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
          .enabled(this.readable && !this.busy && this.nodeName.length > 0).onClick(() => { this.save(true); });
        Text('单节点 JSON 可在“添加节点”中重新导入。').fontSize(13).fontColor($r('app.color.text_secondary'));
      }
      Button('备份整个节点库').id('exportNodeCatalog').width('100%').constraintSize({ minHeight: 48 })
        .fontSize(15).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
        .enabled(this.readable && !this.busy).onClick(() => { this.save(false); });
      Text('包括所有节点、收藏、订阅来源和当前选择。').fontSize(13).fontColor($r('app.color.text_secondary'));
    }.width('100%').padding(20).alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface'))
      .border({ width: 1, color: $r('app.color.border') }).borderRadius(20);
  }

  @Builder
  private restoreCard() {
    Column({ space: 14 }) {
      Text('从备份恢复').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
      Text('选择本应用导出的节点库备份，核对预览后再确认恢复。文件大小最多 5 MiB。')
        .fontSize(14).fontColor($r('app.color.text_secondary')).lineHeight('21fp');
      if (!this.editable) {
        Text('连接期间请先断开。节点库暂时无法读取时，请返回后重试。').id('backupRestoreNotice')
          .fontSize(14).fontColor($r('app.color.warning'));
      }
      Button(this.busy ? '正在处理…' : '选择文件并预览').id('previewNodeBackup').width('100%').constraintSize({ minHeight: 48 })
        .fontSize(15).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
        .enabled(this.editable && !this.busy).onClick(() => { this.preview(); });
      if (this.previewReady) {
        Column({ space: 12 }) {
          Text(`备份中有 ${this.previewCount} 个节点、${this.previewSourceCount} 个订阅`).id('nodeBackupPreviewCount')
            .fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
          Text(`恢复后的当前选择：${this.previewSelection}`).id('nodeBackupPreviewSelection')
            .fontSize(14).fontColor($r('app.color.text_primary')).wordBreak(WordBreak.BREAK_ALL);
          Text('这将替换整个现有节点库。尚未备份的现有内容将被覆盖。')
            .fontSize(14).fontColor($r('app.color.warning'));
          Button('确认替换并恢复').id('confirmNodeBackupRestore').width('100%').constraintSize({ minHeight: 48 })
            .fontSize(15).fontColor(Color.White).backgroundColor($r('app.color.danger'))
            .enabled(this.editable && !this.busy).onClick(() => { this.restore(); });
          Button('取消预览').id('cancelNodeBackupPreview').width('100%').constraintSize({ minHeight: 44 })
            .fontSize(15).fontColor($r('app.color.text_secondary')).backgroundColor($r('app.color.surface'))
            .onClick(() => { this.clearPreview(); this.message = '已取消预览，原节点已保留。'; });
        }.width('100%').padding(14).alignItems(HorizontalAlign.Start)
          .backgroundColor($r('app.color.surface_secondary')).borderRadius(14);
      }
    }.width('100%').padding(20).alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface'))
      .border({ width: 1, color: $r('app.color.border') }).borderRadius(20);
  }
}
