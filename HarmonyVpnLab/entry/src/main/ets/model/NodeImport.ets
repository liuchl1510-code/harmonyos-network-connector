import { url, util } from '@kit.ArkTS';

// Format references and deliberately restricted coverage: docs/node-import-support.md.
// No caller input or core configuration is included in an error message or a log.
export class ImportedNode {
  name: string;
  protocol: string;
  outboundJson: string;

  constructor(name: string, protocol: string, outboundJson: string) {
    this.name = name;
    this.protocol = protocol;
    this.outboundJson = outboundJson;
  }
}

interface UserConfig {
  id: string;
  encryption?: string;
  flow?: string;
  security?: string;
  alterId?: number;
}

interface ServerConfig {
  address: string;
  port: number;
  users?: UserConfig[];
  password?: string;
  method?: string;
}

interface OutboundSettings {
  vnext?: ServerConfig[];
  servers?: ServerConfig[];
}

interface TlsConfig {
  serverName?: string;
  fingerprint?: string;
  alpn?: string[];
  allowInsecure?: boolean;
}

interface RealityConfig {
  serverName: string;
  fingerprint: string;
  publicKey: string;
  shortId: string;
  spiderX?: string;
  mldsa65Verify?: string;
}

interface WsConfig {
  path: string;
  host?: string;
}

interface GrpcConfig {
  serviceName: string;
  multiMode: boolean;
  authority?: string;
}

interface StreamConfig {
  network?: string;
  security?: string;
  tlsSettings?: TlsConfig;
  realitySettings?: RealityConfig;
  wsSettings?: WsConfig;
  grpcSettings?: GrpcConfig;
  tcpSettings?: Object;
  rawSettings?: Object;
  sockopt?: Object;
}

interface OutboundConfig {
  protocol: string;
  settings: OutboundSettings;
  streamSettings?: StreamConfig;
  mux?: Object;
  tag?: string;
  sendThrough?: string;
}

interface VmessShare {
  v?: string | number;
  ps?: string;
  add: string;
  port: string | number;
  id: string;
  aid?: string | number;
  scy?: string;
  net?: string;
  type?: string;
  host?: string;
  path?: string;
  tls?: string;
  sni?: string;
  fp?: string;
  alpn?: string;
  insecure?: string | number | boolean;
}

class ShareParts {
  userInfo: string = '';
  address: string = '';
  port: number = 0;
  name: string = '';
  query: Map<string, string> = new Map<string, string>();
}

const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSECURE_KEYS: string[] = ['allowinsecure', 'allow_insecure', 'skip-cert-verify', 'skipcertverify', 'insecure'];
const NETWORKS: string[] = ['tcp', 'raw', 'ws', 'grpc'];
const SS_METHODS: string[] = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-poly1305', 'chacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305'];
const QUERY_KEYS: string[] = ['type', 'security', 'encryption', 'flow', 'sni', 'fp', 'alpn', 'pbk', 'sid', 'spx',
  'host', 'path', 'headerType', 'serviceName', 'authority', 'mode', 'insecure', 'allowInsecure', 'allow_insecure',
  'skip-cert-verify', 'skipCertVerify'];

function fail(message: string): never {
  throw new Error(message);
}

function requireObject(value: Object | undefined, message: string): void {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(message);
  }
}

function optionalString(value: string | undefined): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    return fail('节点中的文本字段类型不正确。');
  }
  return value;
}

function requireSecret(value: string | undefined): string {
  const result = optionalString(value);
  if (result.trim().length === 0) {
    return fail('节点认证信息不能为空。');
  }
  return result;
}

function requireUuid(value: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('VLESS / VMess 的用户 ID 必须是标准 UUID。');
  }
}

function readPort(value: string | number): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return fail('节点端口必须是 1 至 65535 的整数。');
  }
  if (typeof value === 'string' && !/^[0-9]+$/.test(value)) {
    return fail('节点端口必须是 1 至 65535 的整数。');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail('节点端口必须是 1 至 65535 的整数。');
  }
  return port;
}

