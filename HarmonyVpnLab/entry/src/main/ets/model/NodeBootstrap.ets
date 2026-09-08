// Pure, session-local endpoint binding. No resolver, storage or network API.
export function isBootstrapIpv4Address(address: string): boolean {
  if (typeof address !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(address)) { return false; }
  for (const part of address.split('.')) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255 || String(value) !== part) { return false; }
  }
  return true;
}

export function normalizeBootstrapHost(host: string): string {
  if (typeof host !== 'string' || host.length === 0 || /[^\x21-\x7e]/.test(host)) {
    throw new Error('节点服务器地址格式不受支持');
  }
  if (isBootstrapIpv4Address(host)) { return host; }
  // Numeric shorthand and padded octets must not be reinterpreted by a resolver.
  if (/^[0-9.]+$/.test(host)) { throw new Error('节点 IPv4 地址必须使用标准四段十进制格式'); }
  const normalized = (host.endsWith('.') ? host.substring(0, host.length - 1) : host).toLowerCase();
  if (normalized.length === 0 || normalized.length > 253) {
    throw new Error('节点域名长度不受支持');
  }
  for (const label of normalized.split('.')) {
    if (label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new Error('节点域名必须使用有效的 ASCII DNS 标签');
    }
  }
  return normalized;
}

export class NodeBootstrap {
  host: string;
  ipv4: string;

  constructor(host: string, ipv4: string) {
    this.host = normalizeBootstrapHost(host);
    if (!isBootstrapIpv4Address(ipv4)) { throw new Error('节点预解析结果必须是有效的 IPv4 地址'); }
    if (isBootstrapIpv4Address(this.host) && this.host !== ipv4) {
      throw new Error('节点预解析结果与 IPv4 服务器地址不一致');
    }
    this.ipv4 = ipv4;
  }
}

interface BootstrapServer { address: string; }
interface BootstrapSettings { vnext?: BootstrapServer[]; servers?: BootstrapServer[]; }
interface BootstrapOutbound { protocol: string; settings: BootstrapSettings; }

export function createNodeBootstrap(outboundJson: string, ipv4: string): NodeBootstrap {
  let outbound: BootstrapOutbound;
  try { outbound = JSON.parse(outboundJson) as BootstrapOutbound; }
  catch (_) { throw new Error('保存的节点 JSON 无效'); }
  if (!outbound || !outbound.settings || ['vless', 'vmess', 'trojan', 'shadowsocks'].indexOf(outbound.protocol) < 0) {
    throw new Error('节点预解析需要受支持的单个代理节点');
  }
  const servers = outbound.protocol === 'vless' || outbound.protocol === 'vmess'
    ? outbound.settings.vnext : outbound.settings.servers;
  if (!Array.isArray(servers) || servers === undefined || servers.length !== 1 ||
    !servers[0] || typeof servers[0].address !== 'string') {
    throw new Error('节点预解析需要唯一的服务器地址');
  }
  return new NodeBootstrap(servers[0].address, ipv4);
}
