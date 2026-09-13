import { common } from '@kit.AbilityKit';
import { vpnExtension, http } from '@kit.NetworkKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import nativeBridge from 'libvpnbridge.so';
import { ProbeState, readProbeState, writeProbeState } from '../model/ProbeState';
import { TransferResult, writeTransferResult } from '../model/TransferResult';
import { readNodeProfile } from '../model/NodeProfile';
import { describeError } from '../model/ErrorInfo';
import { ConnectionCommand, isConnectionKind, writeConnectionCommand } from '../model/ConnectionControl';
import { subscribeVpnAuthorization, unsubscribeVpnAuthorization } from '../model/VpnAuthorization';
import { formContentWidth } from '../model/AdaptiveLayout';
import { readConnectionLifecycle } from '../model/ConnectionLifecycle';

interface FixtureReply {
  token: string;
  via: string;
}

@Entry
@Component
struct Index {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State nativeResult: string = '等待原生检查';
  @State nativeReady: boolean = false;
  @State phase: string = 'idle';
  @State detail: string = '点击下方按钮，开始 5 秒 VPN 生命周期测试。';
  @State runId: string = '';
  @State selectedKind: string = 'lifecycle';
  @State testKind: string = 'lifecycle';
  @State nodeStatus: string = '尚未导入节点';
  @State hasNode: boolean = false;
  private lastTransferRun: string = '';
  private pollTimer: number = -1;
  private authorizationSubscription: number = -1;

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  aboutToAppear(): void {
    this.refreshNodeInfo();
    this.checkNative();
    try {
      if (this.authorizationSubscription < 0) {
      this.authorizationSubscription = subscribeVpnAuthorization((allowed: boolean) => {
        hilog.info(0x0000, 'HarmonyVpnLab', 'VPN_AUTH allowed=%{public}s', allowed.toString());
        if (!allowed && this.runId.length > 0) {
          const current = readProbeState(this.context().filesDir);
          if (current.runId !== this.runId || current.kind !== this.testKind) { return; }
          writeProbeState(this.context().filesDir,
            new ProbeState('failed', '用户未授权 VPN，本次未创建虚拟网卡。', this.runId, this.testKind));
          this.refreshState();
        }
      });
      }
    } catch (err) {
      hilog.warn(0x0000, 'HarmonyVpnLab', 'OBSERVER_FAILED %{public}s', JSON.stringify(err));
    }
    this.refreshState();
    if (this.pollTimer < 0) { this.pollTimer = setInterval(() => this.refreshState(), 500); }
  }

  onPageShow(): void {
    this.refreshNodeInfo();
    if (this.pollTimer < 0) { this.pollTimer = setInterval(() => this.refreshState(), 500); }
  }

  onPageHide(): void {
    if (this.pollTimer >= 0) { clearInterval(this.pollTimer); this.pollTimer = -1; }
  }

  private refreshNodeInfo(): void {
    const node = readNodeProfile(this.context().filesDir);
    this.hasNode = node !== undefined;
    this.nodeStatus = node ? `已保存 ${node.protocol} 节点` : '尚未导入节点';
  }

  aboutToDisappear(): void {
    if (this.pollTimer >= 0) {
      clearInterval(this.pollTimer);
      this.pollTimer = -1;
    }
    unsubscribeVpnAuthorization(this.authorizationSubscription);
    this.authorizationSubscription = -1;
  }

  private checkNative(): void {
    try {
      this.nativeResult = nativeBridge.selfCheck();
      this.nativeReady = this.nativeResult.startsWith('NATIVE_OK');
      hilog.info(0x0000, 'HarmonyVpnLab', '%{public}s', this.nativeResult);
    } catch (err) {
      this.nativeReady = false;
      this.nativeResult = '原生检查失败：' + JSON.stringify(err);
      hilog.error(0x0000, 'HarmonyVpnLab', '%{public}s', this.nativeResult);
    }
  }

