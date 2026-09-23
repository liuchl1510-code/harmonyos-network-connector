import { bundleManager } from '@kit.AbilityKit';
import { formContentWidth } from '../model/AdaptiveLayout';
import { VPN_CORE_AVAILABLE } from '../model/BuildCapabilities';

@Entry
@Component
struct About {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;
  @State versionText: string = '版本信息暂不可用';

  aboutToAppear(): void {
    const previewLabel = VPN_CORE_AVAILABLE ? '' : ' · 界面预览';
    this.versionText = '版本信息暂不可用' + previewLabel;
    try {
      const info = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      const name = info.versionName;
      const previewSuffix = '-ui-preview';
      const displayName = !VPN_CORE_AVAILABLE && name.endsWith(previewSuffix)
        ? name.substring(0, name.length - previewSuffix.length) : name;
      if (displayName.length > 0) { this.versionText = '版本 ' + displayName + previewLabel; }
    } catch (_) { /* Keep the unavailable label without exposing platform errors. */ }
  }

  build() {
    Scroll() {
      Column({ space: 24 }) {
        Row({ space: 12 }) {
          Button('‹ 返回').id('backFromAbout').fontSize(15).fontColor($r('app.color.accent'))
            .backgroundColor($r('app.color.accent_soft')).onClick(() => { this.getUIContext().getRouter().back(); });
          Text('关于').fontSize(26).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
        }.width('100%');

        Column({ space: 10 }) {
          Text('H').fontSize(36).fontWeight(FontWeight.Bold).fontColor($r('app.color.accent'))
            .width(72).height(72).textAlign(TextAlign.Center)
            .backgroundColor($r('app.color.accent_soft')).borderRadius(22);
          Text('Harmony VPN').fontSize(26).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
          Text(this.versionText).id('appVersion').fontSize(14).fontColor($r('app.color.text_secondary'))
            .width('100%').textAlign(TextAlign.Center).wordBreak(WordBreak.BREAK_ALL);
          Text('管理节点，连接你的网络。').fontSize(14).fontColor($r('app.color.text_secondary'));
        }.padding(28).width('100%').backgroundColor($r('app.color.surface')).borderRadius(22);

        Column({ space: 18 }) {
          Text('开源组件').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
          if (!VPN_CORE_AVAILABLE) {
            Text('以下为正式版使用的组件；当前界面预览包未包含 Xray 和 Hev。').fontSize(14)
              .fontColor($r('app.color.warning')).lineHeight('22fp');
          }
          this.dependency('Xray-core', '26.6.1', '代理连接核心 · Mozilla Public License 2.0');
          Divider().color($r('app.color.border'));
          this.dependency('Hev SOCKS5 Tunnel', '2.9.0', '虚拟网卡流量转发 · MIT License');
          Divider().color($r('app.color.border'));
          this.dependency('v2rayN 白名单', '7.24.9', '内置分流规则 · GPL-3.0');
          Divider().color($r('app.color.border'));
          this.dependency('Loyalsoldier 规则数据', '202609222357',
            '保留白名单所需完整分类；规则仓库 GPL-3.0，GeoIP 数据 CC-BY-SA-4.0，其他数据来源保留原许可。');
          Divider().color($r('app.color.border'));
          Text('其他依赖').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
          Text('libXray、Hev task system、Hev SOCKS5 core 与 libyaml 使用 MIT 许可证；Go 使用 BSD 许可证。lwIP 保留各源文件声明。核心还包含 GPL-3.0-or-later 的 sing、sing-shadowsocks，以及带特定链接例外的 LGPLv3 ratelimit。其他依赖遵循各自许可证。')
            .fontSize(14).lineHeight('23fp').fontColor($r('app.color.text_secondary'));
          Text('以上为主要组件与许可证摘要。').fontSize(12).fontColor($r('app.color.text_secondary'));
          Text('本项目自有代码采用 GPL-3.0-or-later。完整许可、第三方声明与对应源码获取方法见公开源码仓库。')
            .fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
        }.padding(20).width('100%').alignItems(HorizontalAlign.Start)
          .backgroundColor($r('app.color.surface')).borderRadius(20);

        Column({ space: 10 }) {
          Text('当前连接能力').fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
          Text('使用你导入的节点提供 IPv4 代理连接。连接期间，应用接管的 DNS 通过节点转发；IPv6 流量目前捕获后阻断。')
            .fontSize(14).lineHeight('23fp').fontColor($r('app.color.text_secondary'));
          Text('后台和锁屏期间可保持连接；强行结束应用可能使系统停止 VPN。')
            .fontSize(14).lineHeight('23fp').fontColor($r('app.color.text_secondary'));
        }.padding(20).width('100%').alignItems(HorizontalAlign.Start)
          .backgroundColor($r('app.color.surface')).borderRadius(20);
      }.width(formContentWidth(this.windowWidthVp)).padding(24).alignItems(HorizontalAlign.Start);
    }.id('aboutPage').width('100%').height('100%').align(Alignment.Top).background($r('app.color.page_bg'));
  }

  @Builder
  private dependency(name: string, version: string, description: string) {
    Column({ space: 7 }) {
      Row({ space: 12 }) {
        Text(name).fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).layoutWeight(1);
        Text(version).fontSize(13).fontColor($r('app.color.accent'));
      }.width('100%');
      Text(description).fontSize(13).lineHeight('21fp').fontColor($r('app.color.text_secondary'));
    }.width('100%').alignItems(HorizontalAlign.Start);
  }
}
