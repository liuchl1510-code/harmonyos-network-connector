# 首次访问性能：0.25.0 基线与 0.25.1 HTTP 复用验证

2026-09-26。**C1 已完成：0.25.0/code46，API26／ARM64 鸿蒙手机，12 个会话全部完成并确认清理。** 当前脱敏矩阵汇总包含 24 份测量回执、40 个样本，全部通过：8 个 DNS 会话产生 16 份回执／32 个样本，4 个独立 HTTPS-first 会话产生 8 份回执／8 个样本。这个计数只包括矩阵，不合并其他阶段的探测。

**C2 已完成：0.25.1/code47，另建 4 个 keepalive 会话，4 份测量回执／8 个 GET 样本，全部通过并确认正常清理。** 两批合计 16 个会话、28 份测量回执、48 个样本；C1 是原有 `Connection: close` 基线，C2 是新增固定调试目标的复用验证，下面分别列出结果。

本轮自动化没有切换 WLAN 或移动数据，仅覆盖本应用流量；电脑网络保持原状。节点和代理解析器固定，临时策略不写回用户偏好，每个会话均核对正常停止、两次独立清理读回及服务进程消失。7 份用户文件保持一致。测试完成时变更尚未推送；源码与本文随后纳入公开提交，原始本机证据仍保持私有。

## C1：0.25.0 实验口径

两种模式分别为原有全局／代理 DNS（下表称 global）和临时白名单／DNS 分流（称 split）。split 使用固定 `baseline` 调试描述符，未注入 HTTP 404 或超时。两种模式使用同一条节点和代理 DoH；没有为了测试保存新设置。

- DNS 队列包含 Google→Cloudflare 和 Cloudflare→Google 两种顺序；每种顺序、模式重复 2 次，模式执行先后在轮次间交叉。每个目标均测量 `first` 和紧接的 `repeat`。
- DNS 查询直接向 VPN 虚拟 DNS 发送固定 A 查询，避开 OS DNS 查询缓存。`first` 表示该目标在新核心会话中的首次显式探测，`repeat` 表示同目标再次查询。
- HTTPS-first 使用另外 4 个会话，每模式 2 次。会话内首个测量直接请求固定 Cloudflare HTTPS 目标，随后再执行第二次 GET，避免先执行 DNS 测量预热该目标。
- 每个会话启动后固定等待 750 ms。首个目标前的核心日志中，代理和直连上游查询计数均为 0。原有全局测试的保护上限为 90 秒，split baseline 为 5 分钟；测量结束即正常断开，没有以时限自动停止代替成功清理。
- 回执逐项绑定同一会话、服务身份、重连计数、有效模式和故障描述符。汇总保留失败的分母；身份、顺序或清理不完整时不能标记矩阵完成。本次没有失败或无效轮次。

这里的“冷”限于新 VPN 核心；没有清空 OS、SDK、TLS 会话或上游解析器缓存。

## C1：DNS 顺序交叉结果

下表均为毫秒；每格 `n=2`，括号内为两次测量的最小值和最大值。新增 DoH dispatch 为这两个目标测量区间的合计。

| 模式 | 查询顺序 | 目标位置 | 目标 | first 中位数（范围） | repeat 中位数（范围） | 新增 DoH dispatch |
| --- | --- | --- | --- | ---: | ---: | ---: |
| global | Google→Cloudflare | 1 | Google | 733（725–741） | 43.5（33–54） | 2 |
| global | Google→Cloudflare | 2 | Cloudflare | 192（186–198） | 12.5（12–13） | 0 |
| global | Cloudflare→Google | 1 | Cloudflare | 766.5（765–768） | 23（21–25） | 2 |
| global | Cloudflare→Google | 2 | Google | 185.5（182–189） | 14（14–14） | 0 |
| split | Google→Cloudflare | 1 | Google | 777（761–793） | 25.5（24–27） | 2 |
| split | Google→Cloudflare | 2 | Cloudflare | 742.5（736–749） | 24.5（23–26） | 2 |
| split | Cloudflare→Google | 1 | Cloudflare | 788（750–826） | 28.5（27–30） | 2 |
| split | Cloudflare→Google | 2 | Google | 712（678–746） | 25（23–27） | 2 |

