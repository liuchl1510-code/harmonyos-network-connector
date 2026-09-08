# Hev 的 OHOS ARM64 构建

`scripts/build-hev.ps1` 使用 DevEco SDK 26 的 Clang、CMake、Ninja，将
`source-lock.json` 固定的 Hev 2.9.0 和四个 git 子模块编译为
`entry/libs/arm64-v8a/libhevsocks5tun.so`。不需要 GNU Make、WSL 或 Go。
首次下载需要网络，构建不执行上游安装脚本，也不更改全局环境。

源码缓存位于工作区 `.tooling/sources/hev-socks5-tunnel`。构建仅接受干净的
固定版本，将跟踪文件复制到真正的 ASCII 临时目录后编译；Windows 上作为文本
签出的 36 个头文件符号链接，只在临时目录中按原始 git 目标展开。原源码不改动。
CMake 按上游 `build.mk/configs.mk/Android.mk` 的源文件和宏定义建库，依赖用静态
archive 链接，避免 task-system 与 core 共享的 list/rbtree 实现重复定义。

构建脚本验证 ELF64/AArch64、五个上游入口和一个本地诊断入口、零个未解析的 `hev_*`，并启用
`--no-undefined/-z defs`。所有强导入还要能在 SDK 提供的依赖库中找到。
报告写入 `build/native/hev-verification.json`。当前只依赖 `libc.so` 和 SDK 26
官方工具链自动加入的 `libdeviceinfo_ndk.z.so`。静态检查通过不等于真机转发通过。

公共声明完整复制于 `include/hev-main.h`。主要入口：

```c
int hev_socks5_tunnel_main_from_str(const unsigned char *yaml,
                                  unsigned int length, int tun_fd);
void hev_socks5_tunnel_quit(void);
```

main 阻塞，必须在专属工作线程运行。外部传入的 TUN FD 是借用关系，Hev 不关闭；
桥接可传 `dup` 并设为 nonblocking，但必须等 main 返回、线程 join 后自行关闭 dup。
同进程仅可有一个实例。quit 在事件管道尚未创建时无效，早停须有限重试并有超时。

上游限制：`stats` 与流量计数更新没有原子同步；本阶段不调用。日志清理只关闭
FD 而不复位，停止后继续调用公开 API 可能写入复用的日志 FD，因此固定使用 warn
级别且禁止结束后取 stats。`hev_config_fini` 不重置全局配置，本阶段仅使用固定
配置结构；初始化错误后应重新启动扩展进程，不能声称任意配置切换已验证。

