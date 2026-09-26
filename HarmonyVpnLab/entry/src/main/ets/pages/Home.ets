import { common } from '@kit.AbilityKit';
import { vpnExtension, http } from '@kit.NetworkKit';
import { notificationManager } from '@kit.NotificationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ProbeState, readProbeState, writeProbeState } from '../model/ProbeState';
import { readNodeProfile } from '../model/NodeProfile';
import { describeError } from '../model/ErrorInfo';
import { CONNECTION_UI_EPOCH, ConnectionCommand, isConnectionKind, readConnectionCommand, writeConnectionCommand } from '../model/ConnectionControl';
import { formatBytes, prepareConnectionNotifications } from '../model/ConnectionNotification';
import { checkProxyDns, checkDirectDns, connectionExitMarker, probeIpv6Datagram } from '../model/ConnectionDiagnostics';
import { subscribeVpnAuthorization, unsubscribeVpnAuthorization } from '../model/VpnAuthorization';
import { readPhysicalNetwork, resolvePhysicalIpv4 } from '../model/PhysicalNetwork';
import { AppTabBar } from '../components/AppTabBar';
import { GlassDockLayout } from '../components/GlassDockLayout';
import { openMainTab } from '../model/MainNavigation';
import { AppSideNav } from '../components/AppSideNav';
import { useSideNavigation, primaryContentWidth, formContentWidth, homeUsesColumns } from '../model/AdaptiveLayout';
import { VPN_CORE_AVAILABLE } from '../model/BuildCapabilities';
import { readNetworkPolicy } from '../model/NetworkPolicyStore';
import { isSplitDnsActive, networkPolicyLabel } from '../model/NetworkPolicy';
import { appRoutingLabel } from '../model/AppRouting';
import { TransferRateTracker, formatTransferRate } from '../model/TransferRate';
import { readConnectionLifecycle } from '../model/ConnectionLifecycle';
import { recordConnectionRecovery } from '../model/ConnectionRecoveryStore';
import { ImportedNode } from '../model/NodeImport';
import { nodeIssue } from '../model/NodeIssue';
import { checkNodeForConnection } from '../model/NodePreflight';
import { ConnectionFailure, makeConnectionFailure, connectionFailureFromError, failureProblem } from '../model/ConnectionFailure';
import { FailureNotice } from '../components/FailureNotice';
import { consumeDockConnectionAction } from '../model/DockConnectionAction';
import { DnsFaultRequest, validDnsFaultAdmission } from '../model/DnsFaultTest';

@Entry
@Component
struct Home {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State dockHeight: number = 84;
  @State phase: string = 'idle';
  @State detail: string = '';
  @State hasNode: boolean = false;
  @State protocol: string = '';
  @State nodeName: string = '';
  @State requesting: boolean = false;
  @State closed: boolean = true;
  @State runId: string = '';
  @State uplink: number = 0;
  @State downlink: number = 0;
  @State uplinkRate: string = '—';
  @State downlinkRate: string = '—';
  @State rateAvailable: boolean = false;
  @State startedAt: number = 0;
  @State now: number = Date.now();
  @State ipv6Blocked: number = 0;
  @State dnsRequests: number = 0;
  @State exitMarker: string = '';
  @State checking: boolean = false;
  @State checkResult: string = '连接后可检查域名 HTTPS。';
  @State directDnsResult: string = '';
  @State proxyDnsResult: string = '';
  @State directDnsFailure: ConnectionFailure | undefined = undefined;
  @State dnsFaultHint: string = '';
  @State notificationsEnabled: boolean = true;
  @State networkKind: string = '';
  @State reconnectCount: number = 0;
  @State developerTools: boolean = false;
  @State routingSummary: string = '全部代理';
  @State routingHint: string = 'DNS 通过节点加密查询';
  @State configurationChecked: boolean = false;
  @State configurationIssueCode: string = '';
  @State profileUnreadable: boolean = false;
  @State startFailure: ConnectionFailure | undefined = undefined;
  @State checkFailure: ConnectionFailure | undefined = undefined;
  @State serviceFailure: ConnectionFailure | undefined = undefined;
  @State serviceCleanupFailure: ConnectionFailure | undefined = undefined;
  @State serviceCurrentIssue: ConnectionFailure | undefined = undefined;
  private profileNode: ImportedNode | undefined = undefined;
  private profileOutbound: string = '';
  private poll: number = -1;
  private authorizationSubscription: number = -1;
  private checkGeneration: number = 0;
  private checkRequest: http.HttpRequest | undefined = undefined;
  private startGeneration: number = 0;
  private rateTracker: TransferRateTracker = new TransferRateTracker();

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  aboutToAppear(): void {
    this.refreshProfile();
    this.refresh();
    if (this.poll < 0) { this.poll = setInterval(() => this.refresh(), 1000); }
    notificationManager.isNotificationEnabled().then((enabled: boolean) => { this.notificationsEnabled = enabled; }).catch(() => { this.notificationsEnabled = false; });
    try {
      if (this.authorizationSubscription >= 0) { return; }
      this.authorizationSubscription = subscribeVpnAuthorization((allowed: boolean) => {
        if (!allowed) {
          const current = readProbeState(this.context().filesDir);
          const command = readConnectionCommand(this.context().filesDir);
          if (isConnectionKind(current.kind) && current.phase === 'starting' && command?.runId === current.runId &&
            command.ownerEpoch === CONNECTION_UI_EPOCH) {
            writeConnectionCommand(this.context().filesDir, new ConnectionCommand(current.runId, 'stop'));
            writeProbeState(this.context().filesDir, new ProbeState('failed', '未获得 VPN 授权。', current.runId, current.kind));
            this.startGeneration++; this.requesting = false;
            this.startFailure = makeConnectionFailure('authorization');
            this.closed = true;
            this.refresh();
          }
        }
      });
    } catch (_) { /* Startup errors still return through the normal promise. */ }
  }

  aboutToDisappear(): void {
    this.cancelCheck();
    this.resetTransferRate();
    if (this.poll >= 0) { clearInterval(this.poll); this.poll = -1; }
    unsubscribeVpnAuthorization(this.authorizationSubscription);
    this.authorizationSubscription = -1;
  }

  onPageShow(): void {
    this.resetTransferRate();
    if (AppStorage.get<boolean>('openDeveloperTools') === true) {
      AppStorage.set('openDeveloperTools', false); this.developerTools = true;
    }
    this.refreshProfile();
    if (this.poll < 0) { this.poll = setInterval(() => this.refresh(), 1000); }
    this.refresh();
    void this.handleDockConnectionAction();
  }