global 的较慢 `first` 随首目标的位置移动：Google 和 Cloudflare 先测时均约 0.73–0.77 秒，放在第二位则约 0.18–0.20 秒。第二个不同域名仍各有一次上游查询，但没有新增 DoH dispatch。split 两个目标的 `first` 均约 0.68–0.83 秒，并分别产生新的 DoH dispatch。

固定核心源码为每个 DNS 配置项创建独立的 `DoHNameServer`、缓存控制器、`http.Client` 和 `http2.Transport`。global 只有一个代理解析器项；split 的 Google 项与 catchall 项虽使用同一代理 DoH URL、同一代理标签，仍各有独立 HTTP2 池。顺序交叉结果与该实现一致，支持“split 为第二个解析器池增加一次建立路径开销”的解释。对应第二位置，split 减 global 的成对 first 差值为 496–557 ms。

上述日志能确认上游查询尝试和新增路由 dispatch 尝试；没有物理连接 ID 或 HTTP2 连接追踪，因此不把 dispatch 次数写成精确的 TLS 连接数量。global 第二目标的成功查询且没有新增 dispatch，支持已有 DoH 通道被复用；仅凭耗时不能独立证明这一点。

每个 DNS 目标的 first/repeat 区间均只有一次上游查询，repeat 为 12–54 ms，与核心缓存命中一致。当前 info 日志没有显式 cache-HIT 回执，repeat 的加速也不能作为 DoH 连接复用的直接证据。

## C1：独立 HTTPS-first 结果

每模式、每次 GET 均 `n=2`。这里的请求是原有 `https-cloudflare` 目标：HTTP/1.1、禁用响应缓存、`Connection: close`，每次创建独立请求对象并在结束时销毁。

| 模式 | 第一次 GET 中位数（范围），ms | 第二次 GET 中位数（范围），ms | SDK 连接复用回执 |
| --- | ---: | ---: | --- |
| global | 1513（1473–1553） | 769（747–791） | 4 次均为 false |
| split | 1567（1537–1597） | 798（760–836） | 4 次均为 false |

两模式第一次 HTTPS 的量级相近，成对 split 减 global 为 −16 ms 和 +124 ms。这个小样本没有显示稳定的模式差异。第二次 GET 均明显变快，但 SDK 明确报告 8 次请求全部使用新连接，所以不能把第二次 GET 称为目标网站 HTTP 连接复用效果。

SDK 的 `performanceTiming` 按从请求起点到各事件的累计里程碑读取，不能将 DNS、TCP、TLS 和接收字段相加。下面只列独立中位数，不把它们转换为互斥阶段耗时。

| 模式／GET | DNS 里程碑，ms | TCP 里程碑，ms | TLS 里程碑，ms | 总耗时里程碑，ms |
| --- | ---: | ---: | ---: | ---: |
| global／1 | 735.455 | 736.781 | 1288.752 | 1511.993 |
| global／2 | 0.430 | 1.242 | 558.001 | 768.426 |
| split／1 | 755.128 | 756.634 | 1307.378 | 1566.356 |
| split／2 | 0.409 | 1.250 | 544.073 | 797.618 |

第二次 GET 的 DNS 里程碑接近 0，与已预热的解析路径一致；仅靠现有回执不能区分 OS DNS 缓存和核心 DNS 缓存分别贡献多少。TLS 会话缓存也未清空。请求经 SDK、TUN、Hev 和核心转发，TCP 里程碑可能首先反映本地转发路径的建连，因此这些数字不是纯节点 RTT、直接到网站的 RTT 或节点握手分解。

## C2：0.25.1 HTTP keepalive 实测

0.25.1 新增固定 `https-cloudflare-keepalive` 调试目标。每个 GET 使用自己的 `HttpRequest` 实例，请求保持连接，在一份测量回执中记录 `first-get` 和 `repeat-get`；实际是否复用由 SDK 的 `connectionExtraInfo.isReusedConnection` 判断。

4 个新会话按第一轮 global→split、第二轮 split→global 交叉执行；每模式 `n=2`。仍为手机上的本应用验证，同一节点、同一固定 Cloudflare 目标，split 使用正常 `baseline` 描述符，没有物理网络切换或偏好写回。