  private refreshState(): void {
    let state = readProbeState(this.context().filesDir);
    if (isConnectionKind(state.kind)) {
      const assessment = readConnectionLifecycle(this.context().filesDir);
      this.phase = assessment.phase; this.detail = assessment.detail;
      this.runId = assessment.state.runId; this.testKind = assessment.state.kind;
      return;
    }
    const running = ['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'stop_requested'].includes(state.phase);
    if (running && Date.now() - state.updatedAt > (state.kind === 'node' ? 30000 : 20000)) {
      state = new ProbeState('failed',
        '未在时限内收到后续结果，当前资源状态未知。请点击停止测试，再重试。', state.runId, state.kind);
      writeProbeState(this.context().filesDir, state);
    }
    if (state.phase !== 'idle') {
      this.phase = state.phase;
      this.detail = state.detail;
      this.runId = state.runId;
      this.testKind = state.kind;
      if (state.phase === 'active' && state.kind !== 'lifecycle' && !isConnectionKind(state.kind) && this.lastTransferRun !== state.runId) {
        this.lastTransferRun = state.runId;
        this.executeTransfer(state.runId, state.kind);
      }
    }
  }

  private async executeTransfer(runId: string, kind: string): Promise<void> {
    const request = http.createHttp();
    try {
      // This runs in the UI process, outside the protected VPN extension process.
      // There is no TCP listener at this address: it must traverse the TUN.
      const target = kind === 'node' ? `https://1.1.1.1/cdn-cgi/trace?probe=${runId}`
        : `http://198.18.0.1:18080/probe/${runId}`;
      const response = await request.request(target, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: kind === 'node' ? 10000 : 4000,
        readTimeout: kind === 'node' ? 10000 : 5000,
        usingCache: false
      });
      if (response.responseCode !== 200 || typeof response.result !== 'string') {
        throw new Error('测试 HTTP 状态或响应类型不正确');
      }
      if (kind !== 'node') {
        const body = JSON.parse(response.result) as FixtureReply;
        if (body.token !== runId || body.via !== 'local-socks-fixture') {
          throw new Error('本次 HTTP 校验标记不匹配');
        }
      } else if (!response.result.includes('h=1.1.1.1') || !response.result.includes('ip=')) {
        throw new Error('HTTPS 测试站点返回了意外内容');
      }
      writeTransferResult(this.context().filesDir,
        new TransferResult(runId, 'passed', kind === 'node' ? 'IPv4 HTTPS 成功' : '新校验标记匹配', response.result.length));
      hilog.info(0x0000, 'HarmonyVpnLab', kind === 'node'
        ? 'NODE_HTTPS_OK runId=%{public}s bytes=%{public}d' : 'TRANSFER_HTTP_OK runId=%{public}s bytes=%{public}d',
        runId, response.result.length);
    } catch (error) {
      writeTransferResult(this.context().filesDir,
        new TransferResult(runId, 'failed', describeError(error)));
      hilog.error(0x0000, 'HarmonyVpnLab', 'TRANSFER_HTTP_FAILED runId=%{public}s %{public}s',
        runId, describeError(error));
    } finally {
      request.destroy();
    }
  }

  private async startProbe(): Promise<void> {
    const assessment = readConnectionLifecycle(this.context().filesDir);
    const status = assessment.status;
    if (!assessment.managementAllowed || (status && status.servicePid !== undefined && status.servicePid !== 0 &&
      assessment.servicePresence !== 'absent')) {
      this.refreshState(); this.detail = '请先在首页结束连接并等待服务退出，再启动验证。'; return;
    }
    const startedRunId = Date.now().toString();
    const startedKind = this.selectedKind;
    this.runId = startedRunId;
    this.testKind = startedKind;
    this.phase = 'starting';
    this.detail = '已请求启动。首次运行请在系统弹窗中允许 VPN。';
    try {
      writeTransferResult(this.context().filesDir, new TransferResult(startedRunId));
      writeProbeState(this.context().filesDir, new ProbeState(this.phase, this.detail, this.runId, startedKind));
      await vpnExtension.startVpnExtensionAbility({
        bundleName: 'com.example.harmonyvpnlab',
        abilityName: 'VpnProbeAbility',
        parameters: { runId: startedRunId, kind: startedKind }
      });
      hilog.info(0x0000, 'HarmonyVpnLab', 'VPN_START_REQUESTED runId=%{public}s', startedRunId);
    } catch (err) {
      const current = readProbeState(this.context().filesDir);
      if (current.runId === startedRunId && current.phase === 'starting') {
        writeProbeState(this.context().filesDir,
          new ProbeState('failed', '启动扩展失败：' + JSON.stringify(err), startedRunId, startedKind));
      }
      this.refreshState();
    }
  }

