# 持续连接、代理 DNS 与 IPv6 阻断阶段验证

记录日期：2026-09-08。设备：华为 Pura 80 Ultra / HarmonyOS 7 / API 26。最终候选为 **0.6.8，versionCode 23**；转发核心为真实 Xray 26.6.1。下文区分 0.6.4 的锁屏验证和 0.6.8 的 CPU 修复后回归；不会把不同构建的测试混为同一轮。核心来源及上一阶段验证见[阶段五](phase5-real-node-verification.md)，最终机器记录见[phase6-verification.json](../build/device-tests/phase6-verification.json)。

**0.6.8 已验证全设备模式下的 DNS/HTTPS、华为浏览器出口一致、IPv6 捕获后阻断、桌面后台 146.3 秒后返回继续联网及手动停止清理。** 0.6.4 另通过一次锁屏恢复。已修复 0.6.3 的授权观察器回收卡死，以及 Hev 可写事件空转；最终 8 秒 CPU 采样为一个核心的约 2.5%。这些短时结果不构成长时间稳定性或续航结论。

## 已实现的连接能力

- Home 提供连接、断开、状态、流量和检查入口。普通 `connection` 不设置 90 秒自动停止；`connection-test` 和 `connection-app-test` 在核心启动成功后设置 90 秒停止计时，允许提前手动停止。
- 全设备模式省略应用白名单；应用验证模式仅选择本应用。系统 VPN 配置包含 IPv4 默认路由和虚拟 DNS，DNS 经代理处理；IPv4 模式的 AAAA 答复策略单独检查。
- IPv6 显式配置地址和默认路由，流量进入 TUN → Hev → Xray 后由黑洞出站拒绝。**这是 IPv6 捕获与阻断，不是 IPv6 代理。**
- UI 的停止命令与服务心跳写入不同文件。会话用 `runId` 区分，界面等待销毁与清理回执；服务 PID 已确认不存在时允许恢复连接，但不伪造清理成功回执。不同 UI 进程使用不同 owner epoch，避免将旧进程的持久化记录当成当前连接。
- 页面隐藏或消失只停止界面轮询，不自动停止 VPN。连接通知有返回应用入口、会话标签和 90 秒过期时间；服务更新通知，停止或迟到发布时清理该会话通知。通知权限拒绝与 VPN 授权分开处理。
- 0.6.4 在 UI 进程内强引用一个原生 VPN 授权观察器，只注册一次原生回调；Home 和 Index 使用独立 ArkTS 订阅。页面消失只删除自己的订阅，返回前台只恢复轮询，避免反复创建和回收 SDK observer。

相关实现：[Home](../entry/src/main/ets/pages/Home.ets)、[ConnectionControl](../entry/src/main/ets/model/ConnectionControl.ets)、[ConnectionNotification](../entry/src/main/ets/model/ConnectionNotification.ets)、[VpnAuthorization](../entry/src/main/ets/model/VpnAuthorization.ets)、[VpnProbeAbility](../entry/src/main/ets/vpn/VpnProbeAbility.ets)。上面的生命周期行为有合成回归支持；系统后台调度和通知实际表现应分别以真机记录判断。

## 真机记录

电脑证据文件名采用本机时区；手机日志显示设备当地时间。应以同一个 `runId` 关联记录，不直接比较两种显示时间。

| 检查 | 0.6.2 本应用验证 | 0.6.3 全设备验证 |
| --- | --- | --- |
| runId | `1788855884493` | `1788856077656` |
| 模式 | `connection-app-test` | `connection-test` |
| DNS A / AAAA 策略 | 通过 | 通过 |
| 域名 HTTPS | 通过，响应 219 字节 | 通过，响应 219 字节 |
| IPv6 UDP | 未收到响应，`reply=false` | 未收到响应，`reply=false` |
| IPv6 字面 HTTPS | 请求失败 | 请求失败 |
| IPv6 黑洞命中 | 后续界面快照为 2 | 界面快照为 2 |
| 节点上行 / 下行增量 | 10,142 / 10,371 字节 | 173,111 / 549,353 字节 |
| socket 保护 | 2/2 成功；失败、超时、active 均为 0 | 43/43 成功；失败、超时、active 均为 0 |
| 停止 | `cleanup=true`，扩展销毁 | `cleanup=true`，扩展销毁 |

