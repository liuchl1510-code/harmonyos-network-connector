import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ImportedNode } from '../model/NodeImport';
import { parseNodeBatch } from '../model/NodeBatchImport';
import { SubscriptionSource, SavedNode, readNodeCatalog, saveSubscriptionWithNodes, deleteSubscription } from '../model/NodeCatalog';
import { assertNodeManagementAllowed, isNodeManagementAllowed } from '../model/NodeEditGuard';
import { fetchSubscription, normalizeSubscriptionUrl } from '../model/SubscriptionFetch';
import { formContentWidth } from '../model/AdaptiveLayout';

@Entry
@Component
struct Subscriptions {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State sources: SubscriptionSource[] = [];
  @State nodes: SavedNode[] = [];
  @State name: string = '';
  @State address: string = '';
  @State message: string = '';
  @State busy: boolean = false;
  @State editable: boolean = false;
  @State previewReady: boolean = false;
  @State previewNames: string[] = [];
  @State deleteId: string = '';
  private epoch: number = 0;
  private pendingNodes: ImportedNode[] = [];
  private pendingId: string = '';
  private pendingName: string = '';
  private pendingUrl: string = '';

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void { this.reload(); }
  onPageShow(): void { this.reload(); }
  aboutToDisappear(): void { this.epoch++; this.busy = false; this.clearPreview(); this.address = ''; }
  private reload(): void {
    try {
      const catalog = readNodeCatalog(this.context().filesDir);
      this.sources = catalog.subscriptions; this.nodes = catalog.nodes;
      this.editable = isNodeManagementAllowed(this.context().filesDir);
    } catch (_) { this.message = '订阅列表读取失败，原数据已保留。'; this.editable = false; }
  }
  private clearPreview(): void { this.previewReady = false; this.pendingNodes = []; this.pendingUrl = ''; this.previewNames = []; }
  private count(id: string): number { return this.nodes.filter((node: SavedNode) => node.sourceId === id).length; }
  private updated(at: number): string { return at > 0 ? new Date(at).toLocaleString() : '尚未更新'; }

  private async preview(id: string = '', name: string = this.name, address: string = this.address): Promise<void> {
    if (this.busy) { return; }
    const epoch = ++this.epoch;
    this.clearPreview(); this.busy = true; this.message = '正在获取并解析订阅…';
    try {
      assertNodeManagementAllowed(this.context().filesDir);
      const normalized = normalizeSubscriptionUrl(address);
      const body = await fetchSubscription(normalized);
      if (this.epoch !== epoch) { return; }
      const result = parseNodeBatch(body);
      this.pendingNodes = result.nodes;
      this.pendingId = id; this.pendingName = name.trim() || '我的订阅'; this.pendingUrl = normalized;
      this.previewNames = result.nodes.slice(0, 8).map((node: ImportedNode) => `${node.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64)} · ${node.protocol.toUpperCase()}`);
      this.message = `解析到 ${result.nodes.length} 个可用节点，${result.duplicates} 个重复项，${result.rejected} 个不支持或无效项。` +
        (id ? ' 保存将替换此订阅的节点，手动节点和其他订阅保持不变。' : ' 保存后会加入节点列表，当前节点保持不变。');
      this.previewReady = true;
    } catch (error) {
      if (this.epoch === epoch) { this.message = error instanceof Error ? error.message : '订阅获取未完成，原节点已保留。'; }
    } finally { if (this.epoch === epoch) { this.busy = false; this.reload(); } }
  }

  private save(): void {
    if (!this.previewReady || this.busy) { return; }
    try {
      assertNodeManagementAllowed(this.context().filesDir);
      if (this.pendingId) {
        const current = readNodeCatalog(this.context().filesDir).subscriptions.find((source: SubscriptionSource) => source.id === this.pendingId);
        if (!current || current.url !== this.pendingUrl) { throw new Error('订阅已发生变化，请重新获取。'); }
      }
      const result = saveSubscriptionWithNodes(this.context().filesDir, this.pendingId, this.pendingName, this.pendingUrl, this.pendingNodes);
      this.clearPreview(); this.address = ''; this.name = ''; this.reload();
      this.message = `订阅已保存，当前列表共 ${this.nodes.length} 个节点。`;
      hilog.info(0x0000, 'HarmonyVpnLab', 'SUBSCRIPTION_SAVED added=%{public}d duplicates=%{public}d', result.added, result.duplicates);
    } catch (error) { this.message = error instanceof Error ? error.message : '保存未完成，原节点已保留。'; }
  }
  private remove(id: string): void {
    try {
      deleteSubscription(this.context().filesDir, id);
      this.deleteId = ''; this.clearPreview(); this.reload(); this.message = '订阅及其节点已删除。';
    } catch (_) { this.message = '删除未完成，请先断开连接。'; }
  }

