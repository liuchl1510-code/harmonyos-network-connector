# 本地节点导入范围

`entry/src/main/ets/model/NodeImport.ets` 导出 `ImportedNode` 与 `parseNode(text)`。解析器只处理本地文本并生成单个 Xray outbound JSON，不访问订阅地址、不联网、不写文件、不记录输入。错误使用固定文本，不回显 URL、服务器、UUID 或密钥。调用方仍须在连接前用实际 Xray 核心校验生成的完整配置；解析成功不代表节点已可联网。

## 首版接受的格式

0.7.1 的应用入口新增批量粘贴、节点列表和二维码导入。`NodeBatchImport.ets` 在下面的单节点解析器外处理多行链接、严格单层 Base64 列表；总输入最多 1 MiB、500 行，单节点最多 64 KiB。重复配置保留一份，部分无效时先显示数量，再由用户确认导入可用项。二维码先经过同一解析器验证并填入输入框，点击保存后才写库。

单节点二维码与订阅地址是不同入口：3X-UI 的节点二维码通常用“扫码导入节点”，复制的分享文本用“解析并保存”。只有实际持有 HTTPS 订阅 URL 时才使用“管理订阅”；其响应支持链接列表、Base64 列表或单 outbound JSON，拒绝自动重定向、非 HTTPS、HTML 和 Clash YAML。真实订阅服务在本轮未验证，用户已澄清当前采用单节点分享方式。

| 输入 | 范围 |
| --- | --- |
| `vless://` | 标准 UUID；`encryption=none`；空 flow、`xtls-rprx-vision`、`xtls-rprx-vision-udp443` |
| `trojan://` | 百分号编码密码；默认 TLS；也接受 REALITY |
| `vmess://` | Base64 / Base64URL 包裹的 v2 JSON；只接受 AEAD / `aid=0`；port 可为字符串或数字 |
| `ss://` | SIP002 的 Base64URL userinfo 或百分号编码 `method:password`；AEAD 与 SS2022；IPv6 需方括号 |
| 单个 outbound JSON | `protocol`、`settings` 必需；四个上述协议；一个服务器及一个用户；保留原对象，包括 `streamSettings`、`mux`、`tag`、`sendThrough` |

共同传输为 `type=tcp/raw/ws/grpc`；安全层为 `security=none/tls/reality`。Trojan 必须 TLS / REALITY，Vision 必须 TCP / RAW 加 TLS / REALITY。TLS 支持 `sni`、`fp`、`alpn`；REALITY 支持 `sni`、`fp`（缺省 chrome）、`pbk`、`sid`、`spx`。REALITY + WebSocket 被拒绝。

WebSocket 使用 `host`、`path`；gRPC 使用 `serviceName`、`authority`、`mode=gun/multi`。VMess 的 gRPC 分享字段按 v2rayNG 映射：`path → serviceName`、`host → authority`、`type → mode`。生成数据使用 Xray v25.8.3 实际支持的 `network`、`vnext[].users[]` / `servers[]` 结构；没有采用较新官网的扁平 settings 示例。

## 明确拒绝的内容

- 单节点 `parseNode` 拒绝订阅 URL、列表和完整 Xray `inbounds/outbounds/routing/dns` 配置。应用批量入口用 `parseNodeBatch` 逐项处理列表，不会只截取第一条；订阅 URL 由独立页面下载后再解析。
- VMess 的非 Base64 URI 变体、非零 alterId；旧版整段 Base64 `ss://`；SIP003 插件；旧非 AEAD Shadowsocks 算法。
- HTTP 伪装头、XHTTP、HTTPUpgrade、mKCP、Hysteria、WireGuard 等尚未实现的传输或协议；未识别的分享参数或 VMess JSON 字段；不匹配的传输参数。
- 空地址、无效端口、非标准 UUID、空认证信息、重复查询参数、畸形百分号编码 / Base64、超出 128 KiB 字符的输入。
- 跳过证书校验的 `allowInsecure`、`allow_insecure`、`insecure`、`skip-cert-verify`、`skipCertVerify` 启用值；JSON 嵌套和转义键名也检查。
- 插件、链式代理（`proxySettings`、`dialerProxy`）、TLS 密钥日志。单 outbound 无法携带它们依赖的其他出站。

单 outbound JSON 不做完全的 Xray schema 重实现；深层核心选项由固定版本的核心继续校验。解析器保留对象的附加内容，且对它认识的禁止选项、地址、认证和传输进行预检查。首版不宣称完整兼容 v2rayNG，也没有从本地解析推断真实节点可达性。

## 来源与许可证记录

2026-09-07 阅读下列固定版本源码，用于核对分享字段语义。ArkTS 代码为本项目重新实现，没有粘贴 Kotlin / Go 代码块。

