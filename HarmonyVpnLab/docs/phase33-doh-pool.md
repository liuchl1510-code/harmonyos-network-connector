# 0.26.0：DNS 实例内的 DoH HTTP2 共池

2026-09-26。**0.26.0/code48 已完成实现、离线验证、ARM64 构建及 17 个不同手机会话的验收：12 个矩阵会话、4 个 keepalive 会话及 1 个原策略日常会话。28 份 benchmark 回执／48 个样本全部通过，17 个会话均确认正常清理。** Xray 上游版本仍为固定 26.6.1。使用 phase32 原节点与策略；最终两次核对的 7 份用户文件均按字节保持一致。手机 VPN 已断开，首页“连接”按钮可用，最终命令为 stop。全程没有切换 WLAN／移动数据或操作鸿蒙电脑设备。测试完成时尚未推送；源码与本文随后纳入公开提交。

## 问题与改动范围

[phase32](phase32-first-access.md) 的 0.25.0 基线使用相同节点、解析器和交叉目标顺序：global 第二个不同域名查询没有新增 DoH dispatch，first 为 182–198 ms；split 的 Google 与 catchall 项各有独立 HTTP2 池，第二位置 first 为 678–749 ms，并分别新增 dispatch。这是固定手机与网络的小样本机制证据，不能代替本次补丁的运行结果。

本次在一个 DNS feature／核心实例内，允许等价的远端 DoH 解析器共享 HTTP2 transport。复用条件是：**普通远端 `https`、完整 URL 完全相同、有效 inbound tag 完全相同**。当前 TLS 策略仍为验证证书与主机名的固定 uTLS／Chrome 策略；未增加跳过验证的配置。未来若 TLS 参数可配置，必须扩展等价键，不能仅沿用 URL 和标签。

- nameserver 对象、DNS 缓存、ECS／client IP、查询策略、请求时限、规则顺序、`skipFallback` 和 `finalQuery` 仍各自保持原有语义；只共享 transport。
- 不同路径、query string 或标签不会共池；不同 DNS／核心实例之间不共享。
- 本地 `https+local` 与远端／本地 h2c 不参与共享，仍归各自实例生命周期管理。
- Hev 的 TUN 所有权、SOCKS 数据面、native C++ 桥接和九个 C ABI 均未改动。

固定上游核心 commit 为 `94ffd50060f1cfd5d7482ec90a23a92bdefdff68`。新增补丁只涉及四个 Go 源文件：

| 文件 | 作用 |
| --- | --- |
| `app/dns/dns.go` | 创建 DNS 实例的 transport scope，初始化失败及 `DNS.Close()` 时关闭 scope |
| `app/dns/nameserver.go` | nameserver 构建后按有效标签加入 scope |
| `app/dns/nameserver_doh.go` | 将远端拨号及请求接入受管 transport，保持原 TLS 校验路径 |
| `app/dns/doh_transport.go` | 等价键、请求取消隔离、连接跟踪和生命周期关闭 |

仓库中的可复核源为 `native/xray26/dns-pool/doh_transport.go`、`manifest.json`、`apply_patch.py` 及 `native/xray26/patches/0002-doh-session-transport-pool.patch`。既有 `0001-socket-controller-fail-closed.patch` 保留。新增补丁 SHA256 为 `78ab62a87df5cea367b3b0566fb8cbdd635da0a218e1019d051377ad7d8cf34b`。

## 生命周期与取消边界

phase32 记录的原始 `DNS.Close()` 空实现已改为关闭本实例 scope。scope 标记关闭后拒绝新 transport 所有权；关闭共享 transport 会取消其请求和仍在读取的响应体，关闭已跟踪的连接，并关闭空闲 HTTP2 连接。

原始连接在 TLS handshake **之前**登记，所以实例关闭可以中断正在进行的握手。迟到的 dispatch／dial 成功结果会被拒绝并关闭；返回 link 同时返回 error、请求在 pending dial 时取消等路径也释放 link 的读写两端。成功建立连接后的 dispatch 上下文归连接生命周期持有，不因最初请求结束而提前取消。

