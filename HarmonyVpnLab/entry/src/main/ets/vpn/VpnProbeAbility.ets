import { Want } from '@kit.AbilityKit';
import { systemDateTime } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { vpnExtension, VpnExtensionAbility } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import native from 'libvpnbridge.so';
import { ProbeState, readProbeState, writeProbeState } from '../model/ProbeState';
import { readTransferResult } from '../model/TransferResult';
import { CoreProbe } from './CoreProbe';
import { describeError } from '../model/ErrorInfo';
import { ConnectionSnapshot } from '../model/ConnectionSnapshot';
import { ConnectionStatus, isConnectionKind, readConnectionCommand, readConnectionStatus, writeConnectionStatus } from '../model/ConnectionControl';
import { cancelConnectionNotification, publishConnectionNotification } from '../model/ConnectionNotification';
import { ImportedNode } from '../model/NodeImport';
import { readNodeProfile, nodeServerAddress } from '../model/NodeProfile';
import { NodeBootstrap, createNodeBootstrap, normalizeBootstrapHost, isBootstrapIpv4Address } from '../model/NodeBootstrap';
import { PhysicalNetwork, PhysicalNetworkWatcher, readPhysicalNetwork, resolvePhysicalIpv4 } from '../model/PhysicalNetwork';
import { readNodeCatalog, SavedNode } from '../model/NodeCatalog';
import { fingerprintOutbound, NodeLatencyResult, saveNodeLatency } from '../model/NodeLatency';
import { LatencyProof, readLatencyRequest, readLatencyProof } from '../model/LatencyProtocol';
import { appendDiagnosticEvent } from '../model/DiagnosticJournal';
import { readNetworkPolicy } from '../model/NetworkPolicyStore';
import { VPN_CORE_AVAILABLE } from '../model/BuildCapabilities';
import { ConnectionFailure, ConnectionFailureError, makeConnectionFailure, connectionFailureFromError,
  failureDiagnosticCode, failureDiagnosticValue } from '../model/ConnectionFailure';

const TAG: string = 'HarmonyVpnLab';
const DOMAIN: number = 0x0000;
const PROBE_DURATION_MS: number = 5000;
const CONTROL_POLL_MS: number = 100;

export default class VpnProbeAbility extends VpnExtensionAbility {
  private connection: vpnExtension.VpnConnection | undefined = undefined;
  private initialization: Promise<void> | undefined = undefined;
  private cleanup: Promise<void> | undefined = undefined;
  private timerId: number = -1;
  private controlPollId: number = -1;
  private tunFd: number = -1;
  private networkCreated: boolean = false;
  private resourceCleanupConfirmed: boolean = false;
  private fdInspected: boolean = false;
  private stopRequested: boolean = false;
  private cancelled: boolean = false;
  private destroyed: boolean = false;
  private runId: string = '';
  private nativeDetail: string = '';
  private failure: string = '';
  private connectionFailure?: ConnectionFailure;
  private cleanupFailure?: ConnectionFailure;
  private currentIssue?: ConnectionFailure;
  private testKind: string = 'lifecycle';
  private coreProbe: CoreProbe | undefined = undefined;
  private transferVerified: boolean = false;
  private rejectionObserved: boolean = false;
  private statusTask: Promise<void> | undefined = undefined;
  private lastSnapshot?: ConnectionSnapshot;
  private lastStatusAt: number = 0;
  private lastNotificationAt: number = 0;
  private notificationTask?: Promise<void>;
  private networkWatcher?: PhysicalNetworkWatcher;
  private networkReadTask?: Promise<void>;
  private networkTask?: Promise<void>;
  private networkDebounce: number = -1;
  private lastNetworkRead: number = 0;
  private desiredNetwork?: PhysicalNetwork;
  private networkEpoch: number = 0;
  private dialEpoch: number = -1;
  private appliedNetworkKey: string = '';
  private connectionNode?: ImportedNode;
  private preparedBootstrap?: NodeBootstrap;
  private preparedEpoch: number = -1;
  private connectionPhase: string = 'starting';
  private connectionMessage: string = '正在建立代理连接与 DNS。';
  private reconnectCount: number = 0;
  private reconnectCommandAt: number = 0;
  private retryAt: number = 0;
  private retryCount: number = 0;
  private latencyNodeId: string = '';
  private latencyFingerprint: string = '';
  private latencyFinished: boolean = false;
  private latencyEpoch: number = -1;
  private latencyTask?: Promise<void>;
  private protectStaleBefore: number = 0;
  private protectStaleAfter: number = 0;
  private protectApiFailed: number = 0;
  private loggedBefore: number = 0;
  private loggedAfter: number = 0;
  private loggedApi: number = 0;