  onPageHide(): void {
    this.cancelCheck();
    this.resetTransferRate();
    if (this.poll >= 0) { clearInterval(this.poll); this.poll = -1; }
  }

  onBackPress(): boolean {
    if (this.developerTools) { this.developerTools = false; return true; }
    return false;
  }

  private statusTone(): Resource {
    if (this.phase === 'active') { return $r('app.color.success'); }
    if (['failed', 'unknown'].includes(this.phase)) { return $r('app.color.danger'); }
    if (this.busy()) { return $r('app.color.warning'); }
    return $r('app.color.text_secondary');
  }

  private statusHint(): string {
    if (!this.busy() && this.configurationIssueCode.length > 0) {
      return nodeIssue(this.configurationIssueCode).problem + ' 请查看下方配置检查。';
    }
    if (!VPN_CORE_AVAILABLE) { return '此构建用于界面与交互验证。'; }
    if (!this.hasNode) { return '添加一个节点，开始使用。'; }
    switch (this.phase) {
      case 'active': return '按当前网络设置转发 IPv4 流量。';
      case 'starting': return '正在建立连接，请稍候。';
      case 'recovering': return '网络已变化，正在恢复连接。';
      case 'waiting-network': return '等待 Wi-Fi 或移动网络，也可以随时断开。';
      case 'stopping': case 'stop_requested': return '正在结束连接并释放资源。';
      case 'failed': case 'unknown': return '连接需要处理，可先断开或查看诊断记录。';
      case 'interrupted': return '上次 VPN 服务已结束，可重新连接。';
      case 'diagnostic': return '检测正在进行，结束后即可连接。';
      default: return '节点已就绪，点击连接即可开始。';
    }
  }

  private networkLabel(): string {
    const kind = this.networkKind === 'wifi' ? 'Wi-Fi' : this.networkKind === 'cellular' ? '移动数据' :
      this.phase === 'waiting-network' ? '暂无网络' : '网络检测中';
    return `${kind} · 已恢复 ${this.reconnectCount} 次`;
  }

  private refreshProfile(): void {
    const filesDir = this.context().filesDir;
    try {
      const node = readNodeProfile(filesDir);
      const outbound = node?.outboundJson ?? '';
      if (outbound !== this.profileOutbound || this.profileUnreadable) {
        this.configurationChecked = false; this.configurationIssueCode = '';
      }
      this.profileNode = node; this.profileOutbound = outbound; this.profileUnreadable = false;
      this.hasNode = node !== undefined;
      this.protocol = node?.protocol.toUpperCase() ?? '';
      this.nodeName = node?.name ?? '';
    } catch (_) {
      this.profileNode = undefined; this.profileOutbound = ''; this.profileUnreadable = true;
      this.hasNode = false; this.protocol = ''; this.nodeName = '';
      this.configurationChecked = true; this.configurationIssueCode = 'catalog-unreadable';
    }
    this.refreshNetworkSummary();
  }

  private inspectCurrentConfiguration(): ImportedNode | undefined {
    this.refreshProfile();
    this.configurationChecked = true;
    if (this.profileUnreadable) { this.configurationIssueCode = 'catalog-unreadable'; return undefined; }
    const node = this.profileNode;
    if (!node) { this.configurationIssueCode = 'node-missing'; return undefined; }
    try {
      const issues = checkNodeForConnection(node);
      this.configurationIssueCode = issues.length > 0 ? issues[0].code : '';
      return issues.length === 0 ? node : undefined;
    } catch (_) { this.configurationIssueCode = 'configuration-invalid'; return undefined; }
  }

  private refreshNetworkSummary(): void {
    try {
      const policy = readNetworkPolicy(this.context().filesDir);
      this.routingSummary = appRoutingLabel(policy.appMode, policy.appBundles.length);
      this.routingHint = networkPolicyLabel(policy) + (isSplitDnsActive(policy) ? ' · 部分域名直接查询' : ' · VPN 内 DNS 通过节点查询');
    } catch (_) {
      this.routingSummary = '网络设置需要检查';
      this.routingHint = '打开设置并重新保存后再连接';
    }
  }

  private async primaryAction(): Promise<void> {
    if (this.requesting || this.phase === 'diagnostic') { return; }
    if (this.busy()) { await this.disconnect(); return; }
    this.refreshProfile();
    if (this.profileUnreadable) { this.inspectCurrentConfiguration(); return; }
    if (!this.hasNode) {
      try { await this.getUIContext().getRouter().pushUrl({ url: 'pages/NodeConfig' }); }
      catch (_) { this.detail = '导入页面暂时无法打开，请从节点页重试。'; }
      return;
    }
    await this.connect();
  }

  private async handleDockConnectionAction(): Promise<void> {
    try {
      const request = consumeDockConnectionAction(this.context().filesDir, VPN_CORE_AVAILABLE);
      if (!request || this.requesting || this.developerTools) { return; }
      this.refresh();
      if (request.runId !== this.runId || this.phase === 'diagnostic') { return; }
      if (request.action === 'connect' && this.closed && !this.busy()) { await this.primaryAction(); }
      else if (request.action === 'disconnect' && !this.closed && this.busy()) { await this.disconnect(); }
    } catch (_) { this.detail = '快捷启停暂未完成，请在连接页重试。'; }
  }

  private openNetworkSettings(): void {
    this.getUIContext().getRouter().pushUrl({ url: 'pages/NetworkSettings' })
      .catch(() => { this.routingHint = '页面暂时无法打开，请从设置页重试。'; });
  }

