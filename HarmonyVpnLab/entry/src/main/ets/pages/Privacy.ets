import { formContentWidth } from '../model/AdaptiveLayout';

@Entry
@Component
struct Privacy {
  @StorageProp('windowWidthVp') windowWidthVp: number = 360;

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
          '节点配置、订阅地址、网络设置、节点检测结果、连接诊断记录和外观偏好保存在应用私有目录。节点配置可能包含连接凭据，订阅地址可能包含访问令牌。目前没有为这些配置增加应用层加密。导出的节点和备份文件也包含这些凭据，请妥善保管。');

        this.explanation('节点与订阅请求',
          '连接 VPN 时，应用会访问你选择的节点服务器。全部代理模式通过节点转发接管的 IPv4 流量；白名单按内置的 v2rayN 规则及分类数据选择直连、代理或阻断，自定义规则模式使用你保存的列表。直连流量使用当前物理网络出口。内置白名单随应用提供，不会在连接时联网下载或自动更新。点击获取订阅或检查更新时，应用访问你提供的 HTTPS 订阅地址。');

        this.explanation('按应用设置代理范围',
          '应用范围可以设为全部应用、绕过所选应用或仅代理所选应用。常见应用列表是包名预设，不读取或自动确认安装状态；请按本机实际安装情况勾选，或填写其他鸿蒙应用的包名。所选包名与网络设置保存在应用私有目录，不上传。Harmony VPN 始终纳入 VPN 以进行连接检查；绕过的应用直接使用系统网络，其 DNS、IPv6 和流量不受本应用的分流规则管理。应用范围仅按鸿蒙包名生效，未提供安卓容器内部各安卓应用的单独选择。');

        this.explanation('DNS 如何工作',
          '默认将接管的域名解析经节点发送到你选择的 DNS over HTTPS 服务，默认提供方是 Cloudflare（1.1.1.1）。代理 DNS URL 中的域名交给远端节点解析。白名单 DNS 分流默认关闭；开启后仅在白名单模式生效，Google 类别优先经节点，内置大陆、私有及 DNS 服务域名类别直接查询，其他域名仍经节点。直连 DoH 默认是阿里公共 DNS（223.5.5.5），可改为其他 HTTPS IPv4 地址。直连提供方可见查询域名和当前物理网络的出口地址。公共 DNS 不保证能解析局域网私有域名；仅按 IP 匹配的直连流量不一定使用直连 DNS。查询失败时不会改用另一条 DNS 路径。');

        this.explanation('连接前解析与节点检测',
          '节点服务器本身使用域名时，连接前需先通过当前物理网络解析到 IPv4 地址。进入 VPN 的 IPv6 目前捕获后阻断。节点检测仅接管本应用，使用独立的默认 DNS 和全部代理配置，不应用日常的 DNS 分流或应用选择列表。');

        this.explanation('主动连接检查',
          '点击“检查连接”或检测节点时，应用访问 Cloudflare 的 www.cloudflare.com/cdn-cgi/trace。连接检查用于确认连接可用；节点检测最多向同一地址依次发起两次完整 HTTPS 请求，分别记录首次与第二次请求耗时，只有系统确认第二次复用连接时才显示“复用延迟”。失败、取消或网络变化可能提前结束检测。请求会向该服务呈现网络出口地址。节点检测不保存响应正文或出口 IP；连接检查仅在界面显示当前会话的出口校验标记。浏览器检查会打开同一服务的页面。');

        this.explanation('本地配置检查',
          '首页的“检查配置”只读取节点内容，核对已有格式规则与连接入口限制，不会联网或修改节点。提示使用固定字段、问题分类和建议；批量导入仅标记条目序号，不在问题描述中回显认证信息或原始错误。连接前会再次检查当前节点，检查通过不代表服务器可连接。');

        this.explanation('诊断与日志',
          '应用保留最近 200 条服务诊断事件，包括时间、会话标识、网络类别、计数和固定失败阶段、原因分类。当前运行状态还保留首次失败、清理问题及可重试问题，清理问题不会覆盖原始失败。另保留最多 50 条服务退出观察，包含观察时间、会话标识、服务进程标识、原状态时间与固定分类，用于区分服务退出和清理回执。这些分类不记录节点或原始错误。首页主动检查的阶段提示保留在当前页面中。节点检测记录还包含节点标识、配置指纹、检测时间、结果、首次耗时，以及第二次请求的状态、耗时和连接复用确认信息；旧记录可能只有首次耗时。应用和转发核心也会生成运行日志，用于排查连接问题。');

        this.explanation('诊断摘要的复制与导出',
          '在连接诊断中可生成并预览摘要，再主动复制到本机剪贴板或保存为 TXT 文件。摘要包含版本、系统 API、记录时间、网络类别和固定事件、失败及清理分类，不包含节点名称、服务器地址、端口、密钥、订阅链接、应用包名列表或原始错误；内部会话与进程标识也不会原样导出。复制和保存使用当前预览内容，不会自动上传。摘要仍包含使用时间和网络变化记录，请预览后再决定是否分享。它描述读取时保留的记录，不代表实时联网状态或已确认故障根因。');

        this.explanation('你可以管理的内容',
          '断开连接并完成清理后，可在节点页改名或删除节点；在订阅页可更新或删除订阅。删除订阅会同时删除属于它的节点，手动导入的节点保留。更新失败或尚未确认预览时，原节点保持不变。删除节点或订阅不等同于清空历史检测与诊断记录。');
      }.width(formContentWidth(this.windowWidthVp)).padding(24).alignItems(HorizontalAlign.Start);
    }.id('privacyPage').width('100%').height('100%').align(Alignment.Top).background($r('app.color.page_bg'));
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
