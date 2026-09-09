import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { vpnExtension } from '@kit.NetworkKit';
import native from 'libvpnbridge.so';
import { SavedNode, SubscriptionSource, readNodeCatalog, selectCatalogNode, renameCatalogNode, deleteCatalogNode } from '../model/NodeCatalog';
import { isNodeManagementAllowed } from '../model/NodeEditGuard';
import { ConnectionCommand, ConnectionStatus, readConnectionCommand, readConnectionStatus, writeConnectionCommand } from '../model/ConnectionControl';
import { ProbeState, readProbeState, writeProbeState } from '../model/ProbeState';
import { NodeLatencyResult, fingerprintOutbound, latencyLabel, readNodeLatencies } from '../model/NodeLatency';
import { LatencyRequest, writeLatencyRequest, writeLatencyProof } from '../model/LatencyProtocol';
import { measureNodeLatency } from '../model/LatencyProbe';
import { BatchLatencyTarget, BatchLatencyObservation, BatchLatencyQueue, latencySortRank } from '../model/BatchLatency';
import { AppTabBar } from '../components/AppTabBar';
import { AppSideNav } from '../components/AppSideNav';
import { useSideNavigation, nodeListContentWidth } from '../model/AdaptiveLayout';
import { VPN_CORE_AVAILABLE } from '../model/BuildCapabilities';

@Entry
@Component
struct Nodes {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State nodes: SavedNode[] = [];
  @State sources: SubscriptionSource[] = [];
  @State activeId: string = '';
  @State message: string = '';
  @State editable: boolean = false;
  @State search: string = '';
  @State latencyHelpExpanded: boolean = false;
  @State limit: number = 50;
  @State renameId: string = '';
  @State renameText: string = '';
  @State deleteId: string = '';
  @State latencies: NodeLatencyResult[] = [];
  @State testingId: string = '';
  @State preparing: boolean = false;
  @State batchActive: boolean = false;
  @State batchProgress: string = '';
  @State sortByLatency: boolean = false;
  private batchQueue: BatchLatencyQueue | undefined = undefined;
  private pageVisible: boolean = true;
  private catalogReadable: boolean = true;
  private timer: number = -1;
  private latencyRequest: LatencyRequest | undefined = undefined;
  private latencyServicePid: number = 0;
  private probeStarted: boolean = false;
  private cancelling: boolean = false;
  private pageEpoch: number = 0;
  private resultEpoch: number = 0;

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void { this.reload(); }
  onPageShow(): void {
    this.pageVisible = true;
    this.reload();
    this.pollLatency();
    if (this.timer < 0) { this.timer = setInterval(() => { this.pollLatency(); }, 500); }
  }
  onPageHide(): void {
    this.pageVisible = false; this.cancelLatency(); this.resultEpoch++;
    if (this.timer >= 0) { clearInterval(this.timer); this.timer = -1; }
  }
  aboutToDisappear(): void { this.onPageHide(); }

  private canEdit(): boolean {
    return this.catalogReadable && this.pageVisible && !this.preparing && !this.testingId && !this.batchActive && this.canStartLatencyService();
  }

  private canStartLatencyService(): boolean {
    const filesDir = this.context().filesDir;
    if (!isNodeManagementAllowed(filesDir)) { return false; }
    // Also protect a newly created Nodes page, which has no in-memory request
    // but can still see a previous extension's terminal status and live PID.
    const status = readConnectionStatus(filesDir);
    if (status && Number.isSafeInteger(status.servicePid) && status.servicePid > 0) {
      try { return native.processAlive(status.servicePid) === false; } catch (_) { return false; }
    }
    return true;
  }

  private serviceExitConfirmed(request: LatencyRequest, status?: ConnectionStatus): boolean {
    if (status?.runId === request.runId && Number.isSafeInteger(status.servicePid) && status.servicePid > 0) {
      if (this.latencyServicePid > 0 && this.latencyServicePid !== status.servicePid) { return false; }
      this.latencyServicePid = status.servicePid;
    }
    if (this.latencyServicePid > 0) {
      try { return native.processAlive(this.latencyServicePid) === false; } catch (_) { return false; }
    }
    return false;
  }