  private refresh(): void {
    const filesDir = this.context().filesDir;
    this.now = Date.now();
    const fault = AppStorage.get<DnsFaultRequest>('pendingDnsFaultRequest');
    this.dnsFaultHint = this.context().applicationInfo?.debug && fault && validDnsFaultAdmission(fault, this.now)
      ? (fault.kind === 'http404' ? '本次验证：直连 DNS HTTP 404（最多 90 秒）' : fault.kind === 'timeout' ? '本次验证：直连 DNS 极短超时（最多 90 秒）' : '本次验证：正常分流 DNS（最多 5 分钟）') : '';
    const assessment = readConnectionLifecycle(filesDir, this.now);
    const state = assessment.state, command = assessment.command, status = assessment.status;
    if (this.runId !== state.runId) { this.startFailure = undefined; this.checkFailure = undefined; }
    this.serviceFailure = status?.runId === state.runId ? status.failure : undefined;
    this.serviceCleanupFailure = status?.runId === state.runId ? status.cleanupFailure : undefined;
    this.serviceCurrentIssue = status?.runId === state.runId && !assessment.closed ? status.currentIssue : undefined;
    if (assessment.interruptionObserved) {
      try { recordConnectionRecovery(filesDir, assessment); } catch (_) { /* Diagnostic storage cannot block recovery. */ }
    }
    if ((this.phase === 'active' && assessment.phase !== 'active') || this.runId !== state.runId) {
      this.cancelCheck(); this.checkResult = '网络状态已变化，请重新检查连接。';
    }
    this.runId = state.runId;
    this.phase = assessment.phase;
    this.detail = assessment.detail;
    this.closed = assessment.closed;
    if (!assessment.priorServiceUnresolved && isConnectionKind(state.kind) && state.phase === 'starting' && this.now - state.updatedAt > 25000 &&
      status?.runId !== state.runId && command?.runId === state.runId && command.ownerEpoch === CONNECTION_UI_EPOCH) {
      // API 24 has no authorization-result observer. No service has reported
      // this request, and the extension's 20-second admission window expired.
      // Cancel before allowing a retry; a late authorization cannot create TUN.
      writeConnectionCommand(filesDir, new ConnectionCommand(state.runId, 'stop'));
      this.phase = 'failed';
      this.detail = command.action === 'stop' ? '本次连接请求已取消。' : '未收到 VPN 启动结果，请确认授权后重试。';
      writeProbeState(filesDir, new ProbeState(this.phase, this.detail, state.runId, state.kind));
      this.startGeneration++; this.requesting = false;
      this.startFailure = makeConnectionFailure('start-request', 'timeout');
      this.closed = true;
      this.resetTransferRate();
      return;
    }
    const diagnostic = state.kind === 'node-latency' || !isConnectionKind(state.kind);
    if (diagnostic) {
      this.resetTransferRate();
      if (!assessment.closed && ['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'stop_requested'].includes(assessment.phase)) {
        this.phase = 'diagnostic';
        this.detail = state.kind === 'node-latency' ? '节点延迟检测正在运行，请在节点列表中查看或取消。' :
          '开发验证正在运行，请等待它结束。';
      }
      return;
    }
    if (status?.runId === state.runId && (status.reconnectCount ?? 0) !== this.reconnectCount) {
      this.cancelCheck();
      this.checkResult = '网络状态已变化，请重新检查连接。';
    }
    this.networkKind = status?.runId === state.runId ? (status.networkKind ?? '') : '';
    this.reconnectCount = status?.runId === state.runId ? (status.reconnectCount ?? 0) : 0;
    if (status?.runId === state.runId && status.snapshot) {
      this.uplink = status.snapshot.uplink;
      this.downlink = status.snapshot.downlink;
      this.startedAt = status.snapshot.startedAt;
      this.ipv6Blocked = status.snapshot.ipv6BlockedRequests;
      this.dnsRequests = status.snapshot.dnsRequests;
    }
    if (this.phase === 'active' && status?.runId === state.runId && status.phase === 'active' && !assessment.serviceExited) {
      const rate = this.rateTracker.update(state.runId, status.reconnectCount ?? 0, status.snapshot, this.now);
      this.rateAvailable = rate.available;
      this.uplinkRate = formatTransferRate(rate.available, rate.uplinkPerSecond);
      this.downlinkRate = formatTransferRate(rate.available, rate.downlinkPerSecond);
    } else { this.resetTransferRate(); }
  }

  private resetTransferRate(): void {
    this.rateTracker.reset();
    this.rateAvailable = false;
    this.uplinkRate = '—';
    this.downlinkRate = '—';
  }

  private cancelCheck(): void {
    this.checkGeneration++; this.checking = false; this.exitMarker = '';
    this.checkFailure = undefined; this.directDnsFailure = undefined;
    this.directDnsResult = ''; this.proxyDnsResult = '';
    try { this.checkRequest?.destroy(); } catch (_) {}
    this.checkRequest = undefined;
  }

  private busy(): boolean { return ['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'stop_requested', 'unknown', 'diagnostic'].includes(this.phase); }

  private label(): string {
    if (this.requesting) { return '正在请求授权'; }
    switch (this.phase) {
      case 'active': return '已连接';
      case 'starting': return '正在连接';
      case 'recovering': return '正在恢复连接';
      case 'waiting-network': return '等待网络';
      case 'stopping': case 'stop_requested': return '正在断开';
      case 'unknown': return '连接状态未知';
      case 'failed': return '连接中断';
      case 'interrupted': return '连接已结束';
      case 'diagnostic': return '正在验证';
      default: return '未连接';
    }
  }

  private duration(): string {
    const seconds = this.startedAt > 0 && ['active', 'recovering', 'waiting-network'].includes(this.phase) ? Math.max(0, Math.floor((this.now - this.startedAt) / 1000)) : 0;
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  }

  private async connect(kind: string = 'connection'): Promise<void> {
    if (!VPN_CORE_AVAILABLE) { this.detail = '模拟器界面预览不包含 VPN 转发核心。'; return; }
    this.refresh();
    if (this.busy() || this.requesting || !this.closed) { return; }
    const checkedNode = this.inspectCurrentConfiguration();
    if (!checkedNode) { return; }
    const filesDir = this.context().filesDir;
    const before = readConnectionLifecycle(filesDir);
    if (!before.closed) { this.refresh(); return; }
    this.requesting = true;
    const generation = ++this.startGeneration;
    let startedRunId: string = '';
    try {
      try { this.notificationsEnabled = await prepareConnectionNotifications(this.context()); } catch (_) { this.notificationsEnabled = false; }
      if (generation !== this.startGeneration) { return; }
      const current = readConnectionLifecycle(filesDir);
      if (!current.closed || current.state.runId !== before.state.runId ||
        (before.state.runId.length > 0 && current.state.updatedAt !== before.state.updatedAt) ||
        current.command?.runId !== before.command?.runId || current.command?.action !== before.command?.action ||
        current.command?.createdAt !== before.command?.createdAt || current.command?.ownerEpoch !== before.command?.ownerEpoch) {
        this.refresh(); return;
      }
      const currentNode = this.inspectCurrentConfiguration();
      if (!currentNode) { return; }
      if (currentNode.outboundJson !== checkedNode.outboundJson) {
        this.configurationIssueCode = 'node-changed'; return;
      }
      const runId = Date.now().toString();
      startedRunId = runId;
      this.startFailure = undefined; this.checkFailure = undefined;
      const startCommand = new ConnectionCommand(runId, 'start');
      if (kind === 'connection-app-test') {
        const fault = AppStorage.get<DnsFaultRequest>('pendingDnsFaultRequest');
        if (fault !== undefined) {
          AppStorage.delete('pendingDnsFaultRequest'); this.dnsFaultHint = '';
          if (!this.context().applicationInfo.debug || !validDnsFaultAdmission(fault, Date.now())) {
            this.detail = 'DNS 故障验证请求已过期或不可用，请重新准备。'; return;
          }
          startCommand.dnsFault = new DnsFaultRequest(fault.kind, fault.token, fault.createdAt);
        }
      }
      writeConnectionCommand(this.context().filesDir, startCommand);
      writeProbeState(this.context().filesDir, new ProbeState('starting', '正在建立 VPN 和代理 DNS。', runId, kind));
      this.runId = runId;
      this.checking = false;
      this.uplink = 0; this.downlink = 0; this.startedAt = 0;
      this.resetTransferRate();
      this.ipv6Blocked = 0; this.dnsRequests = 0; this.exitMarker = '';
      this.closed = false;
      this.checkResult = '连接后可检查域名 HTTPS。';
      this.refresh();
      await vpnExtension.startVpnExtensionAbility({
        bundleName: 'com.example.harmonyvpnlab', abilityName: 'VpnProbeAbility', parameters: { runId, kind }
      });
      if (generation !== this.startGeneration) { return; }
      hilog.info(0x0000, 'HarmonyVpnLab', 'CONNECTION_START_REQUESTED runId=%{public}s kind=%{public}s', runId, kind);
    } catch (error) {
      if (generation !== this.startGeneration) { return; }
      const current = readProbeState(this.context().filesDir);
      if (current.runId === startedRunId && current.phase === 'starting') {
        writeConnectionCommand(this.context().filesDir, new ConnectionCommand(current.runId, 'stop'));
        writeProbeState(this.context().filesDir, new ProbeState('failed', '连接未完成：' + describeError(error), current.runId, current.kind));
        this.startFailure = connectionFailureFromError(error, 'start-request');
      }
      this.refresh();
    } finally { if (generation === this.startGeneration) { this.requesting = false; } }
  }

  private async disconnect(): Promise<void> {
    const filesDir = this.context().filesDir;
    const observedRunId = this.runId;
    try {
      const current = readConnectionLifecycle(filesDir);
      const state = current.state, command = current.command;
      if (state.runId !== observedRunId || !isConnectionKind(state.kind) || current.closed ||
        (command !== undefined && command.runId !== state.runId)) { this.refresh(); return; }
      writeConnectionCommand(filesDir, new ConnectionCommand(state.runId, 'stop', command?.ownerEpoch ?? CONNECTION_UI_EPOCH));
      const pendingAge = Date.now() - state.updatedAt;
      if (!current.priorServiceUnresolved && current.status?.runId !== state.runId && state.phase === 'starting' &&
        Number.isFinite(pendingAge) && pendingAge > 25000) {
        // Explicitly cancel an expired request from the prior UI. The service's
        // admission window is over; this does not claim a cleanup receipt.
        const pendingState = readProbeState(filesDir), pendingCommand = readConnectionCommand(filesDir);
        if (pendingState.runId === observedRunId && pendingState.phase === 'starting' &&
          pendingState.updatedAt === state.updatedAt && pendingCommand?.runId === observedRunId && pendingCommand.action === 'stop') {
          writeProbeState(filesDir, new ProbeState('failed', '上次连接请求已取消，可重新连接。', observedRunId, state.kind));
          this.startGeneration++; this.requesting = false;
          this.refresh(); return;
        }
        this.refresh(); return;
      }
      if (current.phase === 'unknown' || current.phase === 'failed') {
        const latestState = readProbeState(filesDir), latestCommand = readConnectionCommand(filesDir);
        if (latestState.runId === observedRunId && latestCommand?.runId === observedRunId && latestCommand.action === 'stop') {
          await vpnExtension.stopVpnExtensionAbility({ bundleName: 'com.example.harmonyvpnlab', abilityName: 'VpnProbeAbility' });
        }
      }
      this.refresh();
    } catch (error) { this.detail = '断开请求未完成：' + describeError(error); }
  }

  private reconnect(): void {
    if (this.phase !== 'active') { return; }
    const current = readConnectionLifecycle(this.context().filesDir);
    const command = current.command;
    if (current.state.runId !== this.runId || current.phase !== 'active' || !command ||
      command.runId !== this.runId || command.action === 'stop') { this.refresh(); return; }
    try {
      writeConnectionCommand(this.context().filesDir, new ConnectionCommand(this.runId, 'reconnect', command.ownerEpoch));
      this.cancelCheck(); this.phase = 'recovering';
      this.resetTransferRate();
      this.checkResult = '正在请求重连。'; this.exitMarker = '';
    } catch (_) { this.detail = '重新连接请求未保存，请重试。'; }
  }

  private async checkPhysicalResolver(): Promise<void> {
    if (this.phase !== 'active' || this.checking) { return; }
    this.checkFailure = undefined;
    this.checking = true; this.checkResult = '正在检查物理网络 DNS…';
    const runId = this.runId;
    const generation = this.checkGeneration;
    const current = (): boolean => this.checkStillCurrent(runId, generation);
    try {
      const network = await readPhysicalNetwork();
      if (!current()) { return; }
      if (!network) { throw new Error('物理网络不可用'); }
      await resolvePhysicalIpv4('example.com', network, current);
      if (!current()) { return; }
      this.checkResult = '物理网络 DNS 检查通过，已得到 IPv4 结果。';
      hilog.info(0x0000, 'HarmonyVpnLab', 'BOOTSTRAP_RESOLVER_OK runId=%{public}s kind=%{public}s', runId, network.kind);
    } catch (_) { if (current()) { this.checkResult = '物理网络 DNS 检查未完成，请检查当前网络。'; } }
    finally { if (generation === this.checkGeneration && this.runId === runId) { this.checking = false; } }
  }

  private checkStillCurrent(runId: string, generation: number): boolean {
    if (this.runId !== runId || this.phase !== 'active' || generation !== this.checkGeneration) { return false; }
    const current = readConnectionLifecycle(this.context().filesDir);
    const state = current.state, status = current.status;
    return state.runId === runId && current.phase === 'active' && status?.runId === runId &&
      status.phase === 'active' && (status.reconnectCount ?? 0) === this.reconnectCount;
  }

  private async checkConnection(ipv6: boolean = false): Promise<void> {
    if (this.phase !== 'active' || this.checking) { return; }
    this.checking = true;
    this.checkFailure = undefined;
    this.directDnsFailure = undefined; this.directDnsResult = ''; this.proxyDnsResult = '';
    this.checkResult = ipv6 ? '正在检查 IPv6 拒绝路径…' : '正在检查 DNS 和 HTTPS…';
    const runId = this.runId;
    const generation = this.checkGeneration;
    const current = (): boolean => this.checkStillCurrent(runId, generation);
    let request: http.HttpRequest | undefined = undefined;
    let failureStage: string = 'https';
    try {
      request = http.createHttp();
      this.checkRequest = request;
      failureStage = ipv6 ? 'https' : 'proxy-dns';
      if (!ipv6) {
        const life = readConnectionLifecycle(this.context().filesDir);
        const split = life.status?.runId === runId && life.status.effectiveMode === 'whitelist' && life.status.effectiveDnsMode === 'split';
        if (split) {
          this.directDnsResult = '直连 DNS：检查中…';
          try {
            await checkDirectDns(current);
            if (!current()) { return; }
            this.directDnsResult = '直连 DNS：通过';
          } catch (error) {
            if (!current()) { return; }
            this.directDnsFailure = connectionFailureFromError(error, 'direct-dns');
            this.directDnsResult = '直连 DNS：未完成' + (this.directDnsFailure.reason === 'timeout' ? '（超时）' : '');
          }
        }
        if (!current()) { return; }
        this.proxyDnsResult = '经节点 DNS：检查中…';
        try {
          await checkProxyDns(current);
          if (!current()) { return; }
          this.proxyDnsResult = '经节点 DNS：通过';
        } catch (error) {
          if (!current()) { return; }
          this.checkFailure = connectionFailureFromError(error, 'proxy-dns');
          this.proxyDnsResult = '经节点 DNS：未完成' + (this.checkFailure.reason === 'timeout' ? '（超时）' : '');
          this.checkResult = failureProblem(this.checkFailure); return;
        }
        hilog.info(0x0000, 'HarmonyVpnLab', 'CONNECTION_DNS_A_AND_AAAA_POLICY_OK runId=%{public}s', runId);
      } else {
        try {
          const replied = await probeIpv6Datagram();
          if (!this.checkStillCurrent(runId, generation)) { return; }
          hilog.info(0x0000, 'HarmonyVpnLab', 'CONNECTION_IPV6_UDP_SENT runId=%{public}s reply=%{public}s', runId, replied.toString());
          if (replied) {
            this.checkResult = 'IPv6 UDP 获得响应，需要检查捕获规则。';
            return;
          }
        } catch (error) {
          hilog.info(0x0000, 'HarmonyVpnLab', 'CONNECTION_IPV6_UDP_ERROR runId=%{public}s detail=%{public}s', runId, describeError(error));
        }
      }
      if (!this.checkStillCurrent(runId, generation)) { return; }
      failureStage = 'https';
      const url = ipv6 ? `https://[2606:4700:4700::1111]/cdn-cgi/trace?check=${Date.now()}`
        : `https://www.cloudflare.com/cdn-cgi/trace?check=${Date.now()}`;
      const response = await request.request(url, {
        method: http.RequestMethod.GET, expectDataType: http.HttpDataType.STRING,
        usingCache: false, connectTimeout: 6000, readTimeout: 6000
      });
      if (!this.checkStillCurrent(runId, generation)) { return; }
      failureStage = 'response';
      if (ipv6) {
        this.checkResult = 'IPv6 请求获得响应，需要检查捕获规则。';
        hilog.error(0x0000, 'HarmonyVpnLab', 'CONNECTION_IPV6_UNEXPECTED_RESPONSE runId=%{public}s', runId);
      } else if (response.responseCode === 200 && typeof response.result === 'string' && response.result.includes('h=www.cloudflare.com') && response.result.includes('ip=')) {
        if (!this.checkStillCurrent(runId, generation)) { return; }
        const exitLine = response.result.split('\n').find((line: string) => line.startsWith('ip='));
        this.exitMarker = exitLine ? connectionExitMarker(exitLine.substring(3), runId) : '';
        this.checkFailure = this.directDnsFailure;
        this.checkResult = this.directDnsFailure ? '经节点 DNS 与域名 HTTPS 检查通过，直连 DNS 需要检查。' :
          (this.directDnsResult === '直连 DNS：通过' ? '直连 DNS、经节点 DNS 与域名 HTTPS 检查通过。' : '代理 DNS 与域名 HTTPS 检查通过。');
        hilog.info(0x0000, 'HarmonyVpnLab', 'CONNECTION_DOMAIN_HTTPS_OK runId=%{public}s bytes=%{public}d', runId, response.result.length);
      } else { throw new Error('测试站点响应不符合预期'); }
    } catch (error) {
      if (!this.checkStillCurrent(runId, generation)) { return; }
      if (ipv6) { this.checkResult = 'IPv6 请求未成功，需结合黑洞命中计数确认阻断。'; }
      else {
        this.checkFailure = failureStage === 'response' ? makeConnectionFailure('response', 'invalid-response') :
          connectionFailureFromError(error, failureStage);
        this.checkResult = failureProblem(this.checkFailure);
      }
      hilog.info(0x0000, 'HarmonyVpnLab', ipv6 ? 'CONNECTION_IPV6_REQUEST_FAILED runId=%{public}s' : 'CONNECTION_DOMAIN_HTTPS_FAILED runId=%{public}s', runId);
      if (ipv6) { hilog.info(0x0000, 'HarmonyVpnLab', 'CONNECTION_IPV6_HTTP_ERROR %{public}s', describeError(error)); }
    } finally {
      if (this.checkRequest === request) {
        try { request?.destroy(); } catch (_) {}
        this.checkRequest = undefined;
      }
      if (this.runId === runId && generation === this.checkGeneration) { this.checking = false; }
    }
  }

  build() {
    Row() {
      if (useSideNavigation(this.windowWidthVp) && !this.developerTools) { AppSideNav({ current: 'home' }); }
      GlassDockLayout({
        showDock: !this.developerTools && !useSideNavigation(this.windowWidthVp), dockHeight: this.dockHeight,
        content: () => { this.pageContent(); }, dock: () => { this.navigationDock(); }
      }).layoutWeight(1).height('100%');
    }.id('homePage').width('100%').height('100%').background($r('app.color.page_bg'));
  }

  @Builder
  private pageContent() {
      Scroll() {
        Column({ space: 20 }) {
          if (this.developerTools) {
            Row({ space: 12 }) {
              Button('返回').id('backFromDeveloperTools').fontColor($r('app.color.accent'))
                .backgroundColor($r('app.color.surface')).onClick(() => { this.developerTools = false; });
              Text('开发工具').fontSize(26).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
            }.width('100%');
          } else {
            Row({ space: 12 }) {
              if (!useSideNavigation(this.windowWidthVp)) {
                Image($r('app.media.ic_shield')).width(28).height(28).fillColor($r('app.color.accent'));
              }
              Column({ space: 5 }) {
                Text(useSideNavigation(this.windowWidthVp) ? '连接' : 'Harmony VPN')
                  .fontSize(28).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).maxLines(2);
                Text('管理你的连接与网络偏好').fontSize(13).fontColor($r('app.color.text_secondary'));
              }.layoutWeight(1).alignItems(HorizontalAlign.Start);
            }.width('100%').padding({ top: 8, bottom: 4 });
          }
          if (!VPN_CORE_AVAILABLE) {
            Text('模拟器界面预览：此构建不包含 VPN 转发核心，连接与节点检测不可用。')
              .id('simulatorPreviewNotice').width('100%').fontSize(14).lineHeight('22fp')
              .padding(16).fontColor($r('app.color.warning')).backgroundColor($r('app.color.surface')).borderRadius(16);
          }
          if (this.developerTools) {
            this.connectionHero();
            this.connectionFailureCards();
            this.configurationCheckCard();
            this.developerContent();
          } else {
            if (homeUsesColumns(this.windowWidthVp)) {
              Row({ space: 24 }) {
                Column({ space: 20 }) {
                  this.connectionHero();
                  this.connectionFailureCards();
                  if (this.busy()) { this.connectionCheckCard(); }
                  this.connectionFootnote();
                }.layoutWeight(1).alignItems(HorizontalAlign.Start);
                Column({ space: 20 }) {
                  if (this.hasNode) { this.nodeCard(); }
                  this.configurationCheckCard();
                  this.networkSettingsCard();
                  this.trafficCard();
                }.layoutWeight(1).alignItems(HorizontalAlign.Start);
              }.id('homeTwoColumns').width('100%').alignItems(VerticalAlign.Top);
            } else {
            this.connectionHero();
            this.connectionFailureCards();
            if (this.hasNode) { this.nodeCard(); }
            this.configurationCheckCard();
            this.networkSettingsCard();
            this.trafficCard();
            if (this.busy()) { this.connectionCheckCard(); }
            this.connectionFootnote();
            }
            if (this.phase === 'failed' || this.phase === 'unknown' || this.phase === 'interrupted') {
              Column({ space: 10 }) {
                Text(this.detail).fontSize(14).fontColor($r('app.color.text_secondary'));
                Button('查看连接诊断').id('openConnectionIssueDiagnostics').fontColor($r('app.color.accent'))
                  .backgroundColor($r('app.color.accent_soft'))
                  .onClick(() => { this.getUIContext().getRouter().pushUrl({ url: 'pages/Diagnostics' }); });
              }.width('100%').padding(18).backgroundColor($r('app.color.surface')).borderRadius(20);
            }
          }
        }.id('homeContent').width(this.developerTools ? formContentWidth(this.windowWidthVp) : primaryContentWidth(this.windowWidthVp))
          .padding({ top: 12, left: 20, right: 20,
            bottom: !this.developerTools && !useSideNavigation(this.windowWidthVp) ? this.dockHeight + 24 : 24 })
          .alignItems(HorizontalAlign.Start);
      }.id('homeScroll').width('100%').height('100%').scrollBar(BarState.Off).align(Alignment.Top)
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]);
  }