单个请求的取消只影响自己的 stream／dial，不能取消共享池的其他请求。请求上下文的资源直到响应体消费完或关闭后才解除，不能在只收到响应头时提前释放。

`Close()` 执行取消和连接关闭，**不等待所有内部 goroutine 退出**。它不是完整 goroutine-drain 屏障，也不据此承诺任意上游实现都在固定毫秒数内停止。实际核心停止、进程退出和手机网络行为仍须分别验收。

## 离线验证与统计口径

`prepare.py` 将补丁应用于隔离的固定核心副本；`build-candidate.ps1` 已集成公开的 `validation/doh_transport_test.go.template`。不会直接修改共享上游 module cache，也不把主机 fixture 当作手机运行证据。

| 验证 | 已确认结果 | 范围 |
| --- | --- | --- |
| Windows transport fixture | 21 个终端 leaf case 全部通过 | 等价键与隔离、独立缓存、同连接查询、并发取消、响应体关闭、握手中关闭及迟到 link 清理 |
| Windows 真实核心策略验证 | 42 个规则场景、7 个路由断言通过 | 真实 JSON loader、DNS.New、固定 geosite 匹配及 Router.PickRoute，leaf DNS 使用内存替身 |
| 策略负向对照 | 预期失败已触发 | 忽略 `finalQuery` 的错误拼写被 `PROTO_FINAL_QUERY` 检查拒绝；负向报告保持 `passed: false`、`expectedFailure: true` |
| Linux／WSL race fixture | `-race -count=3`，21 leaf × 3 = 63 次通过 | 无失败及 data-race 报告，冻结源码和 fixture 保持一致 |
| 核心源码完整性 | 新副本 991 文件的 manifest 与预期补丁一致 | 原始副本 990 文件；增量恰为三个修改文件和一个新增文件；module integrity verified |

race 的 Go 事件中有 **23 个 subtest 名称，包括 2 个分组**；三轮合计 69 次 subtest PASS。终端 leaf 才是 21 个／63 次，通过数量不得将分组再当成独立案例。最初汇总器误将 23 当成 leaf，产生计数门禁失败；修正仅针对统计口径，原 Go 事件和 fixture 未改变，也没有为修正统计重新运行测试。原失败记录保留。

fixture 的正向 TLS 使用注入的标准验证 TLS 拨号器；另有生产构造器拒绝不可信 TLS 的负向案例。fixture 本身证明测试中的证书验证、连接复用与生命周期行为，不等同于手机生产 uTLS 成功。现在另有下面的实际手机 DNS／HTTPS 矩阵：真实上游 DoH 查询及目标 HTTPS 响应均通过，补上了本次构建的生产 uTLS 成功路径证据；该证据仍限于固定手机、节点、目标及本轮请求。

## 行尾与构建证据修复

首次 Windows 测试沿用旧的策略 fixture，错误地把“同 URL 的 transport 必须不同”当作缓存／标签隔离条件，触发 `CACHE_OR_TRANSPORT_SHARED`。新的公开 pool-policy fixture 分别验证缓存独立与允许的 transport 共享；原失败日志保留，没有把旧测试结果记为通过。

初始 native candidate1 的四文件原始字节使用 CRLF；其 LF 归一化源码哈希与发布补丁相同。Linux race 覆盖的是 candidate1 的冻结 raw-byte 快照，LF 归一化后的功能源码与最终 candidate2-lf 相同，因此不能把它说成最终 LF-only native candidate 的逐字节构建测试。

公开策略 validator 随后发现应用补丁阶段的行尾／源码 manifest 差异。recipe 改为使用 `git -c core.autocrlf=false -c core.eol=lf apply`，在 apply 后明确输出 LF，并用最终文件原始字节 SHA256 门禁验证四文件。最终 native candidate 为 `candidate2-lf`，公开 validator 已通过且只出现预期四文件增量。原失败证据仍保留。

构建证据捕获脚本还曾把 smoke 产物目录记为 `smoke/` 而实际为 `artifacts/smoke/`；修正的是捕获路径。编译器构建和 recipe 检查记录与该失败记录均保留，不将证据脚本的返回码等同于设备 runtime 验证。

## 编译器、native 与 HAP 产物

