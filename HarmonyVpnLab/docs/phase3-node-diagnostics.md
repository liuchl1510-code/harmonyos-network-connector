# 节点诊断与 Go 外连回环修复

日期：2026-09-07。设备：Pura 80 Ultra / API 26。本文保留截至 0.4.3 的回环修复与失败定位记录；0.5.0 后续已完成[真实节点联网验证](phase5-real-node-verification.md)。

## 当前结论

本机闭环、Go socket 保护成功路径和停止清理均已在真机验证。
用户保存的节点端口 TCP 可达，Go 外连回环已消除；随后出现 REALITY 专用认证未通过，因此 **外部节点 HTTPS 仍未通过**。
不能据单条认证错误确定公钥、shortId、SNI、端口或服务端哪一项有问题。[后续有效配置与版本对照](phase4-core-compatibility.md)已确认：相同 WLAN 出口下，Windows 25.8.3 失败而 26.6.1 成功，正在推进新版核心适配。

## 问题定位过程

1. 0.3.1 已按用户要求在应用内更新远端服务器地址；没有改内部 127.0.0.1 监听地址。
2. 修复了 libXray 单次运行中重复 Start 的问题；另同时分配不同的 SOCKS/metrics 端口。
3. 实际节点为 VLESS/TCP/REALITY，TCP 443 连通，但 UI HTTPS 超时，节点业务计数为零。
4. 使用相同的 trustedApplications 和 IPv4 默认路由，本机 Xray fixture 仍成功，排除了基本路由/转发层完全不工作的情况。
5. 开启应用私有 info 错误日志，仅输出分类统计，不输出密钥或完整配置。runId `1788792218271` 显示 41 个 SOCKS 入站请求，其中 40 个目标竟是节点自身，确认外连回环。

## 原因与实现

公开 OpenHarmony 的进程保护路径设置进程内标志，随后由 libc socket hook 设置 socket 的 protected-from-VPN 标记。
本项目 OHOS Go fork 用 RawSyscall 创建 socket，绕过这个入口。ArkTS 的 TCP 预检成功，不能证明 Go 外连已经受保护。

源码证据：

- [VPN 保护入口](https://github.com/openharmony/communication_netmanager_ext/blob/bded26787d5edf0228af99d7b4daa46f74ee50d8/frameworks/js/napi/vpnext/src/vpn_exec_ext.cpp#L112-L123)
- [进程标志与 HookSocket](https://github.com/openharmony/communication_netmanager_base/blob/8e9708ccfb65e07cb2ea6824f9fa17af68ba0ac8/services/netmanagernative/fwmarkclient/src/netsys_sock_client.cpp#L29-L71)
- Go fork 固定提交 `302a5306b6fad2f47196360b82561d1db1f954cf` 的 `src/syscall/zsyscall_linux_arm64.go`。

修复采用：Xray DialerController → C ABI callback → C++ TSFN → 扩展中的 `connection.protect(fd)`。
只有 Promise 成功完成才允许继续 connect；拒绝、队列满、超时或未注册保护均阻止拨号。
固定 Xray-core 原本吞掉 controller 错误，已对 TCP/UDP 两条路径增加错误传播补丁。

C++ 复制并持有 Go socket，只把副本交给异步保护，不关闭 Go 原始 FD。正常回执后关闭副本；超时或环境退出但保护未完成时保留同一 socket，防止迟到 IPC 作用于复用 FD。
等待上限 3 秒、活动副本上限 128。此上限也包含等待迟到回执的副本。动态库保持进程存活期，避免卸载仍在执行的 Go runtime。

实现文件：`entry/src/main/cpp/socket_protect.cpp`、`native/xray/main.go.template`、`native/xray/patches/0002-socket-controller-fail-closed.patch`。

## 已验证证据

| 检查 | 结果 |
| --- | --- |
| Go host TCP/UDP 成功与拒绝 | 4/4 通过，仅 Windows loopback |
| 原始未修复核心负向对照 | 两项均检出拒绝后仍连接 |
| OHOS ARM64、TLSDESC、8 个 C 导出 | 通过，包含运行时信息 ABI |
| C++ OHOS 语法检查 | `-Wall -Wextra -Werror` 通过 |
| 真机本机 Xray 闭环 | 通过，保护 requests=1/succeeded=1/failed=0/timedOut=0/active=0 |
| 真机节点外连保护 | requests=5/succeeded=5/failed=0/timedOut=0/active=0 |
| 真机回环消除 | serverRecaptures 从 40 降为 0 |
| 真机节点 HTTPS | 未通过，REALITY 专用认证失败 |
| 真机拒绝保护故障注入 | 通过，5 次拒绝、成功 0、fixture 请求 0、active 0，清理成功 |
| Go 与 ArkTS 运行时时钟 | 已验证，差值 0～1 ms |

关键设备证据：

- `build/device-tests/20260907-104336-Node.log`：旧实现回环，runId `1788792218271`。
- `build/device-tests/20260907-105250-Xray.log`：逐 socket 保护后本机闭环成功，runId `1788792773789`。
- `build/device-tests/20260907-105311-Node.log`：保护成功、回环为零、REALITY rejected=1，runId `1788792793932`。
- `build/device-tests/20260907-111823-RejectProtection.log`：拒绝保护及清理通过，runId `1788794305341`。
- 当前构建证据：`build/native/xray-runtime-info-verification.json`。

当前 libxray.so SHA256：`82c2760f7af524897a9e12c3442e80bc4e501cd7ed1acd961813173e0a1177c9`。
0.4.1 签名 HAP SHA256：`FDDF6C05D878D5B622383331E408052144BC4F79ECD251FA9AAA2CBA6749B659`，34,994,693 字节，已按版本归档。

## 结论边界

nodeProxy 的计数在 REALITY 握手成功返回后才包装，握手字节不在该计数中；零计数不能独立证明没有经过 SOCKS。
`processed invalid connection` 表示普通证书验证路径通过但 REALITY 专用认证未通过，不应直接归因为某一个密钥字段，也不能通过关闭证书检查解决。
本轮未验证 DNS、IPv6、全局代理、UDP 节点业务流量、长期运行或高并发。未完成的异步保护超时/环境销毁分支仍需更广泛的设备压力测试。