  @Builder
  private navigationDock() {
        AppTabBar({ current: 'home', requestInProgress: this.requesting,
          onConnectionAction: () => { void this.handleDockConnectionAction(); } })
          .onAreaChange((_oldArea: Area, area: Area) => { this.dockHeight = Number(area.height); });
  }

  @Builder
  private connectionFootnote() {
    Text(VPN_CORE_AVAILABLE ? 'IPv4 代理 · HTTPS DNS · IPv6 暂时阻断' : '界面预览不改变设备网络')
      .fontSize(12).fontColor($r('app.color.text_secondary')).textAlign(TextAlign.Center).width('100%');
  }

  @Builder
  connectionHero() {
    Column({ space: 14 }) {
      Row({ space: 8 }) {
        Stack() {}.width(8).height(8).backgroundColor(this.statusTone()).borderRadius(4).accessibilityLevel('no');
        Text(this.label()).id('connectionState').fontSize(24).fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary')).constraintSize({ maxWidth: '90%' }).maxLines(2);
      }.width('100%').justifyContent(FlexAlign.Center);
      if (['starting', 'recovering', 'stopping', 'stop_requested'].includes(this.phase) || this.requesting) {
        LoadingProgress().width(64).height(64).color($r('app.color.accent')).accessibilityText('连接状态更新中');
      } else {
        Stack() {
          Image($r('app.media.ic_power')).width(38).height(38).fillColor($r('app.color.accent'));
        }.width(80).height(80).backgroundColor($r('app.color.accent_soft')).borderRadius(40).accessibilityLevel('no');
      }
      Text(this.statusHint()).fontSize(14).fontColor($r('app.color.text_secondary')).textAlign(TextAlign.Center);
      Button(this.busy() ? '断开' : this.profileUnreadable ? '检查节点库' : this.hasNode ? '连接' : '添加节点').id('toggleConnection').width('100%').constraintSize({ minHeight: 54 })
        .fontSize(19).fontWeight(FontWeight.Medium).borderRadius(18)
        .fontColor($r('app.color.on_accent')).backgroundColor($r('app.color.accent'))
        .enabled(this.phase !== 'diagnostic' && !this.requesting &&
          ((!this.hasNode && !this.busy()) || (VPN_CORE_AVAILABLE && (this.busy() || (this.hasNode && this.closed)))))
        .onClick(() => { this.primaryAction(); });
      if (this.busy() && this.phase !== 'diagnostic') {
        Text(this.networkLabel()).id('connectionNetwork').fontSize(12).fontColor($r('app.color.text_secondary'));
      }
      if (this.phase === 'active') {
        Button('重新连接').id('reconnectConnection').fontSize(14).fontColor($r('app.color.accent'))
          .backgroundColor(Color.Transparent).enabled(!this.checking).onClick(() => { this.reconnect(); });
      }
      if (!this.closed && (this.phase === 'failed' || this.phase === 'unknown')) {
        Button('恢复清理').id('recoverConnection').fontColor($r('app.color.danger'))
          .backgroundColor($r('app.color.surface_secondary')).onClick(() => { this.disconnect(); });
      }
      if (VPN_CORE_AVAILABLE && !this.notificationsEnabled) {
        Text('连接通知未启用，可在系统设置中为本应用开启通知。')
          .fontSize(12).fontColor($r('app.color.warning'));
      }
      if (!this.hasNode && !this.busy() && !this.profileUnreadable) {
        Text('已有节点链接或二维码？添加后即可开始。').fontSize(12)
          .fontColor($r('app.color.text_secondary')).textAlign(TextAlign.Center);
      }
    }.padding(24).width('100%').backgroundColor($r('app.color.surface')).borderRadius(28);
  }