| 模式 | 轮次 | first-get，ms | repeat-get，ms | SDK 首次／再次复用回执 |
| --- | --- | ---: | ---: | --- |
| global | 1 | 1554 | 184 | false／true |
| split | 1 | 1609 | 193 | false／true |
| split | 2 | 1632 | 193 | false／true |
| global | 2 | 1566 | 196 | false／true |

global 的首次／再次 GET 中位数为 1560／190 ms；split 为 1620.5／193 ms。4 个首次 GET 全部报告未复用，4 个再次 GET 全部报告实际复用。所有响应均为 HTTP 200，验证后的响应体为 217–222 字节；每个会话均完成正常清理，并确认 7 份用户文件保持一致。

再次 GET 的 SDK TCP 和 TLS 里程碑均为 0，DNS 里程碑为 0.226–0.334 ms。这些累计字段与 SDK 的实际复用标志一致，支持该固定目标在两个独立请求实例之间复用了已有目标 HTTPS 连接。该结果比仅观察“第二次更快”提供了更直接的连接复用证据。

C2 首次 GET 仍为 1.55–1.63 秒。它验证的是新增调试目标的连接复用路径；没有优化 DoH 核心、重跑 C1 的 DNS 矩阵，或改变日常连接行为，不能据此声称 0.25.1 提升了核心首次访问性能。C1 的第二次 GET 使用 `Connection: close`，C2 使用 keepalive，且运行版本、批次不同；两批耗时不能直接当作受控的核心优化前后收益。

## 结论边界与复核输入

C1 在固定手机、节点、解析器和网络环境下，复现了 global 首查询建立路径与 split 两个独立解析器池的差异，并给出独立 HTTPS-first 对照。C2 在固定 Cloudflare 目标上获得了 4 次 SDK 明确报告的再次请求复用，并完成会话清理。

两批都没有测量 Google HTTPS、其他节点、长时间稳定性、多网络切换或整机首次冷启动。DNS 每个模式／顺序／目标位置仅 2 次，C1 HTTPS-first 和 C2 keepalive 各自每模式仅 2 个会话；中位数和成对差值用于定位机制，不构成总体性能或统计显著性结论。OS、上游解析器及 SDK／TLS 缓存没有清空。SDK 里程碑是累计事件时间，不能相加，也不能作为绕过 Hev／TUN 的纯节点 RTT。

本机脱敏复核输入为 ignored 的 `build/phase32-phone/summary.json`（C1）、`build/phase32-phone/keepalive-completion.json`（C2）和 `build/phase32-phone/completion.json`（最终核对）。前者包括固定矩阵身份校验结果、逐目标脱敏时长、上游查询／dispatch 计数及配对差值；C2 输入包含 4 个完成会话的两次 GET 时长、SDK 里程碑和复用标志。最终核对逐一读取 16 个不同会话的收据和清理记录，再独立检查最后的停止命令、两次服务进程消失、首页“连接”按钮及 7 份用户文件按字节一致。这些本机产物不随 Git 发布；原始核心日志和含身份字段的回执保持私有。

0.25.1 的 35 项 SDK 转译方法测试与汇总器 30 项纯数据断言通过；ARM64 签名包通过 13 项核验，132 个构建源输入与安装后源码一致。C1 的 0.25.0 包 SHA-256 为 `6916adc71cc5902e5fab504da0f42dac0d880f121273040e23772f34be503622`；C2 的 0.25.1 包为 `7c6abeb6673138dceaead6c08e994c47da202ddabf388a799732810c45caaa14`。C2 覆盖安装至手机，最后正常断开；没有重编译上游原生库或产出本版本的模拟器预览包。

## Go HTTP2 共池仍为候选

Go 核心的 HTTP2 共池也是待评估方案，尚未启用。即使 URL 相同，也必须先限定路由、标签、dispatcher、TLS 和传输参数的等价条件，保持 DNS 缓存及失败／取消隔离。固定核心当前 `DNS.Close()` 直接返回 nil；在引入共享池前，必须明确池的会话归属、引用和关闭顺序，验证停止后无遗留连接、取消不影响其他查询、重连不复用旧会话资源。生命周期门禁通过前不能直接启用共池优化。