固定 Go 1.26.7 OpenHarmony ARM64 编译器已重建，125 份 port 源文件哈希及目标支持门禁核对通过，smoke 库已构建并完成 ELF／TLS 静态检查。smoke 报告中的 `runtimeTestsPassed` 仍为 false；foreign pthread、寄存器保存、stack growth 和 GC 等计划不能写作本轮设备通过。

native candidate 通过九个 ABI export、AArch64／TLSDESC、四个 socket-protection 案例、两个原核心预期失败对照及三轮统计实例重启检查；最终依赖完整性为 `all modules verified`。Hev 与预构建 Go-runtime 库本轮未重建；native C++ 源码未修改，但 HAP 标准构建确实按 `entry/src/main/cpp/CMakeLists.txt` 中的 `cxx_std_17` 要求重新编译了 C++17 桥接，保留既有 runtime controls。源码未修改不能写成桥接二进制未重新编译。

| 产物 | 字节数 | SHA256 |
| --- | ---: | --- |
| LF-only ARM64 `libxray.so` | 35271448 | `950b715d7a307b8cb7533002bf98304579ffb5fd075724aca3ccbbfe84fea062` |
| 0.26.0/code48 signed debug HAP | 43931617 | `8735cc6880eef10da592031fbdf7b49e45b1e0f90388242960447413aeaa090e` |

HAP 的 13 项构建／静态产物检查通过，包括版本、ARM64-only、完整核心可用、UI preview 关闭、七份 native 库、输入链与签名。220 项冻结输入包括 **132 项 HAP stage 输入和 88 项独立 native rebuild recipe 输入**；88 项 recipe 仅在源码 checkout 中单独冻结，不能写作 HAP stage 再次编译了 Xray。包装时的 libxray 源、stage、merged 哈希一致。

这是本地签名调试产物，不代表生产发布签名或商店审核通过。

## 源码复核命令与本机证据

以下命令从 `HarmonyVpnLab` 项目根目录执行，使用公开源码及固定 lock。先准备 PowerShell 7、Git、Python 3.12+、DevEco OpenHarmony native SDK 和核验过的 Go 1.26.7 源／模块缓存；native build／cache 目录使用真实 ASCII 路径。命令本身不访问手机或读取用户节点。

```powershell
# 生成固定策略 fixture，再验证补丁后的真实 DNS/router 语义和负向对照。
node .\scripts\test-split-dns-policy.cjs
& .\scripts\validate-split-dns-core.ps1 -DoHTransportPool

# 在单独候选目录构建及核验，输出独立 native 候选和证据。
& .\scripts\build-xray26.ps1 `
  -OutputPath "$PWD\build\doh-pool-candidate\libxray.so" `
  -EvidencePath "$PWD\build\doh-pool-candidate\verification.json"
```

`-DoHTransportPool` 使用 `native/xray26/validation/split_dns_pool_policy_test.go.template`；native recipe 自动执行 `doh_transport_test.go.template`。可用 `-GoRoot`／`-ModuleCache` 或 `-PortRoot`／`-CacheRoot` 指向另一个已核验缓存，工具路径可显式传入。native recipe 需要的固定依赖缺失时会按锁获取，不能把这组命令承诺为完全离线首次构建。

Linux race 需要独立的 Linux Go 1.26.7、核验的模块缓存、隔离核心副本及同一份冻结 fixture；上述 Windows recipe 并不自动执行 Linux race。完成对应准备后，测试目标为 `TestHarmonyDoHTransport`，参数为 `-race -count=3`。本轮运行证据位于本机 ignored 的 `build/phase33-local/race/completion.json` 与原始 Go 事件，不能仅凭命令示例声称复现成功。

其他本机 ignored 复核输入包括 `build/split-dns-pool-core-verification.json`、`build/split-dns-pool-core-negative-control.json`、`build/phase33-local/windows-verification.json`、`build/phase33-native/candidate2-lf/verification.json` 和 `build/phase33-arm64/candidate1-doh-pool/verification.json`。这些本机报告不随 Git 发布；可发布的源码、补丁、锁与 fixture 提供复现入口。

## 已完成手机矩阵

