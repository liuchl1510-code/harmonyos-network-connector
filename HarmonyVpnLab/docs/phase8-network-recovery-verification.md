# 阶段八：域名预解析、核心重连和网络切换

记录日期：2026-09-08。最终版本0.8.1/code27，Pura80Ultra / HarmonyOS7 / API26。最新机器记录见[phase8-verification.json](../build/device-tests/phase8-verification.json)。本阶段沿用Xray26.6.1和Hev2.9.0，但新增包装层第9个ABI并重建libxray；没有更换用户节点。

## 实现范围

- 节点端点支持标准IPv4或ASCII/Punycode域名。域名通过当前物理网络句柄解析A记录，初次可用时在创建TUN前预解析；已有TUN恢复时仍显式指定物理netId。结果仅保存在本次会话内。
- 保留原节点address、TLS/REALITY serverName、WS Host、gRPC authority。Xray配置注入完整域名→单IPv4 hosts映射，并使用ForceIPv4；不采用失败后可退到系统DNS的UseIPv4。
- 对额外SRV/TXT地址重写、ECH解析和domainStrategy大小写别名实行连接阶段拒绝，避免绕过固定映射。固定核心负对照证实了别名在后可以覆盖canonical字段，现已拒绝两种顺序。
- PhysicalNetworkWatcher监听物理默认网络，去抖后重新读取getDefaultNet；同时周期复核。身份包括netId、网络类型、接口、IPv4地址/前缀、DNS和默认路由，排序去重后只在内存比较，未记录原始地址。
- 网络丢失时显示等待网络；恢复期间显示正在恢复。保留同一个VPN网卡、CoreProbe和Hev，只暂停/恢复Xray，复用SOCKS端口。旧TCP连接可能需要重试，不承诺无缝保留。
- 原生CA/Go/Socket Protector仅初始化一次，统计基线按核心实例重建，连接时间和累计流量跨重连保留。暂停时无法取得最终计数则保留最后已读值作为下界。
- 最终停止先取消本代任务，等待解析、状态读取和恢复任务，再关闭Hev/Xray、TUN和网卡。过期成功和失败均受epoch保护；界面还读取最新服务状态，避免UI轮询尚未更新时把旧请求当成新连接验证。
- 新增重新连接按钮和网络/恢复次数显示。recovering、waiting-network同样锁定节点编辑。控制调度、解析和保护等待使用单调时钟，状态文件的显示时间仍用墙钟。
- 增加普通GET_NETWORK_INFO权限。没有设置整应用setAppNet，也没有将raw fd伪装为ArkTS Socket传给bindSocket；公开API不支持该用法。

## 域名证据及限制

用户明确表示目前只有IP节点，没有可用于连接的服务器域名。因此本阶段没有真实域名代理节点端到端验收。

固定26.6.1核心的4个域名样本验证了Loader/protobuf、TCP/UDP实际拨号目的地固定到IPv4、原目标不变、TLS/WS/gRPC/REALITY字段保留，以及ForceIPv4失败不进入系统dialer；替换系统dialer后创建socket为0。这是实际核心逻辑验证，不是实网连接。

手机在VPN运行时使用明确物理句柄解析固定公共域名example.com：Wi-Fi和移动数据均得到IPv4结果，日志只写成功和网络类型，不保存结果IP。SDK没有取消DNS的接口；10秒业务期限和200ms取消检查只停止等待并忽略迟到结果，不能承诺终止系统内部查询。

证据：[域名核心验证](../build/hostname-core-verification.json)、[物理网络源码](../entry/src/main/ets/model/PhysicalNetwork.ets)、[配置构造](../entry/src/main/ets/model/ConnectionConfig.ets)、[配置合同及固定源码引用](../scripts/connection-core-contract.md)。

## 0.8.0暴露的问题及0.8.1修复

0.8.0 run1788865200791首次连接、DNS/HTTPS和物理DNS通过，但第一次重连报`Reuse of exported var name: stats`，随后安全结束并确认cleanup。固定Xray metrics模块每次构造都发布同名全局expvar，而且Close没有关闭其TCP监听；只跳过重复注册仍会留下旧监听和旧统计实例。

已在纯loopback实际核心实验中复现重复注册和监听未释放。修复是停止生成metrics配置，新增明确的CGoConnectionStats ABI，在与启动/停止相同的lifecycleMu下读取当前coreServer的StatsManager。原有8个ABI保留；旧CGoQueryStats仍是原HTTP接口，应用不使用它。新接口没有HTTP监听、DNS或其他网络请求，缺实例/缺计数器即报错。

