import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { vpnExtension } from '@kit.NetworkKit';
import { SavedNode, SubscriptionSource, readNodeCatalog, selectCatalogNode, renameCatalogNode, deleteCatalogNode } from '../model/NodeCatalog';
import { isNodeManagementAllowed } from '../model/NodeEditGuard';
import { ConnectionCommand, readConnectionCommand, readConnectionStatus, writeConnectionCommand } from '../model/ConnectionControl';
import { ProbeState, readProbeState, writeProbeState } from '../model/ProbeState';
import { NodeLatencyResult, fingerprintOutbound, latencyLabel, readNodeLatencies } from '../model/NodeLatency';
import { LatencyRequest, writeLatencyRequest, writeLatencyProof } from '../model/LatencyProtocol';
import { measureNodeLatency } from '../model/LatencyProbe';
import { AppTabBar } from '../components/AppTabBar';

@Entry
@Component
struct Nodes {
  @State nodes: SavedNode[] = [];
  @State sources: SubscriptionSource[] = [];
  @State activeId: string = '';
  @State message: string = '';
  @State editable: boolean = false;
  @State search: string = '';
  @State limit: number = 50;
  @State renameId: string = '';
  @State renameText: string = '';
  @State deleteId: string = '';
  @State latencies: NodeLatencyResult[] = [];
  @State testingId: string = '';
  @State preparing: boolean = false;
  private timer: number = -1;
  private latencyRequest: LatencyRequest | undefined = undefined;
  private probeStarted: boolean = false;
  private cancelling: boolean = false;
  private pageEpoch: number = 0;
  private resultEpoch: number = 0;

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void { this.reload(); }
  onPageShow(): void {
    this.reload();
    if (this.timer < 0) { this.timer = setInterval(() => { this.pollLatency(); }, 500); }
  }
  onPageHide(): void { if (this.timer >= 0) { clearInterval(this.timer); this.timer = -1; } }
  aboutToDisappear(): void { this.cancelLatency(); this.pageEpoch++; this.resultEpoch++; this.onPageHide(); }

  private reload(): void {
    try {
      const catalog = readNodeCatalog(this.context().filesDir);
      this.nodes = catalog.nodes;
      this.sources = catalog.subscriptions;
      this.activeId = catalog.activeNodeId;
      this.editable = isNodeManagementAllowed(this.context().filesDir);
      this.refreshLatencies();
    } catch (_) { this.message = '节点列表读取失败，原数据已保留。'; this.editable = false; }
  }

  private async refreshLatencies(): Promise<void> {
    const epoch = ++this.resultEpoch;
    this.latencies = [];
    try {
      const records = readNodeLatencies(this.context().filesDir);
      const matched: NodeLatencyResult[] = [];
      for (const record of records) {
        const node = this.nodes.find((item: SavedNode) => item.id === record.nodeId);
        if (node && await fingerprintOutbound(node.outboundJson) === record.outboundFingerprint) { matched.push(record); }
        if (epoch !== this.resultEpoch) { return; }
      }
      if (epoch === this.resultEpoch) { this.latencies = matched; }
    } catch (_) { if (epoch === this.resultEpoch) { this.latencies = []; this.message = '历史检测记录无法读取，节点数据已保留。'; } }
  }

  private latencyText(id: string): string {
    if (id === this.testingId) { return this.probeStarted ? '正在检测 HTTPS…' : '正在准备检测…'; }
    const record = this.latencies.find((item: NodeLatencyResult) => item.nodeId === id);
    if (!record) { return latencyLabel(); }
    const date = new Date(record.checkedAt);
    const year = date.getFullYear() === new Date().getFullYear() ? '' : date.getFullYear().toString() + '-';
    const stamp = year + (date.getMonth() + 1).toString().padStart(2, '0') + '-' + date.getDate().toString().padStart(2, '0') +
      ' ' + date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
    return latencyLabel(record) + ' · ' + stamp;
  }

