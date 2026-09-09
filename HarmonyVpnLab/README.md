# 鸿蒙 VPN 验证工程

这是鸿蒙原生 VPN 移植的验证工程。当前已集成 ArkTS 界面、C++ 桥接、Hev 2.9.0 和 Xray 26.6.1。

**0.13.0/code34 细化首页、节点列表、设置与编辑体验。** 首页首次使用可直接添加节点，网络设置可直达，宽屏增加配置区；节点列表采用紧凑行、当前标记与筛选数量，检测说明默认折叠；设置分为“连接与数据”和“帮助与说明”，外观选项保留选中勾选并减少重复提示；节点编辑增加未保存离开保护、固定反馈区及端口数字输入与校验。API 24 兼容代码已补充版本/能力判断、启动超时和请求代次隔离。签名构建与有界模拟器页面观察已完成，编辑确认和非法端口完整 GUI 流程尚未完成验收，仅有离线验证；真实平板安装与联网按用户要求暂停，尚未验收。实现与证据见[阶段十三记录](docs/phase13-product-refinement.md)。

**0.12.0 新增手机、平板与 2in1 窗口自适应。** 表单最多 840 vp 并居中；窗口达到 1024 vp 时主入口使用 176 vp 侧导航；首页可用主体达到 680 vp 时显示双栏。PC 缺少系统扫码能力时不加载该模块，仍可粘贴分享链接/单 outbound JSON，或从设置恢复节点备份。x86_64 模拟器包仅预览界面，不包含 VPN 核心。该版本的已测范围与折叠/旋转限制见[阶段十二记录](docs/phase12-adaptive-layout-verification.md)。
**0.11.1 新增分流与 DNS 设置、完整节点编辑、JSON 导出/节点库备份恢复、批量依次 HTTPS 检测和列表耗时排序。** 默认网络行为沿用全部代理；自定义规则与 DNS 在下一次普通连接时生效，节点检测始终使用独立默认配置。真机验收中修复了参数化菜单不展开、跨会话重连计数误用、下一条检测过早启动的问题。C++ 桥接和原生核心未修改。使用方法及验证范围见[阶段十一记录](docs/phase11-network-node-tools.md)。
**0.10.0 完成原生界面与交互整理。** 底部提供连接、节点、设置三个入口；支持系统/浅色/深色外观、系统字体跟随与最大2倍字号；开发工具、诊断、关于和隐私说明独立归纳。节点采用紧凑列表和原生菜单，检测结果在大字体下完整显示。详见[界面与回归记录](docs/phase10-product-ui-verification.md)。
**0.9.0 新增逐节点 HTTPS 耗时检测和连接诊断记录。** 两条真实节点、取消后重试、完全断网恢复和离线中停止已通过真机验证；另完成30分钟/61样本的后台为主观测，四次DNS/HTTPS复查及最终清理通过。临时检测仅接管本应用，保留当前选中节点，完成或取消后自动清理；历史结果与配置 SHA-256 指纹绑定。范围及限制见[阶段九记录](docs/phase9-latency-stability-verification.md)。
**0.8.1 新增域名预解析、手动重连和网络切换恢复。** 已在真机通过三次核心重连，以及 Wi-Fi → 移动数据 → Wi-Fi 后的 DNS/HTTPS 检查；恢复时保留 VPN 网卡和 Hev。用户暂时没有域名节点，因此域名验证限于实际核心拨号逻辑和手机物理网络 DNS 接口。详见[网络恢复记录](docs/phase8-network-recovery-verification.md)。

**0.7.1 新增多节点列表、批量粘贴和扫码导入。** 真机已验证旧节点迁移、增删改、切换和重启保存；用户扫码保存的 3X-UI 节点也通过 DNS/HTTPS 检查。HTTPS 订阅获取和预览已实现，但尚无真实订阅服务验收。详见[节点管理验证记录](docs/phase7-node-management-verification.md)。

0.6.8 已验证全设备 IPv4 代理、代理 DNS、IPv6 捕获后阻断，以及华为浏览器出口一致和桌面后台返回；详见[持续连接验证记录](docs/phase6-persistent-connection-verification.md)。长时间稳定性、续航和广泛协议覆盖仍待后续验证。

**历史验证：0.1.2 的生命周期阶段已通过。** 原生调用、正常创建/释放、提前停止、拒绝授权及重新授权恢复均已实际验证。详见 [第一阶段验证记录](docs/phase1-verification.md)。

