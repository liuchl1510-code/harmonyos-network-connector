import { common } from '@kit.AbilityKit';
import { ImportedNode } from '../model/NodeImport';
import { parseNodeBatch } from '../model/NodeBatchImport';
import { importManualNodes, readNodeCatalog } from '../model/NodeCatalog';
import { nodeServerAddress, readNodeProfile, updateNodeServerAddress } from '../model/NodeProfile';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import { assertNodeManagementAllowed } from '../model/NodeEditGuard';
import { formContentWidth } from '../model/AdaptiveLayout';

interface ScanFailure { code?: number; }

@Entry
@Component
struct NodeConfig {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State input: string = '';
  @State message: string = '';
  @State savedAddress: string = '';
  @State replacementAddress: string = '';
  @State saveReceipt: string = '尚未生成本次保存回执';
  @State partialCount: number = 0;
  @State scanning: boolean = false;
  @State scanSupported: boolean = false;
  @State advancedExpanded: boolean = false;
  @State receiptExpanded: boolean = false;
  private pendingNodes: ImportedNode[] = [];
  private scanEpoch: number = 0;

  aboutToAppear(): void {
    this.scanSupported = this.scannerAvailable();
    // Loading an earlier profile is not evidence that a new import succeeded.
    this.saveReceipt = '尚未生成本次保存回执';
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const saved = readNodeProfile(context.filesDir);
    this.message = saved ? `已保存 ${saved.protocol} 节点` : '尚未保存节点';
    this.savedAddress = saved ? nodeServerAddress(saved) : '';
  }

  private scannerAvailable(): boolean {
    try { return canIUse('SystemCapability.Multimedia.Scan.ScanBarcode'); }
    catch (_) { return false; }
  }

