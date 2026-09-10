# HarmonyOS Network Connector

使用 ArkTS / ArkUI 构建的鸿蒙原生节点管理与 IPv4 代理客户端，集成 Xray 26.6.1、Hev SOCKS5 Tunnel 2.9.0 和本地适配的 Go 1.26.7 工具链。

应用显示名称为 **Harmony VPN**，当前版本为 **0.14.0/code35**。这是独立的开发项目，参考 v2rayNG 的功能与分享链接格式，不是 v2rayNG 或华为的官方客户端。完整 Android 功能对等和商店发布尚未完成。

0.14.0 完善了节点导入、订阅与网络设置的未保存保护和错误反馈，修复编辑页取消返回后输入回退的问题，并加快大节点列表的排序响应。分流模式按钮在窄窗口、大字号下可以换行。两种调试构建已核验，模拟器已完成表单输入/丢弃流程、500 节点合成列表对照及平板 20 分钟界面观察；手机 60 分钟观察本轮未完成，仅保留约 20 分钟的部分样本。实现与验证边界见[阶段十四记录](HarmonyVpnLab/docs/phase14-autonomous-refinement.md)。

各版本变化与验证边界见[完整变更日志](CHANGELOG.md)。本轮未修改原生转发核心，真实设备安装与 VPN 联网继续暂停。

阶段十五完善了长测记录、中断检查和末尾计时，并使用独立诊断变体比较四份 ArkTS 堆快照；五轮导航未观察到所检查页面及订阅实例递增。普通 PC 预览包取得 59 分 57.29 秒、190 个样本的同进程记录，时长不足的完成结论被检查器拒绝。六组离线检查共 213 项通过。应用版本仍为 0.14.0，结果、曲线与限制见[内存观察和采集可靠性](HarmonyVpnLab/docs/phase15-memory-observation.md)。

## 当前功能

- 手机、平板与电脑窗口的响应式布局；表单最大 840 vp，窗口达到 1024 vp 使用侧导航，首页可用内容宽度达到 680 vp 使用双栏。
- 连接、节点、设置三个主入口，浅色/深色/跟随系统外观，最大 2 倍系统字号适配。
- 支持设备上的系统扫码、粘贴和批量导入，节点搜索、选择、参数/单 outbound JSON 编辑与删除。PC 缺少系统扫码能力时保留粘贴、JSON 和节点备份恢复入口。
- 单节点 JSON 导出、节点与订阅备份、预览确认后恢复。
- 编辑、导入、订阅与网络设置的未保存返回确认；失败保留输入，提交后的读回异常单独提示。
- 逐节点及批量依次 HTTPS 请求耗时检测，可取消并按耗时排序，结果与配置指纹绑定。
- 全部代理或自定义域名/IPv4 分流、绕过局域网、可配置的代理内 HTTPS DNS。
- 网络变化后的恢复、等待网络时正常断开。
- 有界诊断记录与连接状态显示。

IPv6 当前进入 VPN 后被阻断，尚未提供 IPv6 代理。节点凭据保存在应用私有目录，尚未增加应用层配置加密。应用不提供节点或订阅服务；测试和实际使用需要自行配置。

**多端界面适配不等于多端 VPN 已通过。** 当前 x86_64 模拟器包仅用于界面预览，不包含 Xray/Hev 转发核心，连接、检测和开发验证均被禁用。真实平板安装与联网按用户要求暂停，尚未验收；PC 联网没有通过验收。

## 界面

以下为 **0.14.0 x86_64 界面预览包**的原始截图，仅使用示例节点。预览包不含 VPN 核心，因此连接和检测按钮禁用；截图不代表联网或文件保存/恢复验收。

| PC 窄窗口：2 倍字号 | 平板：2 倍字号 | 平板：连接首页 |
| --- | --- | --- |
| <img src="docs/images/0.14-pc-network-font2.jpeg" alt="PC 模拟器窄窗口与两倍字号下，分流模式按钮按需换行" width="220" /> | <img src="docs/images/0.14-tablet-network-font2.jpeg" alt="平板模拟器两倍字号下的分流与 DNS 设置" width="320" /> | <img src="docs/images/0.14-tablet-home.jpeg" alt="平板模拟器首页，预览包连接能力禁用" width="360" /> |

包参数与当前验证进度见[阶段十四记录](HarmonyVpnLab/docs/phase14-autonomous-refinement.md)。0.13 的历史截图和 16 张最终包记录仍见[阶段十三](HarmonyVpnLab/docs/phase13-product-refinement.md)；原始构建目录不随源码发布。

## 工程与构建

工程位于 [`HarmonyVpnLab/`](HarmonyVpnLab/)。开发环境为 **Windows + PowerShell 7 + DevEco Studio 26 / HarmonyOS SDK API 26 + Python 3.12 或更新版本 + Git**。

公开构建配置的最低系统版本为 **HarmonyOS 6.1.1（API 24）**，compile/target 仍为 **API 26**。API 24 兼容代码已为较新接口增加版本或能力判断，并补充 VPN 启动超时处理及请求代次隔离，避免迟到结果影响后续请求；这不表示真实 API 24 平板已安装或联网通过。

