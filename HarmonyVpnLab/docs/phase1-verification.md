# 第一阶段真机验证记录

日期：2026-09-07。测试应用：HarmonyVpnLab 0.1.2，包名 `com.example.harmonyvpnlab`。

## 结论与范围

原生 ArkTS/C++ 与第三方 VPN 生命周期已在用户的 Pura 80 Ultra 真机上打通。
当前只创建受限测试网卡并验证 FD 与清理，不读写 TUN 数据包，不含 Xray 或 Hev，不提供代理上网。
这份记录不能证明协议兼容、吞吐、DNS/IPv6 防泄漏、长期后台运行或网络切换已经通过。

## 环境与产物

- DevEco Studio 26.0.0 Release，构建号 26.0.0.821。
- 本机 SDK：HarmonyOS 26.0.0.105，API 26。
- 真机型号 LMR-AL10；界面市场名 HUAWEI Pura 80 Ultra。
- 设备系统参数：OpenHarmony-7.0.0.105，API 26。
- 原生库：ELF64 / AArch64；HAP 包含 `libvpnbridge.so` 和 `libc++_shared.so`。
- 权限：普通 `ohos.permission.INTERNET`；VPN 扩展类型 `vpn`。
- 已安装产物：`build/artifacts/entry-default-signed.hap`，1,458,670 字节。
- SHA-256：`C4CB4B5AC4BDFC360F1B77C37C346A300AFE76AE6D88842A6A92F76AF2646D6E`。
- 上述是当时安装包的历史记录；该未版本化路径随后已被新构建覆盖，0.1.2 HAP 未归档。0.3.0 起签名包改为按版本和哈希归档。
- 最终真机截图：[phase1-passed.png](../build/device-tests/phase1-passed.png)。

## 已执行的检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 调试签名及安装 | 通过 | Hvigor SignHap 成功，hdc 返回 install bundle successfully |
| ArkTS → C++ | 通过 | 真机 UI 与日志均有 `NATIVE_OK pointerBits=64 socket=create/check/close` |
| 进程级网络保护 | 通过 | 扩展进程内 `protectProcessNet succeeded` |
| TUN 创建及原生 FD 检查 | 通过 | `create()` 返回 FD，Native `fcntl` 检查成功 |
| 5 秒自动停止 | 通过 | FD close → VPN destroy → passed → extension destroyed 的顺序完整 |
| 提前停止 | 通过 | 0.1.2 收到 stop_requested 后先完成资源清理，再 stopped 和 onDestroy |
| 停止后重新启动 | 通过 | 新请求、新扩展进程再次完成正常周期 |
| 拒绝 VPN 授权 | 通过 | 用户选择拒绝；`VPN_AUTH allowed=false`，界面显示未授权并允许重试 |
| 拒绝后重新允许 | 通过 | `VPN_AUTH allowed=true`，随后完成创建、清理与退出 |

关键记录位于 `build/device-tests/`，其中设备日志时间与电脑文件名时间采用各自本地时区：

- 提前停止：`20260907-075457-EarlyStop.log`，runId `1788782098492`。
- 随后正常周期：`20260907-075514-Normal.log`，runId `1788782116117`。
- 拒绝：`authorization-denial.log`、`20260907-075717-result.json`。
- 重新允许后的正常周期：`20260907-075829-Observe.log`，runId `1788782263905`。
- 最终自动验收：`20260907-075905-Normal.log` 与 `20260907-075905-Normal-result.json`，runId `1788782347554`。

最终周期中，active 为设备时间 19:59:07.760，FD 关闭为 19:59:12.767，网卡销毁返回为 19:59:13.009，扩展销毁回调为 19:59:13.035。
FD 整数每次不同或复用属于系统行为，不能以相同/不同 FD 数字判断泄漏。
设备 shell 没有可用的 `ip` 命令，因此本阶段没有单独读取内核路由表；清理证据来自原生关闭、VPN API 成功返回及扩展退出日志。

## 真机发现并修复的问题

1. 自动签名材料生成后，default 产品未关联签名方案。补充 `signingConfig: "default"` 后成功生成 signed HAP；本机签名配置已由 Git 忽略。
2. 首次系统授权后的扩展启动未收到测试编号参数。改为恢复本应用内保存的待处理请求，只接收非空编号、starting 状态及未超时请求；取消和过期请求不创建网卡。
3. 界面直接系统停止扩展时，onDestroy 后异步网卡销毁可能尚未返回，旧版本停留在 stopping。改为协作停止，由扩展清理完毕后自停；非受控销毁会记录“清理尚未确认”。

## 下一阶段

先构建并检查纯 C Hev，再准备 Windows 宿主的 Go / OHOS Go 工具链和 Xray 包装库。
本机已经有 Python 3.14.6、Git Bash、DevEco 的 CMake/Ninja/OHOS clang；尚未找到可用 Go 或 GNU make。
WSL 查询返回权限错误，不能据此断定未安装发行版。
后续必须分别验证原生加载、本地 SOCKS、TUN 转发，再加入节点与订阅功能。
