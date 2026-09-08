# 真机真实节点联网验证

电脑记录日期：2026-09-07；手机日志日期：2026-09-08。测试设备：Pura 80 Ultra / API 26。

## 结果

**0.5.0 已在真机完成有效 VLESS/REALITY 节点的 IPv4 HTTPS 转发。** 路径为应用 HTTP 客户端 → VPN TUN → Hev → Xray 26.6.1 → 用户服务器 → HTTPS 测试站点。界面结果、匹配本次 runId 的 HTTP 成功日志、Xray 双向计数增量及资源清理共同作为验收条件。

| 检查 | 结果 / runId |
| --- | --- |
| 原生检测器正向与故障样例 | `1788835547480`；正常样例 32 次通过，故意破坏 x25 的样例准确得到 mask 64 |
| Go 1.26 运行时基础 | `1788835553337`；4 原生线程、32 次调用，分配/栈增长/GC/C 回调及被检查寄存器均通过 |
| TUN → Hev → Xray 本机闭环 | `1788836147477`；HTTP 标记匹配，测试服务收到 1 次请求 |
| 第一次真实节点 HTTPS | `1788836177464`；上行增量 3075、下行增量 3838 字节 |
| 拒绝 socket 保护故障注入 | `1788836233458`；5 次拒绝、成功 0、测试服务请求 0、活动请求 0 |
| 故障后的真实节点恢复 | `1788836250853`；上行增量 3268、下行增量 3749 字节 |

两次真实节点测试均记录：REALITY rejected=0、serverRecaptures=0、证书错误 0、socket 保护 1/1 成功、active=0。停止后 Hev、Xray、TUN FD 和 VPN 网络均释放，扩展进程销毁。Go 时间与 ArkTS 时间差为 0 ms。

设备证据位于 `build/device-tests/20260907-225544-Xray.log`、`20260907-225611-Node.log`、`20260907-225712-RejectProtection.log`、`20260907-225729-Node.log`。运行时检测器记录在 `build/runtime-smoke/`。

## 故障原因和修复

通过用户授权的 Chrome 面板确认，服务端运行 Xray 26.7.28，REALITY `minClientVer` 留空。这个版本将空值解释为默认最低 **26.3.27**，旧手机核心 25.8.3 因此被拒绝。Windows 的 26.6.1 能通过该门槛。[固定版本源码](https://github.com/XTLS/Xray-core/blob/v26.7.28/infra/conf/transport_security.go#L100-L116)

服务端保持原配置。客户端升级为真实 Xray 26.6.1，没有只改版本号伪装，也没有关闭 TLS 验证。较早失败的 uTLS 单项回移候选没有集成；它仍报告 25.8.3，无法满足服务端门槛。完整定位记录见[核心兼容性对照](phase4-core-compatibility.md)。

## 构建来源

- libXray：`1a6c2baedcf102053c1117ea08b3510d6dada895`。
- Xray-core：`94ffd50060f1cfd5d7482ec90a23a92bdefdff68`，实际版本 26.6.1。
- Go 基线：`3cc00d9c2b8ac231a5432ececa784814cc1eb075` / Go 1.26.7；在隔离源码中移植了 OHOS 支持。
- Go 移植保留新版 GC/链接逻辑，并修复 TLS_GD 的 R25 保存及早期 GODEBUG 读取的分配时机；不是把 Linux/Android 产物改名为 OHOS。
- 新核心保留逐 socket 保护和 controller 错误传播补丁。上游已修复 JSON 重复 Start，因此不再应用旧版启动补丁。
- 8 个 C ABI 导出、AArch64、PT_TLS、TLSDESC、无 initial-exec TLS 重定位均检查通过；4 个允许/拒绝合成测试通过，未修复核心的两个负向对照检出原问题；42 项链接模块的许可证已保留。

当前源库 `libxray.so` SHA256：`ee74757daaa2679da0363704c87ecc8cac0fc2b4aa04008026de0baa6820046f`，35,235,832 字节。

SDK 打包时去除了非加载信息，HAP 内库 SHA256 为 `9cb19b2de4054bbff9e3ce0ea55563d2959ee3e6b54b068b5136873c18153f5c`。已逐项核对全部 30 个 SHF_ALLOC 节的类型、地址、大小和字节内容，均与源库一致；最小 Go 检测库也通过同样核对。证据为 `build/device-tests/phase5-native-loadable-sections.json`。

升级后的离线回归：ArkTS 解析器 46/46、真实 Xray 26.6.1 配置加载 12/12；后者仅调用 `core.LoadConfig`，没有启动核心或网络实例。

已安装签名 HAP SHA256：`23647ffad4afa7291ea0be30567fbfde0f5507b65e928f5e9db419aa4775b11a`，39,596,353 字节，已在 `build/artifacts/versioned/0.5.0/` 归档。

## 验证范围

当前仍是**只作用于本应用的 IPv4 短时测试**，单轮最长约 30 秒。尚未验证其他应用的全局代理、DNS、IPv6、UDP 节点业务、长时间后台运行、网络切换或高并发。这里的成功不等于已经完整复刻 v2rayNG，也不代表新 Go 移植已完成广泛运行时回归。

下一阶段应基于这个已通过的转发基础扩展客户端功能，并单独验收上述能力。
