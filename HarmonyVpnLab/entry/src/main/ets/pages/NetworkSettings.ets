import { common } from '@kit.AbilityKit';
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

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  aboutToAppear(): void {
    this.editable = isNodeManagementAllowed(this.context().filesDir);
    try { this.load(readNetworkPolicy(this.context().filesDir)); }
    catch (_) { this.message = '原网络设置无法读取。请检查并保存下面的设置，保存成功后才会替换原文件。'; }
  }
  private load(policy: NetworkPolicy): void {
    this.mode = policy.mode; this.bypassLan = policy.bypassLan;
    this.direct = policy.direct.join('\n'); this.proxy = policy.proxy.join('\n'); this.block = policy.block.join('\n');
    this.dnsUrl = policy.dnsUrl;
  }
  private save(): void {
    try {
      const policy = new NetworkPolicy();
      policy.mode = this.mode; policy.bypassLan = this.bypassLan;
      policy.direct = parseRoutingEntries(this.direct); policy.proxy = parseRoutingEntries(this.proxy);
      policy.block = parseRoutingEntries(this.block); policy.dnsUrl = this.dnsUrl.trim();
      saveNetworkPolicy(this.context().filesDir, policy);
      this.load(readNetworkPolicy(this.context().filesDir));
      this.message = '网络设置已保存，下次连接时生效。';
    } catch (error) { this.message = (error as Error).message || '网络设置未保存，请检查输入并先断开连接。'; }
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Button('返回').id('backFromNetworkSettings').fontColor($r('app.color.accent'))
          .backgroundColor($r('app.color.accent_soft')).onClick(() => { this.getUIContext().getRouter().back(); });
        Text('分流与 DNS').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1);
      }.width(formContentWidth(this.windowWidthVp)).padding(20);
      Scroll() {
        Column({ space: 18 }) {
          if (!this.editable) { Text('请先断开连接并等待清理完成，再修改设置。').fontColor($r('app.color.warning')); }
          Column({ space: 12 }) {
            Text('连接模式').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            Row({ space: 12 }) {
              Button(this.mode === 'global' ? '✓ 全部代理' : '全部代理').id('routingGlobal')
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable).onClick(() => { this.mode = 'global'; });
              Button(this.mode === 'rules' ? '✓ 规则分流' : '规则分流').id('routingRules')
                .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
                .enabled(this.editable).onClick(() => { this.mode = 'rules'; });
            }.width('100%');
            Text('未匹配的 IPv4 流量使用当前节点；IPv6 继续阻断。全部代理模式保留但不启用下面的分流规则。')
              .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            if (this.mode === 'rules') {
              Row({ space: 12 }) {
                Text('绕过局域网').layoutWeight(1).fontColor($r('app.color.text_primary'));
                Toggle({ type: ToggleType.Switch, isOn: this.bypassLan }).id('bypassLan')
                  .enabled(this.editable).onChange((value: boolean) => { this.bypassLan = value; });
              }.width('100%');
              Text('每行一个域名、IPv4 地址或网段，例如 example.com、full:api.example.com、192.168.1.0/24。普通域名包含子域名。优先级：阻断 → 指定代理 → 指定直连 → 局域网。')
                .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
              Text('直连').fontColor($r('app.color.text_primary'));
              TextArea({ text: this.direct, placeholder: '需要直接访问的域名或 IPv4 网段' }).id('routingDirect').height(120)
                .maxLength(16384).enabled(this.editable).fontColor($r('app.color.text_primary'))
                .backgroundColor($r('app.color.surface_secondary')).onChange((text: string) => { this.direct = text; });
              Text('指定代理').fontColor($r('app.color.text_primary'));
              TextArea({ text: this.proxy, placeholder: '优先通过当前节点访问' }).id('routingProxy').height(120)
                .maxLength(16384).enabled(this.editable).fontColor($r('app.color.text_primary'))
                .backgroundColor($r('app.color.surface_secondary')).onChange((text: string) => { this.proxy = text; });
              Text('阻断').fontColor($r('app.color.text_primary'));
              TextArea({ text: this.block, placeholder: '不允许访问的域名或 IPv4 网段' }).id('routingBlock').height(120)
                .maxLength(16384).enabled(this.editable).fontColor($r('app.color.text_primary'))
                .backgroundColor($r('app.color.surface_secondary')).onChange((text: string) => { this.block = text; });
              Text('域名规则依据可识别的 HTTP/TLS 域名匹配；无法识别域名的连接按 IP 规则处理。DNS 仍经节点发送，直连流量使用当前物理网络出口。')
                .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            }
          }.padding(18).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);
          Column({ space: 12 }) {
            Text('DNS over HTTPS').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
            TextInput({ text: this.dnsUrl, placeholder: 'https://1.1.1.1/dns-query' }).id('dnsUrl').maxLength(2048)
              .enabled(this.editable).fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.surface_secondary'))
              .onChange((text: string) => { this.dnsUrl = text; });
            Text('DNS 请求始终经节点发送。支持域名或 IPv4 的 HTTPS URL；URL 中的域名交给远端节点解析。节点检测使用独立的默认 DNS 和全部代理配置。')
              .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
            Button('填入默认 DNS').id('resetDns').fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft'))
              .enabled(this.editable).onClick(() => { this.dnsUrl = 'https://1.1.1.1/dns-query'; });
          }.padding(18).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.surface')).borderRadius(18);
          if (this.message) { Text(this.message).id('networkSettingsResult').fontSize(14).fontColor($r('app.color.text_secondary')); }
          Button('保存网络设置').id('saveNetworkSettings').width('100%').constraintSize({ minHeight: 48 })
            .fontColor($r('app.color.accent')).backgroundColor($r('app.color.accent_soft')).enabled(this.editable)
            .onClick(() => { this.save(); });
        }.padding({ left: 20, right: 20, bottom: 28 }).width(formContentWidth(this.windowWidthVp)).alignItems(HorizontalAlign.Start);
      }.layoutWeight(1).width('100%').align(Alignment.Top);
    }.width('100%').height('100%').alignItems(HorizontalAlign.Center).backgroundColor($r('app.color.page_bg'));
  }
}
