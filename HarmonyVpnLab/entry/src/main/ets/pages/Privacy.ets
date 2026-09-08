@Entry
@Component
struct Privacy {
  build() {
    Scroll() {
      Column({ space: 20 }) {
        Row({ space: 12 }) {
          Button('‹ 返回').id('backFromPrivacy').fontSize(15).fontColor($r('app.color.accent'))
            .backgroundColor($r('app.color.accent_soft')).onClick(() => { this.getUIContext().getRouter().back(); });
          Text('隐私说明').fontSize(26).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'));
        }.width('100%');
        Text('你的节点配置保存在设备上。这里说明应用如何访问网络，以及哪些诊断信息会被记录。')
          .id('privacyScope').fontSize(14).lineHeight('23fp').fontColor($r('app.color.text_secondary'));

        this.explanation('保存在设备上的内容',
          '节点配置、订阅地址、节点检测结果、连接诊断记录和外观偏好保存在应用私有目录。节点配置可能包含连接凭据，订阅地址可能包含访问令牌。目前没有为这些配置增加应用层加密。');

        this.explanation('节点与订阅请求',
          '连接 VPN 时，应用会访问你选择的节点服务器，并通过节点转发接管的网络流量。点击获取订阅或检查更新时，应用访问你提供的 HTTPS 订阅地址。节点服务和订阅服务会接收到对应的连接或请求。');

        this.explanation('DNS 如何工作',
          '连接时，接管的域名解析经节点发送到 Cloudflare 的 DNS over HTTPS 服务（1.1.1.1）。节点服务器本身使用域名时，连接前需先通过当前物理网络解析到 IPv4 地址。当前模式不会代理 IPv6 流量。');

        this.explanation('主动连接检查',
          '点击“检查连接”或检测节点 HTTPS 耗时时，应用访问 Cloudflare 的 www.cloudflare.com/cdn-cgi/trace，用于确认连接可用并测量一次完整 HTTPS 请求耗时。请求会向该服务呈现网络出口地址。节点检测不保存响应正文或出口 IP；连接检查仅在界面显示当前会话的出口校验标记。浏览器检查会打开同一服务的页面。');

        this.explanation('诊断与日志',
          '诊断页保存有限数量的连接、恢复、停止和检测事件，包括时间、会话标识、网络类别与计数。节点检测记录还包含节点标识、配置指纹、检测时间、结果和耗时。应用和转发核心也会生成运行日志，用于排查连接问题。');

        this.explanation('你可以管理的内容',
          '断开连接并完成清理后，可在节点页改名或删除节点；在订阅页可更新或删除订阅。删除订阅会同时删除属于它的节点，手动导入的节点保留。更新失败或尚未确认预览时，原节点保持不变。删除节点或订阅不等同于清空历史检测与诊断记录。');
      }.width('100%').padding(24).alignItems(HorizontalAlign.Start);
    }.id('privacyPage').width('100%').height('100%').backgroundColor($r('app.color.page_bg'));
  }

  @Builder
  private explanation(title: string, body: string) {
    Column({ space: 10 }) {
      Text(title).fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'));
      Text(body).fontSize(14).lineHeight('24fp').fontColor($r('app.color.text_secondary'));
    }.padding(20).width('100%').alignItems(HorizontalAlign.Start)
      .backgroundColor($r('app.color.surface')).borderRadius(20);
  }
}