历史核心集成：0.3.0 包含[节点本地导入](docs/node-import-support.md)和单应用节点 HTTPS 验证入口。详见[核心集成记录](docs/phase2-verification.md)。

当前版本：0.13.0/code34。完整核心构建继续使用 Go 1.26.7 的 OHOS 适配和真实 Xray 26.6.1，满足服务端默认最低 26.3.27 的要求。逐 socket 保护、运行时时钟和保存读回校验继续保留。0.8.1 用第9个包装层ABI直接读取当前核心统计，移除了不支持重复启动的HTTP metrics模块。0.6.4 修复授权观察器回收卡死并通过一次锁屏恢复；0.6.8 修复 Hev 可写事件空转。历史CPU采样不是续航测量，版本/测试范围分别记录。

## 已确认的环境

- DevEco Studio 26.0.0 Release（26.0.0.821）。
- 本机配套 HarmonyOS SDK 26.0.0.105，API 26。
- 公开构建配置最低兼容 HarmonyOS 6.1.1（API 24），compile/target 为 API 26；最低版本声明不等同于真实平板验收。
- USB 真机：华为 Pura 80 Ultra，设备报告型号 LMR-AL10；系统参数报告 OpenHarmony-7.0.0.105，API 26。
- 完整转发核心目标为 arm64-v8a；`-SimulatorUI` 另构建 x86_64 界面预览，不含转发核心。
- manifest 声明 phone、tablet、2in1，支持全屏/分屏/浮窗；界面声明不代表这些设备的 VPN 已通过。
- 普通 INTERNET、GET_NETWORK_INFO 权限，无 MANAGE_VPN 系统权限。

## 构建

首次公开源码克隆不包含原生库，请先按[源码构建指南](docs/public-build.md)运行 `prepare-native.ps1`。不使用个人签名的构建检查采用 `build.ps1 -NoSign`；下文保留本地签名开发流程。

仅检查手机/平板/电脑/折叠屏的布局时，使用独立预览变体：

```powershell
pwsh -File .\scripts\build.ps1 -SimulatorUI -NoSign
```

