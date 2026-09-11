import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { ImportedNode } from '../model/NodeImport';
import { parseNodeBatch } from '../model/NodeBatchImport';
import { importManualNodes, readNodeCatalog } from '../model/NodeCatalog';
import { nodeServerAddress, readNodeProfile, updateNodeServerAddress } from '../model/NodeProfile';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import { router } from '@kit.ArkUI';
import { assertNodeManagementAllowed, isNodeManagementAllowed } from '../model/NodeEditGuard';
import { formContentWidth } from '../model/AdaptiveLayout';
import { ImportedNodesNavigation, readImportedNodeIds } from '../model/NodeListNavigation';

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
  @State editable: boolean = false;
  @State confirmingLeave: boolean = false;
  @State leaving: boolean = false;
  @State importedNodeIds: string[] = [];
  private importedRequestId: string = '';
  private pendingNodes: ImportedNode[] = [];
  private scanEpoch: number = 0;
  private pageEpoch: number = 0;
  private leaveRequest: number = 0;

  aboutToAppear(): void {
    this.pageEpoch++; this.confirmingLeave = false; this.leaving = false;
    this.scanSupported = this.scannerAvailable();
    this.refreshEditable();
    // Loading an earlier profile is not evidence that a new import succeeded.
    this.saveReceipt = '尚未生成本次保存回执';
    this.clearImportedNavigation();
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const saved = readNodeProfile(context.filesDir);
      this.message = saved ? `已保存 ${saved.protocol} 节点` : '尚未保存节点';
      this.savedAddress = saved ? nodeServerAddress(saved) : '';
    } catch (_) { this.savedAddress = ''; this.message = '当前节点无法读取，原数据已保留，请返回列表后重试。'; }
  }
  onPageShow(): void { this.leaving = false; this.refreshEditable(); }
  // Hiding under the system scanner must not invalidate its pending result.
  onPageHide(): void { this.pageEpoch++; this.leaveRequest++; this.confirmingLeave = false; }

  private refreshEditable(): void {
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.editable = isNodeManagementAllowed(context.filesDir);
    } catch (_) { this.editable = false; }
  }

  private hasDraft(): boolean {
    return this.input.length > 0 || this.replacementAddress.length > 0 || this.pendingNodes.length > 0 || this.scanning;
  }

  onBackPress(): boolean {
    if (this.confirmingLeave || this.leaving) { return true; }
    if (!this.hasDraft()) { return false; }
    void this.requestBack(); return true;
  }

  private async requestBack(): Promise<void> {
    if (this.confirmingLeave || this.leaving) { return; }
    if (!this.hasDraft()) {
      this.leaving = true;
      try { this.getUIContext().getRouter().back(); }
      catch (_) { this.leaving = false; this.message = '暂时无法返回，请重试。'; }
      return;
    }
    const epoch = this.pageEpoch; const request = ++this.leaveRequest;
    this.confirmingLeave = true;
    // Explicit return cancels this scan result before a delayed module load can
    // launch the scanner over the leave dialog. Staying allows a fresh scan.
    if (this.scanning) {
      this.scanEpoch++; this.scanning = false;
      this.message = '本次扫码结果将忽略，继续编辑后可重新扫码。';
    }
    try {
      const result = await this.getUIContext().getPromptAction().showDialog({
        title: '放弃未保存的内容？', message: '返回后，尚未保存的节点输入、预览或服务器修改将丢失。',
        buttons: [{ text: '继续编辑', color: $r('app.color.accent') }, { text: '放弃修改', color: $r('app.color.danger') }]
      });
      if (epoch !== this.pageEpoch || request !== this.leaveRequest) { return; }
      if (result.index === 1) {
        this.leaving = true;
        this.getUIContext().getRouter().back();
        this.clearDraft();
      }
    } catch (_) {
      if (epoch === this.pageEpoch && request === this.leaveRequest) {
        this.leaving = false; this.message = '返回确认未完成，输入已保留，请继续编辑或重试。';
      }
    } finally { if (epoch === this.pageEpoch && request === this.leaveRequest) { this.confirmingLeave = false; } }
  }

  private importError(error: Error): string {
    const safeErrors: string[] = [
      '未找到可导入的受支持节点。请使用分享链接列表或单个 Xray outbound JSON。',
      '订阅内容的 Base64 编码或 UTF-8 文本无效。', '订阅内容包含二进制或不受支持的控制字符，无法导入。',
      '收到 HTML / XML 页面，无法作为节点订阅导入。请检查订阅地址或登录状态。',
      '暂不支持 YAML / Clash 订阅，请使用纯文本或 Base64 编码的分享链接列表。',
      '一次最多导入 500 行节点，请拆分后重试。', '一次导入的内容不能超过 1 MiB。',
      '单个节点 JSON 不能超过 64 KiB。', 'JSON 不能作为受支持的单个 Xray outbound 节点导入。',
      'Base64 订阅需要包含分享链接列表；JSON 请直接导入单个 Xray outbound 对象。',
      '请先断开连接并等待清理完成，再修改节点。', '节点数量超过 500，未保存。',
      '节点库超过 4 MiB，未保存。', '节点库保存失败，原有配置未替换。',
      '保存已提交，但节点读回校验未确认；输入已保留，请返回列表核对。'
    ];
    return error instanceof Error && safeErrors.includes(error.message) ? error.message :
      '导入未完成，输入已保留；请检查内容并先断开连接，再重试。';
  }

  private scannerAvailable(): boolean {
    try { return canIUse('SystemCapability.Multimedia.Scan.ScanBarcode'); }
    catch (_) { return false; }
  }

  private save(): void {
    if (this.scanning || this.confirmingLeave || this.leaving || this.input.trim().length === 0) { return; }
    this.clearImportedNavigation();
    this.refreshEditable();
    if (!this.editable) { this.message = '请先断开连接并等待清理完成，再保存节点。'; return; }
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
      this.message = this.importError(error as Error);
    }
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.confirmingLeave || this.leaving || this.input.trim().length > 0) { return; }
    this.clearImportedNavigation();
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
      try { hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_SCAN_PARSED count=%{public}d', parsed.nodes.length); }
      catch (_) { /* Diagnostic logging must not discard a parsed result. */ }
    } catch (error) {
      if (epoch !== this.scanEpoch) { return; }
      this.message = (error as ScanFailure)?.code === 1000500002 ? '已取消扫码。' :
        '扫码未完成或二维码不是支持的节点内容，可尝试粘贴分享链接。';
    } finally { if (epoch === this.scanEpoch) { this.scanning = false; } }
  }

  private persist(nodes: ImportedNode[]): void {
    let committed: boolean = false;
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const result = importManualNodes(context.filesDir, nodes);
      committed = true;
      const catalog = readNodeCatalog(context.filesDir);
      const confirmedIds: string[] = [];
      for (const node of nodes) {
        const saved = catalog.nodes.find((entry) => entry.outboundJson === node.outboundJson);
        if (!saved) { throw new Error('保存后的节点列表未通过读回校验'); }
        if (!confirmedIds.includes(saved.id)) { confirmedIds.push(saved.id); }
      }
      const active = readNodeProfile(context.filesDir);
      this.savedAddress = active ? nodeServerAddress(active) : '';
      const requestId = util.generateRandomUUID();
      const navigationIds = readImportedNodeIds(new ImportedNodesNavigation(confirmedIds, requestId));
      if (navigationIds.length === 0) { throw new Error('保存后的节点列表未通过读回校验'); }
      const receipt = '保存回执：' + requestId;
      this.input = ''; this.pendingNodes = []; this.partialCount = 0;
      this.message = `已新增 ${result.added} 个节点，跳过 ${result.duplicates} 个已有节点。可返回节点列表选择连接。`;
      this.saveReceipt = receipt;
      this.importedNodeIds = navigationIds;
      this.importedRequestId = requestId;
      try { hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_BATCH_SAVED added=%{public}d duplicates=%{public}d', result.added, result.duplicates); }
      catch (_) { /* Logging cannot turn a confirmed commit into a failure. */ }
    } catch (error) {
      if (committed) { throw new Error('保存已提交，但节点读回校验未确认；输入已保留，请返回列表核对。'); }
      throw new Error(this.importError(error as Error));
    }
  }

  private savePartial(): void {
    if (this.scanning || this.confirmingLeave || this.leaving || this.pendingNodes.length === 0) { return; }
    this.clearImportedNavigation();
    this.refreshEditable();
    if (!this.editable) { this.message = '请先断开连接并等待清理完成，再保存节点。'; return; }
    try { this.persist(this.pendingNodes); }
    catch (error) { this.saveReceipt = '本次保存未完成'; this.message = this.importError(error as Error); }
  }

  private clearImportedNavigation(): void { this.importedNodeIds = []; this.importedRequestId = ''; }

  private changeInput(value: string): void {
    if (this.input !== value) { this.clearImportedNavigation(); }
    this.input = value;
    this.pendingNodes = []; this.partialCount = 0;
    if (value.length > 0) { this.saveReceipt = '尚未生成本次保存回执'; }
  }

  private changeReplacementAddress(value: string): void {
    if (this.replacementAddress !== value) { this.clearImportedNavigation(); }
    this.replacementAddress = value;
  }

  private async viewImportedNodes(): Promise<void> {
    if (this.scanning || this.confirmingLeave || this.leaving || this.hasDraft() || this.importedNodeIds.length === 0) { return; }
    const params = new ImportedNodesNavigation(this.importedNodeIds, this.importedRequestId);
    if (readImportedNodeIds(params).length === 0) { this.clearImportedNavigation(); return; }
    const epoch = this.pageEpoch;
    this.leaving = true;
    try {
      await this.getUIContext().getRouter().replaceUrl({ url: 'pages/Nodes', params }, router.RouterMode.Single);
    } catch (_) {
      if (epoch === this.pageEpoch) {
        this.leaving = false; this.message = '节点已保存，列表暂未打开，请重试。';
      }
    }
  }

  private clearDraft(): void { this.scanEpoch++; this.scanning = false; this.input = ''; this.pendingNodes = []; this.partialCount = 0; this.replacementAddress = ''; this.clearImportedNavigation(); }
  aboutToDisappear(): void { this.pageEpoch++; this.leaveRequest++; this.confirmingLeave = false; this.clearDraft(); }

  private updateAddress(): void {
    if (this.scanning || this.confirmingLeave || this.leaving || this.replacementAddress.trim().length === 0) { return; }
    this.clearImportedNavigation();
    this.refreshEditable();
    if (!this.editable) { this.message = '请先断开连接并等待清理完成，再修改服务器地址。'; return; }
    this.saveReceipt = '尚未生成本次保存回执';
    let committed: boolean = false;
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      updateNodeServerAddress(context.filesDir, this.replacementAddress);
      committed = true;
      const saved = readNodeProfile(context.filesDir);
      if (!saved) { throw new Error('missing readback'); }
      this.savedAddress = nodeServerAddress(saved);
      this.replacementAddress = '';
      this.message = '服务器地址已更新为 ' + this.savedAddress;
      try { hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_ADDRESS_UPDATED'); }
      catch (_) { /* Logging cannot turn a confirmed commit into a failure. */ }
    } catch (_) {
      this.message = committed ? '地址修改已提交，但读回未确认；输入已保留，请返回列表核对。' :
        '地址更新未完成，输入已保留；请使用有效的 IPv4 地址或域名，并先断开连接。';
    }
  }

  build() {
    Column() {
      Row({ space: 14 }) {
        Button('‹ 返回', { type: ButtonType.Normal }).id('backToProbe')
          .fontSize(16).fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface'))
          .borderRadius(12).constraintSize({ minHeight: 44 }).padding({ left: 12, right: 12 })
          .enabled(!this.confirmingLeave && !this.leaving).onClick(() => { void this.requestBack(); });
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
          if (!this.editable) {
            Text('请先断开连接并等待清理完成，再保存节点或修改服务器。').id('nodeImportEditNotice')
              .fontSize(14).fontColor($r('app.color.warning')).width('100%');
          }

          Column({ space: 14 }) {
            Text('扫码导入').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Text(this.scanSupported ? '支持 3X-UI 节点二维码，也可在扫码界面从相册选取图片。' :
              '此设备不支持系统扫码。可粘贴分享链接或单个 outbound JSON，也可通过“设置 → 节点备份与恢复”导入备份。')
              .fontSize(14).fontColor($r('app.color.text_secondary'));
            Button(this.scanning ? '正在扫码…' : '扫描节点二维码').id('scanNode').width('100%')
              .constraintSize({ minHeight: 48 }).fontSize(16)
              .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .enabled(this.editable && this.scanSupported && !this.scanning && !this.confirmingLeave && !this.leaving && this.input.trim().length === 0)
              .onClick(() => { this.scan(); });
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
            TextArea({ text: this.input, placeholder: '在这里粘贴节点分享内容' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('nodeInput')
              .width('100%').constraintSize({ minHeight: 200, maxHeight: 360 }).fontSize(15)
              .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(14)
              .maxLength(1048576).enabled(!this.scanning && !this.confirmingLeave && !this.leaving)
              .onChange((value: string) => { this.changeInput(value); });
            Button('解析并保存').id('saveNode').width('100%').constraintSize({ minHeight: 50 })
              .fontSize(16).fontWeight(FontWeight.Medium).backgroundColor($r('app.color.accent')).fontColor(Color.White)
              .enabled(this.editable && !this.scanning && !this.confirmingLeave && !this.leaving && this.input.trim().length > 0)
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
            if (this.importedNodeIds.length > 0) {
              Button('查看导入的节点').id('viewImportedNodes').width('100%')
                .constraintSize({ minHeight: 48 }).fontSize(16)
                .backgroundColor($r('app.color.accent')).fontColor(Color.White)
                .enabled(!this.scanning && !this.confirmingLeave && !this.leaving && !this.hasDraft())
                .onClick(() => { void this.viewImportedNodes(); });
            }
            if (this.partialCount > 0) {
              Button(`仅导入 ${this.partialCount} 个可用节点`).id('confirmPartialImport').width('100%')
                .constraintSize({ minHeight: 48 }).fontSize(15)
                .backgroundColor($r('app.color.accent')).fontColor(Color.White)
                .enabled(this.editable && !this.scanning && !this.confirmingLeave && !this.leaving)
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
                TextInput({ text: this.replacementAddress, placeholder: '新的远端 IP 或域名' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1')
                  .id('nodeHostInput').constraintSize({ minHeight: 48 }).fontSize(15)
                  .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
                  .backgroundColor($r('app.color.surface_secondary')).borderRadius(12)
                  .enabled(!this.scanning && !this.confirmingLeave && !this.leaving)
                  .onChange((value: string) => { this.changeReplacementAddress(value); });
                Button('更新服务器地址').id('updateNodeHost').width('100%').constraintSize({ minHeight: 48 })
                  .fontSize(15).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                  .enabled(this.editable && !this.scanning && !this.confirmingLeave && !this.leaving && this.replacementAddress.trim().length > 0)
                  .onClick(() => { this.updateAddress(); });
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