请从[首次构建指南](HarmonyVpnLab/docs/public-build.md)开始。核心源码、上游版本、补丁与校验信息保存在 [`native/`](HarmonyVpnLab/native/)，仓库不携带预编译 `.so`、HAP、个人证书或本机配置。

```powershell
cd HarmonyVpnLab
pwsh -File .\scripts\prepare-native.ps1
pwsh -File .\scripts\build.ps1 -NoSign
```

以上是 **ARM64 完整核心构建**，用于真实设备功能路径。只检查多端界面时，可跳过原生核心准备，另建 **x86_64 UI 预览包**：

```powershell
pwsh -File .\scripts\build.ps1 -SimulatorUI -NoSign
```

预览产物单独写入 `HarmonyVpnLab/build/artifacts/simulator-ui/`，版本带 `-ui-preview` 后缀。它不含 ARM64 核心，也不能通过修改界面开关变成 VPN 安装包。签名预览包的命令及隔离规则见[构建指南](HarmonyVpnLab/docs/public-build.md)。

首次原生构建会下载固定版本的开源依赖并编译 Go 工具链，耗时和磁盘占用明显高于日常 ArkTS 构建。脚本使用独立的 ASCII 缓存路径，以避开原生工具对中文路径的限制；源码仍可保存在中文目录。

未签名 HAP 用于检查构建是否完整，不能直接安装到真机。当前构建脚本执行 `debug` 构建；签名成功表示获得调试安装包，不表示已完成生产 Release 或商店审核。真机调试应在自己的 DevEco Studio 中配置自己的签名，不应复用其他开发者的证书或 Profile。这个仓库以源码为主，没有通用发行安装包。

## 验证范围

已在华为 Pura 80 Ultra、HarmonyOS 7、API 26 上进行限定范围真机验证。各版本的实现、验收项目与边界分别记录，不能把历史验证视为新增功能的验收。

阶段十四当时，0.14 已通过 23/23 套件离线回归；表单、持续观察及诊断脚本分别通过 46/46、45/45、15/15 项纯模拟安全检查。以上为历史计数，阶段十五新增工具的最终计数单独记录。最终 C4 的实际 25 步 GUI 和 27 张界面截图单独留存。手机 60 分钟观察该轮未完成，阶段记录保留部分样本、历史导航失败及空闲/界面检查对照；不作无泄漏、完整长时稳定性或内存改善结论。

- [阶段十五：内存观察、对象分析与采集可靠性](HarmonyVpnLab/docs/phase15-memory-observation.md)
- [0.14.0 表单保护、列表优化与模拟器观察](HarmonyVpnLab/docs/phase14-autonomous-refinement.md)
- [0.13.0 产品细化与验证范围](HarmonyVpnLab/docs/phase13-product-refinement.md)
- [0.12.0 多端自适应与模拟器界面验证](HarmonyVpnLab/docs/phase12-adaptive-layout-verification.md)
- [0.11.1 分流、编辑备份与批量检测](HarmonyVpnLab/docs/phase11-network-node-tools.md)
- [0.10.0 界面与回归说明](HarmonyVpnLab/docs/phase10-product-ui-verification.md)
- [0.9.0 的 30 分钟稳定性观察](HarmonyVpnLab/docs/phase9-latency-stability-verification.md)
- [支持的导入格式与限制](HarmonyVpnLab/docs/node-import-support.md)
- [开发工程说明](HarmonyVpnLab/README.md)
- [公开源码冷构建记录](HarmonyVpnLab/docs/publication-validation.json)

历史验证摘要描述特定版本与设备，不代表所有机型、协议、输入法、全天稳定性或续航已经通过。真实订阅服务与域名节点的端到端验收尚缺条件。原始本机日志、节点数据和未脱敏截图不进入公开仓库；运行脚本会在本地 `build/` 生成新的报告。

0.12.0 已完成 447 项离线检查和 ARM64 签名构建，另有手机、平板、PC 与折叠屏模拟器的界面记录。PC 已观察窗口缩放、主题及 Tab/Enter 导航；该轮未完成实际输入法、剪贴板或扫码导入验收。折叠屏内屏双栏已观察，但折叠/旋转操作曾导致宿主模拟器退出，连续切换验收尚未通过。这些模拟器记录均不能代替真实设备联网结果。

公开准备时已从不含预编译库、个人签名和旧原生缓存的副本，重新构建五个 ARM64 库并生成未签名 HAP。SDK与操作系统沿用已安装版本；该构建验证没有安装手机，也不替代上面的真机记录。

## 许可证与第三方来源

除文件另有声明外，本项目自有代码采用 **GPL-3.0-or-later**，见仓库根 [`LICENSE`](LICENSE)；第三方文件继续遵循各自原有许可，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。实际依赖包含 MPL、GPL、LGPL（含特定链接例外）、MIT、BSD、Apache 等许可，不能把整个依赖树概括成单一宽松许可证。

公开源码不等同于完成应用商店审核。后续发行二进制时，还需提供与该产物对应的源码、补丁、许可及完整发布材料。