`licenses` 保留五个仓库的许可证、lwIP 源文件中的不同许可证块，以及原始
[libyaml 0.2.5 许可证](https://github.com/yaml/libyaml/blob/0.2.5/License)。发布
应用时还应在随应用分发的开源声明中包含这些内容。

为定位已在真机确认的 Hev 单线程高 CPU，当前构建附加 `ohos-io-stats.c`，
通过链接器 `--wrap=epoll_wait/--wrap=read` 记录此 DSO 内的调用，不修改上游源码。
只记录次数和最后一次 epoll 错误码，不读取或记录包内容、FD、IP、域名或节点配置；
不改变返回值、errno、超时、调度及读写行为。计数增加会带来少量诊断开销。
完整 C/C++ 声明在 `include/hev-ohos-io-stats.h`：

```c
void hev_ohos_io_stats(uint64_t *values, unsigned int count);
```

写入 `min(count, 17)` 项；空指针无操作。前 12 槽布局保持不变，新增 5 槽统计
每个返回事件携带的就绪位；一个事件可以同时使多个槽加一。槽位固定如下：

| 槽位 | 含义 |
| --- | --- |
| 0 | epoll_wait 调用总数 |
| 1 | timeout == 0 次数 |
| 2 | timeout > 0 次数 |
| 3 | timeout < 0 次数 |
| 4 | epoll_wait 返回负数次数 |
| 5 | epoll_wait 返回零次数 |
| 6 | epoll_wait 返回正数次数（不是事件总数） |
| 7 | 最近一次 epoll_wait 失败的 errno；失败前为零 |
| 8 | read 调用总数 |
| 9 | read 返回 EAGAIN/EWOULDBLOCK 次数 |
| 10 | read 返回零次数（包含零长度读） |
| 11 | read 返回其他错误次数 |
| 12 | 返回事件含 EPOLLIN 的次数 |
| 13 | 返回事件含 EPOLLOUT 的次数 |
| 14 | 返回事件含 EPOLLERR 的次数 |
| 15 | 返回事件含 EPOLLHUP 的次数 |
| 16 | 返回事件含 EPOLLRDHUP 的次数 |

所有槽位均为 C11 无锁 64 位原子量，可从独立线程读取。计数自库加载起累计且不重置；
多个槽位不是事务快照，采样时可能有一次在途调用，应用应比较相邻样本差值。
包装仅覆盖链接进 Hev 库的调用，不统计系统库内部或 Xray 等其他 DSO 的 read/epoll。
调用数不是包数，单独的累计调用数也不等于 CPU 使用率。

真机 0.6.7 的 14.4 秒诊断出现约 200 万次 epoll 返回，其中约 200 万个事件含 OUT，
IN 仅 27 次，ERR/HUP/RDHUP 均为零。`patches/demand-driven-io.patch` 因此限定修改
两个 session 实现：TCP 只有发送队列非空才订阅 OUT，接收环形缓冲区有容量才订阅 IN；
只在掩码变化时修改注册，无读写需求时删除注册，lwIP 的 recv/sent 回调负责唤醒恢复。
Socket 转发结束后，等待 lwIP ACK 释放缓冲区的阶段也撤销 socket 注册，避免 EOF/HUP
反复唤醒。UDP 发送任务仅在帧队列非空时注册数据 FD 的 OUT，反向任务独立 dup 的 IN
不受影响；UDP-in-UDP 完成握手后把 TCP 控制通道改为 IN，保留 EOF 检测。
注册失败终止 session；反向任务创建/注册失败会通知发送任务退出，退出时设置零超时
并 join。没有固定 sleep、退避或吞掉待发送数据。

`include/hev-ohos-interest.h` 保存掩码切换逻辑；旧掩码仅在注册操作成功后更新。
构建脚本检查补丁 SHA、两个输入文件及应用后的 SHA，在 ASCII stage 中做 clean apply。
原始 checkout 不打补丁；输入只在 stage 中统一 LF。`prepare-demand-patch.py` 是根据
固定基线生成补丁的维护工具，正常重建不调用它。

已核对的真机证据记录在 `io-interest-verification.json`，关联补丁和库 SHA、原始
计数日志的 SHA。设备为本次 Pura 80 Ultra / HarmonyOS 7.0，profile 报告内核
`HongMeng Kernel 1.13.0`。0.6.5 的 profiler 中约 99.5% CPU-cycle 事件权重定位到 `harmony-hev`，
热点为 session、调度器和 epoll 路径。随后三次有限时长的计数对照如下；它们有相同
连通性检查流程，但不是严格控制全部业务流量的吞吐基准：

| 应用版本 | 约运行时间 | epoll 调用 | 含 OUT 的返回事件 | epoll 错误 |
| --- | --- | --- | --- | --- |
| 0.6.6，修改前 | 18.5 秒 | 2,763,011 | 尚未分类型统计 | 0 |
| 0.6.7，修改前 | 14.4 秒 | 1,999,236 | 1,999,175 | 0 |
| 0.6.8，按需监听 | 19 秒 | 464 | 351 | 0 |

0.6.8 本应用范围的 run `1788858208882` 已通过 DNS A/AAAA 策略、域名 HTTPS
及 `cleanup=true`；库 SHA 为 `c774d64188cbef76b3dfb56db9792fc36ebbb68a8c38861236beddf1eb9d2875`。
证据是 `build/connection-tests/20260908-050346-Stop.log`；该结果证明这次空闲通知风暴
已消除，并不单独构成长期功耗、吞吐或所有协议的验收。

同一次运行中的独立本地 socket 对照，只在 loopback/Unix socket 上注册
`IN|OUT`（ET 组再加 `EPOLLET`），不发外网。流程为连续两次 `epoll_wait(..., 0)`，
执行一次空 `recv`，再连续两次 wait。各组 setup/wait 错误均为零，空 recv 返回
EAGAIN（11）；每个成功事件的掩码均为 OUT（4）：

| 对照 | 四次 wait 的事件数 |
| --- | --- |
| Unix socket，ET | `[1, 0, 0, 0]` |
| Unix socket，LT | `[1, 1, 1, 1]` |
| IPv4 UDP socket，ET | `[1, 0, 0, 0]` |
| IPv4 TCP loopback，ET | `[1, 0, 1, 0]` |

因此可复现的具体触发是：**本机 TCP 的空 recv 返回 EAGAIN 后，可写事件再次报告**。
Hev 原先持续监听空闲 socket 的 OUT，被唤醒后尝试读、得到 EAGAIN、继续等待，再被
OUT 唤醒，形成高频循环。TCP 控制通道也在影响范围。此结论由 profile、分类型计数、
独立 socket 对照和补丁后的结果共同支持；不是“ET 全部无效”或所有 HarmonyOS 的
共同结论。公开 [OpenHarmony musl epoll 实现](https://raw.githubusercontent.com/openharmony/third_party_musl/master/src/linux/epoll.c)
直接转发 syscall；不能将公开 OpenHarmony 用户态源码当作此手机内核实现的证明。

仍未专门覆盖大流量环形缓冲区填满再恢复、强制 ADD/MOD/DEL 失败、连接中途 TCP EOF、
UDP-in-TCP 分支及长时间吞吐/功耗。独立只读审查已完成，未发现新增确定阻塞缺陷：
初始掩码与握手后注册一致，TCP 容量谓词与 ring-buffer 写入条件一致，检查掩码至
WAITIO 之间没有协作让出点，入队/ACK 回调会唤醒任务；UDP 描述符归属、控制通道 EOF
和零超时加 join 的退出链均已核对。新 dup 的 ADD 失败严格退出，没有发现必须依赖
原先盲目 MOD fallback 的源码证据。不能
用正常 DNS/HTTPS 成功代替这些故障注入或压力测试。全设备/后台/锁屏的最终结果由
父任务的连接验收记录维护，此局部记录只认领以上已核对的范围。
