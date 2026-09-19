# 从源码构建（Windows / ARM64 完整核心与 x86_64 界面预览）

Git 仓库只提供源代码、固定版本记录、补丁和许可证文本。`entry/libs/arm64-v8a/*.so`、HAP、下载的上游源码、编译器缓存和个人签名资料均不随 Git 发布。当前开发版本为 0.20.0/code41，构建与验证状态见[阶段二十四记录](phase24-app-routing.md)；公开构建配置的最低兼容版本为 `6.1.1(24)`，compile/target SDK 仍为 `26.0.0`。API 24 真机安装与联网已按用户要求暂停，兼容配置不等于验收通过。先按目标选择构建变体：

| 变体 | 用途 | 是否准备原生核心 | 产物与限制 |
| --- | --- | --- | --- |
| ARM64 完整核心 | 真实设备的 VPN 功能路径 | 需要 `prepare-native.ps1` | 真实 Xray/Hev；当前脚本生成 debug HAP。设备、签名和网络能力必须单独验收。 |
| x86_64 UI 预览 | 手机、平板、PC、折叠屏模拟器的界面 QA | 不需要 | `-SimulatorUI`；版本追加 `-ui-preview`；仅有预览桥接，不能连接 VPN、测速或运行原生开发验证。 |

以下第 1—3 节说明 ARM64 完整核心。只做多端界面检查可直接使用[第 4 节](#4-x86_64-模拟器界面预览)，不能把预览模式用于联网验收。

## 前置条件

- Windows x64，PowerShell 7.2 或更新版本（命令为 `pwsh`，不是 Windows PowerShell 5.1）。
- Git for Windows 在 `PATH` 中。
- Python 3.12+。准备脚本默认在 `PATH` 查找 `python` 或 `python3`；也可明确传入 `-PythonPath`。
- 安装 DevEco Studio 及 HarmonyOS SDK 26.0.0；需要其 Node、JBR、OHPM、Hvigor 和 `sdk/default/openharmony/native` 中的 Clang、CMake、Ninja、LLVM 工具。非默认安装位置传入 `-DevEcoPath`。
- 网络可访问脚本固定的 Git 上游、Go 官方下载站、Go 模块代理/校验服务和 OHPM 软件源。首次准备会下载并编译 Go 工具链与原生依赖，应预留足够磁盘空间和构建时间。
- 使用真实 ASCII 路径存放构建/缓存。不要用 junction 或符号链接掩盖含中文的工具链路径。仓库可以位于中文路径；验证全新构建时建议克隆到例如 `C:\src\HarmonyVpnLab-public`。

以下命令均从仓库内的 `HarmonyVpnLab` 目录执行。路径是示例，可选择自己的 ASCII 目录。

## 1. 一次性准备原生库

先用新目录执行冷构建。`-Cold` 检查缓存和构建根目录为空或不存在；若已有内容会停止，不删除已有文件。

```powershell
pwsh -NoProfile -File .\scripts\prepare-native.ps1 `
  -DevEcoPath 'C:\Program Files\Huawei\DevEco Studio' `
  -CacheRoot 'C:\hvl-build\native-clean-01' `
  -Cold
```

若 Python 不在 PATH，可在同一命令中添加 `-PythonPath 'C:\Python312\python.exe'`。`BuildRoot` 默认是 `CacheRoot\build`，也可传入另一个 ASCII 路径；冷构建时两者都必须为空。之后复用同一缓存只需去掉 `-Cold`。

准备流程依次完成：

1. 在指定缓存根下建立最小 Hev 构建工作区，从固定提交及子模块构建并验证 `libhevsocks5tun.so`。
2. 明确指定 Go 的工作、基础源码与 bootstrap 位置，校验源码/补丁并构建 OHOS 工具链，再执行现有 Xray 构建与测试。
3. 用该工具链构建 `libharmonygo_smoke.so`，比对证据中的 SHA-256、ARM64 目标、TLS 方式和两个导出符号，并直接复核导出；确认后只重命名复制为应用需要的 `libgoruntime-smoke.so`。
4. 构建 C 运行时测试的正、负对照库 `libsmoke-good.so`、`libsmoke-broken.so`。

最终五个库位于 `entry/libs/arm64-v8a`。验证记录写入 `build/native`，C 对照的记录位于 `build/runtime-smoke`。`prepare-native-verification.json` 记录本次缓存/编译器路径及五个文件的哈希，便于检查冷构建是否使用了预期位置。

独立缓存覆盖旧脚本的历史 TEMP 默认值：Hev 源码位于 `CacheRoot\hev-input\.tooling`；Go 源码、bootstrap 及产物位于明确指定的工具链工作目录。Xray 仅在上述编译器已校验为可用后调用。`-Cold` 保证这些指定根没有先前内容；它不意味着操作系统、已安装 SDK 或网络服务也被重新安装。

## 2. 构建 ARM64 未签名 HAP

此命令用于验证源码可构建，不需要签名账号或个人证书：

```powershell
pwsh -NoProfile -File .\scripts\build.ps1 `
  -DevEcoPath 'C:\Program Files\Huawei\DevEco Studio' `
  -BuildRoot 'C:\hvl-build\hap-clean-01' `
  -NoSign
```

`-NoSign` 每次在 `BuildRoot\unsigned\<本次编号>\project` 建立新的项目，直接生成只有公开 SDK 设置的应用 `build-profile.json5`，其中不含 `signingConfigs` 或 `signingConfig`。不会读取仓库中被忽略的个人应用构建配置，不读取或覆盖既有 `BuildRoot\project` 签名项目；OHPM/Hvigor 缓存也放在独立的 `BuildRoot\unsigned\cache`。

暂存仅复制构建所需的应用源码、资源、五个原生库及 C 测试源码；`.private`、`.tooling`、隐藏目录、个人签名文件和既有构建目录不进入暂存。仓库提供的 `mozilla-ca.pem` 是公共 CA 资源，需要正常打包。

暂存还包含桥接代码直接引用的 `native/hev/include` 头文件。公开准备的首次干净 HAP 构建发现这一遗漏，修复后重新构建通过。

未签名产物写入 `build/artifacts/unsigned`，按版本和哈希留档到其 `versioned` 子目录。归档只读取本次构建输出，且拒绝未签名构建中出现非 `*-unsigned.hap` 文件；此前签名产物不会被当作本次结果。此 HAP 不能替代正常签名后的设备安装包。

如果核心库缺失，`build.ps1` 会在启动构建前给出缺失列表和 `prepare-native.ps1` 提示。两个 C 对照库也会在 HAP 构建时重新编译。

## 3. 个人签名与设备验证

省略 `-NoSign` 保留已有本地签名流程，使用 `BuildRoot\project` 中已有的个人配置；首次创建该暂存时才读取本地应用 `build-profile.json5`，没有则使用公开示例。公开示例不包含有效的证书/签名账户，需要在自己的 DevEco 环境中完成配置后才能获得可安装的签名包。

上述准备和构建命令不会操作手机，也不会登录签名账户。构建与 ELF/导出检查不能证明设备运行正确；Go 运行时测试、VPN 授权、数据通路及资源生命周期仍需单独在兼容的真机上验证。准备记录中的 `deviceValidated` 因此保持 `false`。

```powershell
pwsh -NoProfile -File .\scripts\build.ps1 `
  -DevEcoPath 'C:\Program Files\Huawei\DevEco Studio' `
  -BuildRoot 'C:\hvl-build\arm-device'
```

首次暂存后，在自己的 DevEco Studio 中配置 `C:\hvl-build\arm-device\project` 的签名，再重新运行同一命令。当前 `build.ps1` 固定使用 `buildMode=debug`；“完整核心”说明功能路径，“已签名”说明调试安装条件，两者都不等同于完成生产 Release 或应用商店发布。现有 ARM64 源码来自 [Hev](../native/hev/README.md) 和 [Xray/Go](../native/xray26/README.md) 构建链，不能直接改 ABI 名称就得到可用的 x86_64 转发核心。

## 4. x86_64 模拟器界面预览

不准备 ARM64 原生库，执行：

```powershell
pwsh -NoProfile -File .\scripts\build.ps1 `
  -BuildRoot 'C:\hvl-build\ui-preview' `
  -SimulatorUI -NoSign
```

它在独立的 `BuildRoot\simulator-ui\unsigned\<本次编号>\project` 暂存目录中：

- 将 ABI 设为 x86_64，启用 `HARMONY_UI_PREVIEW`，排除原生转发库和其他 ABI 文件。
- 仅在暂存副本中将 `VPN_CORE_AVAILABLE` 改为 false，并给版本名追加 `-ui-preview`；不改源码树中的完整核心开关。
- 编译后检查 HAP 中的原生库均为 ELF64/x86_64，且不包含 Xray、Hev、Go smoke 或 C smoke 库。
- 把结果单独写入 `build/artifacts/simulator-ui/`，按当前版本（例如 `versioned/0.14.0-ui-preview/`）和哈希归档。

安装到模拟器时，使用自己已经配置好的签名 profile 文件，省略 `-NoSign`：

```powershell
pwsh -NoProfile -File .\scripts\build.ps1 `
  -BuildRoot 'C:\hvl-build\ui-preview' `
  -SimulatorUI `
  -SigningProfilePath 'C:\hvl-build\arm-device\project\build-profile.json5'
```

该路径只是示例，必须替换为自己的有效本地配置。签名预览使用独立的 `simulator-ui\signed\<本次编号>\project`，不覆盖 ARM64 签名项目。预览包的普通节点编辑、粘贴导入、备份恢复、分流表单和外观可以检查；其连接按钮、节点联网检测和开发工具被明确禁用。服务入口也拒绝预览版启动 VPN，不能用截图上的未连接状态或按钮渲染作为网络通过证据。

PC 的 `Scan.Core` 能力只证明公共扫码类型可用，不代表系统扫码或图片解码可用。缺少 `SystemCapability.Multimedia.Scan.ScanBarcode` 时，导入页不加载 `NodeScanner`，改为提示粘贴分享链接/单 outbound JSON 或通过设置恢复节点备份。本阶段未引入第三方 PC 二维码解码库。

## 5. 多端界面贡献者检查

布局以窗口的逻辑 vp 宽度为输入，不按设备名称写死。`EntryAbility` 把窗口 px 按当前密度换算为 vp，并维护 `windowWidthVp`；销毁时移除对应尺寸监听。`AdaptiveLayout.ets` 统一规定：表单上限 840 vp、1024 vp 侧导航阈值、侧栏 176 vp、首页可用主内容宽度 680 vp 双栏阈值。新的表单应同时约束标题、滚动内容和固定操作区，避免只缩窄中间卡片。

先运行不访问设备的检查：

```powershell
node .\scripts\test-adaptive-layout.cjs
node .\scripts\test-adaptive-secondary-pages.cjs
```

第一组执行真实布局函数与窗口监听方法、使用合成 SDK；第二组解析实际 ArkTS UI 组件树，检查表单宽度和固定区域对齐。它们不替代实际字体、键盘、滚动、折叠或旋转渲染。修改相关业务后，再运行对应的节点、备份、网络设置或外观测试，保留原有控件 ID 和事件。

模拟器 UI 脚本需要显式选择模拟器目标，不能省略目标或把 USB 真机当作默认目标。例如，替换下方占位值后检查首页：

```powershell
node .\scripts\test-adaptive-emulator.cjs '<选定模拟器的 HDC 地址>' Home phone-home phase14
```

脚本只接受约定的本机模拟器地址；其 `SeedCatalog` / `SeedSamples` 使用合成节点并要求空节点库。不要为 UI QA 导入真实节点或私人备份。上述命令将安全投影 JSON 和同名 JPEG 写入 `build/phase14-emulators/`。生成本地画廊：

```powershell
node .\scripts\make-adaptive-report.cjs phase14
```

在已有本地 QA 原图时，打开 `build/phase14-emulators/report.html` 可筛选设备和查看原图。报告保留截图原像素，忽略启动、锁屏、调试和原始 AX 记录。`appBounds` 是 px；横向溢出为空只覆盖本次可见、被记录的控件。每次改变阈值或重新构建后，应记录安装包哈希和对应截图，不能把同版本号的早期候选都归入最终包。当前记录及未通过项见[阶段十四](phase14-autonomous-refinement.md)；使用 `phase13` 或 `phase12` 参数可分别查看[阶段十三](phase13-product-refinement.md)、[阶段十二](phase12-adaptive-layout-verification.md)的历史画廊。

验收顺序是先完成模拟器 UI；**真实 API24 平板的安装与 VPN 联网验证当前按用户要求暂停**，恢复验收时还需单独核对系统与签名条件。真实鸿蒙 PC 尚未联网验收：ARM64 电脑可走现有完整核心构建路径，仍需实机验证；当前 Go amd64 TLS/运行时限制只对应 x86_64 核心，不能泛化为所有 PC。全天稳定性、续航及完整折叠/旋转链路也不因 UI 包可运行而自动通过。

## 0.14.0 本地构建与验证范围（历史）

以下为 `0.14.0/code35` 的历史记录：ARM64 完整核心和 C4 x86_64 预览包均已完成源码/暂存一致性、签名及变体隔离核验，都是本地 debug 调试签名包。C4 已有 25 步表单 GUI、27 张界面截图、500 节点合成排序对照/夹具恢复及平板 20 分钟导航记录；23 套件离线回归与后续 46/46、45/45、15/15 项脚本安全检查分别保留各自版本归属。

C4 手机的 60 分钟导航观察本轮未完成：仅留下 65 个同进程、同包样本，实际跨度 1218.65 秒，没有完成摘要，中断原因未确认。上述检查不构成真实设备、VPN 联网、端到端文件保存/恢复或完整长时稳定性验收。两包 SHA、历史 C3 对照和完整限定见[阶段十四记录](phase14-autonomous-refinement.md)；HAP 与本地 `build/` 证据均不随源码发布。

## 已完成的公开构建检查（历史）

以下是 2026-09-08 首次公开源码准备的历史检查，不代表当前版本的联网或冷构建记录：使用全新源代码副本与全新原生缓存执行上述准备流程，五个 ARM64 库、Go 编译器检查、Xray socket 保护与统计重启检查、未签名 HAP 编译均通过。最终 HAP 40,089,169字节，SHA256 `a38f00a6ec295bb21e3e52a3f34a967a1d5162486415cdd1d5e73d1e7ccf20ae`。该文件只作本地构建验证，没有作为发行安装包上传。

公开且不含个人路径的结果见[publication-validation.json](publication-validation.json)。失败后的 HAP 重试使用新的暂存项目，只复用本次验证目录内的工具缓存；没有复用历史个人签名项目。新编译器补丁只清理了生成注释中的本机路径，功能修改及125个文件的哈希校验仍保留。
