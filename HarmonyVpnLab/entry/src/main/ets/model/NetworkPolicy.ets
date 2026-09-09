import { isBootstrapIpv4Address, normalizeBootstrapHost } from './NodeBootstrap';

// Pure policy validation. The saved policy never embeds a complete core config.
export class NetworkPolicy {
  schemaVersion: number = 1;
  mode: string = 'global';
  bypassLan: boolean = false;
  direct: string[] = [];
  proxy: string[] = [];
  block: string[] = [];
  dnsUrl: string = 'https://1.1.1.1/dns-query';
}

export class RoutingRule {
  type: string = 'field';
  inboundTag: string[] = ['connection-in'];
  domain?: string[];
  ip?: string[];
  outboundTag: string;
  constructor(tag: string) { this.outboundTag = tag; }
}

export function normalizeRoutingEntry(value: string): string {
  if (typeof value !== 'string' || value.length > 260) { throw new Error('分流条目格式无效。'); }
  const text = value.trim().toLowerCase();
  if (/^[0-9.]+(?:\/[0-9]+)?$/.test(text)) {
    const parts = text.split('/');
    if (!isBootstrapIpv4Address(parts[0]) || (parts.length === 2 &&
      (!/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1])))) { throw new Error('请使用标准 IPv4 地址或 CIDR 网段。'); }
    if (parts.length === 1) { return parts[0]; }
    const octets = parts[0].split('.').map((part: string) => Number(part));
    const ip = ((octets[0] * 16777216) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
    const prefix = Number(parts[1]);
    const network = (ip & (prefix === 0 ? 0 : 0xffffffff << (32 - prefix))) >>> 0;
    return `${network >>> 24}.${(network >>> 16) & 255}.${(network >>> 8) & 255}.${network & 255}/${prefix}`;
  }
  const exact = text.startsWith('full:');
  const host = exact ? text.substring(5) : text.startsWith('domain:') ? text.substring(7) : text;
  try {
    const normalized = normalizeBootstrapHost(host);
    if (isBootstrapIpv4Address(normalized)) { throw new Error('domain'); }
    return `${exact ? 'full' : 'domain'}:${normalized}`;
  } catch (_) { throw new Error('分流域名无效；支持普通域名、domain:域名、full:域名和 IPv4 网段。'); }
}

export function parseRoutingEntries(text: string): string[] {
  if (typeof text !== 'string' || text.length > 16384) { throw new Error('分流列表过长。'); }
  const items = text.split(/[\r\n,]+/).map((item: string) => item.trim()).filter((item: string) => item.length > 0);
  if (items.length > 300) { throw new Error('每类分流最多 300 条。'); }
  const result: string[] = [];
  for (const item of items) {
    const normalized = normalizeRoutingEntry(item);
    if (!result.includes(normalized)) { result.push(normalized); }
  }
  return result;
}

export function policyDnsHost(url: string): string {
  // Deliberately do not accept user info, fragments, escaped authorities or local schemes.
  if (typeof url !== 'string' || url.length > 2048 || /[\u0000-\u0020\u007f\\#]/.test(url) || /%(?![0-9a-fA-F]{2})/.test(url)) {
    throw new Error('DNS 地址需为有效的 HTTPS URL。');
  }
  const match = /^https:\/\/([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(\/[^#]*)$/.exec(url);
  if (!match || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
    throw new Error('DNS 地址需包含 HTTPS 域名或 IPv4 地址及路径，不支持账号、片段或 IPv6 地址。');
  }
  try { return normalizeBootstrapHost(match[1]); }
  catch (_) { throw new Error('DNS 服务器地址格式无效。'); }
}

export function validateNetworkPolicy(value: NetworkPolicy): NetworkPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('网络设置格式无效。'); }
  const keys = ['schemaVersion', 'mode', 'bypassLan', 'direct', 'proxy', 'block', 'dnsUrl'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key: string) => !keys.includes(key)) ||
    value.schemaVersion !== 1 || !['global', 'rules'].includes(value.mode) || typeof value.bypassLan !== 'boolean') {
    throw new Error('网络设置格式或版本无效。');
  }
  const result = new NetworkPolicy();
  result.mode = value.mode; result.bypassLan = value.bypassLan;
  const lists: string[][] = [value.direct, value.proxy, value.block];
  const normalized: string[][] = [];
  for (const list of lists) {
    if (!Array.isArray(list) || list.length > 300 || list.some((item: string) => typeof item !== 'string')) {
      throw new Error('分流列表格式无效。');
    }
    normalized.push(parseRoutingEntries(list.join('\n')));
  }
  result.direct = normalized[0]; result.proxy = normalized[1]; result.block = normalized[2];
  if (result.direct.length + result.proxy.length + result.block.length > 300) { throw new Error('分流条目合计最多 300 条。'); }
  policyDnsHost(value.dnsUrl);
  result.dnsUrl = value.dnsUrl;
  return result;
}

function appendRules(result: RoutingRule[], entries: string[], tag: string): void {
  const domains = entries.filter((item: string) => item.startsWith('domain:') || item.startsWith('full:'));
  const ips = entries.filter((item: string) => !item.startsWith('domain:') && !item.startsWith('full:'));
  // Xray combines different fields with AND; separate domain/IP rules implement OR.
  if (domains.length > 0) { const rule = new RoutingRule(tag); rule.domain = domains; result.push(rule); }
  if (ips.length > 0) { const rule = new RoutingRule(tag); rule.ip = ips; result.push(rule); }
}

export function policyRoutingRules(policy: NetworkPolicy): RoutingRule[] {
  const checked = validateNetworkPolicy(policy);
  const rules: RoutingRule[] = [];
  if (checked.mode !== 'rules') { return rules; }
  appendRules(rules, checked.block, 'rule-block');
  appendRules(rules, checked.proxy, 'nodeProxy');
  appendRules(rules, checked.direct, 'direct');
  if (checked.bypassLan) {
    appendRules(rules, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'], 'direct');
  }
  return rules;
}

export function networkPolicyLabel(policy: NetworkPolicy): string {
  return policy.mode === 'global' ? '全部代理' : policy.bypassLan ? '规则分流 · 绕过局域网' : '规则分流';
}