  onCreate(want: Want): void {
    const pending = readProbeState(this.context.filesDir);
    this.testKind = pending.kind;
    const requestedRunId = want.parameters?.runId;
    // The system authorization launch may omit Want parameters on real devices.
    // Recover only our own pending request; never invent a new request here.
    this.runId = typeof requestedRunId === 'string' && requestedRunId.length > 0
      ? requestedRunId : pending.runId;
    const ageMs = Date.now() - pending.updatedAt;
    if (this.runId.length === 0 || pending.runId !== this.runId ||
      pending.phase !== 'starting' || ageMs < 0 || ageMs > 20000) {
      this.cancelled = true;
      this.stopRequested = true;
    }
    if (isConnectionKind(this.testKind)) {
      const command = readConnectionCommand(this.context.filesDir);
      if (!command || command.runId !== this.runId || command.action !== 'start') {
        this.cancelled = true;
        this.stopRequested = true;
      }
      this.persistConnectionStatus('starting');
    }
    hilog.info(DOMAIN, TAG, 'VPN extension created, runId=%{public}s', this.runId);
    this.journal('session-start');
    if (this.testKind === 'node-latency') {
      this.timerId = setTimeout(() => {
        this.timerId = -1;
        this.finishLatency('cancelled', 0, this.desiredNetwork ? 'stopped' : 'network-changed');
      }, 30000);
    }
    this.controlPollId = setInterval(() => {
      if (this.checkPersistentCancellation()) {
        void this.requestStop(false);
      } else if (isConnectionKind(this.testKind) && !this.stopRequested) {
        if (this.testKind === 'node-latency' && !this.latencyFinished && !this.latencyTask && this.connectionPhase === 'active') {
          const task = this.acceptLatencyProof();
          this.latencyTask = task;
          void task.then(() => { if (this.latencyTask === task) { this.latencyTask = undefined; } });
        }
        if (this.networkWatcher && this.controlClock() - this.lastNetworkRead >= 2000) { void this.refreshDesiredNetwork(); }
        const command = readConnectionCommand(this.context.filesDir);
        if (command?.action === 'reconnect' && command.createdAt !== this.reconnectCommandAt) {
          this.reconnectCommandAt = command.createdAt;
          this.networkEpoch++; this.appliedNetworkKey = ''; this.retryAt = 0;
        }
        if (this.networkCreated && this.networkTask === undefined && this.controlClock() >= this.retryAt &&
          (this.desiredNetwork ? this.appliedNetworkKey !== this.desiredNetwork.key : this.connectionPhase !== 'waiting-network')) {
          void this.runNetworkTransition();
        }
        if (this.statusTask === undefined && this.controlClock() - this.lastStatusAt >= 2000) {
          this.lastStatusAt = this.controlClock();
          const task = this.refreshConnectionStatus();
          this.statusTask = task;
          void task.then(() => { if (this.statusTask === task) { this.statusTask = undefined; } });
        }
      } else if (this.testKind !== 'lifecycle' && !this.stopRequested) {
        if (this.testKind === 'node' && this.coreProbe?.detectOutboundLoop()) {
          this.recordFailure('检测到外连回环', new Error('节点自身地址再次进入 SOCKS 入站，终止本次测试'));
          void this.requestStop(false);
          return;
        }
        const result = readTransferResult(this.context.filesDir);
        if (result.runId === this.runId && result.status === 'passed') {
          if (this.testKind === 'reject') {
            this.recordFailure('拒绝保护检查失败', new Error('拒绝保护后不应收到测试服务响应'));
            void this.requestStop(false);
            return;
          }
          this.transferVerified = true;
          hilog.info(DOMAIN, TAG, this.testKind === 'node'
            ? 'NODE_HTTPS_REPORTED runId=%{public}s bytes=%{public}d'
            : 'TRANSFER_TOKEN_VERIFIED runId=%{public}s bytes=%{public}d',
            this.runId, result.bodyBytes);
          void this.requestStop(true);
        } else if (result.runId === this.runId && result.status === 'failed') {
          if (this.testKind === 'reject') {
            this.rejectionObserved = true;
            void this.requestStop(true);
          } else {
            this.recordFailure('HTTP 流量验证失败', new Error(result.detail));
            void this.requestStop(false);
          }
        }
      }
    }, isConnectionKind(this.testKind) ? 300 : CONTROL_POLL_MS);
    this.initialization = this.initializeProbe();
    void this.observeInitialization();
  }

  onDestroy(): void {
    this.destroyed = true;
    this.stopControlPolling();
    hilog.info(DOMAIN, TAG, 'VPN extension destroyed, runId=%{public}s', this.runId);
    if (!this.resourceCleanupConfirmed) {
      this.cancelled = true;
      this.stopRequested = true;
      const detail = '系统正在销毁 VPN 扩展；TUN FD 关闭和网卡销毁尚未全部确认，不能判定清理通过。';
      this.failure = this.failure.length > 0 ? `${this.failure}; ${detail}` : detail;
      hilog.error(DOMAIN, TAG, '%{public}s', detail);
      // Persist synchronously: this process may end before an awaited destroy()
      // resumes. The cleanup below remains a best-effort fallback.
      this.publishSafely('failed', this.failure);
    }
    if (isConnectionKind(this.testKind)) {
      try { this.persistConnectionStatus(this.resourceCleanupConfirmed ? 'destroyed' : 'destroying'); } catch (_) {}
      void cancelConnectionNotification(this.runId).catch(() => {});
    }
    void this.requestStop(false);
  }