本轮执行 phase32 相同的 8 个 DNS 顺序交叉会话及 4 个独立 HTTPS-first 会话；每模式／目标顺序／目标位置 `n=2`，HTTPS-first 每模式 `n=2`。同一手机、节点、代理解析器及原用户偏好通过 7 份文件的字节一致性核对。测试仅本应用，不切换 WLAN／移动数据，不改变电脑网络，不保存临时策略，也不推送。

12 个会话的首目标之前，上游代理／直连查询均为 0；测量回执与会话、服务身份、重连计数、有效策略及 split baseline 描述符一致。24 份回执包含 32 个 DNS first/repeat 样本和 8 个 HTTPS GET 样本，全部通过，无失败或无效轮次。每轮停止和服务进程消失均确认，7 份用户文件保持一致。本机脱敏复核输入为 `build/phase33-phone/summary.json`，该 ignored 文件不随 Git 发布。

### DNS：第二类别没有新增 dispatch

下表每行两次 first/repeat；单位 ms，括号内为范围。新增 DoH dispatch 是两个测量区间的合计，每行上游目标查询数均为 2（每次 first/repeat 区间各 1 次）。

| 模式 | 顺序 | 目标位置／目标 | first 中位数（范围） | repeat 中位数（范围） | 新增 DoH dispatch |
| --- | --- | --- | ---: | ---: | ---: |
| global | Google→Cloudflare | 1／Google | 936（922–950） | 22.5（20–25） | 2 |
| global | Google→Cloudflare | 2／Cloudflare | 225（219–231） | 16.5（15–18） | 0 |
| global | Cloudflare→Google | 1／Cloudflare | 879.5（871–888） | 26（25–27） | 2 |
| global | Cloudflare→Google | 2／Google | 499.5（222–777） | 19（13–25） | 0 |
| split | Google→Cloudflare | 1／Google | 997（901–1093） | 24.5（24–25） | 2 |
| split | Google→Cloudflare | 2／Cloudflare | 221（220–222） | 14（14–14） | 0 |
| split | Cloudflare→Google | 1／Cloudflare | 976.5（909–1044） | 21（17–25） | 2 |
| split | Cloudflare→Google | 2／Google | 225.5（220–231） | 13（13–13） | 0 |

split 第二类别的两次 Cloudflare first 为 220／222 ms，Google first 为 231／220 ms，均没有新增 DoH dispatch。它们仍各自有一次真实上游查询，因此不能把第二类别的改善解释为该目标已在核心 DNS 缓存中命中。这个行为与实例内同 URL／同标签 transport 共池一致，也消除了 phase32 中 split 第二类别额外新增 dispatch 的现象。

global 第二类别同样没有新增 dispatch；其中 Google 的一份 first 为 **777 ms**，另一份为 222 ms。777 ms 样本通过了同样的身份和响应验收，保留在分母及统计中；当前证据没有定位其变慢原因。

相同模式、顺序和目标位置的历史对照为 phase32 0.25.0 基线：split 第二位置 Cloudflare 中位数 742.5 ms、Google 712 ms，本轮分别为 221 ms、225.5 ms；历史每个第二类别 first/repeat 区间新增 1 次 dispatch，本轮为 0。**减少额外 dispatch 的机制证据明确；历史与本轮时长不是紧邻的随机 A/B 收益估计。** 本轮首位置 first 为 871–1093 ms，历史为 725–826 ms，说明批次间基础时延本身已变化，不能承诺冷启动整体加快。

日志提供上游查询和 dispatch 尝试计数，没有物理 TLS 连接 ID；它支持复用机制，不提供精确物理连接数量。repeat 为 13–27 ms，每个区间只有一次上游查询，与独立核心缓存命中一致；没有显式 cache-HIT 回执。缓存／标签隔离性质另以公开离线策略及 transport fixture 为依据，不能仅靠这两个经节点域名的手机时长重申全部隔离性质。

### 独立 HTTPS-first：保持 Connection close

独立会话直接从固定 Cloudflare HTTPS GET 开始，未先执行 DNS 测量。该队列保留 HTTP/1.1、禁用响应缓存及 `Connection: close`；每次 GET 使用独立请求实例，8 次 SDK `isReusedConnection` 均为 false。