预览版不需要准备 ARM64 库，0.13.0 构建的版本标记为 `0.13.0-ui-preview`，产物写入 `build/artifacts/simulator-ui/`。连接、节点联网检测和开发验证入口均不可用；节点编辑、粘贴导入、备份恢复和外观仍可检查。安装到模拟器需自己的签名配置，命令见[预览构建指南](docs/public-build.md#4-x86_64-模拟器界面预览)。当前脚本的构建模式仍是 debug，本轮预览验收状态以阶段十三记录为准。

在此工程目录执行 PowerShell 7 命令：

```powershell
.\scripts\build.ps1
```

脚本使用 DevEco 自带的 Node、Java、ohpm、Hvigor 和 SDK。首次构建时 Hvigor 会下载它需要的 pnpm 版本。
DevEco 拒绝中文工程路径，目录联接也会被还原。因此当前源码保存在本目录，构建脚本自动同步到英文临时工作区：

```text
%TEMP%\HarmonyVpnLab-01a07b6e\project
```

在 DevEco 中打开上面的英文工作区进行签名和运行。它是可重建的构建副本；应用代码应改本目录，再运行构建脚本同步。
脚本保留构建副本中的 `build-profile.json5`，避免覆盖本机签名配置。签名完成后应把该文件备份到本目录的同名文件（已由 Git 忽略）；证书本身保留在 DevEco 管理位置。
如果临时工作区被清理，需恢复该本机签名配置或重新自动签名。
HAP 构建产物会复制到本目录 `build/artifacts/`。
从 0.3.0 开始，签名包还会按版本与 SHA256 前缀归档到 `build/artifacts/versioned/`。

可通过 `-DevEcoPath` 指定安装路径，通过 `-BuildRoot` 指定另一个纯英文构建目录。

## 真机验收

安装后首页是持续连接页。已保存节点时，点击“连接”开始全设备 IPv4 代理，点击“检查连接”验证代理 DNS 与域名 HTTPS，点击“断开”释放连接。“90 秒全设备验证”和“90 秒本应用验证”会自动结束，普通“连接”没有此计时器。全设备模式省略应用白名单；IPv6 进入 VPN 后由核心黑洞处理，未提供 IPv6 代理。

首页“重新连接”只重启代理核心；网络类型或地址/DNS/路由变化也会触发恢复。恢复期间已有请求可能需要重试，无网时保留VPN网卡并等待，任何阶段都可以断开。界面显示当前物理网络与恢复次数。自动化脚本新增 `-Mode Reconnect` 和 `-Mode Resolve`；后者只验证固定公共域名的物理网络解析，不替代真实域名节点验收。

```powershell
.\scripts\test-connection.ps1 -Mode StartGlobal
.\scripts\test-connection.ps1 -Mode Ipv6
.\scripts\test-connection.ps1 -Mode Check
.\scripts\test-connection.ps1 -Mode Stop
```

`Start` 是持续连接，`StartApp` 是本应用 90 秒检查，`Browser` 打开系统浏览器，`Inspect` 只读当前连接页。脚本记录当前 UI 与日志；IPv6 验收须同时确认无响应及黑洞命中，不能只凭请求失败判定阻断。0.6.0/0.6.1 的 IPv6 配置曾在真机绕过 VPN，不应安装使用。

以下为保留的短时探针验收流程。先在“设置”→“开发工具”中点击“打开短时探针”，再执行相应脚本；首页本身不显示 `NATIVE_OK`。

1. 手机开启开发者模式和 USB 调试，并信任电脑。`hdc list targets -v` 应显示 USB Connected。
2. 在 DevEco 的项目签名配置中登录自己的华为账号并完成自动调试签名。
3. 安装 signed HAP，打开短时探针页面。该页应显示 `NATIVE_OK`：它实际创建、检查并关闭一个原生 socket。
4. 点击“开始 5 秒 VPN 测试”，首次运行处理系统 VPN 授权弹窗。
5. 扩展调用 `protectProcessNet()`，创建 `198.18.0.2/30` 虚拟网卡，仅配置 `198.18.0.0/30` 测试路由；不设置默认路由或 DNS。
6. Native 用 `fcntl` 验证返回 FD，不读取、复制或关闭它。5 秒后由扩展关闭 FD、销毁 VPN 网络并请求停止。
7. UI 结果与 `HarmonyVpnLab` 标签日志一起验收。资源清理结果和扩展销毁日志分别记录。
8. 再做一次正常启停、一次提前停止和一次拒绝授权。超时提示只表示结果未知，不能判定资源已释放。

已授权并打开应用后，可从本工程执行可重复的真机检查：

```powershell
.\scripts\test-device.ps1 -Mode Normal
.\scripts\test-device.ps1 -Mode EarlyStop
.\scripts\test-device.ps1 -Mode Hev
.\scripts\test-device.ps1 -Mode Xray
.\scripts\test-device.ps1 -Mode RejectProtection
.\scripts\test-device.ps1 -Mode Node
```

脚本从当前界面查找按钮，每次重新获取坐标，并同时检查新请求对应的日志顺序与最终界面。
`Observe` 只读取界面和日志，`Request` 只发起请求供用户处理授权弹窗。日志和界面树保存到 `build/device-tests/`。

提前停止通过应用状态文件发送 `stop_requested`，由扩展在存活期间先关闭 FD、等待网卡销毁成功，再请求系统结束扩展；不依赖 `onDestroy` 里的异步操作一定完成。

本阶段不验证数据包转发、DNS 防泄漏、IPv6、后台长期运行、Wi-Fi/蜂窝切换或吞吐。
这些须在 Xray/Hev 接入后独立验证。

以上句中的“本阶段”指生命周期模式。Hev/Xray 模式已经验证 TCP/HTTP 数据包实际转发，但它们不接触外部节点。

## 本地节点导入

在“节点”→“添加”→“扫码或粘贴节点”，粘贴分享链接、Base64列表、单个出站JSON；有系统扫码能力的设备也可扫描3X-UI二维码或从系统扫码页选取图片，识别后点击“解析并保存”。PC 不提供系统扫码或图片识码，界面给出粘贴/JSON/备份恢复指引。支持格式及拒绝项见[导入范围](docs/node-import-support.md)。输入保存后清空，不写入日志。已有当前节点保持选中，可在列表中“选用”。连接运行/清理期间可以浏览列表，修改仍被锁定。

节点只保存在本应用私有目录，尚未实现应用层配置加密。单节点二维码不需要订阅地址。实际持有 HTTPS 订阅 URL 时，可通过“管理订阅”获取预览后保存。订阅支持同样的链接/JSON文本，拒绝自动重定向和Clash YAML；无自动后台刷新。目录最多500节点、20来源，保存采用原子替换，更新失败保留原数据。

节点列表的“检测”用于测量HTTPS请求耗时，可在断开状态逐个执行。计时从HTTPS请求发起到小响应完整返回，包含这次请求的DNS/TLS和传输，不含VPN启动时间，也不是TCP RTT或带宽。固定访问Cloudflare trace，TLS正常验证、禁用跳转和缓存，单次请求总时限8秒，临时会话上限30秒。网络变化或取消使迟到结果失效；不会为测试切换当前节点。每节点只保留最近一次有效格式的记录，配置改变后隐藏旧结果。

“设置”中的“连接诊断”在连接中也可以查看，最多保留最近200条固定类别事件：网络变化、恢复、保护失败分类和停止清理。Socket热路径只累计计数，心跳和停止时写入分类记录；节点、地址和原始核心日志不写进诊断页。

持续连接支持标准 IPv4 地址或 ASCII/Punycode 域名。域名通过明确的物理网络解析IPv4，Xray保留原域名用于SNI/Host/authority并固定实际拨号IP。额外SRV/TXT、ECH解析路径暂不支持。旧开发探针的Node模式仍以IPv4节点为验收范围，正常使用请从首页连接。
“节点联网测试”最多约 30 秒，只把本应用的 IPv4 流量纳入 VPN，访问固定 IPv4 HTTPS 测试站点，并检查 Xray 节点出站计数增量；尚未代表全局代理可用。

原生库可单独重建：

```powershell
.\scripts\build-hev.ps1
.\scripts\build-xray.ps1
.\scripts\build.ps1
```

当前核心构建说明和许可证位于 `native/hev/` 与 `native/xray26/`；`native/xray/` 保留 25.8.3 历史基线。两个正式转发库每轮都在 VPN 扩展进程运行；除了进程级保护，还必须通过逐 socket 回调保护绕过 libc 钩子的 Go 外连。用于 Go 运行时移植验证的独立测试见 `native/runtime-smoke/`。

## 代码入口

- `entry/src/main/ets/pages/Home.ets`：持续连接界面、连接检查与重连状态。
- `entry/src/main/ets/model/AdaptiveLayout.ets`：按窗口 vp 宽度选择侧导航、双栏和内容上限。
- `entry/src/main/ets/entryability/EntryAbility.ets`：窗口尺寸监听和 `windowWidthVp` 更新。
- `entry/src/main/ets/model/BuildCapabilities.ets`：区分完整核心与界面预览；预览脚本只在隔离暂存中改为 false。
- `entry/src/main/ets/model/NodeScanner.ets`：在能力检查后动态加载系统扫码。
- `entry/src/main/ets/pages/Index.ets`：短时探针、授权观察、状态轮询。
- `entry/src/main/ets/vpn/VpnProbeAbility.ets`：VPN 扩展、持续连接和受限测试路由、清理。
- `entry/src/main/ets/model/ConnectionConfig.ets`：代理 DNS 与 IPv6 黑洞路由。
- `entry/src/main/ets/model/ConnectionControl.ets`：跨进程连接命令与状态。
- `entry/src/main/ets/model/ProbeState.ets`：跨进程状态文件。
- `entry/src/main/cpp/napi_init.cpp`：N-API 和原生 FD 检查。

多端贡献的构建与回归入口见[贡献者检查](docs/public-build.md#5-多端界面贡献者检查)。本地截图画廊可用 `node scripts/make-adaptive-report.cjs` 重建，输出 `build/phase12-emulators/report.html`；截图、QA 临时数据与原始日志不随 Git 发布。

## 后续源码参考

已通过实时远程引用及固定提交源文件核对；Hev 与 libXray 现已集成，v2rayNG/Hey 用于格式与平台适配参考：

| 项目 | 固定提交 |
| --- | --- |
| v2rayNG | `2020807c255b76b09c9ced4255c95600250aef48` |
| Hey | `a02a6a51fe02707a5e1ac5fecd90b3966452ef2d` |
| Hey 当前使用的 libXray | `20d70a98a1eef5227252894fa8e08c9e52a67ad6` |
| Hev 2.9.0 | `99cd2d5d5dfc9b21038e977808e59a0b90b38fa0` |

Hey 的上述提交实际使用旧版 libXray/Xray-core v1.250803.0 和 OHOS Go 1.24 系列。
此前网页缓存展示的 1.26.5/v26.7.28 内容与实时提交不符，不能用来决定构建版本。
目前已采用单一 Xray Go 库加纯 C Hev，完成原生加载、SOCKS、VPN 和真实节点 HTTPS 验证。当前核心的固定提交与 Go 移植构建说明以 `native/xray26/` 为准；各依赖许可证保留在对应目录。