function readHost(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\s\/@?#\\]/.test(value)) {
    return fail('节点服务器地址为空或格式不正确。');
  }
  let normalized = value;
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.substring(1, normalized.length - 1);
  }
  const bracketed = normalized.indexOf(':') >= 0 ? '[' + normalized + ']' : normalized;
  try {
    const parsed = url.URL.parseURL('http://' + bracketed + '/');
    let result = parsed.hostname;
    if (result.startsWith('[') && result.endsWith(']')) {
      result = result.substring(1, result.length - 1);
    }
    if (result.length === 0 || parsed.port.length > 0) {
      return fail('节点服务器地址格式不正确。');
    }
    return result;
  } catch (err) {
    return fail('节点服务器地址格式不正确。');
  }
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return fail('分享链接包含无效的百分号编码。');
  }
}

function base64Text(value: string): string {
  let encoded = value.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1 || encoded.length === 0) {
    return fail('分享链接包含无效的 Base64 数据。');
  }
  if (encoded.indexOf('=') >= 0 && encoded.length % 4 !== 0) {
    return fail('分享链接包含无效的 Base64 填充。');
  }
  encoded = encoded.replace(/=+$/, '');
  if (encoded.length % 4 === 1) {
    return fail('分享链接包含无效的 Base64 数据。');
  }
  while (encoded.length % 4 !== 0) {
    encoded += '=';
  }
  try {
    const bytes = new util.Base64Helper().decodeSync(encoded);
    return util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(bytes);
  } catch (err) {
    return fail('分享链接的 Base64 / UTF-8 数据无法解码。');
  }
}

function nameOf(value: string, protocol: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length > 0 ? cleaned.substring(0, 100) : protocol.toUpperCase() + ' 节点';
}

function parseQuery(text: string): Map<string, string> {
  const result = new Map<string, string>();
  if (text.length === 0) {
    return result;
  }
  for (const part of text.split('&')) {
    const equal = part.indexOf('=');
    if (equal <= 0) {
      fail('查询参数必须采用键=值格式。');
    }
    const key = percentDecode(part.substring(0, equal));
    if (result.has(key)) {
      fail('分享链接包含重复查询参数，请使用无歧义的单节点链接。');
    }
    result.set(key, percentDecode(part.substring(equal + 1)));
  }
  return result;
}

function splitShare(text: string): ShareParts {
  const result = new ShareParts();
  let body = text.substring(text.indexOf('://') + 3);
  const hash = body.indexOf('#');
  if (hash >= 0) {
    result.name = percentDecode(body.substring(hash + 1));
    body = body.substring(0, hash);
  }
  const question = body.indexOf('?');
  if (question >= 0) {
    result.query = parseQuery(body.substring(question + 1));
    body = body.substring(0, question);
  }
  if (body.endsWith('/')) {
    body = body.substring(0, body.length - 1);
  }
  const at = body.lastIndexOf('@');
  if (at <= 0 || body.indexOf('@') !== at) {
    return fail('分享链接缺少认证信息或服务器地址。');
  }
  result.userInfo = percentDecode(body.substring(0, at));
  const endpoint = body.substring(at + 1);
  const match = /^(\[[^\]]+\]|[^:]+):([0-9]+)$/.exec(endpoint);
  if (match === null) {
    return fail('服务器地址必须带端口；IPv6 地址需要使用方括号。');
  }
  result.address = readHost(match[1]);
  result.port = readPort(match[2]);
  return result;
}

function get(query: Map<string, string>, key: string, fallback: string = ''): string {
  const value = query.get(key);
  return value === undefined ? fallback : value;
}

function hasValue(query: Map<string, string>, keys: string[]): boolean {
  for (const key of keys) {
    if (get(query, key).length > 0) {
      return true;
    }
  }
  return false;
}

function checkQuery(query: Map<string, string>): void {
  query.forEach((value: string, key: string) => {
    if (QUERY_KEYS.indexOf(key) < 0) {
      fail('分享链接包含首版尚未支持的查询参数，请导入受支持的单节点配置。');
    }
    if (INSECURE_KEYS.indexOf(key.toLowerCase()) >= 0 && value !== '0' && value !== 'false') {
      fail('首版不接受跳过服务器证书校验的配置。');
    }
  });
}

