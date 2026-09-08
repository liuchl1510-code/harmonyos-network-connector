# 从源码构建（Windows / ARM64 HarmonyOS）

Git 仓库只提供源代码、固定版本记录、补丁和许可证文本。`entry/libs/arm64-v8a/*.so`、HAP、下载的上游源码、编译器缓存和个人签名资料均不随 Git 发布。首次克隆需要先生成原生库，再构建 HAP。

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

## 2. 构建未签名 HAP

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

## 已完成的公开构建检查

2026-09-08 使用全新源代码副本与全新原生缓存执行上述准备流程，五个 ARM64 库、Go 编译器检查、Xray socket 保护与统计重启检查、未签名 HAP 编译均通过。最终 HAP 40,089,169字节，SHA256 `a38f00a6ec295bb21e3e52a3f34a967a1d5162486415cdd1d5e73d1e7ccf20ae`。该文件只作本地构建验证，没有作为发行安装包上传。

公开且不含个人路径的结果见[publication-validation.json](publication-validation.json)。失败后的 HAP 重试使用新的暂存项目，只复用本次验证目录内的工具缓存；没有复用历史个人签名项目。新编译器补丁只清理了生成注释中的本机路径，功能修改及125个文件的哈希校验仍保留。
