import { NetworkPolicy, validateNetworkPolicy } from './NetworkPolicy';

export const DNS_FAULT_ADMISSION_MS: number = 30000;
export const DNS_FAULT_NORMAL_URL: string = 'https://223.5.5.5/dns-query';
export const DNS_FAULT_HTTP404_URL: string = 'https://223.5.5.5/harmony-vpn-dns-invalid-path';

export class DnsFaultRequest {
  kind: string;
  token: string;
  createdAt: number;
  constructor(kind: string, token: string, createdAt: number = Date.now()) {
    this.kind = kind; this.token = token; this.createdAt = createdAt;
  }
}

export function isDnsFaultKind(kind: string): boolean {
  return kind === 'baseline' || kind === 'http404' || kind === 'timeout';
}

// Shape validation is separate from admission: a service may retain a valid
// descriptor after its short start window has elapsed, without admitting it again.
export function validDnsFaultRequestShape(value: DnsFaultRequest): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const keys = Object.keys(value);
  return keys.length === 3 && keys.every((key: string) => ['kind', 'token', 'createdAt'].includes(key)) &&
    typeof value.kind === 'string' && isDnsFaultKind(value.kind) &&
    typeof value.token === 'string' && value.token.length >= 8 && value.token.length <= 40 &&
    !/[^A-Za-z0-9]/.test(value.token) &&
    Number.isSafeInteger(value.createdAt) && value.createdAt >= 0;
}

export function validDnsFaultAdmission(value: DnsFaultRequest, now: number = Date.now()): boolean {
  if (!validDnsFaultRequestShape(value) || !Number.isSafeInteger(now) || now < 0) { return false; }
  const age = now - value.createdAt;
  return age >= 0 && age <= DNS_FAULT_ADMISSION_MS;
}

// This returns an independent runtime policy only. It never saves preferences
// and never accepts a caller-supplied test URL, port or complete core config.
export function createDnsFaultPolicy(original: NetworkPolicy, kind: string): NetworkPolicy {
  if (!isDnsFaultKind(kind)) { throw new Error('DNS 故障测试类型无效。'); }
  const policy = validateNetworkPolicy(original);
  policy.mode = 'whitelist'; policy.dnsMode = 'split';
  policy.directDnsUrl = kind === 'http404' ? DNS_FAULT_HTTP404_URL : DNS_FAULT_NORMAL_URL;
  return policy;
}
