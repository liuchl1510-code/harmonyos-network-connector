# 手机稳定性只读采样

先在手机连接 VPN，确认本次连接的 `runId`、VPN 服务 PID 和 UI PID，再从项目目录运行：

```powershell
& 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' .\scripts\measure-device-stability.cjs --pid 12345 --ui-pid 12346 --run-id 1789000000000 --minutes 30 --interval-seconds 30
```

替换示例中的两个 PID 和 runId。脚本不启动或停止 VPN，不操作界面或网络设置；测试结束后应由操作者检查联网并正常断开。请勿在测试期间更换应用进程。已有同名输出目录时拒绝覆盖。

- 每次向 `build/stability/<runId>/samples.jsonl` 追加采样；结束或明确失败时生成 `summary.json`。控制台约每分钟输出数字进度。
- 使用主机单调时钟覆盖指定窗口，每个 HDC 命令有 10 秒超时。每轮确认唯一 USB Connected 设备，检查两个进程的 `/proc/<pid>/stat` 启动时间字段，防止 PID 重用。断连、进程消失或必要字段无法读取会明确失败并退出。
- 保存原始 CPU user/system ticks、RSS KiB、线程数和可读 FD 数；不保存原始 proc 文本。FD 无权限或不可用时保存 `null` 和固定原因，不能解读为零。
- CPU 百分比以“单核 100%”计算，**假设时钟频率为 100 ticks/s**，依据此前该设备的 fault 记录，本脚本不重新测量该值。原始 ticks 保留，便于纠正假设后重新计算。RSS/FD 汇总保留起止、最小最大及可用样本数。
- hilog 只查询应用标签，按两个 PID 与可见 runId 过滤，仅保存 `CONNECTION_ACTIVE`、`CONNECTION_STOPPED`、`PHYSICAL_NETWORK_CHANGED` 和错误事件数量。排除首次已有缓冲区，不落盘原始日志、URL、域名或配置；周期读取缓冲区可能漏日志，零计数不能证明没有发生事件。
- 该窗口只能说明进程资源和观察到的事件，不能独立证明联网、续航或长期稳定性。应把实际窗口和样本数写入验收记录。

离线自测不访问手机或网络：

```powershell
& 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' .\scripts\test-stability-collector.cjs
```
