import { util } from '@kit.ArkTS';
import native from 'libvpnbridge.so';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { socket } from '@kit.NetworkKit';
import { prepareCaBundle } from './CaBundle';
import { nodeEndpoint, readNodeProfile } from '../model/NodeProfile';
import { describeError } from '../model/ErrorInfo';
import { fileIo as fs } from '@kit.CoreFileKit';
import { parseNode } from '../model/NodeImport';
import { buildConnectionConfig } from '../model/ConnectionConfig';
import { ConnectionSnapshot } from '../model/ConnectionSnapshot';
import { NodeBootstrap } from '../model/NodeBootstrap';
import { NetworkPolicy, validateNetworkPolicy } from '../model/NetworkPolicy';
import { systemDateTime } from '@kit.BasicServicesKit';

interface RealityDiagnostics { show?: boolean; }
interface OutboundStream { realitySettings?: RealityDiagnostics; }
interface TaggedOutbound { tag: string; streamSettings?: OutboundStream; }
interface TrafficCounters { uplink: number; downlink: number; }
interface PortPair { socksPort: number; metricsPort: number; }
interface ProtectionStats { requests: number; succeeded: number; failed: number; timedOut: number; active: number; }
interface RuntimeInfo { unixMillis: number; goVersion: string; goos: string; goarch: string; }
interface ForwardingStatus { hevRunning: boolean; hevExit: number; }

interface FixtureStatus {
  port: number;
  requests: number;
  error?: string;
}

interface CoreReply {
  success: boolean;
  data?: Object;
  error?: string;
}

class XrayStartRequest {
  datDir: string;
  configJSON: string;
  constructor(datDir: string, configJSON: string) {
    this.datDir = datDir;
    this.configJSON = configJSON;
  }
}

export class CoreProbe {
  private fixtureAttempted: boolean = false;
  private hevAttempted: boolean = false;
  private xrayAttempted: boolean = false;
  requests: number = 0;
  version: string = '';
  diagnosticSummary: string = '';
  private metricsPort: number = 0;
  private baselineUp: number = 0;
  private baselineDown: number = 0;
  private errorPath: string = '';
  private nodeAddress: string = '';
  private nodePort: number = 0;
  private lastLoopCheck: number = 0;
  private protectorInstalled: boolean = false;
  private connectionMode: boolean = false;
  private connectionActive: boolean = false;
  private connectionStartedAt: number = 0;
  private connectionEpoch: number = 0;
  private connectionLogOffset: number = 0;
  private connectionLogCarry: string = '';
  private ipv6BlockedRequests: number = 0;
  private dnsRequests: number = 0;
  private connectionStartTask: Promise<void> | undefined = undefined;
  private connectionRecoveryTask: Promise<void> | undefined = undefined;
  private connectionStopTask: Promise<void> | undefined = undefined;
  private connectionFinalStop: boolean = false;
  private connectionPrepared: boolean = false;
  private connectionSuspended: boolean = false;
  private connectionOutboundJson: string = '';
  private connectionPolicy?: NetworkPolicy;
  private connectionSocksPort: number = 0;
  private connectionAccumulatedUp: number = 0;
  private connectionAccumulatedDown: number = 0;
  private connectionCachedUp: number = 0;
  private connectionCachedDown: number = 0;

  private decodeReply(encoded: string): CoreReply {
    const bytes = new util.Base64Helper().decodeSync(encoded);
    const json = new util.TextDecoder().decodeToString(bytes);
    const reply = JSON.parse(json) as CoreReply;
    if (typeof reply.success !== 'boolean') {
      throw new Error('Xray 返回格式无效');
    }
    if (!reply.success) {
      throw new Error(reply.error ?? 'Xray 操作失败');
    }
    return reply;
  }