  private async startLatency(id: string): Promise<void> {
    const filesDir = this.context().filesDir;
    if (this.preparing || this.testingId || !isNodeManagementAllowed(filesDir)) { return; }
    this.preparing = true; this.editable = false;
    const epoch = this.pageEpoch;
    let attemptedRequest: LatencyRequest | undefined = undefined;
    try {
      const node = readNodeCatalog(filesDir).nodes.find((item: SavedNode) => item.id === id);
      if (!node) { throw new Error('missing'); }
      const fingerprint = await fingerprintOutbound(node.outboundJson);
      if (epoch !== this.pageEpoch) { return; }
      const latest = readNodeCatalog(filesDir).nodes.find((item: SavedNode) => item.id === id);
      if (!latest || latest.outboundJson !== node.outboundJson || !isNodeManagementAllowed(filesDir)) { throw new Error('changed'); }
      const request = new LatencyRequest(Date.now().toString(), id, fingerprint);
      attemptedRequest = request;
      this.latencyRequest = request; this.testingId = id; this.probeStarted = false; this.cancelling = false;
      writeLatencyRequest(filesDir, request);
      writeConnectionCommand(filesDir, new ConnectionCommand(request.runId, 'start'));
      writeProbeState(filesDir, new ProbeState('starting', '正在准备节点 HTTPS 检测。', request.runId, 'node-latency'));
      this.message = '短时 VPN 仅接管本应用，检测后自动断开；当前选中节点保持不变。';
      await vpnExtension.startVpnExtensionAbility({ bundleName: 'com.example.harmonyvpnlab', abilityName: 'VpnProbeAbility',
        parameters: { runId: request.runId, kind: 'node-latency' } });
    } catch (_) {
      const request = attemptedRequest;
      if (request) {
        const state = readProbeState(filesDir);
        if (state.runId === request.runId && state.phase === 'starting') {
          writeConnectionCommand(filesDir, new ConnectionCommand(request.runId, 'stop'));
          writeProbeState(filesDir, new ProbeState('failed', '节点检测未启动，请检查 VPN 授权和网络。', request.runId, 'node-latency'));
        }
      }
      if (epoch === this.pageEpoch) { this.message = '节点检测未启动，请检查 VPN 授权和网络后重试。'; }
    } finally { if (epoch === this.pageEpoch) { this.preparing = false; this.pollLatency(); } }
  }

  private probeCurrent(request: LatencyRequest, epoch: number): boolean {
    if (this.cancelling || epoch !== this.pageEpoch || this.latencyRequest?.runId !== request.runId) { return false; }
    const state = readProbeState(this.context().filesDir);
    const status = readConnectionStatus(this.context().filesDir);
    const command = readConnectionCommand(this.context().filesDir);
    return state.runId === request.runId && state.kind === 'node-latency' && state.phase === 'active' &&
      command?.runId === request.runId && command.action !== 'stop' &&
      status?.runId === request.runId && status.phase === 'active' && (status.reconnectCount ?? 0) === 0;
  }

  private async probeLatency(request: LatencyRequest): Promise<void> {
    const epoch = this.pageEpoch;
    try {
      const proof = await measureNodeLatency(request, (): boolean => this.probeCurrent(request, epoch));
      if (proof && this.probeCurrent(request, epoch)) { writeLatencyProof(this.context().filesDir, proof); }
    } catch (_) {
      if (epoch === this.pageEpoch && this.latencyRequest?.runId === request.runId) {
        this.message = '检测结果未能提交，请重试。'; this.cancelLatency();
      }
    }
  }

  private pollLatency(): void {
    const filesDir = this.context().filesDir;
    this.editable = !this.preparing && isNodeManagementAllowed(filesDir);
    const request = this.latencyRequest;
    if (!request) { return; }
    const state = readProbeState(filesDir);
    if (!this.cancelling && state.runId === request.runId && state.phase === 'active' && !this.probeStarted) {
      this.probeStarted = true; this.probeLatency(request);
    }
    if (state.runId !== request.runId || this.editable) {
      this.latencyRequest = undefined; this.testingId = ''; this.probeStarted = false;
      this.message = state.runId === request.runId && state.phase === 'failed' ? '检测未完成，请检查授权、节点和网络后重试。' : '检测已结束，临时 VPN 已停止。';
      this.refreshLatencies();
    }
  }

