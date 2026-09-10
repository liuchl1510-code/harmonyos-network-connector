import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
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
  @State readable: boolean = false;
  @State confirmingLeave: boolean = false;
  @State leaving: boolean = false;
  @State previewReady: boolean = false;
  @State previewNames: string[] = [];
  @State deleteId: string = '';
  private epoch: number = 0;
  private pendingNodes: ImportedNode[] = [];
  private pendingId: string = '';
  private pendingName: string = '';
  private pendingUrl: string = '';
  private pendingUpdatedAt: number = -1;
  private pageEpoch: number = 0;
  private leaveRequest: number = 0;
  private pageVisible: boolean = true;

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void {
    this.pageEpoch++; this.pageVisible = true; this.confirmingLeave = false; this.leaving = false; this.reload();
  }
  onPageShow(): void { this.pageVisible = true; this.reload(); }
  onPageHide(): void {
    this.pageEpoch++; this.leaveRequest++; this.pageVisible = false; this.confirmingLeave = false;
    this.cancelFetch();
  }
  aboutToDisappear(): void {
    this.pageEpoch++; this.leaveRequest++; this.pageVisible = false; this.confirmingLeave = false;
    this.clearDraft();
  }
  private reload(): boolean {
    try {
      const catalog = readNodeCatalog(this.context().filesDir);
      this.sources = catalog.subscriptions; this.nodes = catalog.nodes;
      this.editable = isNodeManagementAllowed(this.context().filesDir);
      this.readable = true;
      return true;
    } catch (_) {
      this.sources = []; this.nodes = []; this.readable = false;
      this.message = '订阅列表读取失败，原数据已保留。'; this.editable = false;
      return false;
    }
  }
  private clearPreview(): void {
    this.previewReady = false; this.pendingNodes = []; this.pendingId = ''; this.pendingName = '';
    this.pendingUrl = ''; this.pendingUpdatedAt = -1; this.previewNames = [];
  }
  private cancelFetch(): void {
    this.epoch++;
    if (this.busy) { this.message = '本次获取结果将忽略，输入已保留，可重新获取。'; }
    this.busy = false;
  }
  private clearDraft(): void {
    this.cancelFetch(); this.clearPreview(); this.name = ''; this.address = ''; this.deleteId = '';
  }
  private formLocked(): boolean { return this.confirmingLeave || this.leaving || !this.pageVisible; }
  private hasPendingWork(): boolean {
    return this.name.length > 0 || this.address.length > 0 || this.previewReady || this.busy;
  }
  private changeName(value: string): void {
    if (this.busy || this.formLocked()) { return; }
    this.name = value; this.clearPreview();
  }
  private changeAddress(value: string): void {
    if (this.busy || this.formLocked()) { return; }
    this.address = value; this.clearPreview();
  }
  private cancelPreview(): void {
    if (this.busy || this.formLocked()) { return; }
    this.clearPreview();
  }
  onBackPress(): boolean {
    if (this.formLocked()) { return true; }
    if (!this.hasPendingWork()) { return false; }
    void this.requestBack();
    return true;
  }
  private async requestBack(): Promise<void> {
    if (this.formLocked()) { return; }
    if (!this.hasPendingWork()) {
      this.leaving = true;
      try { this.getUIContext().getRouter().back(); }
      catch (_) { this.leaving = false; this.message = '暂时无法返回，请重试。'; }
      return;
    }
    const epoch = this.pageEpoch;
    const request = ++this.leaveRequest;
    this.confirmingLeave = true;
    // The HTTP adapter has no cancellation handle; invalidate its eventual
    // result while the user decides whether to discard the visible draft.
    this.cancelFetch();
    try {
      const result = await this.getUIContext().getPromptAction().showDialog({
        title: '放弃未保存的订阅内容？',
        message: '返回后，已填写的内容和未保存的预览将丢失。',
        buttons: [
          { text: '继续编辑', color: $r('app.color.accent') },
          { text: '放弃并返回', color: $r('app.color.danger') }
        ]
      });
      if (epoch !== this.pageEpoch || request !== this.leaveRequest) { return; }
      if (result.index === 1) {
        this.leaving = true;
        this.getUIContext().getRouter().back();
        this.clearDraft();
      }
    } catch (_) {
      if (epoch === this.pageEpoch && request === this.leaveRequest) {
        this.leaving = false;
        this.message = '返回确认未完成，输入和预览已保留，请继续编辑或重试。';
      }
    } finally {
      if (epoch === this.pageEpoch && request === this.leaveRequest) { this.confirmingLeave = false; }
    }
  }
  private safeMessage(error: Object, fallback: string): string {
    const allowed: string[] = [
      '订阅地址无效，请使用不含账号和片段的 HTTPS 链接（最多 4096 字符）',
      '订阅请求失败，请检查网络或订阅服务', '订阅请求超时（总时限 12 秒）',
      '订阅响应必须是有效的 UTF-8 文本', '订阅响应超过 1 MiB 上限', '订阅服务器未返回 HTTP 200',
      '收到 HTML / XML 页面，无法作为节点订阅导入。请检查订阅地址或登录状态。',
      '暂不支持 YAML / Clash 订阅，请使用纯文本或 Base64 编码的分享链接列表。',
      '未找到可导入的受支持节点。请使用分享链接列表或单个 Xray outbound JSON。',
      '订阅内容的 Base64 编码或 UTF-8 文本无效。', '订阅内容包含二进制或不受支持的控制字符，无法导入。',
      '一次最多导入 500 行节点，请拆分后重试。', '一次导入的内容不能超过 1 MiB。',
      '单个节点 JSON 不能超过 64 KiB。', 'JSON 不能作为受支持的单个 Xray outbound 节点导入。',
      'Base64 订阅需要包含分享链接列表；JSON 请直接导入单个 Xray outbound 对象。',
      '请先断开连接并等待清理完成，再修改节点。', '订阅已发生变化，请重新获取。',
      '订阅已不存在，请刷新列表。', '订阅数量不能超过 20。', '节点数量超过 500，未保存。',
      '订阅名称无效。', '节点内容无效或超过 64 KiB，未保存。',
      '节点库损坏或无法读取，已停止操作，请保留原文件。', '节点库版本超出范围，未保存。',
      '节点库超过 4 MiB，未保存。', '节点库保存失败，原有配置未替换。'
    ];
    return error instanceof Error && allowed.includes(error.message) ? error.message : fallback;
  }
  private count(id: string): number { return this.nodes.filter((node: SavedNode) => node.sourceId === id).length; }
  private updated(at: number): string { return at > 0 ? new Date(at).toLocaleString() : '尚未更新'; }

  private async preview(id: string = '', name: string = this.name, address: string = this.address): Promise<void> {
    if (this.busy || this.formLocked()) { return; }
    const epoch = ++this.epoch;
    this.clearPreview(); this.busy = true; this.message = '正在获取并解析订阅…';
    try {
      assertNodeManagementAllowed(this.context().filesDir);
      const normalized = normalizeSubscriptionUrl(address);
      let updatedAt = -1;
      if (id) {
        const source = readNodeCatalog(this.context().filesDir).subscriptions.find((item: SubscriptionSource) => item.id === id);
        if (!source || source.url !== normalized) { throw new Error('订阅已发生变化，请重新获取。'); }
        name = source.name; updatedAt = source.lastUpdatedAt;
      }
      const body = await fetchSubscription(normalized);
      if (this.epoch !== epoch || this.formLocked()) { return; }
      assertNodeManagementAllowed(this.context().filesDir);
      if (id) {
        const source = readNodeCatalog(this.context().filesDir).subscriptions.find((item: SubscriptionSource) => item.id === id);
        if (!source || source.url !== normalized || source.name !== name || source.lastUpdatedAt !== updatedAt) {
          throw new Error('订阅已发生变化，请重新获取。');
        }
      }
      const result = parseNodeBatch(body);
      this.pendingNodes = result.nodes;
      this.pendingId = id; this.pendingName = name.trim() || '我的订阅'; this.pendingUrl = normalized;
      this.pendingUpdatedAt = updatedAt;
      this.previewNames = result.nodes.slice(0, 8).map((node: ImportedNode) => `${node.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64)} · ${node.protocol.toUpperCase()}`);
      this.message = `解析到 ${result.nodes.length} 个可用节点，${result.duplicates} 个重复项，${result.rejected} 个不支持或无效项。` +
        (id ? ' 保存将替换此订阅的节点，手动节点和其他订阅保持不变。' : ' 保存后会加入节点列表，当前节点保持不变。');
      this.previewReady = true;
    } catch (error) {
      if (this.epoch === epoch) { this.message = this.safeMessage(error, '订阅获取未完成，输入和原节点已保留。'); }
    } finally { if (this.epoch === epoch) { this.busy = false; this.reload(); } }
  }

  private save(): void {
    if (!this.previewReady || this.busy || this.formLocked()) { return; }
    try {
      assertNodeManagementAllowed(this.context().filesDir);
      if (this.pendingId) {
        const current = readNodeCatalog(this.context().filesDir).subscriptions.find((source: SubscriptionSource) => source.id === this.pendingId);
        if (!current || current.url !== this.pendingUrl || current.name !== this.pendingName ||
          current.lastUpdatedAt !== this.pendingUpdatedAt) { throw new Error('订阅已发生变化，请重新获取。'); }
      }
      const result = saveSubscriptionWithNodes(this.context().filesDir, this.pendingId, this.pendingName, this.pendingUrl, this.pendingNodes);
      this.clearPreview(); this.address = ''; this.name = '';
      this.message = this.reload() ? `订阅已保存，当前列表共 ${this.nodes.length} 个节点。` :
        '订阅保存已提交，但列表读取未确认，请返回后核对。';
      try {
        hilog.info(0x0000, 'HarmonyVpnLab', 'SUBSCRIPTION_SAVED added=%{public}d duplicates=%{public}d', result.added, result.duplicates);
      } catch (_) { /* Logging cannot turn a committed transaction into a failure. */ }
    } catch (error) { this.message = this.safeMessage(error, '保存未完成，输入和预览已保留；请先断开连接并检查订阅内容后重试。'); }
  }
  private remove(id: string): void {
    if (this.busy || this.formLocked() || this.deleteId !== id) { return; }
    try {
      deleteSubscription(this.context().filesDir, id);
      this.deleteId = ''; this.clearPreview();
      this.message = this.reload() ? '订阅及其节点已删除。' : '删除已提交，但列表读取未确认，请返回后核对。';
    } catch (_) { this.message = '删除未完成，请先断开连接。'; }
  }

  build() {
    Column() {
      Row({ space: 14 }) {
        Button('‹ 返回', { type: ButtonType.Normal }).id('backToNodes')
          .fontSize(16).fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface'))
          .borderRadius(12).constraintSize({ minHeight: 44 }).padding({ left: 12, right: 12 })
          .enabled(!this.formLocked()).onClick(() => { void this.requestBack(); });
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
            TextInput({ text: this.name, placeholder: '例如：我的订阅' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('subscriptionName')
              .constraintSize({ minHeight: 48 }).fontSize(15)
              .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(12).maxLength(64).enabled(!this.busy && !this.formLocked())
              .onChange((value: string) => { this.changeName(value); });
            Text('HTTPS 订阅链接').fontSize(14).fontColor($r('app.color.text_secondary'));
            TextInput({ text: this.address, placeholder: '粘贴 https:// 开头的链接' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('subscriptionUrl')
              .constraintSize({ minHeight: 48 }).fontSize(15)
              .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(12)
              .type(InputType.Password).maxLength(4096).enabled(!this.busy && !this.formLocked())
              .onChange((value: string) => { this.changeAddress(value); });
            Text('支持分享链接列表、Base64 列表或单个 Xray 出站 JSON，暂不支持 Clash YAML。')
              .fontSize(13).fontColor($r('app.color.text_secondary'));
            Button(this.busy ? '正在获取…' : '获取并预览').id('previewSubscription').width('100%')
              .constraintSize({ minHeight: 50 }).fontSize(16).fontWeight(FontWeight.Medium)
              .backgroundColor($r('app.color.accent')).fontColor(Color.White)
              .enabled(this.editable && !this.busy && !this.formLocked() && this.address.trim().length > 0).onClick(() => { this.preview(); });
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
                  .enabled(this.editable && !this.busy && !this.formLocked()).onClick(() => { this.save(); });
                Button('取消预览').id('cancelSubscriptionPreview').width('100%').constraintSize({ minHeight: 44 })
                  .fontSize(15).fontColor($r('app.color.text_secondary')).backgroundColor($r('app.color.surface_secondary'))
                  .enabled(!this.busy && !this.formLocked()).onClick(() => { this.cancelPreview(); });
              }
            }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20)
              .border({ width: 1, color: $r('app.color.border') });
          }

          Text(this.readable ? `已有来源 · ${this.sources.length}` : '已有来源').fontSize(18).fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary')).padding({ top: 6 });
          if (this.sources.length === 0) {
            Column({ space: 8 }) {
              Text(!this.readable ? '暂时无法显示来源' : '还没有订阅来源')
                .fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
              Text(!this.readable ? '请返回后重试并核对订阅列表。' :
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
                  .enabled(this.editable && !this.busy && !this.formLocked())
                  .onClick(() => { this.preview(source.id, source.name, source.url); });
                Button('删除订阅').id(`deleteSubscription-${source.id}`).layoutWeight(1).constraintSize({ minHeight: 46 })
                  .fontSize(14).fontColor($r('app.color.danger')).backgroundColor($r('app.color.surface_secondary'))
                  .enabled(this.editable && !this.busy && !this.formLocked()).onClick(() => {
                    if (!this.busy && !this.formLocked()) { this.deleteId = source.id; }
                  });
              }.width('100%');
              if (this.deleteId === source.id) {
                Column({ space: 12 }) {
                  Text('将同时删除此订阅的节点，手动导入的节点会保留。')
                    .fontSize(14).fontColor($r('app.color.text_primary'));
                  Button('确认删除').id('confirmDeleteSubscription').width('100%').constraintSize({ minHeight: 46 })
                    .fontSize(15).backgroundColor($r('app.color.danger')).fontColor(Color.White)
                    .enabled(this.editable && !this.busy && !this.formLocked()).onClick(() => { this.remove(source.id); });
                  Button('取消').id('cancelDeleteSubscription').width('100%').constraintSize({ minHeight: 44 })
                    .fontSize(15).fontColor($r('app.color.text_secondary')).backgroundColor($r('app.color.surface'))
                    .enabled(!this.busy && !this.formLocked()).onClick(() => {
                      if (!this.busy && !this.formLocked()) { this.deleteId = ''; }
                    });
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