  private async checkRuntimeClock(): Promise<void> {
    const before = Date.now();
    const reply = this.decodeReply(await native.xrayCall('runtime', ''));
    const after = Date.now();
    const info = reply.data as RuntimeInfo;
    if (typeof info.unixMillis !== 'number' || !Number.isFinite(info.unixMillis)) {
      throw new Error('Go 运行时未返回有效时间');
    }
    const delta = info.unixMillis - Math.round((before + after) / 2);
    hilog.info(0x0000, 'HarmonyVpnLab',
      'GO_RUNTIME go=%{public}s os=%{public}s arch=%{public}s clockDeltaMs=%{public}d windowMs=%{public}d',
      info.goVersion, info.goos, info.goarch, delta, after - before);
    if (info.unixMillis < before - 10000 || info.unixMillis > after + 10000) {
      throw new Error('Go 时间与系统时间差异超过 10 秒，暂不开始节点握手');
    }
  }

  async start(fd: number, token: string, context: common.Context, useXray: boolean,
    protectSocket: (fd: number) => Promise<void>): Promise<void> {
    const filesDir = context.filesDir;
    this.fixtureAttempted = true;
    const fixture = JSON.parse(await native.startFixture(token)) as FixtureStatus;
    let socksPort = fixture.port;
    hilog.info(0x0000, 'HarmonyVpnLab', 'FIXTURE_STARTED port=%{public}d', socksPort);
    if (useXray) {
      await native.configureXrayCa(await prepareCaBundle(context));
      const versionReply = this.decodeReply(await native.xrayCall('version', ''));
      this.version = String(versionReply.data);
      await this.checkRuntimeClock();
      native.installSocketProtector(protectSocket);
      this.protectorInstalled = true;
      hilog.info(0x0000, 'HarmonyVpnLab', 'SOCKET_PROTECTOR_INSTALLED');
      hilog.info(0x0000, 'HarmonyVpnLab', 'XRAY_VERSION %{public}s', this.version);
      const xrayPort = native.getFreePort();
      // Both ends of this core-only integration test are loopback SOCKS.
      // The synthetic destination remains visible end-to-end to the fixture.
      const config = `{"log":{"loglevel":"warning"},` +
        `"inbounds":[{"tag":"probe-in","listen":"127.0.0.1","port":${xrayPort},` +
        `"protocol":"socks","settings":{"auth":"noauth","udp":true}}],` +
        `"outbounds":[{"tag":"fixture-out","protocol":"socks","settings":` +
        `{"servers":[{"address":"127.0.0.1","port":${socksPort}}]}}]}`;
      const request = JSON.stringify(new XrayStartRequest(filesDir, config));
      const encoded = new util.Base64Helper().encodeToStringSync(new util.TextEncoder().encodeInto(request));
      this.xrayAttempted = true;
      this.decodeReply(await native.xrayCall('start', encoded));
      socksPort = xrayPort;
      hilog.info(0x0000, 'HarmonyVpnLab', 'XRAY_STARTED');
    }
    this.hevAttempted = true;
    await native.startHev(fd, socksPort);
    hilog.info(0x0000, 'HarmonyVpnLab', 'HEV_WORKER_STARTED (traffic not yet verified)');
  }

