// Public diagnostics are fixed classifications. Never include input values,
// unknown parameter names, decoded links, credentials or native error text.
export class NodeIssue {
  code: string;
  field: string;
  problem: string;
  suggestion: string;
  constructor(code: string, field: string, problem: string, suggestion: string) {
    this.code = code; this.field = field; this.problem = problem; this.suggestion = suggestion;
  }
}

export function nodeIssue(code: string): NodeIssue {
  switch (code) {
    case 'input-empty': return new NodeIssue(code, '分享内容', '尚未填写节点内容。', '粘贴节点分享链接或单个 outbound JSON。');
    case 'input-size': return new NodeIssue(code, '分享内容', '内容超过当前入口的大小限制。', '缩短单节点内容或拆分批量后重试。');
    case 'input-format': return new NodeIssue(code, '分享格式', '内容不是受支持的节点分享格式。', '使用 VLESS、VMess、Trojan、Shadowsocks 分享链接或单个 outbound JSON。');
    case 'input-control': return new NodeIssue(code, '分享内容', '内容包含无效编码或不受支持的控制字符。', '重新复制原始分享文本，避免混入二进制内容。');
    case 'input-html': return new NodeIssue(code, '分享内容', '收到的是 HTML / XML 页面。', '检查复制内容或订阅登录状态，使用实际节点文本。');
    case 'input-yaml': return new NodeIssue(code, '分享格式', '暂不支持 YAML / Clash 配置。', '从原客户端导出受支持的分享链接列表。');
    case 'base64-format': return new NodeIssue(code, 'Base64 编码', '编码或解码后的 UTF-8 文本无效。', '重新复制完整分享内容，不增加编码层。');
    case 'percent-encoding': return new NodeIssue(code, '分享编码', '链接包含无效的百分号编码。', '重新复制完整链接，不手动修改编码字符。');
    case 'json-syntax': return new NodeIssue(code, 'JSON 内容', 'JSON 语法无法解析。', '使用无注释、无尾逗号的单个 outbound 对象。');
    case 'json-structure': return new NodeIssue(code, 'JSON 结构', '节点结构或字段类型不正确。', '核对单个 outbound 的 protocol、settings、服务器和用户结构。');
    case 'json-document': return new NodeIssue(code, 'JSON 结构', '此入口只接受单个 outbound。', '导出目标节点的 outbound，不粘贴完整配置、数组、路由或入站。');
    case 'batch-base64-json': return new NodeIssue(code, '分享格式', 'Base64 列表中不能包装 JSON 配置。', 'JSON 请直接粘贴为单个 outbound 对象。');
    case 'batch-lines': return new NodeIssue(code, '条目数量', '一次最多处理 500 行。', '拆分内容后分别导入。');
    case 'entry-size': return new NodeIssue(code, '节点内容', '单个节点超过 64 KiB。', '重新导出精简的单节点配置。');
    case 'address-format': return new NodeIssue(code, '服务器地址', '地址为空或格式不正确。', '填写服务器 IP 或域名，不包含协议前缀、路径或空格。');
    case 'endpoint-format': return new NodeIssue(code, '服务器与端口', '分享链接缺少明确的服务器、认证信息或端口。', '重新复制完整链接；IPv6 字面地址需使用方括号。');
    case 'port-format': return new NodeIssue(code, '端口', '端口应为 1–65535 的整数。', '核对服务器端口；outbound JSON 中端口必须使用数字。');
    case 'credential-missing': return new NodeIssue(code, '认证信息', '认证信息不能为空。', '从服务端或有效客户端重新复制对应的密码或认证字段。');
    case 'uuid-format': return new NodeIssue(code, '用户 UUID', 'VLESS / VMess 用户 ID 必须是标准 UUID。', '核对完整 UUID，包括各段之间的连字符。');
    case 'protocol-unsupported': return new NodeIssue(code, '协议', '当前不支持此协议。', '使用 VLESS、VMess、Trojan 或 Shadowsocks 节点。');
    case 'transport-unsupported': return new NodeIssue(code, '传输方式', '当前不支持此传输。', '使用服务端已配置的 TCP / RAW、WebSocket 或 gRPC 节点。');
    case 'security-unsupported': return new NodeIssue(code, '传输安全', '安全层不受支持或与协议不符。', '核对 none、TLS、REALITY；Trojan 必须启用 TLS 或 REALITY。');
    case 'transport-mismatch': return new NodeIssue(code, '传输参数', '参数与传输方式或安全层不匹配。', '对照服务端重新导出匹配的配置，勿直接删除不认识的参数。');
    case 'options-unsupported': return new NodeIssue(code, '高级选项', '内容包含当前未支持的选项。', '对照服务端导出受支持的单节点配置，不要直接删除不认识的参数。');
    case 'duplicate-option': return new NodeIssue(code, '查询参数', '分享链接包含重复参数。', '从原客户端重新导出无重复参数的链接。');
    case 'certificate-verification': return new NodeIssue(code, '证书校验', '不接受跳过服务器证书校验。', '修正服务端证书和服务器名称，使用启用证书校验的配置。');
    case 'reality-key': return new NodeIssue(code, 'REALITY 公钥', '公钥缺失或格式不正确。', '复制服务端对应的 43 位 Base64URL 公钥。');
    case 'reality-sni': return new NodeIssue(code, 'REALITY 服务器名称', 'REALITY 需要非空的服务器名称。', '复制节点配置中的 SNI / serverName。');
    case 'reality-fingerprint': return new NodeIssue(code, 'REALITY 指纹', 'REALITY 指纹不能为空。', '从原配置复制 fingerprint；本地检查不会为 JSON 自动补值。');
    case 'reality-short-id': return new NodeIssue(code, 'REALITY Short ID', 'Short ID 必须为空或不超过 16 位的偶数长度十六进制文本。', '按服务端配置填写 shortId，不自行补零或截断。');
    case 'flow-unsupported': return new NodeIssue(code, 'Flow', 'Flow 不受支持或与传输组合不符。', '使用空 Flow，或服务端配置的 Vision 加 TCP / RAW 与 TLS / REALITY。');
    case 'cipher-unsupported': return new NodeIssue(code, '加密方式', '加密方式或旧版认证模式不受支持。', 'VLESS 使用 none，VMess 使用 AEAD，Shadowsocks 使用受支持的 AEAD / 2022 方法。');
    case 'ws-path': return new NodeIssue(code, 'WebSocket 路径', 'WebSocket 路径必须以 / 开头。', '复制服务端完整路径，不自行猜测。');
    case 'ws-host': return new NodeIssue(code, 'WebSocket Host', 'Host 不允许包含换行。', '重新填写单行 Host 值。');
    case 'grpc-mode': return new NodeIssue(code, 'gRPC 模式', 'gRPC mode 仅支持 gun 或 multi。', '核对服务端模式并重新导出。');
    case 'alpn-format': return new NodeIssue(code, 'ALPN', 'ALPN 中含有空项或无效协议名称。', '按原配置填写非空协议名称，分享链接使用逗号分隔。');
    case 'editor-transition': return new NodeIssue(code, '编辑方式', '基础表单不能改变协议、传输方式或安全层。', '需要修改结构时，明确切换到高级 JSON 编辑。');
    case 'ipv4-entry-required': return new NodeIssue(code, '服务器地址', '当前连接入口不支持 IPv6 字面地址。', '使用服务端可连接的 IPv4 地址，或能解析到 IPv4 的域名。');
    case 'bootstrap-host-format': return new NodeIssue(code, '服务器地址', '地址不符合当前连接入口的格式要求。', 'IPv4 使用标准四段十进制；域名使用有效 ASCII DNS 标签。');
    case 'catalog-unreadable': return new NodeIssue(code, '本地节点库', '节点库暂时无法读取或未通过完整性检查。', '保留原数据，重新打开应用后重试；仍失败时记录此提示以便排查。');
    case 'node-missing': return new NodeIssue(code, '当前节点', '尚未选择可用的已保存节点。', '先添加节点，再在节点列表选择需要连接的一项。');
    case 'node-changed': return new NodeIssue(code, '当前节点', '等待期间当前节点已改变。', '重新检查当前配置后再连接。');
    default: return new NodeIssue('configuration-invalid', '节点配置', '本地配置检查未完成。', '检查原始分享内容；输入和已保存的配置会保留。');
  }
}