| 模式 | 首次 GET 两次值／中位数，ms | 第二次 GET 两次值／中位数，ms |
| --- | ---: | ---: |
| global | 2671、1761／2216 | 785、874／829.5 |
| split | 1828、1772／1800 | 890、971／930.5 |

global 的 **2671 ms** 首次 GET 保留在统计中，其原因尚未定位。第二次 GET 的加速发生在 SDK 报告新连接的条件下，不能称为目标 HTTP 连接复用结果。该队列确认生产 DoH 和固定目标 HTTPS 请求可用，但没有给出稳定的冷启动 HTTPS 性能改善证据。

SDK timing 是从请求起点到各事件的累计里程碑，DNS、TCP、TLS、接收等字段不能相加。实际路径包含 SDK、TUN、Hev 与核心转发，不能把这些值当作纯节点 RTT 或远端 handshake 的互斥分解。OS、解析器及 SDK／TLS 会话缓存未清空；本轮没有测量 Google HTTPS、其他节点、多网络切换或长期稳定性。

## Keepalive 复验

本版本另建 4 个 `https-cloudflare-keepalive` 会话，每模式 `n=2`。每会话一份回执包含两个独立请求实例的 GET，共 4 份回执／8 个样本，全部通过并完成正常清理。使用相同固定 Cloudflare 目标，请求保持连接；它们独立于上面的 `Connection: close` 队列。

| 模式 | 轮次 | 首次 GET，ms | 再次 GET，ms | SDK 首次／再次复用回执 |
| --- | --- | ---: | ---: | --- |
| global | 1 | 1637 | 197 | false／true |
| split | 1 | 1635 | 203 | false／true |
| split | 2 | 3008 | 199 | false／true |
| global | 2 | 1806 | 206 | false／true |

global 的首次／再次 GET 中位数为 1721.5／201.5 ms；split 为 2321.5／201 ms。4 个首次 GET 均报告未复用，4 个再次 GET 均报告实际复用；再次 GET 的 SDK TCP 和 TLS 里程碑均为 0。这个回执确认本版本的固定目标 HTTP 连接复用路径仍可用，197–206 ms 是该路径在本轮的再次请求时长。

split 首次 GET 的 **3008 ms** 样本通过相同身份及响应检查，保留在统计和分母中，原因尚未定位。本队列每模式仅两个会话，且首次与再次请求同时涉及缓存和连接状态改变；它不构成核心冷启动 HTTPS 整体加快的证明，也不等同于生产 uTLS pool 的物理连接追踪。本机脱敏结果在 `build/phase33-phone/keepalive-completion.json`，不随 Git 发布。

## 日常模式与最终状态

最后单独创建 1 个原保存策略的普通日常会话，`probe.kind` 为 `connection`，有效策略为原有 global／proxy DNS，没有继承 split baseline 故障描述符。首页“代理 DNS”及“域名 HTTPS”检查均通过，然后正常断开。这个会话验证普通连接入口及原策略可用，没有测量其他应用行为，也未增加 benchmark 样本。

本轮最终合计为 **17 个不同会话 = 12 个矩阵 + 4 个 keepalive + 1 个普通连接；28 份 benchmark 回执 = 24 + 4；48 个样本 = 40 + 8**。17 个会话分别以各自所属的运行身份确认正常清理，独立读回稳定且各自服务进程两次确认消失。最终两次用户文件核对均保持 7 份文件按字节一致；最终命令为 `stop`，首页显示可用的“连接”按钮，VPN 已断开。

最终本机脱敏完成记录为 `build/phase33-phone/completion.json`；它与矩阵及 keepalive 汇总同属 ignored 文件，不随 Git 发布。源码和本文纳入公开提交，原始本机证据保持私有。已确认的性能机制是 split 第二 DNS 类别减少额外 DoH dispatch；原策略连接、固定目标 HTTPS 及 keepalive 复用均可用。777、2671 和 3008 ms 样本的原因仍未定位；完整冷启动 HTTPS、多节点、多网络和长时间稳定性仍超出本轮结论。