  async startNode(fd: number, context: common.Context, protectSocket: (fd: number) => Promise<void>): Promise<void> {
    const node = readNodeProfile(context.filesDir);
    if (!node) {
      throw new Error('请先在应用中导入节点');
    }
    const endpoint = nodeEndpoint(node);
    this.nodeAddress = endpoint.address;
    this.nodePort = endpoint.port;
    hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_CONFIG protocol=%{public}s transport=%{public}s security=%{public}s port=%{public}d',
      endpoint.protocol, endpoint.network, endpoint.security, endpoint.port);
    const client = socket.constructTCPSocketInstance();
    try {
      await client.connect({ address: { address: endpoint.address, port: endpoint.port, family: 1 }, timeout: 4000 });
      hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_TCP_REACHABLE');
    } catch (error) {
      throw new Error('节点 TCP 连通性检查失败：' + describeError(error));
    } finally {
      try { await client.close(); } catch (_) { /* connect may fail before allocating a socket */ }
    }
    await native.configureXrayCa(await prepareCaBundle(context));
    const versionReply = this.decodeReply(await native.xrayCall('version', ''));
    this.version = String(versionReply.data);
    await this.checkRuntimeClock();
    native.installSocketProtector(protectSocket);
    this.protectorInstalled = true;
    hilog.info(0x0000, 'HarmonyVpnLab', 'SOCKET_PROTECTOR_INSTALLED');
    const ports = JSON.parse(native.getFreePorts()) as PortPair;
    const socksPort = ports.socksPort;
    this.metricsPort = ports.metricsPort;
    const outbound = JSON.parse(node.outboundJson) as TaggedOutbound;
    outbound.tag = 'nodeProxy';
    if (outbound.streamSettings?.realitySettings) {
      outbound.streamSettings.realitySettings.show = false;
    }
    this.errorPath = `${context.filesDir}/xray-node-diagnostic.log`;
    const logFile = fs.openSync(this.errorPath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    fs.closeSync(logFile);
    const config = `{"log":{"loglevel":"info","access":"none","error":${JSON.stringify(this.errorPath)}},` +
      `"stats":{},"policy":{"system":{"statsOutboundUplink":true,"statsOutboundDownlink":true}},` +
      `"inbounds":[{"tag":"probe-in","listen":"127.0.0.1","port":${socksPort},` +
      `"protocol":"socks","settings":{"auth":"noauth","udp":true}}],` +
      `"outbounds":[${JSON.stringify(outbound)}]}`;
    const request = JSON.stringify(new XrayStartRequest(context.filesDir, config));
    const encoded = new util.Base64Helper().encodeToStringSync(new util.TextEncoder().encodeInto(request));
    this.xrayAttempted = true;
    this.decodeReply(await native.xrayCall('start', encoded));
    hilog.info(0x0000, 'HarmonyVpnLab', 'XRAY_NODE_STARTED version=%{public}s', this.version);
    const baseline = await this.readCounters();
    this.baselineUp = baseline.uplink;
    this.baselineDown = baseline.downlink;
    this.hevAttempted = true;
    await native.startHev(fd, socksPort);
    hilog.info(0x0000, 'HarmonyVpnLab', 'HEV_WORKER_STARTED (node traffic not yet verified)');
  }

  private requireConnectionEpoch(epoch: number): void {
    if (!this.connectionMode || this.connectionFinalStop || this.connectionEpoch !== epoch) {
      throw new Error('连接启动已取消');
    }
  }

  // Persistent engine startup only. The owning VPN ability manages cancellation,
  // heartbeat scheduling and session duration; this path performs no node probe.
  async startConnection(fd: number, context: common.Context,
    protectSocket: (fd: number) => Promise<void>, bootstrap?: NodeBootstrap,
    sessionOutboundJson?: string, policy?: NetworkPolicy): Promise<void> {
    if (this.connectionStartTask !== undefined) { throw new Error('连接核心正在启动'); }
    const task = this.startConnectionInternal(fd, context, protectSocket, bootstrap, sessionOutboundJson, policy);
    this.connectionStartTask = task;
    try { await task; }
    finally {
      if (this.connectionStartTask === task) { this.connectionStartTask = undefined; }
    }
  }