function streamFromQuery(query: Map<string, string>, protocol: string): StreamConfig {
  checkQuery(query);
  const network = get(query, 'type', 'tcp');
  const security = get(query, 'security', protocol === 'trojan' ? 'tls' : 'none');
  if (NETWORKS.indexOf(network) < 0) {
    return fail('首版仅支持 TCP / RAW、WebSocket 和 gRPC 传输。');
  }
  if (['none', 'tls', 'reality'].indexOf(security) < 0) {
    return fail('首版仅支持 none、TLS 和 REALITY 传输安全配置。');
  }
  if (protocol === 'trojan' && security === 'none') {
    return fail('Trojan 节点需要启用 TLS 或 REALITY。');
  }
  if (get(query, 'headerType', 'none') !== 'none' && get(query, 'headerType') !== '') {
    return fail('首版不支持 HTTP 伪装头。');
  }
  const stream: StreamConfig = { network: network, security: security };
  if (network === 'ws') {
    if (hasValue(query, ['serviceName', 'authority', 'mode'])) {
      return fail('WebSocket 节点包含不适用的 gRPC 参数。');
    }
    const path = get(query, 'path', '/') || '/';
    if (!path.startsWith('/')) {
      return fail('WebSocket 路径必须以 / 开头。');
    }
    const ws: WsConfig = { path: path };
    const host = get(query, 'host');
    if (host.length > 0) {
      if (/[\r\n]/.test(host)) {
        return fail('WebSocket Host 不允许包含换行。');
      }
      ws.host = host;
    }
    stream.wsSettings = ws;
  } else if (network === 'grpc') {
    if (hasValue(query, ['host', 'path'])) {
      return fail('gRPC 请使用 serviceName / authority 参数。');
    }
    const mode = get(query, 'mode', 'gun');
    if (mode !== 'gun' && mode !== 'multi') {
      return fail('gRPC mode 仅支持 gun 或 multi。');
    }
    const grpc: GrpcConfig = { serviceName: get(query, 'serviceName'), multiMode: mode === 'multi' };
    if (get(query, 'authority').length > 0) {
      grpc.authority = get(query, 'authority');
    }
    stream.grpcSettings = grpc;
  } else if (hasValue(query, ['host', 'path', 'serviceName', 'authority', 'mode'])) {
    return fail('普通 TCP / RAW 节点不接受路径、伪装 Host 或 gRPC 参数。');
  }
  if (security === 'tls') {
    if (hasValue(query, ['pbk', 'sid', 'spx'])) {
      return fail('TLS 节点包含不适用的 REALITY 参数。');
    }
    const tls: TlsConfig = { allowInsecure: false };
    if (get(query, 'sni').length > 0) {
      tls.serverName = get(query, 'sni');
    }
    if (get(query, 'fp').length > 0) {
      tls.fingerprint = get(query, 'fp');
    }
    if (get(query, 'alpn').length > 0) {
      const alpn = get(query, 'alpn').split(',');
      for (const item of alpn) {
        if (item.length === 0 || /[\s\u0000-\u001f]/.test(item)) {
          return fail('ALPN 必须是逗号分隔的非空协议名称。');
        }
      }
      tls.alpn = alpn;
    }
    stream.tlsSettings = tls;
  } else if (security === 'reality') {
    if (network === 'ws' || get(query, 'alpn').length > 0) {
      return fail('REALITY 不支持 WebSocket 或此链接中的 ALPN 参数。');
    }
    const key = get(query, 'pbk');
    const shortId = get(query, 'sid');
    const sni = get(query, 'sni');
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || sni.length === 0) {
      return fail('REALITY 需要有效的 pbk 公钥和 sni。');
    }
    if (!/^(?:[0-9a-fA-F]{2}){0,8}$/.test(shortId)) {
      return fail('REALITY sid 必须是最长 16 位、偶数长度的十六进制字符串。');
    }
    const reality: RealityConfig = { serverName: sni, fingerprint: get(query, 'fp', 'chrome') || 'chrome',
      publicKey: key, shortId: shortId };
    if (get(query, 'spx').length > 0) {
      reality.spiderX = get(query, 'spx');
    }
    stream.realitySettings = reality;
  } else if (hasValue(query, ['sni', 'fp', 'alpn', 'pbk', 'sid', 'spx'])) {
    return fail('未启用 TLS / REALITY，却提供了对应的安全参数。');
  }
  return stream;
}