- v2rayNG，commit `2020807c255b76b09c9ced4255c95600250aef48`：[VlessFmt.kt](https://github.com/2dust/v2rayNG/blob/2020807c255b76b09c9ced4255c95600250aef48/V2rayNG/app/src/main/java/com/v2ray/ang/fmt/VlessFmt.kt)、[TrojanFmt.kt](https://github.com/2dust/v2rayNG/blob/2020807c255b76b09c9ced4255c95600250aef48/V2rayNG/app/src/main/java/com/v2ray/ang/fmt/TrojanFmt.kt)、[VmessFmt.kt](https://github.com/2dust/v2rayNG/blob/2020807c255b76b09c9ced4255c95600250aef48/V2rayNG/app/src/main/java/com/v2ray/ang/fmt/VmessFmt.kt)、[ShadowsocksFmt.kt](https://github.com/2dust/v2rayNG/blob/2020807c255b76b09c9ced4255c95600250aef48/V2rayNG/app/src/main/java/com/v2ray/ang/fmt/ShadowsocksFmt.kt)、[FmtBase.kt](https://github.com/2dust/v2rayNG/blob/2020807c255b76b09c9ced4255c95600250aef48/V2rayNG/app/src/main/java/com/v2ray/ang/fmt/FmtBase.kt)。上游 [LICENSE](https://github.com/2dust/v2rayNG/blob/2020807c255b76b09c9ced4255c95600250aef48/LICENSE) 为 GNU GPL v3 文本；后续直接移植代码时须保留其版权与许可义务。
- Xray-core，tag `v25.8.3`：[vless.go](https://github.com/XTLS/Xray-core/blob/v25.8.3/infra/conf/vless.go)、[vmess.go](https://github.com/XTLS/Xray-core/blob/v25.8.3/infra/conf/vmess.go)、[shadowsocks.go](https://github.com/XTLS/Xray-core/blob/v25.8.3/infra/conf/shadowsocks.go)、[transport_internet.go](https://github.com/XTLS/Xray-core/blob/v25.8.3/infra/conf/transport_internet.go)、[grpc.go](https://github.com/XTLS/Xray-core/blob/v25.8.3/infra/conf/grpc.go)。Xray-core 上游使用 [MPL-2.0](https://github.com/XTLS/Xray-core/blob/v25.8.3/LICENSE)；其原生集成许可证另见项目依赖记录。
- 官方[传输文档](https://xtls.github.io/config/transport.html)、[VLESS 文档](https://xtls.github.io/config/outbounds/vless.html)用于概念对照；页面许可为 CC-BY-SA-4.0，未复制页面正文。由于文档会更新，配置字段以实际 v25.8.3 核心为准。
- 本机 DevEco Studio 26 SDK：`sdk/default/openharmony/ets/api/@ohos.url.d.ts`（`url.URL.parseURL`、hostname）、`@ohos.util.d.ts`（`Base64Helper.decodeSync`、`TextDecoder.create`、`decodeToString`）。URI 查询参数自行按百分号编码读取，以保留字面 `+`，避免表单 URL 参数的空格替换。

## 验证界限

实现阶段使用虚构 UUID、`example.invalid` 和占位密码进行离线测试；不包含真实用户节点。`scripts/test-node-import.cjs` 的 46 个用例全部通过，覆盖 12 个成功解析断言和 34 个拒绝场景。输出 `build/parser-verification.json` 包括源码 SHA256、运行时间及验证范围。

执行示例（从任意目录运行均可，源码相对脚本定位）：

```powershell
& 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' .\scripts\test-node-import.cjs
```

可设置环境变量 `DEVECO_STUDIO_HOME`，或传入 `--typescript-dir <TypeScript 包目录>` 来指定其他 DevEco 安装；不会安装 npm 包。脚本以 Node 对应实现替代 SDK 的 URL / Base64 / UTF-8 API，这些测试只能证明解析逻辑，不能代替真实 ArkTS 编译、实际 SDK 行为或联网验证。主工程已另行通过 SDK 26 ArkTS 编译；真机运行状态以主工程验证记录为准。真实配置只由用户稍后在设备应用本地导入。

## 私有 JSON 导入辅助脚本的多节点语义

`scripts/import-private-node.cjs` 仍只接收本地单 outbound JSON，通过“首页 → 节点管理 → 导入节点”填写应用；也兼容首页直接进入导入页的导航。成功需要本次新生成且保持有效的保存回执、可见输入框已清空，以及当前保存结果为成功。应用只有在节点库读回包含全部本次节点后才生成此回执，因此脚本输出 `savedToCatalog` / `readbackReceiptVerified`，不表示新节点已被选中；已有当前节点可以保持不变。

旧字段 `saved` / `saveReceiptFresh` 保留为兼容别名，含义同样是确认保存到节点库；`serverMatches` 已移除，不能继续用当前服务器证明本次导入。失败输出中的 `false` 表示尚未完成确认，不承诺已撤销可能发生的保存。脚本使用不带 bundle 过滤的临时布局快照，每次操作先确认属于首页、节点管理或导入页；快照读完立即删除，异常和命令输出均不回显配置。`test-private-import-confirmation.cjs` 使用合成界面验证这些约定，不能代替真机测试。
