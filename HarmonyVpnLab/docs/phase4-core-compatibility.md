# 有效节点对照与核心兼容性

记录日期：2026-09-07（电脑时区）。手机日志已跨至 09-08。

## 已确认结论

**后续结果：0.5.0 已集成真正的 Xray 26.6.1，并通过真机真实节点 HTTPS、拒绝保护和恢复验证。详见[最终验证记录](phase5-real-node-verification.md)。** 下文保留定位和候选淘汰过程。

恢复工作后已通过用户授权的 Chrome 面板核查：服务端运行 Xray **26.7.28**，443 端口 VLESS/REALITY 入站的 `minClientVer` 与 `maxClientVer` 均为空。[该固定版本源码](https://github.com/XTLS/Xray-core/blob/v26.7.28/infra/conf/transport_security.go#L100-L116)明确将空 `minClientVer` 解释为默认 **26.3.27**，并非无限制；空 `maxClientVer` 不设上界。此前将“空值”暂时解释为未限制是不正确的，已根据源码纠正。

因此原有 25.8.3 客户端会被这条默认版本门槛拒绝，26.6.1 可以通过这一检查，与下表实测吻合。单独更新 uTLS 或编译器、同时保留 25.8.3 的上报版本，也不会满足门槛。服务端配置没有修改；现已通过真正升级核心满足门槛并完成手机联网验证。

同一份 v2rayN 安装目录生成的 VLESS/RAW/REALITY 出站配置，在独立 Windows 测试中：

| 条件 | Xray 25.8.3 | Xray 26.6.1 |
| --- | --- | --- |
| 显式绑定同一 WLAN 出站接口 | REALITY 验证失败，HTTPS 未完成 | HTTPS 200，约 1.5 秒 |
| socket 选项错误计数 | 0 | 0 |

这是目前最有效的版本对照。现在已有服务端实际空值配置和固定版本的默认值代码作为依据，不能再把这些结果单独解释为 uTLS 或加密算法错误。

证据：`build/host/wlan-bound-old-core-result.json`、`build/host-v2rayn/wlan-bound-new-core-result.json`。

历史阶段：手机 0.4.3 通过写入后读回、全配置一致、随机新保存回执、地址一致和输入框清空检查，保存了上述已验证配置。随后 runId `1788797305743` 仍出现 REALITY rejected=1；Go/ArkTS 时钟差 0 ms，socket 保护 5/5 成功，回环 0，核心与 VPN 网卡成功释放。当时手机核心为 25.8.3，尚未通过真实联网；该状态已由后续 0.5.0 的真机结果取代。

## 配置来源

用户最初保存的 JSON 与 v2rayN 安装目录生成配置并不一致。仅在内存中比较了字段，没有输出凭据。用户明确选择“使用 v2rayN 本地生成的配置，先验证成功再导入手机”。

已定位正在运行的程序为 v2rayN 7.24.9 / Xray 26.6.1，核心文件与用于对照的副本 SHA256 完全一致。该程序报告 commit `9f96d16` / Go 1.26.3；`go version -m` 显示 module 为 `(devel)`，不将根据日期推测的 module tag 当作实际构建标识。

电脑还存在 AppData 与 Downloads 下的其他副本。AppData 生成配置比实际安装目录中的配置更旧；这份旧副本的测试不能代表正在运行的客户端。

## Windows 测试环境干扰

现有 v2rayN 正在运行 TUN。单独复制出去的 Xray 进程不会继承该 TUN 核心的出站接口控制器。早期复制路径下的失败结果受到现有 TUN 路由影响，不能直接用作无干扰的节点可用性判定。

同字节 26.6.1 从原安装路径启动独立测试成功，从工作区普通复制路径启动失败。静态配置存在 `xray/` 进程规则；[固定源码](https://github.com/XTLS/Xray-core/blob/9f96d16/app/router/condition.go)将这个特殊值展开为正在运行核心的完整可执行文件路径，然后精确匹配，并不是任意包含 `xray/` 的目录都匹配。工作区仿造目录片段的两次失败不能分离版本因素。

尝试创建原安装目录的临时旧版副本被 Windows 目录权限拒绝，未覆盖现有文件。即便同目录另名文件能创建，也不能据此保证该特殊规则精确匹配，因而不采用该路线。

最终使用 `streamSettings.sockopt.interface`，仅在测试生成配置中为节点出站指定 WLAN。Windows 核心在该 socket 上设置 `IP_UNICAST_IF`；不修改全局路由或用户存储的节点，也不停止现有 v2rayN。这建立了上表中的配对条件。

正在运行的 v2rayN HTTP 代理也实际返回 HTTPS 200，观察窗口中 VLESS 计数增长、freedom 计数无增长。但该进程可能同时服务其他请求，所以这些共享计数只作辅助证据。

## 可重复测试

```powershell
& 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' .\HarmonyVpnLab\scripts\test-host-node.cjs --node-file .\.private\v2rayn-installed-outbound.json --outbound-interface WLAN

& 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' .\HarmonyVpnLab\scripts\test-host-node.cjs --node-file .\.private\v2rayn-installed-outbound.json --core-dir .\HarmonyVpnLab\build\host-v2rayn --outbound-interface WLAN
```

需要正常用户网络权限；受限执行环境的 socket 拒绝不算节点测试结果。每轮最多 20 秒，严格验证目标 HTTPS 证书，只创建随机本机 HTTP 代理并验证核心摘要，结束后清理自己的子进程和连接。原始配置及核心日志只写入 `.private`，标准输出仅含分类结果。

## 新版适配边界

官方 OHOS Go 仓库的 `release-branch.go1.26` 存在，固定提交为 `3cc00d9c2b8ac231a5432ececa784814cc1eb075`。但实际 Windows 自举得到的 Go 1.26.7 未列出 `openharmony/arm64`，最小动态库测试也返回 `-buildmode=c-shared not supported on openharmony/arm64`。不能仅凭分支名宣称已有可用的新版鸿蒙编译器。证据为 `build/native/xray26-candidate/toolchain-verification.json`。

已完成较小兼容候选：保持 OHOS Go 1.24.5、Xray 25.8.3 和现有保护补丁，单独更新到有效新版使用的 uTLS。Windows/OHOS 模块清单均验证只有 uTLS 一项版本变化，候选 ELF、8 项 ABI、4/4 socket 保护合成测试通过。但固定 WLAN 的真实节点测试仍失败，因此没有替换手机核心。

随后仅用 Windows Go 1.26.7 重编同一候选，保持源码、35 项链接模块版本和节点配置不变，真实测试仍失败。这排除了“单独更新 uTLS”或“仅更换编译器”足以修复的假设；没有改变 `Version_x/y/z` 来伪装客户端版本。证据分别在 `build/native/xray-utls-candidate/host/node-result.json` 和 `host-go126/node-result.json`。

后续在隔离工作区完成了 Go 1.26 鸿蒙平台适配。旧平台补丁对官方 Go 1.24.5 自校验通过；最初对 1.26.7 的机械检查为 125 文件中 109 可应用、16 冲突。冲突解决后又处理了新发现的 ABI/早期初始化兼容问题，并通过最小动态库及完整核心真机验证；这些后续运行证据独立于最初的机械检查。

官方 release API 的非预发布版选项返回 26.3.27；26.6.1 官方标为预发布版。不能将 API `latest` 的返回值直接当作数值最大的版本。26.3.27 的官方 ZIP 与 `.dgst` 已核对，其对照记录也保留。

25.8.3 本身已有 ML-DSA-65 验证实现。本项目拒绝非空 `mldsa65Verify` 是导入器尚未验证该组合的范围限制，不是核心没有实现；当前测试配置该字段为空，不影响此次对照。

新版构建必须继续保留逐 socket 保护、保护失败阻止拨号、8 项 C ABI、单 Go runtime、私有日志及资源清理验证。完整功能仍不包含已验证的 DNS、IPv6、其他应用全局代理或长期运行。