  build() {
    Column() {
      Row({ space: 14 }) {
        Button('‹ 返回', { type: ButtonType.Normal }).id('backToNodes')
          .fontSize(16).fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface'))
          .borderRadius(12).constraintSize({ minHeight: 44 }).padding({ left: 12, right: 12 })
          .onClick(() => { this.epoch++; this.busy = false; this.clearPreview(); this.address = ''; this.getUIContext().getRouter().back(); });
        Text('订阅管理').fontSize(23).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1);
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, top: 12, bottom: 16 });
      Scroll() {
        Column({ space: 18 }) {
          Column({ space: 8 }) {
            Text('通过链接管理节点').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
            Text('粘贴 HTTPS 链接，获取预览，再确认保存。已有来源可以手动检查更新。')
              .fontSize(15).fontColor($r('app.color.text_secondary'));
          }.width('100%').alignItems(HorizontalAlign.Start).padding({ bottom: 2 });
          if (!this.editable) {
            Text('暂时无法修改订阅。连接期间请先断开；列表读取失败时请返回后重试。').id('subscriptionEditNotice')
              .fontSize(14).fontColor($r('app.color.warning')).width('100%').padding(16)
              .backgroundColor($r('app.color.surface')).borderRadius(16);
          }
          Column({ space: 14 }) {
            Text('1 · 添加 HTTPS 来源').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Text('订阅名称（选填）').fontSize(14).fontColor($r('app.color.text_secondary'));
            TextInput({ text: this.name, placeholder: '例如：我的订阅' }).id('subscriptionName')
              .constraintSize({ minHeight: 48 }).fontSize(15)
              .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(12).maxLength(64).enabled(!this.busy)
              .onChange((value: string) => { this.name = value; this.clearPreview(); });
            Text('HTTPS 订阅链接').fontSize(14).fontColor($r('app.color.text_secondary'));
            TextInput({ text: this.address, placeholder: '粘贴 https:// 开头的链接' }).id('subscriptionUrl')
              .constraintSize({ minHeight: 48 }).fontSize(15)
              .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(12)
              .type(InputType.Password).maxLength(4096).enabled(!this.busy)
              .onChange((value: string) => { this.address = value; this.clearPreview(); });
            Text('支持分享链接列表、Base64 列表或单个 Xray 出站 JSON，暂不支持 Clash YAML。')
              .fontSize(13).fontColor($r('app.color.text_secondary'));
            Button(this.busy ? '正在获取…' : '获取并预览').id('previewSubscription').width('100%')
              .constraintSize({ minHeight: 50 }).fontSize(16).fontWeight(FontWeight.Medium)
              .backgroundColor($r('app.color.accent')).fontColor(Color.White)
              .enabled(this.editable && !this.busy && this.address.trim().length > 0).onClick(() => { this.preview(); });
          }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
            .backgroundColor($r('app.color.surface')).borderRadius(20)
            .border({ width: 1, color: $r('app.color.border') });

          if (this.message || this.previewReady) {
            Column({ space: 14 }) {
              Text(this.previewReady ? '2 · 确认预览并保存' : '处理结果').fontSize(18).fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.text_primary'));
              if (this.message) {
                Text(this.message).id('subscriptionResult').fontSize(14).fontColor($r('app.color.text_primary'))
                  .width('100%').wordBreak(WordBreak.BREAK_ALL);
              }
              if (this.previewReady) {
                Text('节点预览 · 最多显示前 8 个').fontSize(13).fontColor($r('app.color.text_secondary'));
                Column({ space: 12 }) {
                  ForEach(this.previewNames, (name: string, index: number) => {
                    Text(name).fontSize(14).fontColor($r('app.color.text_primary'))
                      .width('100%').wordBreak(WordBreak.BREAK_ALL);
                  }, (name: string, index: number) => `${index}`)
                }.width('100%').alignItems(HorizontalAlign.Start).padding(14)
                  .backgroundColor($r('app.color.surface_secondary')).borderRadius(12);
                Button('保存订阅和可用节点').id('saveSubscription').width('100%').constraintSize({ minHeight: 50 })
                  .fontSize(16).fontWeight(FontWeight.Medium).backgroundColor($r('app.color.accent')).fontColor(Color.White)
                  .enabled(this.editable && !this.busy).onClick(() => { this.save(); });
                Button('取消预览').id('cancelSubscriptionPreview').width('100%').constraintSize({ minHeight: 44 })
                  .fontSize(15).fontColor($r('app.color.text_secondary')).backgroundColor($r('app.color.surface_secondary'))
                  .onClick(() => { this.clearPreview(); });
              }
            }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20)
              .border({ width: 1, color: $r('app.color.border') });
          }

          Text(`已有来源 · ${this.sources.length}`).fontSize(18).fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary')).padding({ top: 6 });
          if (this.sources.length === 0) {
            Column({ space: 8 }) {
              Text(this.message === '订阅列表读取失败，原数据已保留。' ? '暂时无法显示来源' : '还没有订阅来源')
                .fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
              Text(this.message === '订阅列表读取失败，原数据已保留。' ? '请返回后重试，原订阅数据已保留。' :
                '在上方添加 HTTPS 链接并确认保存后，来源会显示在这里。')
                .fontSize(14).fontColor($r('app.color.text_secondary'));
            }.id('subscriptionEmptyState').width('100%').padding(20).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20)
              .border({ width: 1, color: $r('app.color.border') });
          }
          ForEach(this.sources, (source: SubscriptionSource) => {
            Column({ space: 14 }) {
              Text(source.name).fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
                .width('100%').wordBreak(WordBreak.BREAK_ALL);
              Text(`${this.count(source.id)} 个节点`).fontSize(14).fontColor($r('app.color.accent'));
              Text(`最近更新：${this.updated(source.lastUpdatedAt)}`).fontSize(13).fontColor($r('app.color.text_secondary'));
              Row({ space: 10 }) {
                Button('检查更新').id(`refreshSubscription-${source.id}`).layoutWeight(1).constraintSize({ minHeight: 46 })
                  .fontSize(14).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                  .enabled(this.editable && !this.busy)
                  .onClick(() => { this.preview(source.id, source.name, source.url); });
                Button('删除订阅').id(`deleteSubscription-${source.id}`).layoutWeight(1).constraintSize({ minHeight: 46 })
                  .fontSize(14).fontColor($r('app.color.danger')).backgroundColor($r('app.color.surface_secondary'))
                  .enabled(this.editable && !this.busy).onClick(() => { this.deleteId = source.id; });
              }.width('100%');
              if (this.deleteId === source.id) {
                Column({ space: 12 }) {
                  Text('将同时删除此订阅的节点，手动导入的节点会保留。')
                    .fontSize(14).fontColor($r('app.color.text_primary'));
                  Button('确认删除').id('confirmDeleteSubscription').width('100%').constraintSize({ minHeight: 46 })
                    .fontSize(15).backgroundColor($r('app.color.danger')).fontColor(Color.White)
                    .enabled(this.editable && !this.busy).onClick(() => { this.remove(source.id); });
                  Button('取消').id('cancelDeleteSubscription').width('100%').constraintSize({ minHeight: 44 })
                    .fontSize(15).fontColor($r('app.color.text_secondary')).backgroundColor($r('app.color.surface'))
                    .onClick(() => { this.deleteId = ''; });
                }.width('100%').padding(14).alignItems(HorizontalAlign.Start)
                  .backgroundColor($r('app.color.surface_secondary')).borderRadius(14);
              }
            }.padding(20).width('100%').alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20)
              .border({ width: 1, color: $r('app.color.border') });
          }, (source: SubscriptionSource) => source.id)
          Text('更新失败或未确认预览时保留原节点。订阅地址保存在应用私有目录，不写入调试日志。')
            .fontSize(13).fontColor($r('app.color.text_secondary'));
        }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, bottom: 28 }).alignItems(HorizontalAlign.Start);
      }.width('100%').layoutWeight(1).align(Alignment.Top);
    }.width('100%').height('100%').alignItems(HorizontalAlign.Center).backgroundColor($r('app.color.page_bg'));
  }
}