  @Builder
  nodeCard() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 14 }) {
        Image($r('app.media.ic_nodes')).width(24).height(24).fillColor($r('app.color.accent'));
        Column({ space: 6 }) {
          Text('当前节点').fontSize(12).fontColor($r('app.color.text_secondary'));
          Text(this.hasNode ? this.nodeName : '添加你的第一个节点').id('currentNodeName')
            .fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
            .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis });
          Text(this.hasNode ? this.protocol : '扫码或粘贴分享链接').fontSize(12).fontColor($r('app.color.text_secondary'));
        }.layoutWeight(1).alignItems(HorizontalAlign.Start);
        Column({ space: 4 }) {
          Text('切换').fontSize(12).fontColor($r('app.color.accent'));
          Image($r('app.media.ic_chevron')).width(16).height(16).fillColor($r('app.color.accent'));
        }.accessibilityLevel('no');
      }.width('100%').padding(20);
    }.id('openNodeConfig').width('100%').backgroundColor($r('app.color.surface')).borderRadius(20)
      .enabled(!this.requesting).accessibilityText('查看节点列表')
      .onClick(() => { void openMainTab(this.getUIContext(), 'home', 'nodes'); });
  }

  @Builder
  private networkSettingsCard() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 14 }) {
        Image($r('app.media.ic_settings')).width(24).height(24).fillColor($r('app.color.accent'));
        Column({ space: 7 }) {
          Text('网络设置').fontSize(12).fontColor($r('app.color.text_secondary'));
          Text(this.routingSummary).id('homeRoutingSummary').fontSize(17).fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary')).width('100%');
          Text(this.routingHint).fontSize(12).lineHeight('18fp').fontColor($r('app.color.text_secondary')).width('100%');
        }.layoutWeight(1).alignItems(HorizontalAlign.Start);
        Image($r('app.media.ic_chevron')).width(18).height(18).fillColor($r('app.color.text_secondary'));
      }.width('100%').padding(20);
    }.id('openHomeNetworkSettings').width('100%').backgroundColor($r('app.color.surface')).borderRadius(20)
      .enabled(!this.requesting).accessibilityText('网络设置，' + this.routingSummary)
      .onClick(() => { this.openNetworkSettings(); });
  }

  @Builder
  trafficCard() {
    Column({ space: 16 }) {
      Row() {
        Text(this.startedAt <= 0 ? '代理流量' : this.busy() && this.phase !== 'diagnostic' ? '本次连接' : '上次连接')
          .fontSize(13).fontColor($r('app.color.text_secondary'));
        Blank();
        if (this.busy() && this.phase !== 'diagnostic' && this.startedAt > 0) {
          Text(this.duration()).fontSize(12).fontColor($r('app.color.text_secondary'));
        }
      }.width('100%');
      Row({ space: 16 }) {
        Column({ space: 6 }) {
          Text('↑  代理上传').fontSize(12).fontColor($r('app.color.text_secondary'));
          Text(this.uplinkRate).id('connectionUplinkRate').fontSize(23).minFontSize(16).maxFontSize(23).maxLines(1)
            .fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).width('100%');
          Text(this.startedAt > 0 ? '累计 ' + formatBytes(this.uplink) : '累计 —').id('connectionUplink').fontSize(12)
            .fontColor($r('app.color.text_secondary')).width('100%');
        }.layoutWeight(1).alignItems(HorizontalAlign.Start);
        Column({ space: 6 }) {
          Text('↓  代理下载').fontSize(12).fontColor($r('app.color.text_secondary'));
          Text(this.downlinkRate).id('connectionDownlinkRate').fontSize(23).minFontSize(16).maxFontSize(23).maxLines(1)
            .fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).width('100%');
          Text(this.startedAt > 0 ? '累计 ' + formatBytes(this.downlink) : '累计 —').id('connectionDownlink').fontSize(12)
            .fontColor($r('app.color.text_secondary')).width('100%');
        }.layoutWeight(1).alignItems(HorizontalAlign.Start);
      }.width('100%');
      Text(this.rateAvailable ? '实时速率按最近两次采样计算，约每 2 秒更新。' :
        this.phase === 'active' ? '等待新的流量采样；速率暂不可用时显示 —。' : '连接后显示实时速率，累计量仅统计代理流量。')
        .id('connectionRateHint').fontSize(12).fontColor($r('app.color.text_secondary')).width('100%');
    }.width('100%').padding(20).backgroundColor($r('app.color.surface')).borderRadius(20);
  }

  @Builder
  configurationCheckCard() {
    Column({ space: 12 }) {
      Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap, alignItems: ItemAlign.Center,
        justifyContent: FlexAlign.SpaceBetween }) {
        Text('本地配置检查').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
        Button('检查配置', { type: ButtonType.Normal }).id('checkNodeConfiguration').constraintSize({ minHeight: 44 })
          .padding({ left: 14, right: 14 }).fontSize(13).fontColor($r('app.color.accent'))
          .backgroundColor($r('app.color.accent_soft')).borderRadius(14).enabled(!this.requesting)
          .onClick(() => { this.inspectCurrentConfiguration(); });
      }.width('100%');
      if (this.configurationIssueCode.length > 0) {
        Text('需要检查：' + nodeIssue(this.configurationIssueCode).field).id('nodeConfigurationField')
          .fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.warning')).width('100%');
        Text(nodeIssue(this.configurationIssueCode).problem).id('nodeConfigurationProblem')
          .fontSize(14).fontColor($r('app.color.text_primary')).width('100%');
        Text('建议：' + nodeIssue(this.configurationIssueCode).suggestion).id('nodeConfigurationSuggestion')
          .fontSize(13).fontColor($r('app.color.text_secondary')).width('100%');
      } else {
        Text(this.configurationChecked ? '本地检查通过，尚未验证节点联网。' : '检查格式与当前连接入口，不会联网或修改配置。')
          .id('nodeConfigurationResult').fontSize(13).fontColor($r('app.color.text_secondary')).width('100%');
      }
    }.width('100%').padding(20).alignItems(HorizontalAlign.Start)
      .backgroundColor($r('app.color.surface')).borderRadius(20);
  }

  @Builder
  connectionFailureCards() {
    if (this.startFailure) {
      FailureNotice({ title: '本次启动未完成', stage: this.startFailure.stage, reason: this.startFailure.reason, idPrefix: 'startupFailure' });
    }
    if (this.serviceFailure) {
      FailureNotice({ title: this.closed ? '上次连接的失败阶段' : '本次连接的失败阶段',
        stage: this.serviceFailure.stage, reason: this.serviceFailure.reason, idPrefix: 'serviceFailure' });
    } else if (this.serviceCurrentIssue) {
      FailureNotice({ title: '当前步骤尚未完成', stage: this.serviceCurrentIssue.stage,
        reason: this.serviceCurrentIssue.reason, idPrefix: 'currentConnectionIssue' });
    }
    if (this.serviceCleanupFailure) {
      FailureNotice({ title: '清理回执需要确认', stage: this.serviceCleanupFailure.stage,
        reason: this.serviceCleanupFailure.reason, idPrefix: 'cleanupFailure' });
    }
  }

  @Builder
  connectionCheckCard() {
    Column({ space: 12 }) {
      Row() {
        Text('连接检查').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
        Blank();
        Button(this.checking ? '检查中…' : '检查连接').id('checkConnection').fontSize(13)
          .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
          .enabled(this.phase === 'active' && !this.checking).onClick(() => { this.checkConnection(); });
      }.width('100%');
      Text(this.checkResult).id('connectionCheckResult').width('100%')
        .fontSize(13).fontColor($r('app.color.text_secondary'));
      if (this.directDnsResult) { Text(this.directDnsResult).id('directDnsCheckResult').fontSize(13).fontColor($r('app.color.text_secondary')).width('100%'); }
      if (this.proxyDnsResult) { Text(this.proxyDnsResult).id('proxyDnsCheckResult').fontSize(13).fontColor($r('app.color.text_secondary')).width('100%'); }
      if (this.directDnsFailure && this.checkFailure?.stage !== 'direct-dns') {
        FailureNotice({ title: '直连 DNS 检查未完成', stage: this.directDnsFailure.stage,
          reason: this.directDnsFailure.reason, idPrefix: 'directDnsCheckFailure' });
      }
      if (this.checkFailure) {
        FailureNotice({ title: '本次联网检查未完成', stage: this.checkFailure.stage,
          reason: this.checkFailure.reason, idPrefix: 'connectionCheckFailure' });
      }
    }.width('100%').padding(20).backgroundColor($r('app.color.surface')).borderRadius(20);
  }

  @Builder
  developerContent() {
    Text('以下工具用于排查连接问题。短时验证会创建 VPN，结束后自动断开。')
      .fontSize(14).fontColor($r('app.color.text_secondary'));
    if (this.dnsFaultHint) {
      Text(this.dnsFaultHint + '。只作用于本次本应用验证，结束后恢复日常设置。')
        .id('dnsFaultTestHint').fontSize(14).fontColor($r('app.color.warning')).width('100%');
      Button('开始受控 DNS 验证').id('startDnsFaultTest').width('100%')
        .enabled(!this.busy() && this.hasNode && this.closed && !this.requesting)
        .onClick(() => { this.connect('connection-app-test'); });
    }
    this.connectionCheckCard();
    Column({ space: 12 }) {
      Text('短时连接验证').fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
      Button('90 秒全设备验证').id('startConnectionTest').width('100%')
        .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
        .enabled(!this.busy() && this.hasNode && this.closed && !this.requesting)
        .onClick(() => { this.connect('connection-test'); });
      Button('90 秒本应用验证').id('startConnectionAppTest').width('100%')
        .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
        .enabled(!this.busy() && this.hasNode && this.closed && !this.requesting)
        .onClick(() => { this.connect('connection-app-test'); });
      Button('浏览器检查').id('checkOtherApp').width('100%').fontColor($r('app.color.accent'))
        .backgroundColor($r('app.color.surface_secondary')).enabled(this.phase === 'active')
        .onClick(() => {
          this.context().openLink('https://www.cloudflare.com/cdn-cgi/trace?browserCheck=' + Date.now())
            .catch(() => { this.checkResult = '未能打开浏览器。'; });
        });
    }.width('100%').padding(20).alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(20);
    Column({ space: 12 }) {
      Text('网络诊断').fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
      Button('检查 IPv6 拒绝路径').id('checkConnectionIpv6').width('100%')
        .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
        .enabled(this.phase === 'active' && !this.checking).onClick(() => { this.checkConnection(true); });
      Button('检查物理网域名解析').id('checkPhysicalResolver').width('100%')
        .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
        .enabled(this.phase === 'active' && !this.checking).onClick(() => { this.checkPhysicalResolver(); });
      Text('IPv6 黑洞命中：' + this.ipv6Blocked).id('ipv6BlockedCount').fontSize(13).fontColor($r('app.color.text_secondary'));
      Text('代理 DNS 请求：' + this.dnsRequests).id('dnsRequestCount').fontSize(13).fontColor($r('app.color.text_secondary'));
      if (this.exitMarker) {
        Text('出口校验标记：' + this.exitMarker).id('connectionExitMarker').fontSize(13).fontColor($r('app.color.text_secondary'));
      }
      if (this.detail) { Text(this.detail).fontSize(13).fontColor($r('app.color.text_secondary')); }
      Button('连接诊断记录').id('openDiagnosticJournal').width('100%')
        .fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface_secondary'))
        .onClick(() => { this.getUIContext().getRouter().pushUrl({ url: 'pages/Diagnostics' }); });
      Button('打开短时探针').id('openDiagnostics').width('100%')
        .fontColor($r('app.color.accent')).backgroundColor($r('app.color.surface_secondary'))
        .enabled(!this.busy() && !this.requesting)
        .onClick(() => { this.getUIContext().getRouter().pushUrl({ url: 'pages/Index' }); });
    }.width('100%').padding(20).alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(20);
  }
}