  private save(): void {
    if (this.scanning) { return; }
    this.saveReceipt = '本次保存正在校验';
    try {
      const result = parseNodeBatch(this.input);
      if (result.rejected > 0) {
        this.pendingNodes = result.nodes; this.partialCount = result.nodes.length;
        this.message = `检测到 ${result.nodes.length} 个可用节点、${result.duplicates} 个重复项和 ${result.rejected} 个无效或不支持项。确认后仅导入可用节点。`;
        this.saveReceipt = '部分内容未通过，请确认可用节点';
        return;
      }
      this.persist(result.nodes);
    } catch (error) {
      this.saveReceipt = '本次保存未完成';
      this.message = '导入未完成：' + String(error);
    }
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.input.trim().length > 0) { return; }
    this.scanSupported = this.scannerAvailable();
    if (!this.scanSupported) {
      this.message = '此设备不支持系统扫码，可粘贴分享链接或单个 outbound JSON，也可从设置恢复节点备份。';
      return;
    }
    const epoch = ++this.scanEpoch;
    this.scanning = true;
    this.saveReceipt = '扫码结果尚未保存';
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      assertNodeManagementAllowed(context.filesDir);
      // The unsupported system module is never loaded on a device without the
      // capability. A relative, literal dynamic import remains build-resolvable.
      const scanner = await import('../model/NodeScanner');
      if (epoch !== this.scanEpoch) { return; }
      assertNodeManagementAllowed(context.filesDir);
      const content = await scanner.scanNodeCode(context);
      if (epoch !== this.scanEpoch) { return; }
      const parsed = parseNodeBatch(content);
      this.input = content;
      this.pendingNodes = []; this.partialCount = 0;
      this.saveReceipt = '尚未生成本次保存回执';
      this.message = `已识别 ${parsed.nodes.length} 个可用节点，请点击“解析并保存”加入节点列表。`;
      hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_SCAN_PARSED count=%{public}d', parsed.nodes.length);
    } catch (error) {
      if (epoch !== this.scanEpoch) { return; }
      this.message = (error as ScanFailure)?.code === 1000500002 ? '已取消扫码。' :
        '扫码未完成或二维码不是支持的节点内容，可尝试粘贴分享链接。';
    } finally { if (epoch === this.scanEpoch) { this.scanning = false; } }
  }

  private persist(nodes: ImportedNode[]): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const result = importManualNodes(context.filesDir, nodes);
    const catalog = readNodeCatalog(context.filesDir);
    if (!nodes.every((node: ImportedNode) => catalog.nodes.some((saved) => saved.outboundJson === node.outboundJson))) {
      throw new Error('保存后的节点列表未通过读回校验');
    }
    this.input = ''; this.pendingNodes = []; this.partialCount = 0;
    const active = readNodeProfile(context.filesDir);
    this.savedAddress = active ? nodeServerAddress(active) : '';
    this.message = `已新增 ${result.added} 个节点，跳过 ${result.duplicates} 个已有节点。可返回节点列表选择连接。`;
    this.saveReceipt = '保存回执：' + util.generateRandomUUID();
    hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_BATCH_SAVED added=%{public}d duplicates=%{public}d', result.added, result.duplicates);
  }

  private savePartial(): void {
    try { this.persist(this.pendingNodes); }
    catch (_) { this.saveReceipt = '本次保存未完成'; this.message = '保存未完成，请先断开连接并重试。'; }
  }

  aboutToDisappear(): void { this.scanEpoch++; this.scanning = false; this.input = ''; this.pendingNodes = []; this.partialCount = 0; this.replacementAddress = ''; }

  private updateAddress(): void {
    this.saveReceipt = '尚未生成本次保存回执';
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      updateNodeServerAddress(context.filesDir, this.replacementAddress);
      const saved = readNodeProfile(context.filesDir);
      this.savedAddress = saved ? nodeServerAddress(saved) : '';
      this.replacementAddress = '';
      this.message = '服务器地址已更新为 ' + this.savedAddress;
      hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_ADDRESS_UPDATED');
    } catch (error) {
      this.message = '地址更新未完成：' + String(error);
    }
  }

  build() {
    Column() {
      Row({ space: 14 }) {
        Button('‹ 返回', { type: ButtonType.Normal }).id('backToProbe')
          .fontSize(16).fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface'))
          .borderRadius(12).constraintSize({ minHeight: 44 }).padding({ left: 12, right: 12 })
          .onClick(() => {
            this.input = '';
            this.getUIContext().getRouter().back();
          });
        Text('导入节点').fontSize(23).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
          .layoutWeight(1);
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, top: 12, bottom: 16 });
      Scroll() {
        Column({ space: 18 }) {
          Column({ space: 10 }) {
            Text('添加你的节点').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
            Text(this.scanSupported ? '扫描二维码，或粘贴节点分享内容。保存成功后，可回到节点列表选择连接。' :
              '粘贴节点分享内容。保存成功后，可回到节点列表选择连接。')
              .fontSize(15).fontColor($r('app.color.text_secondary'));
          }.width('100%').alignItems(HorizontalAlign.Start).padding({ bottom: 2 });

          Column({ space: 14 }) {
            Text('扫码导入').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Text(this.scanSupported ? '支持 3X-UI 节点二维码，也可在扫码界面从相册选取图片。' :
              '此设备不支持系统扫码。可粘贴分享链接或单个 outbound JSON，也可通过“设置 → 节点备份与恢复”导入备份。')
              .fontSize(14).fontColor($r('app.color.text_secondary'));
            Button(this.scanning ? '正在扫码…' : '扫描节点二维码').id('scanNode').width('100%')
              .constraintSize({ minHeight: 48 }).fontSize(16)
              .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .enabled(this.scanSupported && !this.scanning && this.input.trim().length === 0).onClick(() => { this.scan(); });
            if (this.input.trim().length > 0) {
              Text('输入框已有内容，清空后可使用扫码。').fontSize(13).fontColor($r('app.color.text_secondary'));
            }
          }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
            .backgroundColor($r('app.color.surface')).borderRadius(20)
            .border({ width: 1, color: $r('app.color.border') });

          Column({ space: 14 }) {
            Text('粘贴导入').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Text('支持多行分享链接、Base64 列表或单个 Xray 出站 JSON。')
              .fontSize(14).fontColor($r('app.color.text_secondary'));
            TextArea({ text: this.input, placeholder: '在这里粘贴节点分享内容' }).id('nodeInput')
              .width('100%').constraintSize({ minHeight: 200, maxHeight: 360 }).fontSize(15)
              .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(14)
              .maxLength(1048576).enabled(!this.scanning).onChange((value: string) => {
                this.input = value;
                this.pendingNodes = []; this.partialCount = 0;
                if (value.length > 0) {
                  this.saveReceipt = '尚未生成本次保存回执';
                }
              });
            Button('解析并保存').id('saveNode').width('100%').constraintSize({ minHeight: 50 })
              .fontSize(16).fontWeight(FontWeight.Medium).backgroundColor($r('app.color.accent')).fontColor(Color.White)
              .enabled(!this.scanning && this.input.trim().length > 0)
              .onClick(() => { this.save(); });
            Text('已有当前节点会保持选中，保存成功后输入内容会清空。')
              .fontSize(13).fontColor($r('app.color.text_secondary'));
          }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
            .backgroundColor($r('app.color.surface')).borderRadius(20)
            .border({ width: 1, color: $r('app.color.border') });

          Column({ space: 12 }) {
            Text(this.partialCount > 0 ? '需要确认' : '导入结果').fontSize(16).fontWeight(FontWeight.Medium)
              .fontColor(this.partialCount > 0 ? $r('app.color.warning') : $r('app.color.text_primary'));
            Text(this.message).id('nodeSaveResult').fontSize(15).fontColor($r('app.color.text_primary'))
              .width('100%').wordBreak(WordBreak.BREAK_ALL);
            if (this.partialCount > 0) {
              Button(`仅导入 ${this.partialCount} 个可用节点`).id('confirmPartialImport').width('100%')
                .constraintSize({ minHeight: 48 }).fontSize(15)
                .backgroundColor($r('app.color.accent')).fontColor(Color.White)
                .onClick(() => { this.savePartial(); });
            }
            Button(this.receiptExpanded ? '收起保存详情 −' : '查看保存详情 +', { type: ButtonType.Normal })
              .id('toggleNodeSaveDetails').fontSize(14).fontColor($r('app.color.accent'))
              .backgroundColor(Color.Transparent).constraintSize({ minHeight: 44 })
              .padding({ left: 0, right: 8 }).onClick(() => { this.receiptExpanded = !this.receiptExpanded; });
            if (this.receiptExpanded) {
              Text(this.saveReceipt).id('nodeSaveReceipt').fontSize(13).fontColor($r('app.color.text_secondary'))
                .width('100%').wordBreak(WordBreak.BREAK_ALL);
            }
          }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
            .backgroundColor($r('app.color.surface')).borderRadius(20)
            .border({ width: 1, color: $r('app.color.border') });

          if (this.savedAddress.length > 0) {
            Column({ space: 12 }) {
              Button(this.advancedExpanded ? '高级选项 −' : '高级选项 +', { type: ButtonType.Normal })
                .id('toggleNodeAdvanced').width('100%').fontSize(16).fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.text_primary')).backgroundColor(Color.Transparent)
                .constraintSize({ minHeight: 44 }).padding({ left: 0, right: 0 })
                .onClick(() => { this.advancedExpanded = !this.advancedExpanded; });
              if (this.advancedExpanded) {
                Text('修改当前节点服务器').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
                Text('当前远端服务器：' + this.savedAddress).id('currentNodeHost').fontSize(14)
                  .fontColor($r('app.color.text_secondary')).width('100%').wordBreak(WordBreak.BREAK_ALL);
                TextInput({ text: this.replacementAddress, placeholder: '新的远端 IP 或域名' })
                  .id('nodeHostInput').constraintSize({ minHeight: 48 }).fontSize(15)
                  .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
                  .backgroundColor($r('app.color.surface_secondary')).borderRadius(12)
                  .onChange((value: string) => { this.replacementAddress = value; });
                Button('更新服务器地址').id('updateNodeHost').width('100%').constraintSize({ minHeight: 48 })
                  .fontSize(15).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                  .enabled(this.replacementAddress.trim().length > 0).onClick(() => { this.updateAddress(); });
                Text('支持 IPv4 地址或域名。连接前解析域名，应用 DNS 通过节点，IPv6 流量暂时阻断。')
                  .fontSize(13).fontColor($r('app.color.text_secondary'));
              }
            }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface')).borderRadius(20)
              .border({ width: 1, color: $r('app.color.border') });
          }
        }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, bottom: 28 }).alignItems(HorizontalAlign.Start);
      }.width('100%').layoutWeight(1).align(Alignment.Top);
    }.width('100%').height('100%').alignItems(HorizontalAlign.Center).backgroundColor($r('app.color.page_bg'));
  }
}