  private async initializeProbe(): Promise<void> {
    let stage = 'vpn-init';
    try {
      if (!VPN_CORE_AVAILABLE) { throw new Error('模拟器界面预览不包含 VPN 核心，未创建虚拟网卡。'); }
      if (this.checkPersistentCancellation() || this.stopRequested) {
        return;
      }
      this.publish('starting', isConnectionKind(this.testKind)
        ? '正在建立代理连接与 DNS。'
        : this.testKind === 'node' || this.testKind === 'xray' || this.testKind === 'reject'
        ? '正在启动仅作用于本应用的 IPv4 验证。'
        : '正在启动受限 VPN 探针，不配置默认路由或 DNS。');
      this.connection = vpnExtension.createVpnConnection(this.context);
      await this.connection.protectProcessNet();
      hilog.info(DOMAIN, TAG, 'protectProcessNet succeeded');
      if (this.checkPersistentCancellation() || this.stopRequested) {
        return;
      }

      if (isConnectionKind(this.testKind)) {
        stage = 'configuration';
        if (this.testKind === 'node-latency') {
          const request = readLatencyRequest(this.context.filesDir);
          if (!request || request.runId !== this.runId) { throw new Error('节点检测请求无效'); }
          this.latencyNodeId = request.nodeId; this.latencyFingerprint = request.outboundFingerprint;
          const selected = readNodeCatalog(this.context.filesDir).nodes.find((node: SavedNode) => node.id === request.nodeId);
          if (!selected) { throw new Error('检测节点已不存在'); }
          this.connectionNode = new ImportedNode(selected.name, selected.protocol, selected.outboundJson);
          if (await fingerprintOutbound(selected.outboundJson) !== request.outboundFingerprint) { throw new Error('检测节点配置已改变'); }
          this.journal('latency-start');
        } else { this.connectionNode = readNodeProfile(this.context.filesDir); }
        if (!this.connectionNode) { throw new Error('请先导入节点'); }
        normalizeBootstrapHost(nodeServerAddress(this.connectionNode));
        stage = 'network';
        this.networkWatcher = new PhysicalNetworkWatcher();
        await this.networkWatcher.start(() => this.queueNetworkRead());
        await this.refreshDesiredNetwork();
        if (this.desiredNetwork && !this.stopRequested) {
          const epoch = this.networkEpoch;
          try {
            this.preparedBootstrap = await this.resolveBootstrap(this.desiredNetwork, epoch);
            this.preparedEpoch = epoch;
          } catch (error) {
            if (!this.stopRequested && epoch === this.networkEpoch) {
              const issue = connectionFailureFromError(error, 'endpoint-dns');
              if (issue.stage === 'configuration') { throw error as Error; }
              this.currentIssue = issue;
              try { this.persistConnectionStatus('starting'); } catch (_) { /* Diagnostics cannot block resource ownership. */ }
            }
          }
        }
        if (this.checkPersistentCancellation() || this.stopRequested) { return; }
      }

      stage = 'vpn-create';
      const config: vpnExtension.VpnConfig = {
        addresses: [{ address: { address: '198.18.0.2', family: 1 }, prefixLength: 30 }],
        routes: [{
          interface: '',
          destination: { address: { address: '198.18.0.0', family: 1 }, prefixLength: 30 },
          gateway: { address: '0.0.0.0', family: 1 },
          hasGateway: false,
          isDefaultRoute: false
        }],
        mtu: 1400,
        isIPv4Accepted: true,
        isIPv6Accepted: false,
        isBlocking: false
      };
      if (this.testKind === 'node' || this.testKind === 'xray' || this.testKind === 'reject' || isConnectionKind(this.testKind)) {
        config.routes = [{
          interface: '',
          destination: { address: { address: '0.0.0.0', family: 1 }, prefixLength: 0 },
          gateway: { address: '0.0.0.0', family: 1 },
          hasGateway: false,
          isDefaultRoute: true
        }];
        if (!isConnectionKind(this.testKind) || this.testKind === 'connection-app-test' || this.testKind === 'node-latency') {
          config.trustedApplications = ['com.example.harmonyvpnlab'];
        }
      }
      if (isConnectionKind(this.testKind)) {
          config.dnsAddresses = ['198.18.0.1'];
          // This complete IPv6 address/route combination captured real UDP6 on
          // Pura80Ultra / HarmonyOS 7.0. Prefix 64 with an empty interface and ::
          // gateway had allowed bypass despite create() succeeding. Reference:
          // https://github.com/xiaobaigroup/ClashBox/pull/147
          config.addresses.push({ address: { address: 'fdfe:dcba:9876::1', family: 2, port: 0 }, prefixLength: 126 });
        config.routes?.push({
          interface: 'vpn-tun', destination: { address: { address: '::', family: 2, port: 0 }, prefixLength: 0 },
          gateway: { address: 'fe80::', family: 2, port: 0 }, hasGateway: false, isDefaultRoute: true
        });
        // Capture IPv6 into the VPN and explicitly reject it in Xray. The
        // acceptance flag alone is not an IPv6 blocking policy.
        config.isIPv6Accepted = true;
      }

      // Assign the returned FD before checking cancellation: cleanup must own it
      // even when the extension was destroyed while create() was pending.
      this.tunFd = await this.connection.create(config);
      this.networkCreated = true;
      if (this.tunFd < 0) {
        throw new Error(`VPN returned an invalid FD: ${this.tunFd}`);
      }
      if (this.checkPersistentCancellation() || this.stopRequested) {
        return;
      }

      // The native function must throw if fcntl fails. It never reads or closes.
      this.nativeDetail = native.inspectFd(this.tunFd);
      this.fdInspected = true;
      hilog.info(DOMAIN, TAG, 'TUN FD inspection: %{public}s', this.nativeDetail);
      if (isConnectionKind(this.testKind)) {
        try {
          hilog.info(DOMAIN, TAG, 'CONNECTION_TUN_ADDRESSES runId=%{public}s result=%{public}s', this.runId, native.inspectTunAddresses(this.tunFd));
        } catch (_) { hilog.warn(DOMAIN, TAG, 'CONNECTION_TUN_ADDRESSES_UNAVAILABLE'); }
      }
      if (this.testKind !== 'lifecycle') {
        stage = 'core-init';
        if (isConnectionKind(this.testKind)) {
          await this.runNetworkTransition();
        } else {
          this.coreProbe = new CoreProbe();
          if (this.testKind === 'node') {
          await this.coreProbe.startNode(this.tunFd, this.context, (fd: number) => this.protectSocket(fd));
          } else {
          await this.coreProbe.start(this.tunFd, this.runId, this.context,
            this.testKind === 'xray' || this.testKind === 'reject',
            (fd: number) => this.testKind === 'reject'
              ? Promise.reject(new Error('测试注入：拒绝保护')) : this.protectSocket(fd));
          }
        }
        if (this.checkPersistentCancellation() || this.stopRequested) {
          return;
        }
        if (!isConnectionKind(this.testKind)) { this.publish('active', this.testKind === 'reject' ? '正在检查保护被拒绝时，核心是否停止拨号。'
          : this.testKind === 'node' ? '节点核心已启动，正在验证本应用的 IPv4 HTTPS 与 Xray 流量计数。'
          : (this.testKind === 'xray' ? 'Xray + Hev 已启动，等待真实 HTTP 校验标记。'
            : 'Hev 已启动，等待真实 HTTP 校验标记。')); }
      } else {
        this.publish('active', `受限路由 198.18.0.0/30 已创建，观察 5 秒。${this.nativeDetail}`);
      }
      if (isConnectionKind(this.testKind)) {
        this.lastStatusAt = 0;
        if (this.testKind !== 'connection' && this.testKind !== 'node-latency') {
          this.timerId = setTimeout(() => { this.timerId = -1; void this.requestStop(false); }, 90000);
        }
        return;
      }
      this.timerId = setTimeout(() => {
        this.timerId = -1;
        if (this.testKind !== 'lifecycle') {
          this.recordFailure('流量验证超时', new Error('未在测试时限内收到有效响应'));
          void this.requestStop(false);
        } else {
          void this.requestStop(true);
        }
      }, this.testKind === 'lifecycle' ? PROBE_DURATION_MS : (this.testKind === 'node' ? 25000 : 15000));
    } catch (error) {
      this.recordFailure('探针初始化失败', error, stage);
    }
  }