IPv6 结论同时依据无有效响应与本次核心黑洞命中；单独的 HTTP 错误或超时不足以证明没有绕过。0.6.2 的第一张 IPv6 快照为 1，随后的检查快照已为 2，反映心跳采样时间差。

0.6.3 全设备这一轮还记录华为浏览器 `HuaweiBrowser/6.1.7.302` HTTPS 成功。将浏览器与应用的出口值按同一 runId 转成标记后，`exitMatches=true`；文档不保存出口地址。该观察支持另一应用的请求使用了相同出口，不代表已经逐一验证所有应用或全部业务协议。停止前记录 `serverRecaptures=0`、`realityRejected=0`、`certErrors=0`，随后依次确认 Hev、Xray 停止、TUN FD 关闭、VPN 网络销毁及扩展销毁。

本轮证据：

- 0.6.2：[IPv6 日志](../build/connection-tests/20260908-042446-Ipv6.log)、[检查日志](../build/connection-tests/20260908-042530-Check.log)、[黑洞计数快照](../build/connection-tests/20260908-042530-Check-layout.json)、[停止日志](../build/connection-tests/20260908-042535-Stop.log)。
- 0.6.3：[启动日志](../build/connection-tests/20260908-042755-StartGlobal.log)、[IPv6 日志](../build/connection-tests/20260908-042759-Ipv6.log)、[黑洞计数快照](../build/connection-tests/20260908-042759-Ipv6-layout.json)、[检查日志](../build/connection-tests/20260908-042810-Check.log)、[浏览器比对记录](../build/connection-tests/browser-exit-verification.json)、[停止日志](../build/connection-tests/20260908-042906-Stop.log)。

## IPv6 绕过的修复与归因边界

**0.6.0 / 0.6.1 存在 IPv6 绕过，不能使用旧版本作为当前连接版本。** 旧实验中 IPv6 UDP 收到了合法事务 ID 对应的回复，而该次核心没有相应转发与保护请求。0.6.1 的应用与全设备实验均记录 `reply=true`，见 [应用实验](../build/connection-tests/20260908-041216-Stop.log) 和 [全设备实验](../build/connection-tests/20260908-041747-Stop.log)。只配置 IPv4、关闭 DNS AAAA，或者单独观察 IPv6 HTTPS 失败，都不能排除这种绕过。

