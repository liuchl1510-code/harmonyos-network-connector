// Pure configuration construction, also used by offline synthetic acceptance.
import { NodeBootstrap, isBootstrapIpv4Address, normalizeBootstrapHost } from './NodeBootstrap';

export const CONNECTION_DNS_ADDRESS: string = '198.18.0.1';
export const CONNECTION_DOH_URL: string = 'https://1.1.1.1/dns-query';

interface ConnectionServer { address: string; port: number; }
interface ConnectionServerSettings { vnext?: ConnectionServer[]; servers?: ConnectionServer[]; }
interface ConnectionReality { show?: boolean; }
interface ConnectionTls { echConfigList?: string; echSockopt?: Object; }
interface ConnectionSockopt { domainStrategy?: string; addressPortStrategy?: string; }
interface ConnectionStream {
  realitySettings?: ConnectionReality;
  tlsSettings?: ConnectionTls;
  sockopt?: ConnectionSockopt;
}
interface ConnectionOutbound {
  protocol: string;
  tag?: string;
  settings: ConnectionServerSettings;
  streamSettings?: ConnectionStream;
}

export function isConnectionIpv4Address(address: string): boolean {
  return isBootstrapIpv4Address(address);
}

function checkConnectionBootstrapOptions(stream: ConnectionStream | undefined): void {
  if (stream === undefined) { return; }
  if (stream === null || typeof stream !== 'object' || Array.isArray(stream)) {
    throw new Error('节点传输设置格式无效');
  }
  const sockopt = stream.sockopt;
  if (sockopt !== undefined) {
    if (sockopt === null || typeof sockopt !== 'object' || Array.isArray(sockopt)) {
      throw new Error('节点 Socket 设置格式无效');
    }
    for (const key of Object.keys(sockopt)) {
      // Go's JSON decoder also accepts case-insensitive field names. Do not let
      // an alternate spelling bypass the typed-field checks below.
      if (key.toLowerCase() === 'addressportstrategy' && key !== 'addressPortStrategy') {
        throw new Error('节点地址重写选项需要使用受支持的字段格式');
      }
      if (key.toLowerCase() === 'domainstrategy' && key !== 'domainStrategy') {
        throw new Error('节点域名解析选项需要使用受支持的字段格式');
      }
    }
    const strategy = sockopt.addressPortStrategy;
    if (strategy !== undefined && (typeof strategy !== 'string' ||
      (strategy !== '' && strategy.toLowerCase() !== 'none'))) {
      throw new Error('持续连接暂不支持 SRV / TXT 地址或端口重写');
    }
  }
  const tls = stream.tlsSettings;
  if (tls !== undefined) {
    if (tls === null || typeof tls !== 'object' || Array.isArray(tls)) {
      throw new Error('节点 TLS 设置格式无效');
    }
    for (const key of Object.keys(tls)) {
      if ((key.toLowerCase() === 'echconfiglist' && key !== 'echConfigList') ||
        (key.toLowerCase() === 'echsockopt' && key !== 'echSockopt')) {
        throw new Error('持续连接暂不支持此 ECH 配置字段格式');
      }
    }
    if ((tls.echConfigList !== undefined && tls.echConfigList !== '') ||
      (tls.echSockopt !== undefined && (tls.echSockopt === null || typeof tls.echSockopt !== 'object' ||
        Array.isArray(tls.echSockopt) || Object.keys(tls.echSockopt).length > 0))) {
      throw new Error('持续连接暂不支持 ECH 的额外配置或解析路径');
    }
  }
}