  private async startConnectionInternal(fd: number, context: common.Context,
    protectSocket: (fd: number) => Promise<void>, bootstrap?: NodeBootstrap,
    sessionOutboundJson?: string, policy?: NetworkPolicy): Promise<void> {
    if (this.connectionFinalStop || this.xrayAttempted || this.hevAttempted || this.fixtureAttempted || this.protectorInstalled) {
      throw new Error('请在上一 VPN 扩展进程退出后创建新的连接');
    }
    let outboundJson = sessionOutboundJson;
    if (outboundJson === undefined) {
      const saved = readNodeProfile(context.filesDir);
      if (!saved) { throw new Error('请先在应用中导入节点'); }
      outboundJson = saved.outboundJson;
    }
    this.connectionOutboundJson = parseNode(outboundJson).outboundJson;
    this.connectionPolicy = policy === undefined ? undefined : validateNetworkPolicy(policy);
    this.connectionMode = true;
    this.connectionActive = false;
    const epoch = ++this.connectionEpoch;
    const ports = JSON.parse(native.getFreePorts()) as PortPair;
    this.connectionSocksPort = ports.socksPort;
    this.metricsPort = ports.metricsPort;
    this.errorPath = `${context.filesDir}/xray-connection-diagnostic.log`;
    // Validate the frozen node/bootstrap before loading any process-lived code.
    buildConnectionConfig(this.connectionOutboundJson, ports.socksPort, ports.metricsPort, this.errorPath, bootstrap, this.connectionPolicy);
    const logFile = fs.openSync(this.errorPath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    fs.closeSync(logFile);
    this.connectionLogOffset = 0;
    this.connectionLogCarry = '';
    this.ipv6BlockedRequests = 0;
    this.dnsRequests = 0;
    await native.configureXrayCa(await prepareCaBundle(context));
    this.requireConnectionEpoch(epoch);
    const versionReply = this.decodeReply(await native.xrayCall('version', ''));
    this.requireConnectionEpoch(epoch);
    this.version = String(versionReply.data);
    await this.checkRuntimeClock();
    this.requireConnectionEpoch(epoch);
    native.installSocketProtector(protectSocket);
    this.protectorInstalled = true;
    this.connectionPrepared = true;
    await this.startConnectionCore(context, bootstrap, epoch);
    this.hevAttempted = true;
    await native.startHev(fd, ports.socksPort, true);
    this.requireConnectionEpoch(epoch);
    this.connectionStartedAt = Date.now();
    this.connectionActive = true;
    hilog.info(0x0000, 'HarmonyVpnLab',
      'CONNECTION_CORE_READY version=%{public}s dns=proxied-doh ipv6=blocked', this.version);
  }

  private async startConnectionCore(context: common.Context, bootstrap: NodeBootstrap | undefined,
    epoch: number): Promise<void> {
    this.requireConnectionEpoch(epoch);
    const config = buildConnectionConfig(this.connectionOutboundJson, this.connectionSocksPort,
      this.metricsPort, this.errorPath, bootstrap, this.connectionPolicy);
    const request = JSON.stringify(new XrayStartRequest(context.filesDir, config));
    const encoded = new util.Base64Helper().encodeToStringSync(new util.TextEncoder().encodeInto(request));
    this.xrayAttempted = true;
    this.decodeReply(await native.xrayCall('start', encoded));
    this.requireConnectionEpoch(epoch);
    const baseline = await this.readCounters();
    this.requireConnectionEpoch(epoch);
    this.baselineUp = baseline.uplink;
    this.baselineDown = baseline.downlink;
    this.connectionCachedUp = 0;
    this.connectionCachedDown = 0;
  }

  private requireHevRunning(): void {
    const forwarding = JSON.parse(native.forwardingStatus()) as ForwardingStatus;
    if (!this.hevAttempted || typeof forwarding.hevRunning !== 'boolean' || !forwarding.hevRunning ||
      typeof forwarding.hevExit !== 'number' || !Number.isInteger(forwarding.hevExit)) {
      throw new Error('Hev 转发已停止，需要重新连接');
    }
  }

  private async queueConnectionRecovery(operation: () => Promise<void>): Promise<void> {
    if (this.connectionFinalStop) { throw new Error('连接已最终停止'); }
    const previous = this.connectionRecoveryTask;
    const task = this.runConnectionRecovery(previous, operation);
    this.connectionRecoveryTask = task;
    try { await task; }
    finally {
      if (this.connectionRecoveryTask === task) { this.connectionRecoveryTask = undefined; }
    }
  }

  private async runConnectionRecovery(previous: Promise<void> | undefined,
    operation: () => Promise<void>): Promise<void> {
    if (previous !== undefined) {
      try { await previous; } catch (_) { /* The next operation validates native ownership again. */ }
    }
    const pendingStart = this.connectionStartTask;
    if (pendingStart !== undefined) { await pendingStart; }
    if (this.connectionFinalStop) { throw new Error('连接已最终停止'); }
    if (!this.connectionPrepared || !this.connectionMode) { throw new Error('持续连接尚未初始化'); }
    await operation();
  }

  async suspendConnection(): Promise<void> {
    await this.queueConnectionRecovery(async () => {
      this.connectionActive = false;
      this.connectionSuspended = true;
      this.connectionEpoch++;
      this.requireHevRunning();
      if (!this.xrayAttempted) { await this.waitForProtectionIdle(); return; }
      // The native stats read can fail while a core is being cancelled. Retain
      // the last accepted snapshot as a lower bound if that final read fails.
      try {
        const counters = await this.readCounters();
        this.cacheConnectionCounters(counters);
      } catch (_) { /* Cached counters are an explicit lower-bound fallback. */ }
      try { this.collectConnectionDiagnostics(); } catch (_) { /* Cleanup must still stop the core. */ }
      this.decodeReply(await native.xrayCall('stop', ''));
      this.xrayAttempted = false;
      this.connectionAccumulatedUp += this.connectionCachedUp;
      this.connectionAccumulatedDown += this.connectionCachedDown;
      this.connectionCachedUp = 0;
      this.connectionCachedDown = 0;
      try { this.collectConnectionDiagnostics(); } catch (_) { /* Preserve previously collected counts. */ }
      await this.waitForProtectionIdle();
      hilog.info(0x0000, 'HarmonyVpnLab', 'CONNECTION_CORE_SUSPENDED hev=retained');
    });
  }

  async resumeConnection(context: common.Context, bootstrap?: NodeBootstrap): Promise<void> {
    await this.queueConnectionRecovery(async () => {
      this.requireHevRunning();
      if (this.connectionActive) { return; }
      if (!this.connectionSuspended || this.xrayAttempted) { throw new Error('连接核心尚未完成暂停'); }
      await this.waitForProtectionIdle();
      const epoch = ++this.connectionEpoch;
      this.requireConnectionEpoch(epoch);
      await this.startConnectionCore(context, bootstrap, epoch);
      this.requireConnectionEpoch(epoch);
      this.requireHevRunning();
      this.connectionSuspended = false;
      this.connectionActive = true;
      hilog.info(0x0000, 'HarmonyVpnLab', 'CONNECTION_CORE_RESUMED hev=retained');
    });
  }

  private cacheConnectionCounters(counters: TrafficCounters): void {
    this.connectionCachedUp = Math.max(this.connectionCachedUp, counters.uplink - this.baselineUp, 0);
    this.connectionCachedDown = Math.max(this.connectionCachedDown, counters.downlink - this.baselineDown, 0);
  }

  private async waitForProtectionIdle(): Promise<void> {
    if (!this.protectorInstalled) { return; }
    const deadline = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false) + 3000;
    for (;;) {
      const protection = JSON.parse(native.socketProtectionStats()) as ProtectionStats;
      if (!Number.isFinite(protection.active) || protection.active < 0) { throw new Error('Socket 保护计数无效'); }
      if (protection.active === 0) { return; }
      if (systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false) >= deadline) {
        throw new Error('仍有未完成的 socket 保护请求');
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    }
  }