0.6.2 参考已合并的 [ClashBox PR #147](https://github.com/xiaobaigroup/ClashBox/pull/147)，将 IPv6 参数调整为以下组合；0.6.3 和 0.6.4 沿用：

| 参数 | 修复后的值 |
| --- | --- |
| 第二个 TUN 地址 | `fdfe:dcba:9876::1`，family `2`，port `0`，prefixLength `126` |
| IPv6 默认路由目的地 | `::`，family `2`，port `0`，prefixLength `0` |
| route.interface | `vpn-tun` |
| gateway | `fe80::`，family `2`，port `0` |
| 路由标志 | `hasGateway:false`，`isDefaultRoute:true` |
| VPN 接受标志 | `isIPv6Accepted:true` |

ClashBox 固定提交为 `25cf9ddcb43e557ec7994f82621d3aaaa881423b`：[地址和路由构造](https://github.com/xiaobaigroup/ClashBox/blob/25cf9ddcb43e557ec7994f82621d3aaaa881423b/proxy_core/src/main/ets/rpc/CommonVpnService.ts#L119)、[配置生成](https://github.com/xiaobaigroup/ClashBox/blob/25cf9ddcb43e557ec7994f82621d3aaaa881423b/proxy_core/src/main/ets/rpc/FlClashVpnService.ts#L104)。这些是系统 VPN 捕获参数，不能用核心的 DNS/出站 IPv6 开关代替。

**有效字段的单独归因仍未知。** 本轮一起调整了地址/前缀、interface、gateway 和 port，没有逐项 A/B。TUN 名称查询返回 `tun-name-unavailable`，因此没有得到该手机实际接口地址或路由表的独立快照；不能把公开 OpenHarmony 的 Linux 实现直接当作商业 HarmonyOS 7 的运行证明。当前证明来自修改后流量进入本次核心并命中黑洞的真机对照。

## 生命周期合成回归

[test-connection-session.cjs](../scripts/test-connection-session.cjs) 抽取并转译实际 ArkTS 方法，使用合成 SDK、内存文件、可控 Promise 和定时器，当前 **29/29 通过**。涵盖独立停止命令、部分写入、创建期间取消、销毁与清理回执、旧会话覆盖防护、90 秒计时、页面隐藏、PID 恢复、通知迟到、检查回执竞态及授权订阅生命周期。源文件哈希保存在[通过报告](../build/connection-session-verification.json)。

复核发现原 21 项未模拟新增 `probeIpv6Datagram`，其 ReferenceError 被业务 catch 捕获，遗漏了真实 UDP 路径。补齐该依赖后增加 4 项：旧 UDP 回复不得覆盖新会话；断开后迟到 UDP 超时、DNS 成功和 UDP 异常不得继续发 HTTP。0.6.3 在 UDP await 后及发 HTTP 前增加 runId/phase 检查。

为证明测试能够检出原问题，只在测试进程内移除这两个 guard；磁盘生产源码保持不变。负对照结果是原 21 项仍通过、新增 **4 项按预期失败**，见[负对照报告](../build/connection-session-negative-control.json)。这些结果不替代系统 IPC、设备后台调度、真实通知或长时间运行验证。

0.6.4 又增加 4 项真实模块回归：Home 20 轮 appear/hide/show 不累积 observer 或轮询；Home 取消订阅后 Index 仍接收授权；两个订阅独立取消且不重复派发；最后一个订阅移除后重新订阅仍复用原生 observer。检查到 create/on/off 次数为 1/1/0。**mock 不执行 SDK finalizer、原生锁或 Ark GC，29 项通过不等于证明系统 ANR 已被彻底修复。**

本地复现命令（无节点、手机或联网请求）：

```powershell
& 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' .\scripts\test-connection-session.cjs
```

## 0.6.3 后台返回 ANR 与 0.6.4 修复

0.6.3 持续连接 `1788856173660` 初次 DNS/HTTPS 成功，但退到后台后返回前台失败。故障记录 `10934826136712072443` 表明：UI 进程 55172 的主线程自手机时间 `16:29:43` 起阻塞于 `uv_io_cb`；`16:31:20` 开始的前台生命周期未在 5 秒内完成，系统记录 `LIFECYCLE_TIMEOUT` 并终止 UI/VPN。本轮属于 ANR，不能解释成普通后台省电回收，更不能作为后台测试通过。见[脱敏故障栈](../build/connection-tests/0.6.3-observer-finalizer-freeze.txt)及[后台中断日志](../build/connection-tests/background-interruption.log)。

故障栈显示 `CreateVpnObserver` 的 NAPI finalizer → `EventManager::DeleteAllListener` → mutex 等待。旧 Home 返回前台会再次执行 `aboutToAppear` 并创建新 observer，旧对象随后可被 GC；Index 也独立创建 observer。0.6.4 改为进程级强引用单例和页面订阅，避免这条正常页面流转中的重复创建/回收路径。

公开源码审核与实机栈必须区分：所查固定 OpenHarmony 两仓版本中，[NewInstance](https://github.com/openharmony/communication_netmanager_base/blob/21f40be371a18ba897dc23c10f94c23548f8ee46/utils/napi_utils/src/module_template.cpp#L175) 每次创建 EventManager 并包装 `shared_ptr<EventManager>*`，而 [CreateVpnObserver finalizer](https://github.com/openharmony/communication_netmanager_ext/blob/e82c251752deda336c33e3208b8d06dd7da680f1/frameworks/js/napi/vpnext/src/vpn_module_ext.cpp#L430) 将参数当作 `VpnObserverInstance*`。这组源码存在析构参数类型不一致；没有据此确认商业固件的逐字节实现，也没有证实其内部一定是 singletonEventManager 共享锁问题。当前修复针对可观察的 GC 触发路径，仍需继续真机回归。

## 0.6.4 持续连接：后台返回、锁屏恢复与停止

本轮 runId 为 `1788856563364`，模式 `connection`。启动后 IPv6 UDP `reply=false`、IPv6 字面 HTTPS 失败，黑洞计数为 2；DNS A/AAAA 策略及域名 HTTPS 成功。华为浏览器与应用出口标记均为 `d684502e`，`exitMatches=true`。证据：[启动](../build/connection-tests/20260908-043601-Start.log)、[IPv6](../build/connection-tests/20260908-043604-Ipv6.log)、[计数快照](../build/connection-tests/20260908-043615-Check-layout.json)、[DNS/HTTPS](../build/connection-tests/20260908-043615-Check.log)、[浏览器出口比对](../build/connection-tests/1788856563364-browser-exit.json)。

退到桌面 **128.6 秒**后成功返回前台，UI PID `61535` 与 VPN PID `61626` 均未重启，同一 runId 在手机时间 `16:39:24.739` 再次完成 DNS/域名 HTTPS 检查。这一轮没有重现先前后台返回 ANR。见[计时与进程记录](../build/connection-tests/1788856563364-background-timing.json)和[返回后检查日志](../build/connection-tests/20260908-043920-Check.log)。该证据只支持本次约两分钟后台返回，不代表已验证更长时间或耗电表现。

随后开始锁屏观察；手机时间 `16:39:59` 的 `aa start` 明确返回 `10106102 screen locked`，确认已锁屏。从发出锁屏请求到用户回复已解锁为 **79.7 秒**；这个数包含操作与确认延迟，**不是精确的实际锁屏时长**。恢复后 UI/VPN 进程未重启，同一 runId 在 `16:40:50.594` 再次完成 DNS/域名 HTTPS，所查故障记录未见新增。这证明本次锁屏后恢复检查通过，不等于验证了锁屏期间连续业务流量或长期锁屏稳定性。见[解锁后检查日志](../build/connection-tests/20260908-044046-Check.log)及前述计时记录。

`16:41:34.618` 手动停止后记录 `cleanup=true`，节点上行/下行增量为 **568,811 / 520,278 字节**；socket 保护 **121/121** 成功，失败、超时和 active 均为 0。日志同时确认 Hev、Xray 停止、TUN FD 关闭、VPN 网络销毁及扩展销毁。见[本轮停止日志](../build/connection-tests/20260908-044132-Stop.log)。

| 本轮项目 | 状态 |
| --- | --- |
| 退到桌面后返回 | 128.6 秒；返回成功，UI/VPN 进程未重启 |
| 返回后同 runId DNS/HTTPS | 通过，手机时间 `16:39:24.739` |
| 锁屏状态 | 已由 `10106102 screen locked` 确认 |
| 锁屏请求至用户解锁确认 | 79.7 秒；非精确实际锁屏时长 |
| 解锁后同 runId DNS/HTTPS | 通过，手机时间 `16:40:50.594`；进程未重启，所查故障记录无新增 |
| 手动停止、保护统计与清理回执 | `cleanup=true`；保护 121/121 成功，active=0；扩展销毁 |
| 本轮判定 | 后台返回、一次锁屏恢复和停止清理通过；CPU/耗电与长期稳定性仍未验收 |

## 0.6.8：可写事件空转修复与最终回归

0.6.5 的 [hiperf 采样](../build/connection-tests/0.6.5-cpu-report.txt) 将热点定位到命名后的 `harmony-hev` 线程。诊断库仅累计原子计数，不保存 FD、地址或数据包内容。0.6.6 在约 19 秒中调用 epoll 2,763,011 次，几乎每次立即就绪，读取仅 37 次且无非 EAGAIN 错误；0.6.7 的新增位计数确认主导事件为 OUT，而不是读失败、ERR 或 HUP。

独立本地 socket 控制不使用节点，也不访问外网。每组依次执行两次 wait、一次空 recv、再两次 wait；setupError 与 waitErrors 均为 0，空 recv errno 为 11：

| 控制 | 四次返回数量 | 非空掩码 |
| --- | --- | --- |
| Unix socketpair / ET | 1, 0, 0, 0 | OUT |
| Unix socketpair / LT | 1, 1, 1, 1 | OUT |
| IPv4 UDP / ET | 1, 0, 0, 0 | OUT |
| IPv4 TCP loopback / ET | 1, 0, 1, 0 | OUT |

因此在本机固件上，TCP 空读后会重新报告 OUT；不能泛称 ET 完全无效，也没有测试发送缓冲区填满后的全部平台语义。Hev 原先持续监听 OUT，空读后可重复被唤醒。修复使 TCP 根据待发送队列和接收容量监听 OUT/IN，UDP 无待发送帧时撤销 OUT，关联 TCP 保留 IN 检查关闭。仅在掩码改变时更新注册，未加 sleep；lwIP 的收包和 ACK 回调负责唤醒等待的任务。具体补丁、源码哈希与复现见 [Hev 说明](../native/hev/README.md) 和 [局部证据](../native/hev/io-interest-verification.json)。独立只读审查未发现阻塞性缺陷；满缓冲压力和系统调用失败注入尚未完成。

0.6.8 应用范围 run `1788858208882` 的约 19 秒检查中，epoll 调用为 464 次，DNS/HTTPS 和清理通过。[停止日志](../build/connection-tests/20260908-050346-Stop.log)同时记录上述控制结果。调用次数不是 CPU 百分比，两个实验也不是吞吐基准。

最终全设备持续连接 run `1788858278715`：

| 项目 | 结果 |
| --- | --- |
| DNS A / AAAA 策略和域名 HTTPS | 启动、浏览器返回、桌面后台返回后三次均通过 |
| IPv6 | 指定 UDP 请求无回复；初次黑洞计数 2，最终全设备计数 79 |
| 华为浏览器 HTTPS | 与应用内出口标记均为 `7a5b871f` |
| 后台 | 桌面停留 146.3 秒；UI PID 32443、VPN PID 34743 和 runId 不变 |
| CPU | `hiperf stat` 8 秒，task-clock 201,026,565 ns，`0.025128 cpus used`，即一个核心的约 2.5% |
| 节点流量 | 上行 140,289 / 下行 140,411 字节 |
| socket 保护 | 57/57 成功，失败、超时、停止后 active 均为 0 |
| 停止 | Hev/Xray 停止、TUN FD 关闭、网卡销毁、`cleanup=true` 与扩展销毁 |
| 系统故障 | 未观察到新增 fault；仍只有已记录的 0.6.3 事件 |

证据：[IPv6](../build/connection-tests/20260908-050440-Ipv6.log)、[浏览器出口](../build/connection-tests/1788858278715-browser-exit.json)、[后台时间及恢复](../build/connection-tests/1788858278715-background-timing.json)、[CPU](../build/connection-tests/1788858278715-cpu-stat.txt)、[最终停止](../build/connection-tests/20260908-050836-Stop.log)。0.6.8 未再次要求用户锁屏，锁屏结论仍明确归属于 0.6.4；本轮最终设备保留节点并处于未连接状态。

签名 HAP 为 39,802,617 字节，SHA256 `b95c26a69ac0a9153fac097b1bdcba699f5b86072bc8b19eb51b84339a57ea0a`。Hev 源库 SHA256 `c774d64188cbef76b3dfb56db9792fc36ebbb68a8c38861236beddf1eb9d2875`；Xray 源库仍为 `ee74757daaa2679da0363704c87ecc8cac0fc2b4aa04008026de0baa6820046f`。

## 验证范围

当前证明限于上述设备、网络和短时请求。**CPU 空转修复已经过一次短时 CPU 采样，尚未测量电池续航。** 尚不承诺 kill-switch、划掉或强停应用后保活、所有 UDP 协议、网络切换、长时间稳定性或所有应用兼容性。IPv6 业务当前被拒绝，不提供 IPv6 出口。页面隐藏不自动停止是应用实现行为；系统是否保留进程和 VPN 生命周期仍受平台管理，不能据此承诺强停后继续连接。