  private async stopProbe(): Promise<void> {
    const stoppedRunId = this.runId;
    try {
      const beforeStop = readProbeState(this.context().filesDir);
      if (beforeStop.runId !== stoppedRunId) {
        this.refreshState();
        return;
      }
      if (['starting', 'active', 'recovering', 'waiting-network'].includes(beforeStop.phase)) {
        if (isConnectionKind(beforeStop.kind)) {
          writeConnectionCommand(this.context().filesDir, new ConnectionCommand(stoppedRunId, 'stop'));
        }
        writeProbeState(this.context().filesDir, new ProbeState('stop_requested',
          '正在通知扩展先清理资源，再结束测试。', stoppedRunId, beforeStop.kind));
        this.refreshState();
        return;
      }
      if (beforeStop.phase !== 'failed') {
        return;
      }
      // A failed/unknown run can still request a system stop. This is recovery,
      // not proof that the extension completed its asynchronous cleanup.
      await vpnExtension.stopVpnExtensionAbility({
        bundleName: 'com.example.harmonyvpnlab', abilityName: 'VpnProbeAbility'
      });
      this.refreshState();
    } catch (err) {
      this.detail = '停止请求失败：' + JSON.stringify(err);
      hilog.error(0x0000, 'HarmonyVpnLab', '%{public}s', this.detail);
    }
  }

  private busy(): boolean {
    return ['starting', 'active', 'recovering', 'waiting-network', 'stopping', 'stop_requested', 'unknown', 'diagnostic'].includes(this.phase);
  }

  private phaseLabel(): string {
    switch (this.phase) {
      case 'starting': return '正在启动';
      case 'active': return this.testKind === 'lifecycle' ? '虚拟网卡已创建' : '正在验证真实流量';
      case 'stopping': return '正在释放';
      case 'stop_requested': return '正在请求停止';
      case 'passed': return this.testKind === 'reject' ? '拒绝保护检查通过'
        : this.testKind === 'lifecycle' ? '网卡创建与释放检查通过' : '真实流量与清理检查通过';
      case 'failed': return '本次检查失败';
      case 'stopped': return '已停止';
      case 'interrupted': return '连接已结束';
      case 'unknown': return '连接状态待确认';
      case 'diagnostic': return '其他验证正在运行';
      default: return '等待测试';
    }
  }