真实包装层三轮start→零计数→修改计数→查询→stop→查询拒绝→新实例归零已通过，连同9ABI/ELF/TLSDESC、4项socket保护和2项原核心负向对照通过。见[标准构建证据](../build/native/xray26-verification.json)、[metrics负对照](../build/native/metrics-restart-original-negative.json)、[去metrics正对照](../build/native/metrics-restart-without-metrics-positive.json)、[包装层说明](../native/xray26/README.md)。

保留Hev的原因：lwIP全量重新初始化存在尚未覆盖的半开TCP/分片链表残留，不应仅靠几次普通HTTPS成功就允许重启整个Hev。本轮没有修改该内存管理路径。

## 真机：三次手动核心重连

0.8.1 run1788866443562，应用范围，UI PID24655、VPN PID25002。初次和每次重连后的4次DNS/HTTPS均通过；3次CONNECTION_CORE_RESUMED保持Hev，只有一次TUN创建/检查与最终关闭路径。物理DNS检查通过；最后指定IPv6 UDP无回复，UI黑洞命中2。累计上/下28699/25806字节，保护5/5、超时0、最终active0；cleanup=true及扩展销毁。

证据：[手动恢复记录](../build/network-tests/manual-recovery-verification.json)、[最终清理日志](../build/connection-tests/20260908-072127-Stop.log)。

## 真机：Wi-Fi → 移动数据 → Wi-Fi

全设备持续run1788866673315，UI PID24655、VPN PID25094均保持不变。用户按请求关闭WLAN并启用移动数据，再恢复原Wi-Fi。以当前网络类型、恢复计数、用户物理操作确认和切换后的新DNS/HTTPS响应共同验收；没有完整保留切换瞬间的原始回调历史。

| 阶段 | 观察结果 |
| --- | --- |
| 初始Wi-Fi | DNS/HTTPS通过，恢复计数0 |
| 移动数据 | 显示移动数据、恢复计数1；DNS/HTTPS通过，响应220字节；物理网络DNS通过 |
| 返回Wi-Fi | 显示Wi-Fi、恢复计数3；DNS/HTTPS通过，响应218字节；物理网络DNS通过 |
| IPv6 | 结束前已有黑洞命中51；最后指定UDP无回复。最后一次探针后的独立新计数快照未保留，不将单次失败单独当作阻断证据 |
| 流量 | 累计上/下443938/580763字节 |
| 保护 | 220请求、203成功、17拒绝或失败、超时0、最终active0 |
| 清理 | Hev/Xray停止、TUN FD关闭、VPN网络销毁、cleanup=true、扩展销毁 |
| 系统fault | 没有新增fault；仍只有历史0.6.3生命周期超时 |

恢复计数不能直接等同于用户开关次数。本轮17个保护失败未逐项保存原因，因此不声称全是某一种拒绝；按现有fail-closed控制器实现，它们没有被当作保护成功放行。没有把这些请求计为成功，也没有忽略最终active归零。

证据：[网络切换记录](../build/network-tests/physical-handover-verification.json)、[移动数据检查](../build/connection-tests/20260908-073201-Check-layout.json)、[回到Wi-Fi检查](../build/connection-tests/20260908-073723-Check-layout.json)、[最终停止](../build/connection-tests/20260908-073742-Stop.log)。最终Wi-Fi已恢复、VPN已断开，两条节点和选中项未修改。

## 自动化回归与交付

- 服务/UI/恢复竞态54项；Core恢复18项；配置和Core24项；物理网络27项；编辑保护11组/174状态通过。
- 实际核心连接protobuf6项、节点配置12项、域名4项；DNS未知字段、重新启用metrics、domainStrategy别名覆盖等负对照按预期失败。
- 这些合成时序测试不替代相机、网络、无网停机或长时运行实测。人为断网期间停止、长时/耗电、满缓冲/多协议压力、真实域名节点、IPv6转发和VPN停止后的kill-switch仍待后续。

HAP 40,107,609字节，SHA256 `d644c5d7a138515d1d670881b70bdd3edb9da26dc5dcc5b43aa826af03ff20e6`。Xray源库新SHA256 `0cfda2bd92a12cdbd5bcd9cf516ca17344023c93cb3a6659747af0ceecd974bc`，Hev仍为`c774d64188cbef76b3dfb56db9792fc36ebbb68a8c38861236beddf1eb9d2875`。没有Git提交或推送。