  private cancelLatency(): void {
    const request = this.latencyRequest;
    if (!request) { return; }
    try {
      const state = readProbeState(this.context().filesDir);
      if (state.runId === request.runId) { writeConnectionCommand(this.context().filesDir, new ConnectionCommand(request.runId, 'stop')); }
    } catch (_) { this.message = '取消请求未保存，检测将在时限内自动结束。'; }
    this.cancelling = true; this.preparing = false; this.pageEpoch++; this.message = '正在取消检测并清理临时 VPN…';
  }

  private filtered(): SavedNode[] {
    const query = this.search.trim().toLowerCase();
    return this.nodes.filter((node: SavedNode) => node.name.toLowerCase().includes(query) || node.protocol.includes(query));
  }
  private visibleNodes(): SavedNode[] { return this.filtered().slice(0, this.limit); }
  private sourceName(id: string): string { return id ? (this.sources.find((item: SubscriptionSource) => item.id === id)?.name ?? '订阅') : '手动导入'; }

  private select(id: string): void {
    try {
      selectCatalogNode(this.context().filesDir, id);
      this.reload(); this.message = '已切换当前节点，返回首页后连接。';
      hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_SELECTION_SAVED');
    } catch (_) { this.message = '切换未完成，请先断开连接。'; }
  }
  private rename(): void {
    try {
      renameCatalogNode(this.context().filesDir, this.renameId, this.renameText);
      this.renameId = ''; this.renameText = ''; this.reload(); this.message = '名称已保存。';
    } catch (_) { this.message = '改名未完成，请检查名称并先断开连接。'; }
  }
  private remove(id: string): void {
    try {
      deleteCatalogNode(this.context().filesDir, id);
      this.deleteId = ''; this.reload(); this.message = '节点已删除。';
      hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_REMOVED');
    } catch (_) { this.message = '删除未完成，请先断开连接。'; }
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回', { type: ButtonType.Normal }).id('backToConnection').constraintSize({ minHeight: 36 })
          .padding({ left: 0, right: 4 }).fontSize(15).fontColor($r('app.color.accent'))
          .backgroundColor(Color.Transparent).onClick(() => { this.getUIContext().getRouter().back(); });
        Column({ space: 2 }) {
          Text('节点').fontSize(26).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
          Text(`共 ${this.nodes.length} 个节点`).id('nodeCount').fontSize(12).fontColor($r('app.color.text_secondary'));
        }.alignItems(HorizontalAlign.Start).layoutWeight(1);
        Button('添加', { type: ButtonType.Normal }).id('addNodes').constraintSize({ minHeight: 38 }).borderRadius(19)
          .padding({ left: 18, right: 18 }).fontSize(15).fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
          .enabled(this.editable).bindMenu(this.addNodeMenu);
      }.width('100%').padding({ left: 20, right: 20, top: 16, bottom: 14 });
      Scroll() {
        Column({ space: 12 }) {
          TextInput({ text: this.search, placeholder: '搜索名称或协议' }).id('nodeSearch').constraintSize({ minHeight: 44 })
            .fontSize(15).fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
            .backgroundColor($r('app.color.surface_secondary')).borderRadius(12)
            .onChange((value: string) => { this.search = value; this.limit = 50; });
          if (!this.editable) {
            Text(this.testingId ? '检测期间暂不能修改节点。' : '请先返回首页断开连接，再修改节点。')
              .fontSize(13).fontColor($r('app.color.warning')).width('100%');
          }
          if (this.message) {
            Text(this.message).id('nodeManagerResult').fontSize(13).lineHeight('19fp')
              .fontColor($r('app.color.text_secondary')).width('100%');
          }
          if (this.visibleNodes().length > 0) {
            Column() {
              ForEach(this.visibleNodes(), (node: SavedNode) => {
                Column({ space: 10 }) {
                  Row({ space: 8 }) {
                    Column({ space: 5 }) {
                      Text(node.name).id(`nodeName-${node.id}`).fontSize(17).fontWeight(FontWeight.Medium)
                        .fontColor($r('app.color.text_primary')).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
                        .width('100%').lineHeight('23fp');
                      Text(`${node.protocol.toUpperCase()} · ${this.sourceName(node.sourceId)}`)
                        .fontSize(12).fontColor($r('app.color.text_secondary')).maxLines(1)
                        .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%');
                    }.layoutWeight(1).alignItems(HorizontalAlign.Start);
                    Button('更多', { type: ButtonType.Normal }).id(`nodeMore-${node.id}`)
                      .constraintSize({ minHeight: 36, minWidth: 48 }).padding({ left: 10, right: 10 }).fontSize(13).fontColor($r('app.color.text_secondary'))
                      .backgroundColor(Color.Transparent).enabled(this.editable)
                      .bindMenu(() => { this.nodeActionsMenu(node); });
                  }.width('100%').alignItems(VerticalAlign.Top);
                  Text(this.latencyText(node.id)).id(`nodeLatency-${node.id}`).fontSize(12).lineHeight('17fp')
                    .fontColor(node.id === this.testingId ? $r('app.color.accent') : $r('app.color.text_secondary')).width('100%');
                  Row({ space: 8 }) {
                    Blank();
                    Button('检测', { type: ButtonType.Normal }).id(`testNodeLatency-${node.id}`)
                      .constraintSize({ minHeight: 36, minWidth: 54 }).padding({ left: 10, right: 10 }).borderRadius(16).fontSize(13)
                      .fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface_secondary'))
                      .enabled(this.editable && !this.preparing && !this.testingId)
                      .onClick(() => { this.startLatency(node.id); });
                    Button({ type: ButtonType.Normal }) {
                      Text(node.id === this.activeId ? '已选中' : '选用')
                        .id(node.id === this.activeId ? 'activeNodeLabel' : `nodeSelectLabel-${node.id}`)
                        .fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.accent'));
                    }.id(`selectNode-${node.id}`).constraintSize({ minHeight: 36, minWidth: 68 }).padding({ left: 10, right: 10 }).borderRadius(16)
                      .backgroundColor(node.id === this.activeId ? $r('app.color.accent_soft') : $r('app.color.surface_secondary'))
                      .enabled(node.id === this.activeId || this.editable)
                      .accessibilityDescription(node.id === this.activeId ? '当前节点' : '设为当前节点')
                      .onClick(() => { if (this.editable && node.id !== this.activeId) { this.select(node.id); } });
                  }.width('100%');
                  if (this.renameId === node.id) {
                    TextInput({ text: this.renameText, placeholder: '节点名称' }).id('renameNodeInput').maxLength(64)
                      .constraintSize({ minHeight: 42 }).fontSize(14).fontColor($r('app.color.text_primary'))
                      .placeholderColor($r('app.color.text_secondary')).backgroundColor($r('app.color.surface_secondary'))
                      .onChange((value: string) => { this.renameText = value; });
                    Row({ space: 12 }) {
                      Button('保存名称', { type: ButtonType.Normal }).id('confirmRenameNode').constraintSize({ minHeight: 34 }).borderRadius(17)
                        .fontSize(13).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                        .enabled(this.editable).onClick(() => { this.rename(); });
                      Button('取消改名', { type: ButtonType.Normal }).id('cancelRenameNode').constraintSize({ minHeight: 34 }).borderRadius(17)
                        .fontSize(13).fontColor($r('app.color.text_secondary')).backgroundColor($r('app.color.surface_secondary'))
                        .onClick(() => { this.renameId = ''; this.renameText = ''; });
                    }.width('100%');
                  }
                  if (this.deleteId === node.id) {
                    Text(node.id === this.activeId ? '删除当前节点后，将选择列表中的另一个节点。' : '确认删除此节点？')
                      .fontSize(13).lineHeight('19fp').fontColor($r('app.color.text_primary')).width('100%');
                    Row({ space: 12 }) {
                      Button('确认删除', { type: ButtonType.Normal }).id('confirmDeleteNode').constraintSize({ minHeight: 34 }).borderRadius(17)
                        .fontSize(13).fontColor($r('app.color.danger')).backgroundColor($r('app.color.surface_secondary'))
                        .enabled(this.editable).onClick(() => { this.remove(node.id); });
                      Button('取消', { type: ButtonType.Normal }).id('cancelDeleteNode').constraintSize({ minHeight: 34 }).borderRadius(17)
                        .fontSize(13).fontColor($r('app.color.text_secondary')).backgroundColor($r('app.color.surface_secondary'))
                        .onClick(() => { this.deleteId = ''; });
                    }.width('100%');
                  }
                }.padding({ left: 16, right: 12, top: 14, bottom: 14 }).width('100%').alignItems(HorizontalAlign.Start);
                Divider().color($r('app.color.border')).strokeWidth(0.5);
              }, (node: SavedNode) => node.id)
            }.width('100%').backgroundColor($r('app.color.surface')).borderRadius(16).clip(true);
          }
          if (this.filtered().length > this.limit) {
            Button('显示更多', { type: ButtonType.Normal }).id('showMoreNodes').constraintSize({ minHeight: 40 }).width('100%')
              .fontSize(14).fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface'))
              .borderRadius(12).onClick(() => { this.limit += 50; });
          }
          if (this.nodes.length === 0) {
            Column({ space: 8 }) {
              Text('还没有节点').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
              Text('点击右上角“添加”，扫码、粘贴链接或添加订阅。')
                .fontSize(14).lineHeight('21fp').fontColor($r('app.color.text_secondary')).textAlign(TextAlign.Center);
            }.id('nodesEmptyState').width('100%').padding({ top: 48, bottom: 48, left: 16, right: 16 });
          } else if (this.filtered().length === 0) {
            Column({ space: 8 }) {
              Text('没有匹配的节点').fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
              Text('试试其他名称或协议。').fontSize(14).fontColor($r('app.color.text_secondary'));
            }.id('nodeSearchEmpty').width('100%').padding({ top: 40, bottom: 40 });
          }
          Text('检测为 HTTPS 请求耗时，包含域名解析，不含 VPN 启动时间。检测会短暂建立仅用于本应用的 VPN，结束后自动断开。')
            .fontSize(12).lineHeight('18fp').fontColor($r('app.color.text_secondary')).width('100%');
        }.width('100%').padding({ left: 20, right: 20, bottom: 20 }).alignItems(HorizontalAlign.Start);
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top);
      if (this.testingId) {
        Row({ space: 12 }) {
          Text('节点 HTTPS 检测中').fontSize(13).fontColor($r('app.color.accent')).layoutWeight(1);
          Button('取消节点检测', { type: ButtonType.Normal }).id('cancelNodeLatency').constraintSize({ minHeight: 36 }).borderRadius(18)
            .fontSize(13).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
            .onClick(() => { this.cancelLatency(); });
        }.width('100%').padding({ left: 20, right: 20, top: 10, bottom: 10 })
          .backgroundColor($r('app.color.surface'));
      }
      AppTabBar({ current: 'nodes' });
    }.width('100%').height('100%').backgroundColor($r('app.color.page_bg'));
  }

  @Builder
  private addNodeMenu() {
    Menu() {
      MenuItem({ content: '扫码或粘贴节点' }).id('importNodes').contentFontColor($r('app.color.text_primary'))
        .enabled(this.editable).onClick(() => { this.getUIContext().getRouter().pushUrl({ url: 'pages/NodeConfig' }); });
      MenuItem({ content: '添加与管理订阅' }).id('manageSubscriptions').contentFontColor($r('app.color.text_primary'))
        .enabled(this.editable).onClick(() => { this.getUIContext().getRouter().pushUrl({ url: 'pages/Subscriptions' }); });
    }.backgroundColor($r('app.color.surface'));
  }

  @Builder
  private nodeActionsMenu(node: SavedNode) {
    Menu() {
      MenuItem({ content: '改名' }).id(`renameNode-${node.id}`).contentFontColor($r('app.color.text_primary'))
        .enabled(this.editable).onClick(() => { this.renameId = node.id; this.renameText = node.name; });
      MenuItem({ content: '删除' }).id(`deleteNode-${node.id}`).contentFontColor($r('app.color.danger'))
        .enabled(this.editable).onClick(() => { this.deleteId = node.id; });
    }.backgroundColor($r('app.color.surface'));
  }
}