function checkFlow(flow: string, stream: StreamConfig): void {
  if (flow.length === 0) {
    return;
  }
  if (flow !== 'xtls-rprx-vision' && flow !== 'xtls-rprx-vision-udp443') {
    fail('首版仅支持空 flow 或 XTLS Vision flow。');
  }
  const network = stream.network || 'tcp';
  if ((network !== 'tcp' && network !== 'raw') ||
    (stream.security !== 'tls' && stream.security !== 'reality')) {
    fail('XTLS Vision 需要 TCP / RAW 加 TLS 或 REALITY。');
  }
}

function parseVlessTrojan(text: string, protocol: string): ImportedNode {
  const share = splitShare(text);
  const stream = streamFromQuery(share.query, protocol);
  let settings: OutboundSettings;
  if (protocol === 'vless') {
    requireUuid(share.userInfo);
    if (get(share.query, 'encryption', 'none') !== 'none') {
      return fail('当前 Xray 核心的 VLESS encryption 仅支持 none。');
    }
    const user: UserConfig = { id: share.userInfo, encryption: 'none' };
    const flow = get(share.query, 'flow');
    checkFlow(flow, stream);
    if (flow.length > 0) {
      user.flow = flow;
    }
    const server: ServerConfig = { address: share.address, port: share.port, users: [user] };
    settings = { vnext: [server] };
  } else {
    if (hasValue(share.query, ['encryption', 'flow'])) {
      return fail('Trojan 节点不接受 VLESS encryption / flow 参数。');
    }
    const server: ServerConfig = { address: share.address, port: share.port,
      password: requireSecret(share.userInfo) };
    settings = { servers: [server] };
  }
  const outbound: OutboundConfig = { protocol: protocol, settings: settings, streamSettings: stream };
  return new ImportedNode(nameOf(share.name, protocol), protocol, JSON.stringify(outbound));
}

function knownKeys(value: Object, allowed: string[], message: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.indexOf(key) < 0) {
      fail(message);
    }
  }
}

// Walk JSON string tokens (not a regex over raw secrets). Only tokens followed by ':'
// are keys. This also catches escaped key spellings at arbitrary nesting depth.
function checkSensitiveJsonOptions(json: string): void {
  let index = 0;
  while (index < json.length) {
    if (json[index] !== '"') {
      index++;
      continue;
    }
    const start = index++;
    while (index < json.length) {
      if (json[index] === '\\') {
        index += 2;
      } else if (json[index++] === '"') {
        break;
      }
    }
    const key: string = JSON.parse(json.substring(start, index)) as string;
    let next = index;
    while (/\s/.test(json[next] || '') && next < json.length) {
      next++;
    }
    if (json[next] !== ':') {
      continue;
    }
    const lower = key.toLowerCase();
    if (INSECURE_KEYS.indexOf(lower) >= 0) {
      const value = json.substring(next + 1).trimStart();
      if (!/^(false|0|"false"|"0")\s*[,}]/.test(value)) {
        fail('首版不接受跳过服务器证书校验的配置。');
      }
    }
    if (['plugin', 'proxysettings', 'dialerproxy', 'masterkeylog'].indexOf(lower) >= 0) {
      fail('首版不支持插件、链式代理或 TLS 密钥日志配置。');
    }
  }
}