  private async refreshConnectionStatus(): Promise<void> {
    const epoch = this.networkEpoch;
    try {
      if (this.stopRequested) { return; }
      const state = readProbeState(this.context.filesDir);
      if (state.runId !== this.runId) { return; }
      if (this.connectionPhase === 'active' && this.networkTask === undefined && this.coreProbe) {
        const snapshot = await this.coreProbe.readConnectionSnapshot();
        if (epoch !== this.networkEpoch || this.connectionPhase !== 'active' || this.networkTask !== undefined) { return; }
        this.lastSnapshot = snapshot;
      }
      if (this.stopRequested || this.checkPersistentCancellation()) { return; }
      this.flushProtectionJournal();
      this.persistConnectionStatus(this.connectionPhase);
      writeProbeState(this.context.filesDir, new ProbeState(this.connectionPhase, this.connectionMessage, this.runId, this.testKind));
      if (this.notificationTask === undefined && this.controlClock() - this.lastNotificationAt > 30000) {
        this.lastNotificationAt = this.controlClock();
        const phase = this.connectionPhase;
        const task = publishConnectionNotification(this.lastSnapshot ?? new ConnectionSnapshot(), this.runId,
          () => !this.stopRequested && !this.destroyed && this.connectionPhase === phase, phase).catch(() => {});
        this.notificationTask = task;
        void task.then(() => { if (this.notificationTask === task) { this.notificationTask = undefined; } });
      }
    } catch (error) {
      if (!this.stopRequested && epoch === this.networkEpoch && this.connectionPhase === 'active' && this.networkTask === undefined) {
        this.recordFailure('连接状态检查失败', error, 'status');
        // Do not await cleanup from the task that cleanup itself must settle.
        setTimeout(() => { void this.requestStop(false); }, 0);
      }
    }
  }