  private collectConnectionDiagnostics(): void {
    if (!this.connectionMode || this.errorPath.length === 0 || !fs.accessSync(this.errorPath)) { return; }
    const size = fs.statSync(this.errorPath).size;
    const limit = 1048576;
    if (size < this.connectionLogOffset) {
      this.connectionLogOffset = 0;
      this.connectionLogCarry = '';
    }
    // Diagnostic counts are observed route decisions, not an exact packet counter.
    // Keep a bounded tail if a burst exceeded what the heartbeat previously read.
    if (size - this.connectionLogOffset > limit) {
      this.connectionLogOffset = size - limit;
      this.connectionLogCarry = '';
    }
    if (size > this.connectionLogOffset) {
      const length = size - this.connectionLogOffset;
      const chunk = fs.readTextSync(this.errorPath, { offset: this.connectionLogOffset, length: length });
      this.connectionLogOffset = size;
      const lines = (this.connectionLogCarry + chunk).split('\n');
      this.connectionLogCarry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.includes('app/dispatcher:') && line.includes('taking detour [block-ipv6]')) {
          this.ipv6BlockedRequests++;
        }
        if (line.includes('app/dispatcher:') && line.includes('taking detour [dns-out]')) {
          this.dnsRequests++;
        }
      }
    }
    if (size >= limit) {
      // The pinned core opens this file O_APPEND. Truncation keeps its handle
      // valid and bounds the private diagnostic log without copying its targets.
      fs.truncateSync(this.errorPath, 0);
      this.connectionLogOffset = 0;
      this.connectionLogCarry = '';
    }
  }

  async readConnectionSnapshot(): Promise<ConnectionSnapshot> {
    if (this.connectionSuspended && !this.connectionFinalStop) { throw new Error('持续连接核心已暂停'); }
    if (!this.connectionActive || !this.connectionMode || !this.xrayAttempted || !this.hevAttempted) {
      throw new Error('持续连接核心尚未运行或已经停止');
    }
    const epoch = this.connectionEpoch;
    const counters = await this.readCounters();
    this.requireConnectionEpoch(epoch);
    if (!this.connectionActive) { throw new Error('连接快照已失效'); }
    this.requireHevRunning();
    this.cacheConnectionCounters(counters);
    const protection = JSON.parse(native.socketProtectionStats()) as ProtectionStats;
    const values = [protection.requests, protection.succeeded, protection.failed, protection.timedOut, protection.active];
    for (const value of values) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('Socket 保护计数无效');
      }
    }
    try { this.collectConnectionDiagnostics(); }
    catch (_) { throw new Error('读取或轮转核心诊断日志失败'); }
    const snapshot = new ConnectionSnapshot();
    snapshot.active = true;
    snapshot.startedAt = this.connectionStartedAt;
    snapshot.sampledAt = Date.now();
    snapshot.coreVersion = this.version;
    snapshot.uplink = this.connectionAccumulatedUp + this.connectionCachedUp;
    snapshot.downlink = this.connectionAccumulatedDown + this.connectionCachedDown;
    snapshot.protectionRequests = protection.requests;
    snapshot.protectionSucceeded = protection.succeeded;
    snapshot.protectionFailed = protection.failed;
    snapshot.protectionTimedOut = protection.timedOut;
    snapshot.protectionActive = protection.active;
    snapshot.ipv6BlockedRequests = this.ipv6BlockedRequests;
    snapshot.dnsRequests = this.dnsRequests;
    return snapshot;
  }

  private async readCounters(): Promise<TrafficCounters> {
    if (!this.xrayAttempted) { throw new Error('Xray 核心未运行，不能读取流量计数'); }
    const epoch = this.connectionEpoch;
    const reply = this.decodeReply(await native.xrayCall('stats', ''));
    if (!this.xrayAttempted || this.connectionEpoch !== epoch) { throw new Error('Xray 流量统计读取已失效'); }
    const counts = reply.data as TrafficCounters;
    if (!counts || typeof counts.uplink !== 'number' || typeof counts.downlink !== 'number' ||
      !Number.isFinite(counts.uplink) || !Number.isFinite(counts.downlink) || counts.uplink < 0 || counts.downlink < 0) {
      throw new Error('Xray 流量计数字段缺失');
    }
    return counts;
  }

  async verifyNodeTraffic(): Promise<void> {
    const counters = await this.readCounters();
    const up = counters.uplink - this.baselineUp;
    const down = counters.downlink - this.baselineDown;
    if (up <= 0 || down <= 0) {
      throw new Error('HTTPS 返回，但未确认 Xray 节点出站双向流量增加');
    }
    const protection = JSON.parse(native.socketProtectionStats()) as ProtectionStats;
    if (protection.succeeded < 1 || protection.failed !== 0 || protection.timedOut !== 0) {
      throw new Error('节点连接缺少成功的逐 socket 保护证据');
    }
    hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_TRAFFIC_CONFIRMED uplink=%{public}d downlink=%{public}d', up, down);
  }

  async logNodeTraffic(): Promise<void> {
    this.logCoreSummary();
    if (this.connectionMode) {
      if (this.xrayAttempted) {
        try { this.cacheConnectionCounters(await this.readCounters()); }
        catch (_) { /* The retained counters are a lower bound after network loss. */ }
      }
      hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_TRAFFIC_SNAPSHOT uplink=%{public}d downlink=%{public}d',
        this.connectionAccumulatedUp + this.connectionCachedUp, this.connectionAccumulatedDown + this.connectionCachedDown);
      return;
    }
    if (!this.xrayAttempted) { return; }
    try {
      const counters = await this.readCounters();
      hilog.info(0x0000, 'HarmonyVpnLab', 'NODE_TRAFFIC_SNAPSHOT uplink=%{public}d downlink=%{public}d',
        counters.uplink - this.baselineUp, counters.downlink - this.baselineDown);
    } catch (error) {
      hilog.warn(0x0000, 'HarmonyVpnLab', 'NODE_METRICS_UNAVAILABLE %{public}s', describeError(error));
    }
  }

  private coreLog(): string {
    if (this.errorPath.length === 0 || !fs.accessSync(this.errorPath)) { return ''; }
    const size = fs.statSync(this.errorPath).size;
    if (size === 0) { return ''; }
    return fs.readTextSync(this.errorPath, { length: Math.min(size, 262144) });
  }

  detectOutboundLoop(): boolean {
    if (this.connectionMode) { return false; }
    if (Date.now() - this.lastLoopCheck < 500) { return false; }
    this.lastLoopCheck = Date.now();
    try {
      // Only for this fixed 1.1.1.1 probe: the UI never requests the node itself.
      return this.coreLog().includes(`proxy/socks: TCP Connect request to tcp:${this.nodeAddress}:${this.nodePort}`);
    } catch (_) { return false; }
  }

  private logCoreSummary(): void {
    try {
      const lines = this.coreLog().split('\n');
      let socks = 0;
      let recaptures = 0;
      let dials = 0;
      let realityRejected = 0;
      let certErrors = 0;
      let eof = 0;
      let timeouts = 0;
      for (const line of lines) {
        if (line.includes('proxy/socks: TCP Connect request')) { socks++; }
        if (line.includes(`proxy/socks: TCP Connect request to tcp:${this.nodeAddress}:${this.nodePort}`)) { recaptures++; }
        if (line.includes('dialing TCP to')) { dials++; }
        if (line.includes('processed invalid connection')) { realityRejected++; }
        if (line.includes('x509:') || line.includes('certificate verify')) { certErrors++; }
        if (line.includes('EOF')) { eof++; }
        if (line.includes('timeout') || line.includes('deadline exceeded')) { timeouts++; }
      }
      hilog.info(0x0000, 'HarmonyVpnLab',
        'NODE_DIAG socksRequests=%{public}d serverRecaptures=%{public}d tcpDials=%{public}d realityRejected=%{public}d certErrors=%{public}d eof=%{public}d timeouts=%{public}d',
        socks, recaptures, dials, realityRejected, certErrors, eof, timeouts);
      if (recaptures > 0) {
        this.diagnosticSummary = '检测到节点外连回环';
      } else if (realityRejected > 0) {
        this.diagnosticSummary = 'REALITY 握手未通过，需对照同一有效配置的核心版本与网络环境';
      } else if (certErrors > 0) {
        this.diagnosticSummary = '核心记录了证书验证错误，需结合 REALITY/服务器配置核对';
      } else if (eof > 0) {
        this.diagnosticSummary = '远端连接提前结束，不能仅据此判断具体认证参数';
      }
    } catch (error) {
      hilog.warn(0x0000, 'HarmonyVpnLab', 'NODE_DIAG_UNAVAILABLE %{public}s', describeError(error));
    }
  }

  verifyRejectedProtection(): void {
    const protection = JSON.parse(native.socketProtectionStats()) as ProtectionStats;
    if (protection.requests < 1 || protection.failed < 1 || protection.succeeded !== 0 ||
      protection.timedOut !== 0 || protection.active !== 0 || this.requests !== 0) {
      throw new Error('拒绝保护的检查未满足计数或资源条件');
    }
    hilog.info(0x0000, 'HarmonyVpnLab', 'PROTECTION_REJECTION_VERIFIED rejected=%{public}d fixtureRequests=0 active=0', protection.failed);
  }

  async stop(): Promise<void> {
    if (this.connectionStopTask !== undefined) { return this.connectionStopTask; }
    this.connectionFinalStop = true;
    this.connectionActive = false;
    this.connectionEpoch++;
    const task = this.stopInternal();
    this.connectionStopTask = task;
    return task;
  }

  private async stopInternal(): Promise<void> {
    // Drain an already queued start before stopping native resources. Without
    // this ordering a thread-pool stop could run before a late start completes.
    const pendingStart = this.connectionStartTask;
    if (pendingStart !== undefined) {
      try { await pendingStart; } catch (_) { /* cancellation/failure is cleaned below */ }
    }
    const pendingRecovery = this.connectionRecoveryTask;
    if (pendingRecovery !== undefined) {
      try { await pendingRecovery; } catch (_) { /* A late recovery cannot outlive final cleanup. */ }
    }
    let failures: string[] = [];
    if (this.hevAttempted) {
      try {
        const result = await native.stopHev();
        this.hevAttempted = false;
        hilog.info(0x0000, 'HarmonyVpnLab', 'HEV_STOPPED %{public}s', result);
      } catch (error) {
        failures.push('停止 Hev：' + String(error));
      }
    }
    if (this.xrayAttempted) {
      try {
        this.decodeReply(await native.xrayCall('stop', ''));
        this.xrayAttempted = false;
        hilog.info(0x0000, 'HarmonyVpnLab', 'XRAY_STOPPED');
      } catch (error) {
        failures.push('停止 Xray：' + String(error));
      }
    }
    if (this.fixtureAttempted) {
      try {
        const result = JSON.parse(await native.stopFixture()) as FixtureStatus;
        this.requests = result.requests;
        this.fixtureAttempted = false;
        hilog.info(0x0000, 'HarmonyVpnLab', 'FIXTURE_STOPPED requests=%{public}d', this.requests);
      } catch (error) {
        failures.push('停止测试服务：' + String(error));
      }
    }
    if (this.protectorInstalled) {
      try { await this.waitForProtectionIdle(); }
      catch (error) { failures.push(String(error)); }
      const protection = JSON.parse(native.socketProtectionStats()) as ProtectionStats;
      hilog.info(0x0000, 'HarmonyVpnLab',
        'SOCKET_PROTECTION requests=%{public}d succeeded=%{public}d failed=%{public}d timedOut=%{public}d active=%{public}d',
        protection.requests, protection.succeeded, protection.failed, protection.timedOut, protection.active);
    }
    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
  }
}
