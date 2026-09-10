import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { NetworkPolicy, parseRoutingEntries } from '../model/NetworkPolicy';
import { readNetworkPolicy, saveNetworkPolicy } from '../model/NetworkPolicyStore';
import { isNodeManagementAllowed } from '../model/NodeEditGuard';
import { formContentWidth } from '../model/AdaptiveLayout';

@Entry
@Component
struct NetworkSettings {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State mode: string = 'global';
  @State bypassLan: boolean = false;
  @State direct: string = '';
  @State proxy: string = '';
  @State block: string = '';
  @State dnsUrl: string = 'https://1.1.1.1/dns-query';
  @State message: string = '';
  @State editable: boolean = false;
  @State dirty: boolean = false;
  @State confirmingLeave: boolean = false;
  @State leaving: boolean = false;
  @State needsRepair: boolean = false;
  private baseline: string = '';
  private pageEpoch: number = 0;
  private leaveRequest: number = 0;

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void {
    this.pageEpoch++; this.confirmingLeave = false; this.leaving = false;
    this.baseline = this.snapshot(); this.dirty = false; this.needsRepair = false;
    this.refreshEditable();
    try { this.load(readNetworkPolicy(this.context().filesDir)); }
    catch (_) { this.needsRepair = true; this.message = '原网络设置无法读取。请检查并保存下面的设置，保存成功后才会替换原文件。'; }
  }
  onPageShow(): void { this.refreshEditable(); }
  onPageHide(): void { this.pageEpoch++; this.leaveRequest++; this.confirmingLeave = false; }
  aboutToDisappear(): void { this.pageEpoch++; this.leaveRequest++; this.confirmingLeave = false; }
  private refreshEditable(): void {
    try { this.editable = isNodeManagementAllowed(this.context().filesDir); }
    catch (_) { this.editable = false; }
  }
  private snapshot(): string {
    return JSON.stringify([this.mode, String(this.bypassLan), this.direct, this.proxy, this.block, this.dnsUrl]);
  }
  private draftChanged(): void { this.dirty = this.snapshot() !== this.baseline; this.message = ''; }
  onBackPress(): boolean {
    if (this.confirmingLeave || this.leaving) { return true; }
    if (this.snapshot() === this.baseline) { return false; }
    void this.requestBack(); return true;
  }
  private async requestBack(): Promise<void> {
    if (this.confirmingLeave || this.leaving) { return; }
    if (this.snapshot() === this.baseline) {
      this.leaving = true;
      try { this.getUIContext().getRouter().back(); }
      catch (_) { this.leaving = false; this.message = '暂时无法返回，请重试。'; }
      return;
    }
    const epoch = this.pageEpoch; const request = ++this.leaveRequest;
    this.confirmingLeave = true;
    try {
      const result = await this.getUIContext().getPromptAction().showDialog({
        title: '放弃未保存的设置？', message: '返回后，这次未保存的分流与 DNS 修改将丢失。',
        buttons: [{ text: '继续编辑', color: $r('app.color.accent') }, { text: '放弃修改', color: $r('app.color.danger') }]
      });
      if (epoch !== this.pageEpoch || request !== this.leaveRequest) { return; }
      if (result.index === 1) { this.leaving = true; this.getUIContext().getRouter().back(); }
    } catch (_) {
      if (epoch === this.pageEpoch && request === this.leaveRequest) {
        this.leaving = false; this.message = '返回确认未完成，输入已保留，请继续编辑或重试。';
      }
    } finally { if (epoch === this.pageEpoch && request === this.leaveRequest) { this.confirmingLeave = false; } }
  }
  private load(policy: NetworkPolicy): void {
    this.mode = policy.mode; this.bypassLan = policy.bypassLan;
    this.direct = policy.direct.join('\n'); this.proxy = policy.proxy.join('\n'); this.block = policy.block.join('\n');
    this.dnsUrl = policy.dnsUrl;
    this.baseline = this.snapshot(); this.dirty = false; this.needsRepair = false;
  }
  private save(): void {
    if (this.confirmingLeave || this.leaving) { return; }
    this.dirty = this.snapshot() !== this.baseline;
    if (!this.dirty && !this.needsRepair) { return; }
    this.refreshEditable();
    if (!this.editable) { this.message = '请先断开连接并等待清理完成，再保存网络设置。'; return; }
    let committed: boolean = false;
    try {
      const policy = new NetworkPolicy();
      policy.mode = this.mode; policy.bypassLan = this.bypassLan;
      policy.direct = parseRoutingEntries(this.direct); policy.proxy = parseRoutingEntries(this.proxy);
      policy.block = parseRoutingEntries(this.block); policy.dnsUrl = this.dnsUrl.trim();
      saveNetworkPolicy(this.context().filesDir, policy);
      committed = true;
      // A successful atomic commit is distinct from a failed subsequent read.
      this.baseline = this.snapshot(); this.dirty = false; this.needsRepair = false;
      this.load(readNetworkPolicy(this.context().filesDir));
      this.message = '网络设置已保存，下次连接时生效。';
    } catch (error) {
      const safeErrors: string[] = [
        '分流条目格式无效。', '请使用标准 IPv4 地址或 CIDR 网段。',
        '分流域名无效；支持普通域名、domain:域名、full:域名和 IPv4 网段。',
        '分流列表过长。', '每类分流最多 300 条。', '分流列表格式无效。',
        'DNS 地址需为有效的 HTTPS URL。', 'DNS 地址需包含 HTTPS 域名或 IPv4 地址及路径，不支持账号、片段或 IPv6 地址。',
        'DNS 服务器地址格式无效。', '网络设置超过 32 KiB，未保存。', '网络设置未保存，原设置已保留。'
      ];
      this.message = committed ? '保存已提交，但设置读回未确认，请返回后重新打开核对。' :
        (error instanceof Error && safeErrors.includes(error.message) ? error.message : '网络设置未保存，输入已保留；请检查输入并先断开连接。');
    }
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回').id('backFromNetworkSettings').fontColor($r('app.color.accent'))
          .backgroundColor($r('app.color.accent_soft')).enabled(!this.confirmingLeave && !this.leaving)
          .onClick(() => { void this.requestBack(); });
        Text('分流与 DNS').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1);
      }.width(formContentWidth(this.windowWidthVp)).padding(20);
      Scroll() {
        Column({ space: 18 }) {
          if (!this.editable) { Text('请先断开连接并等待清理完成，再修改设置。').fontColor($r('app.color.warning')); }
          Column({ space: 12 }) {
            Text('连接模式').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Flex({ wrap: FlexWrap.Wrap }) {
              Button(this.mode === 'global' ? '✓ 全部代理' : '全部代理').id('routingGlobal')
                .constraintSize({ minHeight: 44, maxWidth: '100%' }).margin({ right: 8, bottom: 8 })
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.mode = 'global'; this.draftChanged(); });
              Button(this.mode === 'rules' ? '✓ 规则分流' : '规则分流').id('routingRules')
                .constraintSize({ minHeight: 44, maxWidth: '100%' }).margin({ right: 8, bottom: 8 })
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.mode = 'rules'; this.draftChanged(); });
            }.width('100%');
            Text('未匹配的 IPv4 流量使用当前节点；IPv6 继续阻断。全部代理模式保留但不启用下面的分流规则。')
              .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            if (this.mode === 'rules') {
              Row({ space: 12 }) {
                Text('绕过局域网').layoutWeight(1).fontColor($r('app.color.text_primary'));
                Toggle({ type: ToggleType.Switch, isOn: this.bypassLan }).id('bypassLan')
                  .enabled(this.editable && !this.confirmingLeave && !this.leaving).onChange((value: boolean) => { this.bypassLan = value; this.draftChanged(); });
              }.width('100%');
              Text('每行一个域名、IPv4 地址或网段，例如 example.com、full:api.example.com、192.168.1.0/24。普通域名包含子域名。优先级：阻断 → 指定代理 → 指定直连 → 局域网。')
                .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
              Text('直连').fontColor($r('app.color.text_primary'));
              TextArea({ text: this.direct, placeholder: '需要直接访问的域名或 IPv4 网段' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('routingDirect').height(120)
                .maxLength(16384).enabled(this.editable && !this.confirmingLeave && !this.leaving).fontColor($r('app.color.text_primary'))
                .backgroundColor($r('app.color.surface_secondary')).onChange((text: string) => { this.direct = text; this.draftChanged(); });
              Text('指定代理').fontColor($r('app.color.text_primary'));
              TextArea({ text: this.proxy, placeholder: '优先通过当前节点访问' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('routingProxy').height(120)
                .maxLength(16384).enabled(this.editable && !this.confirmingLeave && !this.leaving).fontColor($r('app.color.text_primary'))
                .backgroundColor($r('app.color.surface_secondary')).onChange((text: string) => { this.proxy = text; this.draftChanged(); });
              Text('阻断').fontColor($r('app.color.text_primary'));
              TextArea({ text: this.block, placeholder: '不允许访问的域名或 IPv4 网段' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('routingBlock').height(120)
                .maxLength(16384).enabled(this.editable && !this.confirmingLeave && !this.leaving).fontColor($r('app.color.text_primary'))
                .backgroundColor($r('app.color.surface_secondary')).onChange((text: string) => { this.block = text; this.draftChanged(); });
              Text('域名规则依据可识别的 HTTP/TLS 域名匹配；无法识别域名的连接按 IP 规则处理。DNS 仍经节点发送，直连流量使用当前物理网络出口。')
                .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            }
          }.padding(18).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);
          Column({ space: 12 }) {
            Text('DNS over HTTPS').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            TextInput({ text: this.dnsUrl, placeholder: 'https://1.1.1.1/dns-query' }).enableKeyboardOnFocus(deviceInfo.deviceType !== '2in1').id('dnsUrl').maxLength(2048)
              .enabled(this.editable && !this.confirmingLeave && !this.leaving).fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.surface_secondary'))
              .onChange((text: string) => { this.dnsUrl = text; this.draftChanged(); });
            Text('DNS 请求始终经节点发送。支持域名或 IPv4 的 HTTPS URL；URL 中的域名交给远端节点解析。节点检测使用独立的默认 DNS 和全部代理配置。')
              .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            Button('填入默认 DNS').id('resetDns').fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .enabled(this.editable && !this.confirmingLeave && !this.leaving).onClick(() => { this.dnsUrl = 'https://1.1.1.1/dns-query'; this.draftChanged(); });
          }.padding(18).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);
        }.padding({ left: 20, right: 20, bottom: 28 }).width(formContentWidth(this.windowWidthVp)).alignItems(HorizontalAlign.Start);
      }.layoutWeight(1).width('100%').align(Alignment.Top);
      Column({ space: 10 }) {
        if (this.message) { Text(this.message).id('networkSettingsResult').fontSize(14).fontColor($r('app.color.text_secondary')).width('100%'); }
        Text(this.dirty ? '有未保存的修改' : '保存后，下次连接时生效').id('networkSettingsDirtyState')
          .fontSize(13).fontColor(this.dirty ? $r('app.color.warning') : $r('app.color.text_secondary'));
        Button('保存网络设置').id('saveNetworkSettings').width('100%').constraintSize({ minHeight: 48 })
          .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
          .enabled(this.editable && (this.dirty || this.needsRepair) && !this.confirmingLeave && !this.leaving)
          .onClick(() => { this.save(); });
      }.width(formContentWidth(this.windowWidthVp)).padding({ left: 20, right: 20, top: 12, bottom: 16 })
        .alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface'));
    }.width('100%').height('100%').alignItems(HorizontalAlign.Center).backgroundColor($r('app.color.page_bg'));
  }
}