  build() {
    Scroll() {
      Column({ space: 20 }) {
        Column({ space: 8 }) {
          Text('Harmony VPN Lab').fontSize(14).fontColor('#52627A');
          Text('鸿蒙 VPN 验证').fontSize(30).fontWeight(FontWeight.Bold).fontColor('#172B4D');
          Text('阶段 2 · 原生核心与数据转发').fontSize(15).fontColor('#52627A');
        }.alignItems(HorizontalAlign.Start).width('100%');

        Column({ space: 10 }) {
          Text('设备与原生调用').fontSize(19).fontWeight(FontWeight.Medium);
          Text(deviceInfo.marketName + '\n' + deviceInfo.osFullName).fontSize(13).fontColor('#52627A');
          Text(this.nativeReady ? 'ArkTS → C++ 调用通过' : '原生调用待确认')
            .fontSize(16).fontColor(this.nativeReady ? '#127345' : '#B54708');
          Text(this.nativeResult).fontSize(12).fontColor('#52627A').wordBreak(WordBreak.BREAK_ALL);
        }.alignItems(HorizontalAlign.Start).width('100%').padding(20).backgroundColor(Color.White).borderRadius(20);

        Column({ space: 14 }) {
          Row({ space: 8 }) {
            Button('生命周期').id('modeLifecycle').fontSize(12).width('31%').height(36)
              .backgroundColor(this.selectedKind === 'lifecycle' ? '#155EEF' : '#E8EEF7')
              .fontColor(this.selectedKind === 'lifecycle' ? Color.White : '#172B4D')
              .enabled(!this.busy()).onClick(() => { this.selectedKind = 'lifecycle'; });
            Button('Hev 转发').id('modeHev').fontSize(12).width('31%').height(36)
              .backgroundColor(this.selectedKind === 'hev' ? '#155EEF' : '#E8EEF7')
              .fontColor(this.selectedKind === 'hev' ? Color.White : '#172B4D')
              .enabled(!this.busy()).onClick(() => { this.selectedKind = 'hev'; });
            Button('Xray + Hev').id('modeXray').fontSize(12).width('31%').height(36)
              .backgroundColor(this.selectedKind === 'xray' ? '#155EEF' : '#E8EEF7')
              .fontColor(this.selectedKind === 'xray' ? Color.White : '#172B4D')
              .enabled(!this.busy()).onClick(() => { this.selectedKind = 'xray'; });
          }.width('100%');
          Text(this.phaseLabel()).fontSize(20).fontWeight(FontWeight.Medium);
          Text(this.detail).fontSize(15).fontColor('#52627A').lineHeight(23);
          Button(this.selectedKind === 'lifecycle' ? '开始 5 秒 VPN 测试'
            : (this.selectedKind === 'node' ? '开始节点联网测试' : '开始真实流量验证')).id('startVpnProbe')
            .width('100%').height(48).backgroundColor('#155EEF')
            .enabled(this.nativeReady && !this.busy())
            .onClick(() => { this.startProbe(); });
          Button('停止测试').id('stopVpnProbe')
            .width('100%').height(44).backgroundColor('#E8EEF7').fontColor('#172B4D')
            .onClick(() => { this.stopProbe(); });
          Button('检查保护失败的处理').id('startRejectProbe').fontSize(12)
            .width('100%').height(36).backgroundColor('#E8EEF7').fontColor('#172B4D')
            .enabled(!this.busy()).onClick(() => { this.selectedKind = 'reject'; this.startProbe(); });
        }.alignItems(HorizontalAlign.Start).width('100%').padding(20).backgroundColor(Color.White).borderRadius(20);

        Column({ space: 12 }) {
          Text(this.nodeStatus).fontSize(16).fontWeight(FontWeight.Medium);
          Row({ space: 10 }) {
            Button('导入节点').id('openNodeConfig').width('44%').height(42).enabled(!this.busy())
              .onClick(() => { this.getUIContext().getRouter().pushUrl({ url: 'pages/NodeConfig' }); });
            Button('节点联网测试').id('startNodeProbe').width('52%').height(42)
              .enabled(!this.busy() && this.hasNode).onClick(() => {
                this.selectedKind = 'node';
                this.startProbe();
              });
          }.width('100%');
          Text('仅测试本应用的 IPv4 HTTPS，最长约 30 秒；完成后自动停止。')
            .fontSize(12).fontColor('#52627A');
        }.width('100%').padding(16).backgroundColor(Color.White).borderRadius(16);

        Text('上方三个模式使用本机受限地址段。节点联网测试需要先导入配置，目前不接管其他应用，也不代表 DNS、IPv6 和长期运行已验证。')
          .fontSize(13).fontColor('#52627A').lineHeight(21);
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 24, right: 24, top: 24, bottom: 24 });
    }.width('100%').height('100%').align(Alignment.Top).backgroundColor('#F5F7FA');
  }
}