export class NodeIssueError extends Error {
  code: string;
  constructor(code: string) {
    super(nodeIssue(code).problem);
    this.code = nodeIssue(code).code;
  }
}

export function nodeIssueFromError(error: Object): NodeIssue | undefined {
  if (!(error instanceof NodeIssueError)) { return undefined; }
  const issue = nodeIssue(error.code);
  return issue.code === error.code ? issue : undefined;
}

export function isKnownNodeIssueError(error: Object): boolean {
  return nodeIssueFromError(error) !== undefined;
}

export function formatNodeIssue(issue: NodeIssue): string {
  const known = nodeIssue(issue.code);
  return `${known.field}：${known.problem} 建议：${known.suggestion}`;
}

// Legacy parser sites supply only authored constant messages. This lookup keeps
// their validation order and accepted configurations unchanged during migration.
export function importIssueCode(message: string): string {
  if (message.startsWith('VMess 链接必须')) { return 'json-syntax'; }
  if (message.includes('端口')) { return message.includes('方括号') ? 'endpoint-format' : 'port-format'; }
  if (message.includes('UUID')) { return 'uuid-format'; }
  if (message.includes('服务器地址')) { return 'address-format'; }
  if (message.includes('百分号')) { return 'percent-encoding'; }
  if (message.includes('Base64')) { return 'base64-format'; }
  if (message.includes('重复查询')) { return 'duplicate-option'; }
  if (message.includes('证书校验')) { return 'certificate-verification'; }
  if (message.includes('ALPN 必须')) { return 'alpn-format'; }
  if (message.includes('WebSocket 路径')) { return 'ws-path'; }
  if (message.includes('WebSocket Host')) { return 'ws-host'; }
  if (message.includes('gRPC mode')) { return 'grpc-mode'; }
  if (message.includes('flow') || message.includes('XTLS Vision')) { return 'flow-unsupported'; }
  if (message.includes('仅支持 TCP / RAW')) { return 'transport-unsupported'; }
  if (message.includes('安全配置') || message.includes('Trojan 节点需要')) { return 'security-unsupported'; }
  if (message.includes('加密方式') || message.includes('encryption') || message.includes('AEAD') || message.includes('alterId')) { return 'cipher-unsupported'; }
  if (message.includes('不适用') || message.includes('不匹配') || message.includes('gRPC 请使用') ||
    message.includes('普通 TCP / RAW') || message.includes('REALITY 不支持') || message.includes('未启用 TLS')) { return 'transport-mismatch'; }
  if (message.includes('JSON 解析失败')) { return 'json-syntax'; }
  if (message.includes('完整配置')) { return 'json-document'; }
  if (message.includes('单 outbound 目前仅支持')) { return 'protocol-unsupported'; }
  if (message.includes('不支持') || message.includes('未支持') || message.includes('未验证')) { return 'options-unsupported'; }
  if (message.includes('JSON 对象') || message.includes('字段类型') || message.includes('结构') || message.includes('恰好')) { return 'json-structure'; }
  if (message.includes('认证信息')) { return 'credential-missing'; }
  return 'input-format';
}
