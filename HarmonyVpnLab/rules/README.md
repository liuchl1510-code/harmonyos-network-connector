# v2rayN 白名单规则与数据

本目录固定 v2rayN **7.24.9** 的内置 `custom_routing_white`，不是从第三方教程整理的近似规则。源文件副本为 `custom_routing_white.json`；版本、提交、下载地址、输入和输出 SHA-256 均记录在 [`sources.lock.json`](sources.lock.json)。

## 规则顺序

规则来自 [2dust/v2rayN 提交 521230c40d5c180bc0727cf4003907edfae5a3e0](https://github.com/2dust/v2rayN/blob/521230c40d5c180bc0727cf4003907edfae5a3e0/v2rayN/ServiceLib/Sample/custom_routing_white)，按首次命中顺序处理：

1. 阻断 UDP 443（上游默认规则，影响 QUIC）。
2. `geosite:google` 走代理。
3. `geoip:private` 直连。
4. `geosite:private` 直连。
5. 上游列出的 35 个中国公共 DNS IPv4/IPv6 地址直连。
6. `alidns.com`、`doh.pub`、`dot.pub`、`360.cn`、`onedns.net` 及其子域直连。
7. `geoip:cn` 直连。
8. `geosite:cn` 直连。

未命中上述规则的流量走代理。Google 规则早于中国及私有地址规则，这一顺序不能任意调整。白名单指允许直连的目标集合；与按应用选择是否进入 VPN 的设置是不同维度。

上游新配置的路由 `domainStrategy` 为 `AsIs`，白名单模板没有覆盖它（参见同一提交的 `Global.cs`、`ConfigHandler.cs` 和 `V2rayRoutingService.cs`）。它不会仅为了匹配 IP 路由而主动把域名解析为 IP：域名由域名规则判断；已经取得的目标 IP 则可命中 IP 规则。不要把改成 `IPIfNonMatch` 描述为完全相同的上游默认行为。DNS 服务器选择和路由策略是两个设置，上游的 DNS 生成器还会根据 direct/proxy 域名规则分配 DNS；本目录提供规则与数据，不代表复制了上游全部 DNS 设置。

## GeoData 子集

数据来自 v2rayN 默认的数据源 [Loyalsoldier/v2ray-rules-dat，202609222357](https://github.com/Loyalsoldier/v2ray-rules-dat/releases/tag/202609222357)。完整输入下载后先核验锁定大小和 SHA-256，再保留 protobuf 最外层所选类别的**完整原字节**，保持原顺序，不重新编码、不修改类别内记录，不把正则表达式简化为域名后缀。

| 应用资源 | 保留类别 | 体积 | 内容 |
| --- | --- | ---: | --- |
| `geoip.dat` | CN、PRIVATE | 139,274 字节 | CN 9,741 个网段；PRIVATE 18 个网段，均含 IPv4 与 IPv6 |
| `geosite.dat` | PRIVATE、GOOGLE、CN | 1,994,637 字节 | 分别 131、1,075、111,179 条域名规则，保留完整域名、子域及正则类型 |

资源位于 `entry/src/main/resources/rawfile/`。输入完整数据约 28 MB，应用内子集约 2.13 MB。其他类别被省略，因此这些资源只供当前白名单所需类别使用，不能宣称提供了全量国家/广告等类别。GeoIP 中保留 IPv6 分类数据，不等于应用已支持 IPv6 隧道；实际网络支持以应用实现和实测记录为准。

## 验证与重新生成

在 `HarmonyVpnLab` 目录执行，需要 Python 3.9 或以上及标准库：

```sh
# 离线、只读：核对规则副本、资源大小/SHA、每个类别原字节/SHA/记录数
python scripts/prepare-routing-assets.py verify

# 提取器的缺项、重复类别、损坏/截断 protobuf、顺序和字节保持测试
python scripts/prepare-routing-assets.py selftest

# 从锁定 release URL 下载完整文件、校验、提取并替换应用内资源
python scripts/prepare-routing-assets.py prepare

# 或使用已经下载的完整 geoip.dat 和 geosite.dat；同样校验锁定 SHA
python scripts/prepare-routing-assets.py prepare --source-dir /path/to/upstream-assets
```

`prepare` 不使用浮动 `latest`，也不会因缺少类别而继续生成不完整资源。全部输入和两个输出验证完成后才写入资源，每个文件通过同目录临时文件替换；构建或提交前仍应执行 `verify`。脚本不连接设备，不读取节点，不更新应用的用户配置。

这里的可复现性是：由锁定的官方发布二进制数据产生字节相同的子集。上游发布流程会读取多个动态数据源，release 的源码提交并不固定那些数据源的历史输入，因此我们没有声称能从全部原始数据重建其完整 release。今后更新需要显式审查并修改锁定版本、哈希和类别统计，重新验证再发布。

## 署名与许可

- v2rayN 规则文件保留其 GPL-3.0 许可，完整原文见 [`LICENSE-v2rayN`](LICENSE-v2rayN)。
- Loyalsoldier/v2ray-rules-dat 仓库使用 GPL-3.0；`geoip.dat` 来源 Loyalsoldier/geoip，保留 **CC-BY-SA-4.0** 许可，未将这份数据统一改为应用的 GPL 许可。我们仅省略了无关类别，所选记录没有修改。
- CN IP 数据署名 gaoyifan/china-operator-ip；域名数据署名 Loyalsoldier/domain-list-custom、v2fly/domain-list-community、felixonmars/dnsmasq-china-list 及其贡献者。完整上游许可、MIT 版权通知和 dnsmasq-china-list 的 WTFPL-2.0 许可汇集于 [`LICENSE-Loyalsoldier`](LICENSE-Loyalsoldier)。
- `sources.lock.json` 的 `dataSourceNotices` 提交只固定本次保留的许可通知，并非声称它们就是上游构建时使用的数据版本。

数据选择/转换方式和相应源码已随本仓库提供；上述署名不表示上游作者为本应用背书。