  private controlClock(): number { return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false); }

  private queueNetworkRead(): void {
    if (this.stopRequested || this.destroyed || this.networkDebounce >= 0) { return; }
    this.networkDebounce = setTimeout(() => {
      this.networkDebounce = -1;
      if (!this.stopRequested) { void this.refreshDesiredNetwork(); }
    }, 500);
  }

  private async refreshDesiredNetwork(): Promise<void> {
    if (this.stopRequested || this.destroyed) { return; }
    if (this.networkReadTask) { await this.networkReadTask; return; }
    this.lastNetworkRead = this.controlClock();
    const task = this.readNetworkTarget();
    this.networkReadTask = task;
    try { await task; } finally { if (this.networkReadTask === task) { this.networkReadTask = undefined; } }
  }

  private async readNetworkTarget(): Promise<void> {
    const next = await readPhysicalNetwork();
    if (this.stopRequested || this.destroyed) { return; }
    if (next?.key !== this.desiredNetwork?.key) {
      this.desiredNetwork = next;
      this.networkEpoch++; this.retryAt = 0; this.retryCount = 0;
      this.journal('network-change', next?.kind ?? 'unavailable', this.networkEpoch);
      if (this.testKind === 'node-latency' && this.latencyEpoch >= 0) { this.finishLatency('cancelled', 0, 'network-changed'); }
      hilog.info(DOMAIN, TAG, 'PHYSICAL_NETWORK_CHANGED runId=%{public}s kind=%{public}s epoch=%{public}d',
        this.runId, next?.kind ?? 'unavailable', this.networkEpoch);
    }
  }

  private async resolveBootstrap(network: PhysicalNetwork, epoch: number): Promise<NodeBootstrap> {
    let stage = 'configuration';
    try {
      if (!this.connectionNode) { throw new Error('本次连接没有节点'); }
      const host = normalizeBootstrapHost(nodeServerAddress(this.connectionNode));
      const current = (): boolean => !this.stopRequested && !this.destroyed && epoch === this.networkEpoch;
      let ipv4 = host;
      if (!isBootstrapIpv4Address(host)) {
        stage = 'endpoint-dns';
        ipv4 = await resolvePhysicalIpv4(host, network, current);
      }
      if (!current()) { throw new Error('节点解析已取消'); }
      stage = 'configuration';
      return createNodeBootstrap(this.connectionNode.outboundJson, ipv4);
    } catch (error) {
      const failure = connectionFailureFromError(error, stage);
      throw new ConnectionFailureError(failure.stage, failure.reason);
    }
  }

  private setConnectionPhase(phase: string, detail: string): void {
    if (this.stopRequested || this.destroyed) { return; }
    this.connectionPhase = phase; this.connectionMessage = detail;
    if (phase === 'active') { this.currentIssue = undefined; }
    this.lastStatusAt = 0; this.lastNotificationAt = 0;
    this.publishSafely(phase, detail); this.persistConnectionStatus(phase);
    if (phase === 'waiting-network') { this.journal('waiting-network'); }
    if (phase === 'recovering') { this.journal('recovery-start', this.desiredNetwork?.kind ?? 'unavailable'); }
  }

  private async runNetworkTransition(): Promise<void> {
    if (!this.networkCreated || this.stopRequested || this.destroyed) { return; }
    if (this.networkTask) { await this.networkTask; return; }
    const task = this.reconcileNetwork();
    this.networkTask = task;
    try { await task; } finally { if (this.networkTask === task) { this.networkTask = undefined; } }
  }

  private async reconcileNetwork(): Promise<void> {
    const epoch = this.networkEpoch;
    const hadCore = this.coreProbe !== undefined;
    let stage = 'core-init';
    try {
      const target = this.desiredNetwork;
      if (target && this.appliedNetworkKey === target.key) { return; }
      this.setConnectionPhase(target ? (this.coreProbe ? 'recovering' : 'starting') : 'waiting-network',
        target ? '正在准备当前网络并恢复代理，已有请求可能需要重试。' : '等待可用的 IPv4 网络，VPN 网卡保持接管。');
      if (this.coreProbe) { await this.coreProbe.suspendConnection(); }
      this.appliedNetworkKey = '';
      if (!target || this.stopRequested || epoch !== this.networkEpoch) { return; }
      let bootstrap: NodeBootstrap;
      try {
        bootstrap = this.preparedBootstrap && this.preparedEpoch === epoch
          ? this.preparedBootstrap : await this.resolveBootstrap(target, epoch);
      } catch (error) {
        if (this.stopRequested || epoch !== this.networkEpoch) { return; }
        const issue = connectionFailureFromError(error, 'endpoint-dns');
        if (issue.stage === 'configuration') { throw error as Error; }
        this.currentIssue = issue;
        this.retryCount++;
        this.retryAt = this.controlClock() + Math.min(30000, 2000 * Math.pow(2, Math.min(this.retryCount - 1, 4)));
        this.setConnectionPhase(this.coreProbe ? 'recovering' : 'starting', '节点域名暂未解析成功，将在当前网络重试；可随时断开。');
        return;
      }
      this.preparedBootstrap = undefined;
      this.currentIssue = undefined;
      if (this.stopRequested || epoch !== this.networkEpoch) { return; }
      this.dialEpoch = epoch;
      const resumed = this.coreProbe !== undefined;
      if (this.coreProbe) { await this.coreProbe.resumeConnection(this.context, bootstrap); }
      else {
        this.coreProbe = new CoreProbe();
        stage = 'configuration';
        const policy = this.testKind === 'connection' ? readNetworkPolicy(this.context.filesDir) : undefined;
        stage = 'core-init';
        await this.coreProbe.startConnection(this.tunFd, this.context, (fd: number) => this.protectSocket(fd), bootstrap,
          this.connectionNode?.outboundJson, policy);
      }
      if (this.stopRequested || epoch !== this.networkEpoch) { return; }
      this.appliedNetworkKey = target.key; this.retryAt = 0; this.retryCount = 0;
      if (resumed) { this.reconnectCount++; }
      if (resumed) { this.journal('recovery-ok', target.kind, this.reconnectCount); }
      if (this.testKind === 'node-latency') { this.latencyEpoch = epoch; }
      this.setConnectionPhase('active', this.connectionDetail());
      hilog.info(DOMAIN, TAG, 'CONNECTION_ACTIVE runId=%{public}s scope=%{public}s kind=%{public}s recoveries=%{public}d',
        this.runId, ['connection-app-test', 'node-latency'].includes(this.testKind) ? 'application' : 'all-applications', target.kind, this.reconnectCount);
    } catch (error) {
      if (!this.stopRequested) {
        if (epoch !== this.networkEpoch && hadCore) { this.appliedNetworkKey = ''; return; }
        if (hadCore) { this.journal('recovery-failed', this.desiredNetwork?.kind ?? 'unavailable'); }
        this.recordFailure(hadCore ? '代理恢复失败' : '代理启动失败', error, stage);
        setTimeout(() => { void this.requestStop(false); }, 0);
      }
    }
  }

  private async observeInitialization(): Promise<void> {
    if (this.initialization !== undefined) {
      await this.initialization;
    }
    if (this.failure.length > 0 || this.stopRequested) {
      await this.requestStop(false);
    }
  }

  private async protectSocket(fd: number): Promise<void> {
    if (this.connection === undefined) {
      this.protectApiFailed++;
      throw new Error('VPN 连接上下文不可用，拒绝外连');
    }
    const epoch = this.dialEpoch;
    if (isConnectionKind(this.testKind) && (this.stopRequested || !this.desiredNetwork || epoch !== this.networkEpoch)) {
      this.protectStaleBefore++;
      throw new Error('网络正在切换，拒绝过时外连');
    }
    try { await this.connection.protect(fd); }
    catch (_) { this.protectApiFailed++; throw new Error('系统 Socket 保护调用失败，拒绝外连'); }
    if (isConnectionKind(this.testKind) && (this.stopRequested || epoch !== this.networkEpoch)) {
      this.protectStaleAfter++;
      throw new Error('网络正在切换，拒绝过时外连');
    }
  }

  private async requestStop(completed: boolean): Promise<void> {
    this.stopControlPolling();
    // A retryable issue describes work still being attempted, not a historical
    // fatal failure. Once stopping starts it must not survive the final receipt.
    this.currentIssue = undefined;
    if (this.cleanup !== undefined) {
      await this.cleanup;
      return;
    }
    this.stopRequested = true;
    this.journal('stop-requested');
    this.networkEpoch++;
    if (this.networkDebounce >= 0) { clearTimeout(this.networkDebounce); this.networkDebounce = -1; }
    if (this.timerId !== -1) {
      clearTimeout(this.timerId);
      this.timerId = -1;
    }
    this.cleanup = this.cleanupProbe(completed);
    await this.cleanup;
  }

  private async cleanupProbe(completed: boolean): Promise<void> {
    if (this.initialization !== undefined) {
      await this.initialization;
    }
    if (this.networkReadTask !== undefined) { await this.networkReadTask; }
    if (this.networkTask !== undefined) { await this.networkTask; }
    if (this.latencyTask !== undefined) { await this.latencyTask; }
    if (this.networkWatcher) {
      try { await this.networkWatcher.stop(); } catch (_) { hilog.warn(DOMAIN, TAG, 'NETWORK_WATCHER_STOP_UNCONFIRMED'); }
    }
    if (this.statusTask !== undefined) { await this.statusTask; }
    if (this.testKind === 'node-latency' && !this.latencyFinished) {
      const reason = this.connectionFailure?.stage === 'configuration' ? 'configuration' :
        this.connectionFailure?.reason === 'timeout' ? 'timeout' : 'internal';
      this.finishLatency(this.failure ? 'failed' : 'cancelled', 0, this.failure ? reason : 'stopped');
    }
    this.checkPersistentCancellation();
    const hadNetwork = this.networkCreated;
    let resourceCleanupSucceeded = true;
    if (!this.cancelled) {
      this.publishSafely('stopping', '正在关闭探针 FD，并销毁本次受限 VPN 网卡。');
    }
    if (this.coreProbe !== undefined) {
      if (isConnectionKind(this.testKind) && this.connectionPhase === 'active') {
        try { this.lastSnapshot = await this.coreProbe.readConnectionSnapshot(); } catch (_) {}
      }
      if (this.testKind === 'node' || isConnectionKind(this.testKind)) {
        await this.coreProbe.logNodeTraffic();
        if (this.failure.length > 0 && this.coreProbe.diagnosticSummary.length > 0) {
          this.failure += '; ' + this.coreProbe.diagnosticSummary;
        }
      }
      if (this.testKind === 'node' && this.transferVerified) {
        try {
          await this.coreProbe.verifyNodeTraffic();
        } catch (error) {
          this.recordFailure('节点流量证据不足', error);
        }
      }
      try {
        await this.coreProbe.stop();
        if (this.testKind === 'reject') {
          if (!this.rejectionObserved) { throw new Error('未观察到预期的请求失败'); }
          this.coreProbe.verifyRejectedProtection();
        }
        if (this.testKind !== 'node' && !isConnectionKind(this.testKind) && this.transferVerified && this.coreProbe.requests < 1) {
          throw new Error('客户端收到响应，但本次测试服务没有成功请求记录');
        }
      } catch (error) {
        resourceCleanupSucceeded = false;
        this.recordFailure('清理转发核心失败', error, 'cleanup', true);
      }
    }

    // Clear ownership before closing, so repeated destroy/stop cannot close a
    // descriptor which the operating system has since reused for another file.
    if (this.tunFd >= 0) {
      const ownedFd = this.tunFd;
      this.tunFd = -1;
      try {
        fs.closeSync(ownedFd);
        hilog.info(DOMAIN, TAG, 'TUN FD closed');
      } catch (error) {
        resourceCleanupSucceeded = false;
        this.recordFailure('关闭 TUN FD 失败', error, 'cleanup', true);
      }
    }
    if (this.networkCreated && this.connection !== undefined) {
      try {
        await this.connection.destroy();
        this.networkCreated = false;
        hilog.info(DOMAIN, TAG, 'VPN network destroy succeeded');
      } catch (error) {
        resourceCleanupSucceeded = false;
        this.recordFailure('销毁 VPN 网卡失败', error, 'cleanup', true);
      }
    }
    this.resourceCleanupConfirmed = resourceCleanupSucceeded && this.tunFd < 0 && !this.networkCreated;
    this.currentIssue = undefined;

    // A timeout/cancellation can arrive while destroy() is pending. Preserve
    // that result instead of replacing it with a successful observation.
    this.checkPersistentCancellation();
    if (isConnectionKind(this.testKind)) {
      if (this.notificationTask !== undefined) {
        await Promise.race([this.notificationTask, new Promise<void>((resolve) => { setTimeout(resolve, 1500); })]);
      }
      try { await cancelConnectionNotification(this.runId); } catch (_) {}
      if (this.failure.length > 0) {
        this.publishSafely('failed', this.failure);
      } else {
        this.publishSafely('stopped', this.testKind === 'connection' ? '已断开连接，核心和 VPN 网卡已释放。' : '连接验证已结束，核心和 VPN 网卡已释放。');
      }
      try { this.persistConnectionStatus(this.destroyed ? 'destroyed' : 'stopped'); } catch (_) {}
      hilog.info(DOMAIN, TAG, 'CONNECTION_STOPPED runId=%{public}s cleanup=%{public}s', this.runId, this.resourceCleanupConfirmed.toString());
      this.flushProtectionJournal();
      this.journal('session-stopped', '', this.resourceCleanupConfirmed ? 1 : 0);
    } else if (this.failure.length > 0) {
      this.publishSafely('failed', this.failure);
    } else if (completed && this.fdInspected && !this.cancelled) {
      if (this.testKind === 'reject' && this.rejectionObserved) {
        this.publishSafely('passed', '保护请求被拒绝后未向测试服务拨号，活动请求为 0，核心和网卡已释放。');
      } else if (this.testKind !== 'lifecycle' && this.transferVerified) {
        this.publishSafely('passed', this.testKind === 'node'
          ? '节点 IPv4 HTTPS 测试成功，Xray 出站双向流量增加；测试已结束并释放网卡。'
          : (this.testKind === 'xray'
            ? '真实 HTTP 已经过 TUN → Hev → Xray → 本机测试服务，校验标记匹配，核心和网卡已释放。'
            : '真实 HTTP 已经过 TUN → Hev → 本机测试服务，校验标记匹配，核心和网卡已释放。'));
      } else {
        this.publishSafely('passed', `5 秒受限探针完成：TUN FD 检查、关闭及 VPN 网卡销毁均成功。${this.nativeDetail}`);
      }
    } else if (hadNetwork) {
      this.publishSafely('stopped', '探针已提前停止；本次取得的 TUN FD 已关闭，VPN 网卡已销毁。');
    } else {
      this.publishSafely('stopped', '本次启动已取消，扩展未取得 TUN FD，未确认创建虚拟网卡。');
    }

    // Persist resource results before stopping this process. onDestroy logs
    // separately establish whether the extension itself exited.
    // Never stop a newer request using the same extension identity.
    const current = readProbeState(this.context.filesDir);
    if (!this.destroyed && (current.runId.length === 0 || current.runId === this.runId)) {
      const want: Want = {
        bundleName: 'com.example.harmonyvpnlab',
        abilityName: 'VpnProbeAbility'
      };
      try {
        await vpnExtension.stopVpnExtensionAbility(want);
      } catch (error) {
        this.recordFailure('请求停止 VPN 扩展失败', error, 'cleanup', true);
        this.publishSafely('failed', this.failure);
      }
    }
  }

  private checkPersistentCancellation(): boolean {
    if (isConnectionKind(this.testKind)) {
      const command = readConnectionCommand(this.context.filesDir);
      if (!command || command.runId !== this.runId || command.action === 'stop') {
        this.cancelled = true;
        this.stopRequested = true;
        return true;
      }
    }
    const current = readProbeState(this.context.filesDir);
    const superseded = current.runId.length > 0 && current.runId !== this.runId;
    const cancelledByUi = current.runId === this.runId &&
      (current.phase === 'stop_requested' || current.phase === 'stopped' || current.phase === 'failed');
    if (!superseded && !cancelledByUi) {
      return false;
    }
    this.cancelled = true;
    this.stopRequested = true;
    if (cancelledByUi && current.phase === 'failed' && this.failure.length === 0) {
      this.failure = current.detail;
    }
    hilog.info(DOMAIN, TAG, 'Persistent cancellation observed, runId=%{public}s, phase=%{public}s',
      this.runId, current.phase);
    return true;
  }

  private persistConnectionStatus(phase: string): void {
    const command = readConnectionCommand(this.context.filesDir);
    const state = readProbeState(this.context.filesDir);
    if ((command && command.runId !== this.runId) || (state.runId.length > 0 && state.runId !== this.runId)) { return; }
    const previous = readConnectionStatus(this.context.filesDir);
    if (previous?.runId === this.runId && previous.phase === 'destroyed' && phase !== 'destroyed') { return; }
    const value = new ConnectionStatus(this.runId, phase, this.lastSnapshot, this.resourceCleanupConfirmed, native.currentProcessId(),
      this.desiredNetwork?.kind ?? '', this.reconnectCount);
    value.failure = this.connectionFailure;
    value.cleanupFailure = this.cleanupFailure;
    value.currentIssue = this.currentIssue;
    writeConnectionStatus(this.context.filesDir, value);
  }

  private connectionDetail(): string {
    if (this.testKind === 'node-latency') { return '正在检测指定节点，仅接管本应用流量；完成后自动断开。'; }
    const scope = this.testKind === 'connection-app-test' ? '本应用验证' : '全设备 IPv4 代理';
    const network = this.desiredNetwork?.kind === 'wifi' ? 'Wi-Fi' : this.desiredNetwork?.kind === 'cellular' ? '移动数据' : '物理网络';
    return `${scope}与代理 DNS 已启动，当前使用${network}，IPv6 请求暂不转发。` +
      (this.testKind === 'connection' ? '' : '本次验证到 90 秒会自动断开。');
  }

  private journal(code: string, kind: string = '', value: number = 0): void {
    if (!isConnectionKind(this.testKind)) { return; }
    try { appendDiagnosticEvent(this.context.filesDir, this.runId, code, kind, value); } catch (_) {}
  }

  private flushProtectionJournal(): void {
    if (this.loggedBefore !== this.protectStaleBefore) {
      this.journal('protect-stale-before', 'before', this.protectStaleBefore); this.loggedBefore = this.protectStaleBefore;
    }
    if (this.loggedAfter !== this.protectStaleAfter) {
      this.journal('protect-stale-after', 'after', this.protectStaleAfter); this.loggedAfter = this.protectStaleAfter;
    }
    if (this.loggedApi !== this.protectApiFailed) {
      this.journal('protect-api-failed', '', this.protectApiFailed); this.loggedApi = this.protectApiFailed;
    }
  }

  private finishLatency(status: string, durationMs: number, reason: string, proof?: LatencyProof): void {
    if (this.latencyFinished || this.testKind !== 'node-latency') { return; }
    this.latencyFinished = true;
    if (this.latencyNodeId && this.latencyFingerprint) {
      try {
        saveNodeLatency(this.context.filesDir, new NodeLatencyResult(this.latencyNodeId, this.latencyFingerprint,
          this.runId, status, durationMs, reason, Date.now(), proof?.measurementVersion ?? 2,
          proof?.secondStatus ?? 'not-tested', proof?.secondDurationMs ?? 0,
          proof?.secondReason ?? '', proof?.secondConnection ?? 'unknown'));
        this.journal(status === 'passed' ? 'latency-ok' : 'latency-failed', '', Math.round(durationMs));
        hilog.info(DOMAIN, TAG, 'NODE_LATENCY_RESULT runId=%{public}s status=%{public}s durationMs=%{public}d reason=%{public}s',
          this.runId, status, Math.round(durationMs), reason);
      } catch (_) { hilog.warn(DOMAIN, TAG, 'NODE_LATENCY_SAVE_FAILED'); }
    }
    if (!this.stopRequested && !this.destroyed) { setTimeout(() => { void this.requestStop(false); }, 0); }
  }

  private async acceptLatencyProof(): Promise<void> {
    try {
      const proof = readLatencyProof(this.context.filesDir);
      if (!proof || proof.runId !== this.runId || proof.nodeId !== this.latencyNodeId ||
        proof.outboundFingerprint !== this.latencyFingerprint) { return; }
      const epoch = this.networkEpoch;
      if (this.stopRequested || this.checkPersistentCancellation() || epoch !== this.latencyEpoch || this.connectionPhase !== 'active') { return; }
      if (proof.status === 'passed') {
        if (!this.coreProbe) { return; }
        const snapshot = await this.coreProbe.readConnectionSnapshot();
        if (this.stopRequested || this.checkPersistentCancellation() || this.latencyFinished || epoch !== this.networkEpoch) { return; }
        if (snapshot.active !== true || !Number.isFinite(snapshot.uplink) || !Number.isFinite(snapshot.downlink) || snapshot.uplink <= 0 || snapshot.downlink <= 0) {
          this.finishLatency('failed', 0, 'internal'); return;
        }
      }
      this.finishLatency(proof.status, proof.durationMs, proof.reason, proof);
    } catch (_) { if (!this.stopRequested && !this.checkPersistentCancellation()) { this.finishLatency('failed', 0, 'internal'); } }
  }

  private stopControlPolling(): void {
    if (this.controlPollId !== -1) {
      clearInterval(this.controlPollId);
      this.controlPollId = -1;
    }
  }

  private publish(phase: string, detail: string): void {
    const current = readProbeState(this.context.filesDir);
    if (current.runId.length > 0 && current.runId !== this.runId) {
      hilog.warn(DOMAIN, TAG, 'Skipping state write for superseded runId=%{public}s', this.runId);
      return;
    }
    writeProbeState(this.context.filesDir, new ProbeState(phase, detail, this.runId, this.testKind));
    hilog.info(DOMAIN, TAG, 'Probe state %{public}s: %{public}s', phase, detail);
  }

  private publishSafely(phase: string, detail: string): void {
    try {
      this.publish(phase, detail);
    } catch (error) {
      this.recordFailure('保存探针状态失败', error);
    }
  }

  private recordFailure(message: string, error: Object, stage: string = 'status', cleanup: boolean = false): void {
    const detail = `${message}: ${describeError(error)}`;
    this.failure = this.failure.length > 0 ? `${this.failure}; ${detail}` : detail;
    if (isConnectionKind(this.testKind)) {
      let recorded: ConnectionFailure | undefined = undefined;
      if (cleanup) {
        if (!this.cleanupFailure) { this.cleanupFailure = makeConnectionFailure('cleanup'); recorded = this.cleanupFailure; }
      } else if (!this.connectionFailure) { this.connectionFailure = connectionFailureFromError(error, stage); recorded = this.connectionFailure; }
      // Preserve the first fatal stage before asynchronous cleanup can be cut
      // short. Status remains service-owned and existing run guards still apply.
      try {
        const previous = readConnectionStatus(this.context.filesDir);
        const phase = previous?.runId === this.runId && ['stopped', 'destroyed', 'destroying'].includes(previous.phase) ?
          previous.phase : this.destroyed ? 'destroying' : this.connectionPhase;
        this.persistConnectionStatus(phase);
      } catch (_) {}
      if (recorded) {
        const state = readProbeState(this.context.filesDir);
        const command = readConnectionCommand(this.context.filesDir);
        if ((!state.runId || state.runId === this.runId) && (!command || command.runId === this.runId)) {
          this.journal(failureDiagnosticCode(recorded), '', failureDiagnosticValue(recorded));
        }
      }
    }
    hilog.error(DOMAIN, TAG, '%{public}s', detail);
  }
}