function parseVmess(text: string): ImportedNode {
  const decoded = base64Text(text.substring(8));
  let share: VmessShare;
  try {
    share = JSON.parse(decoded) as VmessShare;
  } catch (err) {
    return fail('VMess 链接必须包含 Base64 编码的 JSON 对象。');
  }
  requireObject(share, 'VMess 数据必须是单个 JSON 对象。');
  knownKeys(share, ['v', 'ps', 'add', 'port', 'id', 'aid', 'scy', 'net', 'type', 'host', 'path', 'tls', 'sni',
    'fp', 'alpn', 'insecure'], 'VMess 数据包含首版未支持的字段。');
  checkSensitiveJsonOptions(JSON.stringify(share));
  if (share.v !== undefined && share.v !== '2' && share.v !== 2) {
    return fail('首版仅支持 VMess v2 分享格式。');
  }
  if (share.aid !== undefined && share.aid !== '0' && share.aid !== 0 && share.aid !== '') {
    return fail('首版仅支持 VMess AEAD（aid=0）。');
  }
  requireUuid(share.id);
  const cipher = optionalString(share.scy) || 'auto';
  if (['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'].indexOf(cipher) < 0) {
    return fail('VMess 加密方式不受支持。');
  }
  const query = new Map<string, string>();
  const network = optionalString(share.net) || 'tcp';
  query.set('type', network);
  query.set('security', optionalString(share.tls) || 'none');
  query.set('sni', optionalString(share.sni));
  query.set('fp', optionalString(share.fp));
  query.set('alpn', optionalString(share.alpn));
  if (network === 'grpc') {
    query.set('serviceName', optionalString(share.path));
    query.set('authority', optionalString(share.host));
    const mode = optionalString(share.type);
    query.set('mode', mode === '' || mode === 'none' ? 'gun' : mode);
  } else {
    query.set('path', optionalString(share.path));
    query.set('host', optionalString(share.host));
    query.set('headerType', optionalString(share.type) || 'none');
  }
  const stream = streamFromQuery(query, 'vmess');
  const user: UserConfig = { id: share.id, alterId: 0, security: cipher };
  const server: ServerConfig = { address: readHost(share.add), port: readPort(share.port), users: [user] };
  const settings: OutboundSettings = { vnext: [server] };
  const outbound: OutboundConfig = { protocol: 'vmess', settings: settings, streamSettings: stream };
  return new ImportedNode(nameOf(optionalString(share.ps), 'vmess'), 'vmess', JSON.stringify(outbound));
}

function checkSsMethod(method: string): void {
  if (SS_METHODS.indexOf(method) < 0) {
    fail('首版 Shadowsocks 仅支持 AEAD 和 2022 系列加密方式。');
  }
}

function parseShadowsocks(text: string): ImportedNode {
  const share = splitShare(text);
  if (share.query.size > 0) {
    return fail('首版 Shadowsocks 不支持 SIP003 插件或其他查询参数。');
  }
  const info = share.userInfo.indexOf(':') >= 0 ? share.userInfo : base64Text(share.userInfo);
  const colon = info.indexOf(':');
  if (colon <= 0) {
    return fail('Shadowsocks 认证信息应包含 method:password。');
  }
  const method = info.substring(0, colon);
  checkSsMethod(method);
  const server: ServerConfig = { address: share.address, port: share.port, method: method,
    password: requireSecret(info.substring(colon + 1)) };
  const settings: OutboundSettings = { servers: [server] };
  const outbound: OutboundConfig = { protocol: 'shadowsocks', settings: settings };
  return new ImportedNode(nameOf(share.name, 'shadowsocks'), 'shadowsocks', JSON.stringify(outbound));
}

function checkOutboundStream(stream: StreamConfig | undefined): StreamConfig {
  if (stream === undefined) {
    const empty: StreamConfig = { network: 'tcp', security: 'none' };
    return empty;
  }
  requireObject(stream, 'streamSettings 必须是 JSON 对象。');
  knownKeys(stream, ['network', 'security', 'tlsSettings', 'realitySettings', 'wsSettings', 'grpcSettings',
    'tcpSettings', 'rawSettings', 'sockopt'], 'streamSettings 包含首版未支持的字段或传输。');
  const network = optionalString(stream.network) || 'tcp';
  if (NETWORKS.indexOf(network) < 0) {
    return fail('首版仅支持 TCP / RAW、WebSocket 和 gRPC 传输。');
  }
  const security = optionalString(stream.security) || 'none';
  if (['none', 'tls', 'reality'].indexOf(security) < 0) {
    return fail('该传输安全配置不受支持。');
  }
  if ((stream.wsSettings !== undefined && network !== 'ws') ||
    (stream.grpcSettings !== undefined && network !== 'grpc') ||
    ((stream.tcpSettings !== undefined || stream.rawSettings !== undefined) && network !== 'tcp' && network !== 'raw') ||
    (stream.tlsSettings !== undefined && security !== 'tls') ||
    (stream.realitySettings !== undefined && security !== 'reality')) {
    return fail('传输设置与 network / security 不匹配，配置不会被静默忽略。');
  }
  if (security === 'reality') {
    const reality = stream.realitySettings;
    requireObject(reality, 'REALITY 缺少设置对象。');
    if (reality === undefined || network === 'ws') {
      return fail('REALITY 不支持 WebSocket。');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(requireSecret(reality.publicKey)) ||
      !/^(?:[0-9a-fA-F]{2}){0,8}$/.test(optionalString(reality.shortId))) {
      return fail('REALITY 公钥或 shortId 格式不正确。');
    }
    requireSecret(reality.serverName);
    requireSecret(reality.fingerprint);
    if (reality.mldsa65Verify !== undefined && reality.mldsa65Verify !== '') {
      return fail('当前导入器尚未验证非空 mldsa65Verify，暂不接受此配置，也不会忽略该校验。');
    }
  }
  return stream;
}