  private reload(): void {
    try {
      const catalog = readNodeCatalog(this.context().filesDir);
      this.nodes = catalog.nodes;
      this.sources = catalog.subscriptions;
      this.activeId = catalog.activeNodeId;
      this.catalogReadable = true;
      this.editable = this.canEdit();
      this.refreshLatencies();
    } catch (_) { this.catalogReadable = false; this.message = '节点列表读取失败，原数据已保留。'; this.editable = false; }
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

  private async startLatency(id: string, batchTarget?: BatchLatencyTarget): Promise<void> {
    if (!VPN_CORE_AVAILABLE) { this.message = '此模拟器构建仅用于界面验证，不提供 VPN 节点检测。'; return; }
    const filesDir = this.context().filesDir;
    if (!this.pageVisible || this.preparing || this.testingId || !this.canStartLatencyService() ||
      (this.batchActive && (!batchTarget || this.batchQueue?.next()?.nodeId !== batchTarget.nodeId))) { return; }
    if (!batchTarget) { this.batchQueue = undefined; this.batchProgress = ''; }
    this.preparing = true; this.editable = false;
    const epoch = this.pageEpoch;
    let attemptedRequest: LatencyRequest | undefined = undefined;
    try {
      const node = readNodeCatalog(filesDir).nodes.find((item: SavedNode) => item.id === id);
      if (!node) { throw new Error('missing'); }
      const fingerprint = await fingerprintOutbound(node.outboundJson);
      if (epoch !== this.pageEpoch || !this.pageVisible) { return; }
      const catalog = readNodeCatalog(filesDir);
      const latest = catalog.nodes.find((item: SavedNode) => item.id === id);
      if (!latest || latest.outboundJson !== node.outboundJson || !this.canStartLatencyService() ||
        (batchTarget && (!this.batchActive || fingerprint !== batchTarget.outboundFingerprint || catalog.activeNodeId !== this.batchQueue?.activeNodeId))) {
        throw new Error('changed');
      }
      const request = new LatencyRequest(Date.now().toString(), id, fingerprint);
      if (batchTarget && !this.batchQueue?.claim(id, request.runId, readConnectionStatus(filesDir)?.runId ?? '')) { throw new Error('queue'); }
      attemptedRequest = request;
      this.latencyRequest = request; this.latencyServicePid = 0; this.testingId = id; this.probeStarted = false; this.cancelling = false;
      writeLatencyRequest(filesDir, request);
      writeConnectionCommand(filesDir, new ConnectionCommand(request.runId, 'start'));
      writeProbeState(filesDir, new ProbeState('starting', '正在准备节点 HTTPS 检测。', request.runId, 'node-latency'));
      this.message = '短时 VPN 仅接管本应用，检测后自动断开；当前选中节点保持不变。';
      this.updateBatchProgress();
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
      if (epoch === this.pageEpoch) {
        if (batchTarget) { this.stopBatch('start-failed'); }
        this.message = batchTarget ? '批量检测已停止：节点配置或 VPN 授权未就绪，请检查后重新开始。' : '节点检测未启动，请检查 VPN 授权和网络后重试。';
      }
    } finally { if (epoch === this.pageEpoch) { this.preparing = false; this.pollLatency(); } }
  }

  private async startBatch(): Promise<void> {
    if (!VPN_CORE_AVAILABLE) { this.message = '此模拟器构建仅用于界面验证，不提供 VPN 节点检测。'; return; }
    if (!this.canEdit()) { return; }
    const selected = this.filtered().slice(0, 500);
    if (selected.length === 0) { return; }
    const filesDir = this.context().filesDir;
    const epoch = this.pageEpoch;
    this.batchActive = true; this.preparing = true; this.editable = false;
    this.batchQueue = undefined;
    this.renameId = ''; this.deleteId = ''; this.batchProgress = `正在准备 ${selected.length} 个筛选结果的检测快照…`;
    try {
      const activeId = readNodeCatalog(filesDir).activeNodeId;
      const targets: BatchLatencyTarget[] = [];
      for (const node of selected) {
        const fingerprint = await fingerprintOutbound(node.outboundJson);
        if (epoch !== this.pageEpoch || !this.pageVisible || !this.batchActive) { return; }
        targets.push(new BatchLatencyTarget(node.id, fingerprint));
      }
      if (!this.canStartLatencyService() || readNodeCatalog(filesDir).activeNodeId !== activeId) { throw new Error('changed'); }
      this.batchQueue = new BatchLatencyQueue(targets, activeId);
      this.preparing = false;
      await this.startNextBatch();
    } catch (_) {
      if (epoch === this.pageEpoch) { this.stopBatch('snapshot-failed'); this.message = '检测快照未能建立，请检查节点和连接状态后重试。'; }
    } finally {
      if (epoch === this.pageEpoch) { this.preparing = false; this.editable = this.canEdit(); }
    }
  }

  private async startNextBatch(): Promise<void> {
    if (!this.batchActive || !this.pageVisible || this.preparing || this.testingId) { return; }
    const target = this.batchQueue?.next();
    if (!target || !this.canStartLatencyService()) {
      this.stopBatch('state-changed'); this.message = '批量检测已停止：连接状态发生变化。'; return;
    }
    await this.startLatency(target.nodeId, target);
  }

  private updateBatchProgress(): void {
    const queue = this.batchQueue;
    if (!queue) { return; }
    this.batchProgress = `已完成 ${queue.completed}/${queue.targets.length}` +
      (this.batchActive ? ` · 正在检测第 ${Math.min(queue.completed + 1, queue.targets.length)} 个` : queue.phase === 'completed' ? ' · 检测结束' : ' · 已停止后续检测');
  }

  private stopBatch(reason: string): void {
    this.batchQueue?.cancel(reason); this.batchActive = false;
    if (this.batchQueue) { this.updateBatchProgress(); }
    else if (this.batchProgress) { this.batchProgress = '批量检测已取消，未启动后续节点。'; }
  }

  private observeBatch(request: LatencyRequest, status: ConnectionStatus | undefined, serviceExited: boolean): string {
    const queue = this.batchQueue;
    if (!this.batchActive || !queue) { return 'waiting'; }
    try {
      const filesDir = this.context().filesDir;
      const state = readProbeState(filesDir), command = readConnectionCommand(filesDir);
      const value = new BatchLatencyObservation();
      value.activeNodeId = readNodeCatalog(filesDir).activeNodeId;
      value.runId = state.runId; value.kind = state.kind; value.phase = state.phase;
      value.commandRunId = command?.runId ?? ''; value.commandAction = command?.action ?? '';
      value.statusRunId = status?.runId ?? ''; value.statusPhase = status?.phase ?? '';
      value.cleanupConfirmed = status?.cleanupConfirmed === true; value.reconnectCount = status?.reconnectCount ?? 0;
      value.servicePid = status?.runId === request.runId && Number.isSafeInteger(status.servicePid) && status.servicePid > 0 ?
        status.servicePid : this.latencyServicePid;
      value.serviceExited = serviceExited;
      if (['stopped', 'failed'].includes(state.phase)) {
        const result = readNodeLatencies(filesDir).find((item: NodeLatencyResult) => item.nodeId === request.nodeId);
        if (result) {
          value.resultRunId = result.runId; value.resultNodeId = result.nodeId; value.resultFingerprint = result.outboundFingerprint;
          value.resultStatus = result.status; value.resultReason = result.reason;
        }
      }
      return queue.observe(value);
    } catch (_) { queue.cancel('state-unreadable'); return 'aborted'; }
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
    this.editable = this.canEdit();
    const request = this.latencyRequest;
    if (!request) { return; }
    const state = readProbeState(filesDir);
    const status = readConnectionStatus(filesDir);
    const serviceExited = this.serviceExitConfirmed(request, status);
    const batchAction = this.observeBatch(request, status, serviceExited);
    if (batchAction === 'aborted') {
      this.stopBatch(this.batchQueue?.reason ?? 'state-changed'); this.cancelLatency();
      this.message = '批量检测已停止：授权、节点、网络或会话状态发生变化；正在清理当前检测。';
    }
    if (!this.probeStarted && this.probeCurrent(request, this.pageEpoch) && this.pageVisible) {
      this.probeStarted = true; this.probeLatency(request);
    }
    const serviceReleased = this.latencyServicePid > 0 ? serviceExited :
      status?.runId !== request.runId || status.phase === 'destroyed' && status.cleanupConfirmed === true;
    const released = !this.preparing && serviceReleased && isNodeManagementAllowed(filesDir);
    if (!this.cancelling && ['stopped', 'failed'].includes(state.phase) && this.latencyServicePid > 0 && !serviceExited) {
      this.message = '当前检测已结束，正在等待临时 VPN 进程退出…';
    }
    // A terminal probe message alone is insufficient for the batch: observeBatch
    // waits for a known PID to exit, with cleanup fallback only when no PID
    // has ever been observed for the session.
    if (this.batchActive && batchAction === 'waiting') { return; }
    if ((state.runId !== request.runId && serviceReleased) || released) {
      const wasCancelling = this.cancelling;
      const cleanupDetail = this.latencyServicePid > 0 ? '临时 VPN 进程已退出' : '本次检测已清理';
      this.latencyRequest = undefined; this.latencyServicePid = 0; this.testingId = ''; this.probeStarted = false;
      this.cancelling = false;
      if (batchAction === 'next') {
        this.updateBatchProgress(); this.refreshLatencies(); this.startNextBatch(); return;
      }
      if (batchAction === 'completed') {
        this.batchActive = false; this.updateBatchProgress(); this.message = '筛选结果已依次检测完毕，临时 VPN 已停止；当前选中节点保持不变。';
      } else if (this.batchProgress) {
        if (this.batchQueue?.reason === 'cancelled') {
          this.message = `批量检测已停止，${cleanupDetail}，未启动后续节点。`;
        } else if (this.batchQueue?.reason === 'start-failed') {
          this.message = '批量检测未能启动，未继续检测后续节点；请检查节点配置或 VPN 授权后重试。';
        } else {
          this.message = `批量检测已停止，${cleanupDetail}；请检查授权、节点或网络后重新开始。`;
        }
      } else {
        this.message = wasCancelling ? `检测已取消，${cleanupDetail}。` :
          state.runId === request.runId && state.phase === 'failed' ? '检测未完成，请检查授权、节点和网络后重试。' : '检测已结束，临时 VPN 已停止。';
      }
      this.editable = this.canEdit();
      this.refreshLatencies();
    }
  }

  private cancelLatency(): void {
    const request = this.latencyRequest;
    const hadWork = !!request || this.preparing || this.batchActive;
    this.stopBatch('cancelled');
    this.cancelling = true; this.preparing = false; this.pageEpoch++;
    if (!request) { if (hadWork) { this.message = '已取消检测，未启动后续节点。'; } this.editable = this.canEdit(); return; }
    try {
      const state = readProbeState(this.context().filesDir);
      if (state.runId === request.runId) { writeConnectionCommand(this.context().filesDir, new ConnectionCommand(request.runId, 'stop')); }
    } catch (_) { this.message = '取消请求未保存，检测将在时限内自动结束。'; }
    this.message = '正在取消检测并清理临时 VPN…';
  }

  private filtered(): SavedNode[] {
    const query = this.search.trim().toLowerCase();
    const nodes = this.nodes.filter((node: SavedNode) => node.name.toLowerCase().includes(query) || node.protocol.includes(query));
    if (this.sortByLatency) {
      nodes.sort((left: SavedNode, right: SavedNode): number => {
        const leftResult = this.latencies.find((item: NodeLatencyResult) => item.nodeId === left.id);
        const rightResult = this.latencies.find((item: NodeLatencyResult) => item.nodeId === right.id);
        const leftRank = latencySortRank(leftResult?.status ?? '', leftResult?.durationMs ?? 0);
        const rightRank = latencySortRank(rightResult?.status ?? '', rightResult?.durationMs ?? 0);
        return leftRank === rightRank ? 0 : leftRank < rightRank ? -1 : 1;
      });
    }
    return nodes;
  }
  private visibleNodes(): SavedNode[] { return this.filtered().slice(0, this.limit); }
  private sourceName(id: string): string { return id ? (this.sources.find((item: SubscriptionSource) => item.id === id)?.name ?? '订阅') : '手动导入'; }

  private select(id: string): void {
    if (!this.canEdit()) { this.message = '请先断开连接或等待检测结束，再修改节点。'; return; }
    try {
      selectCatalogNode(this.context().filesDir, id);
      this.reload(); this.message = '已切换当前节点，返回首页后连接。';
      hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_SELECTION_SAVED');
    } catch (_) { this.message = '切换未完成，请先断开连接。'; }
  }
  private rename(): void {
    if (!this.canEdit()) { this.message = '请先断开连接或等待检测结束，再修改节点。'; return; }
    try {
      renameCatalogNode(this.context().filesDir, this.renameId, this.renameText);
      this.renameId = ''; this.renameText = ''; this.reload(); this.message = '名称已保存。';
    } catch (_) { this.message = '改名未完成，请检查名称并先断开连接。'; }
  }
  private remove(id: string): void {
    if (!this.canEdit()) { this.message = '请先断开连接或等待检测结束，再修改节点。'; return; }
    try {
      deleteCatalogNode(this.context().filesDir, id);
      this.deleteId = ''; this.reload(); this.message = '节点已删除。';
      hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_REMOVED');
    } catch (_) { this.message = '删除未完成，请先断开连接。'; }
  }

  private clearSearch(): void { this.search = ''; this.limit = 50; }

  private searchResultText(): string {
    return this.search.trim().length > 0 ? `匹配 ${this.filtered().length} 个 · 已显示 ${this.visibleNodes().length} 个` :
      `显示 ${this.visibleNodes().length} / ${this.nodes.length} 个节点`;
  }

  private batchButtonText(): string { return `检测当前 ${Math.min(this.filtered().length, 500)} 项`; }

  private toggleLatencyHelp(): void { this.latencyHelpExpanded = !this.latencyHelpExpanded; }

  private wideNodeRows(): boolean { return nodeListContentWidth(this.windowWidthVp) >= 680; }

  private nodeInformationWidth(): number {
    // The list has 20 vp outer padding and each row has 16/12 vp padding.
    // Wide rows reserve 276 vp for controls and a 12 vp inter-column gap.
    const innerWidth = nodeListContentWidth(this.windowWidthVp) - 40 - 28;
    return Math.max(1, innerWidth - (this.wideNodeRows() ? 288 : 0));
  }

  build() {
    Row() {
      if (useSideNavigation(this.windowWidthVp)) { AppSideNav({ current: 'nodes' }); }
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
      }.width(nodeListContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, top: 16, bottom: 14 });
      Scroll() {
        Column({ space: 12 }) {
          if (!VPN_CORE_AVAILABLE) {
            Text('界面预览：节点管理可用，此包不提供 VPN 检测。').id('previewNodeNotice')
              .fontSize(13).lineHeight('20fp').fontColor($r('app.color.warning')).width('100%');
          }
          Row({ space: 8 }) {
            TextInput({ text: this.search, placeholder: '搜索名称或协议' }).id('nodeSearch').constraintSize({ minHeight: 44 })
              .fontSize(15).fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(12).layoutWeight(1)
              .onChange((value: string) => { this.search = value; this.limit = 50; });
            if (this.search.length > 0) {
              Button('清空', { type: ButtonType.Normal }).id('clearNodeSearch').constraintSize({ minHeight: 44, minWidth: 48 })
                .padding({ left: 8, right: 8 }).fontSize(13).fontColor($r('app.color.accent')).backgroundColor(Color.Transparent)
                .accessibilityText('清空节点搜索').onClick(() => { this.clearSearch(); });
            }
          }.width('100%');
          Text(this.searchResultText()).id('nodeSearchResultCount').fontSize(12).fontColor($r('app.color.text_secondary'));
          Row({ space: 8 }) {
            Button({ type: ButtonType.Normal }) {
              Text(this.batchButtonText()).fontSize(13).fontColor($r('app.color.accent'))
                .width('100%').textAlign(TextAlign.Center);
            }.id('testFilteredNodes').constraintSize({ minHeight: 44 }).borderRadius(14).layoutWeight(1)
              .padding({ left: 10, right: 10, top: 10, bottom: 10 }).backgroundColor($r('app.color.accent_soft'))
              .enabled(VPN_CORE_AVAILABLE && this.editable && this.filtered().length > 0).onClick(() => { this.startBatch(); });
            Button({ type: ButtonType.Normal }) {
              Text(this.sortByLatency ? '恢复原顺序' : '按 HTTPS 耗时排序').fontSize(13).fontColor($r('app.color.text_secondary'))
                .width('100%').textAlign(TextAlign.Center);
            }.id('sortNodeLatency').constraintSize({ minHeight: 44 }).borderRadius(14).layoutWeight(1)
              .padding({ left: 10, right: 10, top: 10, bottom: 10 }).backgroundColor($r('app.color.surface_secondary'))
              .onClick(() => { this.sortByLatency = !this.sortByLatency; });
          }.width(this.wideNodeRows() ? 448 : '100%');
          Row({ space: 8 }) {
            Text('检测仅临时接管本应用，结束后自动断开。').id('nodeLatencyScopeNotice')
              .fontSize(12).fontColor($r('app.color.text_secondary')).layoutWeight(1);
            Button(this.latencyHelpExpanded ? '收起说明' : '检测说明', { type: ButtonType.Normal }).id('toggleNodeLatencyHelp')
              .constraintSize({ minHeight: 44 }).padding({ left: 8, right: 0 }).fontSize(12)
              .fontColor($r('app.color.accent')).backgroundColor(Color.Transparent)
              .accessibilityText(this.latencyHelpExpanded ? '收起节点检测说明' : '展开节点检测说明')
              .onClick(() => { this.toggleLatencyHelp(); });
          }.width('100%');
          if (this.latencyHelpExpanded) {
            Column({ space: 8 }) {
              Text('批量检测在点击时固定筛选结果，包含尚未展开的节点，最多 500 个。之后切换搜索或排序不会改变已开始的队列；每个节点会逐个建立并清理临时 VPN。')
                .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
              Text('结果是一次 HTTPS 请求耗时，包含域名解析，不含 VPN 启动时间，不代表带宽或 TCP 往返延迟。检测不会切换当前选中节点。')
                .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            }.id('nodeLatencyHelp').padding(14).width('100%').alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.surface_secondary')).borderRadius(12);
          }
          if (this.batchProgress) {
            Text(this.batchProgress).id('batchLatencyProgress').fontSize(13).lineHeight('19fp')
              .fontColor($r('app.color.accent')).width('100%');
          }
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
                  Flex({ direction: this.wideNodeRows() ? FlexDirection.Row : FlexDirection.Column,
                    alignItems: ItemAlign.Center, justifyContent: FlexAlign.SpaceBetween }) {
                    Column({ space: 5 }) {
                      Row({ space: 8 }) {
                        if (node.id === this.activeId) {
                          Text('当前').id(`currentNodeBadge-${node.id}`).fontSize(11).fontWeight(FontWeight.Medium)
                            .fontColor($r('app.color.accent')).padding({ left: 6, right: 6, top: 3, bottom: 3 })
                            .backgroundColor($r('app.color.surface')).borderRadius(6);
                        }
                        Text(node.name).id(`nodeName-${node.id}`).fontSize(17).fontWeight(FontWeight.Medium)
                          .fontColor($r('app.color.text_primary')).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
                          .lineHeight('23fp').layoutWeight(1);
                      }.width('100%').alignItems(VerticalAlign.Top);
                      Text(`${node.protocol.toUpperCase()} · ${this.sourceName(node.sourceId)}`)
                        .fontSize(12).fontColor($r('app.color.text_secondary')).maxLines(2)
                        .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%');
                      Text(this.latencyText(node.id)).id(`nodeLatency-${node.id}`).fontSize(12).lineHeight('18fp')
                        .fontColor(node.id === this.testingId ? $r('app.color.accent') : $r('app.color.text_secondary')).width('100%');
                    }.width(this.nodeInformationWidth()).alignItems(HorizontalAlign.Start);
                    Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.End, alignItems: ItemAlign.Center }) {
                      Button('检测', { type: ButtonType.Normal }).id(`testNodeLatency-${node.id}`)
                        .constraintSize({ minHeight: 44, minWidth: 64 }).padding({ left: 10, right: 10 }).borderRadius(14).fontSize(13)
                        .margin({ right: 8, top: 4, bottom: 4 }).fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface_secondary'))
                        .enabled(VPN_CORE_AVAILABLE && this.editable && !this.preparing && !this.testingId)
                        .onClick(() => { this.startLatency(node.id); });
                      Button({ type: ButtonType.Normal }) {
                        Text(node.id === this.activeId ? '已选中' : '选用')
                          .id(node.id === this.activeId ? 'activeNodeLabel' : `nodeSelectLabel-${node.id}`)
                          .fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.accent'));
                      }.id(`selectNode-${node.id}`).constraintSize({ minHeight: 44, minWidth: 76 }).padding({ left: 10, right: 10 }).borderRadius(14)
                        .margin({ right: 8, top: 4, bottom: 4 }).backgroundColor(node.id === this.activeId ? $r('app.color.surface') : $r('app.color.surface_secondary'))
                        .enabled(node.id === this.activeId || this.editable)
                        .accessibilityDescription(node.id === this.activeId ? '当前节点' : '设为当前节点')
                        .onClick(() => { if (this.editable && node.id !== this.activeId) { this.select(node.id); } });
                      Button('更多', { type: ButtonType.Normal }).id(`nodeMore-${node.id}`)
                        .constraintSize({ minHeight: 44, minWidth: 64 }).padding({ left: 10, right: 10 }).fontSize(13)
                        .margin({ top: 4, bottom: 4 }).fontColor($r('app.color.text_secondary')).backgroundColor(Color.Transparent)
                        .enabled(this.editable).bindMenu(this.nodeMenuItems(node));
                    }.width(this.wideNodeRows() ? 276 : '100%')
                      .margin({ left: this.wideNodeRows() ? 12 : 0, top: this.wideNodeRows() ? 0 : 6 });
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
                }.id(`nodeRow-${node.id}`).padding({ left: 16, right: 12, top: 14, bottom: 14 }).width('100%')
                  .alignItems(HorizontalAlign.Start).backgroundColor(node.id === this.activeId ? $r('app.color.accent_soft') : $r('app.color.surface'));
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
        }.id('nodeListContent').width(nodeListContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, bottom: 20 }).alignItems(HorizontalAlign.Start);
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top);
      if (this.testingId || this.batchActive) {
        Row({ space: 12 }) {
          Text(this.batchActive ? '正在依次检测节点' : '节点 HTTPS 检测中').fontSize(13).fontColor($r('app.color.accent')).layoutWeight(1);
          Button(this.batchActive ? '取消后续检测' : '取消节点检测', { type: ButtonType.Normal }).id('cancelNodeLatency').constraintSize({ minHeight: 36 }).borderRadius(18)
            .fontSize(13).fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
            .onClick(() => { this.cancelLatency(); });
        }.width(nodeListContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, top: 10, bottom: 10 })
          .backgroundColor($r('app.color.surface'));
      }
      if (!useSideNavigation(this.windowWidthVp)) { AppTabBar({ current: 'nodes' }); }
    }.layoutWeight(1).height('100%');
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

  private nodeMenuItems(node: SavedNode): MenuElement[] {
    // Use ArkUI's data menu for per-row actions. Parameterized deferred builders
    // in this ForEach did not render a menu on the API 26 device.
    return [
      { value: '编辑节点', enabled: this.editable, action: () => {
        if (this.canEdit()) {
          this.getUIContext().getRouter().pushUrl({ url: 'pages/NodeEditor', params: { nodeId: node.id } })
            .catch(() => { this.message = '编辑页暂时无法打开，请重试。'; });
        }
      } },
      { value: '导出节点 JSON', enabled: this.editable, action: () => {
        if (this.canEdit()) {
          this.getUIContext().getRouter().pushUrl({ url: 'pages/NodeBackup', params: { nodeId: node.id } })
            .catch(() => { this.message = '导出页暂时无法打开，请重试。'; });
        }
      } },
      { value: '改名', enabled: this.editable, action: () => {
        if (this.canEdit()) { this.renameId = node.id; this.renameText = node.name; }
      } },
      { value: '删除', enabled: this.editable, action: () => {
        if (this.canEdit()) { this.deleteId = node.id; }
      } }
    ];
  }
}