export function buildConnectionConfig(outboundJson: string, socksPort: number,
  metricsPort: number, errorPath: string, bootstrap?: NodeBootstrap): string {
  if (!Number.isInteger(socksPort) || !Number.isInteger(metricsPort) || socksPort < 1 || socksPort > 65535 ||
    metricsPort < 1 || metricsPort > 65535 || socksPort === metricsPort) {
    throw new Error('连接核心端口配置无效');
  }
  let outbound: ConnectionOutbound;
  try { outbound = JSON.parse(outboundJson) as ConnectionOutbound; }
  catch (_) { throw new Error('保存的节点 JSON 无效'); }
  if (!outbound || !outbound.settings || ['vless', 'vmess', 'trojan', 'shadowsocks'].indexOf(outbound.protocol) < 0) {
    throw new Error('持续连接需要受支持的单个代理节点');
  }
  const servers = outbound.protocol === 'vless' || outbound.protocol === 'vmess'
    ? outbound.settings.vnext : outbound.settings.servers;
  if (!Array.isArray(servers) || servers === undefined || servers.length !== 1 ||
    !servers[0] || typeof servers[0].address !== 'string') {
    throw new Error('持续连接需要唯一的服务器地址');
  }
  const host = normalizeBootstrapHost(servers[0].address);
  const isIpv4 = isConnectionIpv4Address(host);
  checkConnectionBootstrapOptions(outbound.streamSettings);
  if (bootstrap !== undefined && (!bootstrap || bootstrap.host !== host ||
    !isConnectionIpv4Address(bootstrap.ipv4) || (isIpv4 && bootstrap.ipv4 !== host))) {
    throw new Error('节点 IPv4 预解析结果与当前节点不匹配');
  }
  let hostsJSON = '';
  if (!isIpv4) {
    if (bootstrap === undefined) { throw new Error('域名节点需要先完成 IPv4 预解析'); }
    // Preserve the original endpoint so default SNI, WS Host and gRPC authority
    // remain intact. DialSystem changes only its local destination value to IP.
    hostsJSON = `"hosts":{${JSON.stringify('full:' + host)}:${JSON.stringify(bootstrap.ipv4)}},`;
    if (outbound.streamSettings === undefined) { outbound.streamSettings = {}; }
    if (outbound.streamSettings.sockopt === undefined) { outbound.streamSettings.sockopt = {}; }
    // UseIPv4 falls through to system DNS after a lookup failure; ForceIPv4 does not.
    outbound.streamSettings.sockopt.domainStrategy = 'ForceIPv4';
  }
  outbound.tag = 'nodeProxy';
  if (outbound.streamSettings?.realitySettings) {
    outbound.streamSettings.realitySettings.show = false;
  }
  // The ordinary HTTPS scheme invokes Xray's routing dispatcher. +local would
  // bypass it and is deliberately absent. A match-all server rule and the sole
  // fixed IP endpoint keep DNS selection independent of system DNS/hosts.
  // This first IPv4 client serves A records, empty AAAA and empty non-IP replies.
  // No DNS 'direct' rule is present, so non-IP questions cannot create a local
  // UDP/TCP fallback connection from the DNS outbound.
  return `{"log":{"loglevel":"info","access":"none","error":${JSON.stringify(errorPath)}},` +
    `"stats":{},"policy":{"system":{"statsOutboundUplink":true,"statsOutboundDownlink":true}},` +
    `"dns":{"tag":"dns-via-node","queryStrategy":"UseIPv4","useSystemHosts":false,${hostsJSON}` +
    `"disableFallback":true,"disableFallbackIfMatch":true,"servers":[{` +
    `"address":"${CONNECTION_DOH_URL}","domains":["regexp:.*"],"skipFallback":true,"queryStrategy":"UseIPv4"}]},` +
    `"inbounds":[{"tag":"connection-in","listen":"127.0.0.1","port":${socksPort},` +
    `"protocol":"socks","settings":{"auth":"noauth","udp":true}}],` +
    `"outbounds":[${JSON.stringify(outbound)},` +
    `{"tag":"dns-out","protocol":"dns","settings":{"rules":[` +
    `{"action":"return","qType":"28","rCode":0},` +
    `{"action":"hijack","qType":"1"},{"action":"return","rCode":0}]}},` +
    `{"tag":"block-ipv6","protocol":"blackhole","settings":{}},` +
    `{"tag":"block-virtual","protocol":"blackhole","settings":{}}],` +
    `"routing":{"domainStrategy":"AsIs","rules":[` +
    `{"type":"field","ip":["::/0"],"outboundTag":"block-ipv6"},` +
    `{"type":"field","inboundTag":["dns-via-node"],"outboundTag":"nodeProxy"},` +
    `{"type":"field","inboundTag":["connection-in"],"network":"tcp,udp","port":"53","outboundTag":"dns-out"},` +
    `{"type":"field","inboundTag":["connection-in"],"ip":["198.18.0.0/30"],"outboundTag":"block-virtual"},` +
    `{"type":"field","inboundTag":["connection-in"],"network":"tcp,udp","outboundTag":"nodeProxy"}]}}`;
}