function parseOutbound(text: string): ImportedNode {
  let outbound: OutboundConfig;
  try {
    outbound = JSON.parse(text) as OutboundConfig;
  } catch (err) {
    return fail('JSON 解析失败，请使用无注释、无尾逗号的单个 outbound 对象。');
  }
  requireObject(outbound, '请导入单个 outbound JSON 对象。');
  knownKeys(outbound, ['protocol', 'settings', 'streamSettings', 'mux', 'tag', 'sendThrough'],
    '仅接受单个 outbound；完整配置、路由、DNS、入站或链式代理配置暂不支持。');
  const protocol = optionalString(outbound.protocol);
  if (['vless', 'vmess', 'trojan', 'shadowsocks'].indexOf(protocol) < 0) {
    return fail('单 outbound 目前仅支持 VLESS、VMess、Trojan 和 Shadowsocks。');
  }
  requireObject(outbound.settings, 'outbound 缺少 settings 对象。');
  const isUuid = protocol === 'vless' || protocol === 'vmess';
  knownKeys(outbound.settings, isUuid ? ['vnext'] : ['servers'],
    'settings 必须使用受支持的 vnext / servers 结构。');
  const servers = isUuid ? outbound.settings.vnext : outbound.settings.servers;
  if (!Array.isArray(servers) || servers === undefined || servers.length !== 1) {
    return fail('首版单 outbound 必须恰好配置一个服务器。');
  }
  const server = servers[0];
  requireObject(server, '服务器配置必须是 JSON 对象。');
  readHost(server.address);
  if (typeof server.port !== 'number') {
    return fail('outbound JSON 中的端口必须是数字。');
  }
  readPort(server.port);
  const stream = checkOutboundStream(outbound.streamSettings);
  if (isUuid) {
    if (!Array.isArray(server.users) || server.users === undefined || server.users.length !== 1) {
      return fail('首版服务器必须恰好配置一个用户。');
    }
    const user = server.users[0];
    requireObject(user, '用户配置必须是 JSON 对象。');
    requireUuid(user.id);
    if (protocol === 'vless') {
      if (user.encryption !== 'none') {
        return fail('当前核心的 VLESS encryption 必须为 none。');
      }
      checkFlow(optionalString(user.flow), stream);
    } else if (user.alterId !== undefined && user.alterId !== 0) {
      return fail('首版仅支持 VMess AEAD（alterId=0）。');
    }
  } else {
    requireSecret(server.password);
    if (protocol === 'trojan' && stream.security !== 'tls' && stream.security !== 'reality') {
      return fail('Trojan 节点需要启用 TLS 或 REALITY。');
    }
    if (protocol === 'shadowsocks') {
      checkSsMethod(requireSecret(server.method));
    }
  }
  const canonical = JSON.stringify(outbound);
  checkSensitiveJsonOptions(canonical);
  return new ImportedNode(nameOf(optionalString(outbound.tag), protocol), protocol, canonical);
}

export function parseNode(text: string): ImportedNode {
  const input = text.trim();
  if (input.length === 0 || input.length > 131072) {
    return fail('请粘贴一个节点，长度不能超过 131072 个字符。');
  }
  if (input.startsWith('{')) {
    return parseOutbound(input);
  }
  if (/[\r\n\s]/.test(input)) {
    return fail('请一次导入一个分享链接，链接中的空格需要百分号编码。');
  }
  if (input.startsWith('vless://')) {
    return parseVlessTrojan(input, 'vless');
  }
  if (input.startsWith('trojan://')) {
    return parseVlessTrojan(input, 'trojan');
  }
  if (input.startsWith('vmess://')) {
    return parseVmess(input);
  }
  if (input.startsWith('ss://')) {
    return parseShadowsocks(input);
  }
  return fail('支持单个 VLESS、Trojan、VMess、Shadowsocks SIP002 链接或 Xray outbound JSON；暂不支持订阅。');
}
