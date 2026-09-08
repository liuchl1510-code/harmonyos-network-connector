import { connection } from '@kit.NetworkKit';
import { systemDateTime } from '@kit.BasicServicesKit';

const API_TIMEOUT_MS: number = 5000;
const RESOLVE_TIMEOUT_MS: number = 10000;
const CANCEL_POLL_MS: number = 200;
const LOOKUP_FAILED: string = '节点域名解析失败';
const LOOKUP_TIMEOUT: string = '节点域名解析超时（总时限 10 秒）';
const LOOKUP_CANCELLED: string = '节点域名解析已取消';
const NETWORK_CHANGED: string = '物理网络已变化，请重新连接';
const WATCH_FAILED: string = '物理网络监听启动失败';
const WATCH_STOPPED: string = '物理网络监听已停止';
const WATCH_CLEANUP_FAILED: string = '物理网络监听尚未确认注销';

function uptimeMillis(): number {
  return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
}

// The native APIs have no cancellation API. This bounds the caller and discards
// late results; callers which allocate a registration own its late cleanup.
function bounded<T>(operation: () => Promise<T>, deadline: number, isCurrent: () => boolean,
  failure: string, timeout: string, cancelled: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled: boolean = false;
    let timer: number = -1;
    const fail = (message: string): void => {
      if (settled) { return; }
      settled = true;
      if (timer !== -1) { clearTimeout(timer); timer = -1; }
      reject(new Error(message));
    };
    const current = (): boolean => {
      if (settled) { return false; }
      try {
        if (!isCurrent()) { fail(cancelled); return false; }
        if (uptimeMillis() >= deadline) { fail(timeout); return false; }
        return true;
      } catch (_) { fail(failure); return false; }
    };
    const poll = (): void => {
      timer = -1;
      if (!current()) { return; }
      try { timer = setTimeout(poll, Math.min(CANCEL_POLL_MS, Math.max(0, deadline - uptimeMillis()))); }
      catch (_) { fail(failure); }
    };
    if (!current()) { return; }
    try {
      poll();
      if (settled) { return; }
      operation().then((value: T) => {
        if (!current()) { return; }
        settled = true;
        if (timer !== -1) { clearTimeout(timer); timer = -1; }
        resolve(value);
      }, () => { if (current()) { fail(failure); } });
    } catch (_) { fail(failure); }
  });
}

export class PhysicalNetwork {
  netId: number;
  kind: string;
  // Contains network addresses. Keep this identity in memory; never log or persist it.
  key: string;
  constructor(netId: number = 0, kind: string = 'other', key: string = `${netId}/${kind}`) {
    this.netId = netId;
    this.kind = kind;
    this.key = key;
  }
}

function validNetId(netId: number): boolean {
  return Number.isInteger(netId) && netId >= 100;
}

function physicalCapabilities(capabilities: connection.NetCapabilities): boolean {
  return capabilities.networkCap !== undefined &&
    capabilities.networkCap.includes(connection.NetCap.NET_CAPABILITY_INTERNET) &&
    !capabilities.bearerTypes.includes(connection.NetBearType.BEARER_VPN);
}

class PhysicalIdentity {
  netId: number;
  kind: string;
  interfaceName: string;
  addresses: Array<string>;
  dns: Array<string>;
  routes: Array<string>;
  constructor(netId: number, kind: string, properties: connection.ConnectionProperties) {
    this.netId = netId;
    this.kind = kind;
    this.interfaceName = properties.interfaceName ?? '';
    this.addresses = [];
    for (const link of properties.linkAddresses ?? []) {
      if (link.address && ipv4Address(link.address) && Number.isInteger(link.prefixLength) &&
        link.prefixLength >= 0 && link.prefixLength <= 32) {
        this.addresses.push(JSON.stringify([link.address.address, String(link.prefixLength)]));
      }
    }
    this.dns = [];
    for (const address of properties.dnses ?? []) {
      this.dns.push(JSON.stringify([String(address.family ?? 1), address.address, String(address.port ?? 0)]));
    }
    this.routes = [];
    for (const route of properties.routes ?? []) {
      if (route.destination && route.destination.address && ipv4Address(route.destination.address) &&
        route.destination.address.address === '0.0.0.0' && route.destination.prefixLength === 0) {
        this.routes.push(JSON.stringify([route.interface ?? '', route.destination.address.address,
          String(route.destination.prefixLength), route.gateway ? route.gateway.address : '',
          String(route.hasGateway), String(route.isExcludedRoute ?? false)]));
      }
    }
    // Ordering / duplicate entries do not indicate a changed physical path.
    this.addresses = Array.from(new Set(this.addresses)).sort();
    this.dns = Array.from(new Set(this.dns)).sort();
    this.routes = Array.from(new Set(this.routes)).sort();
  }
}

function networkFromProperties(netId: number, capabilities: connection.NetCapabilities,
  properties: connection.ConnectionProperties): PhysicalNetwork | undefined {
  if (!physicalCapabilities(capabilities) || properties.isIPv4LinkValid === false) { return undefined; }
  let kind: string = 'other';
  if (capabilities.bearerTypes.includes(connection.NetBearType.BEARER_WIFI)) { kind = 'wifi'; }
  else if (capabilities.bearerTypes.includes(connection.NetBearType.BEARER_CELLULAR)) { kind = 'cellular'; }
  else if (capabilities.bearerTypes.includes(connection.NetBearType.BEARER_ETHERNET)) { kind = 'ethernet'; }
  return new PhysicalNetwork(netId, kind, JSON.stringify(new PhysicalIdentity(netId, kind, properties)));
}

export async function readPhysicalNetwork(): Promise<PhysicalNetwork | undefined> {
  try {
    return await readCurrentPhysicalNetwork(uptimeMillis() + API_TIMEOUT_MS, () => true,
      NETWORK_CHANGED, NETWORK_CHANGED);
  } catch (_) { return undefined; }
}

async function readCurrentPhysicalNetwork(deadline: number, isCurrent: () => boolean,
  timeout: string, cancelled: string): Promise<PhysicalNetwork | undefined> {
  const handle = await bounded(() => connection.getDefaultNet(), deadline, isCurrent,
    NETWORK_CHANGED, timeout, cancelled);
  if (!validNetId(handle.netId)) { return undefined; }
  const capabilities = await bounded(() => connection.getNetCapabilities(handle), deadline, isCurrent,
    NETWORK_CHANGED, timeout, cancelled);
  if (!physicalCapabilities(capabilities)) { return undefined; }
  const properties = await bounded(() => connection.getConnectionProperties(handle), deadline, isCurrent,
    NETWORK_CHANGED, timeout, cancelled);
  const network = networkFromProperties(handle.netId, capabilities, properties);
  if (!network) { return undefined; }
  const latest = await bounded(() => connection.getDefaultNet(), deadline, isCurrent,
    NETWORK_CHANGED, timeout, cancelled);
  if (latest.netId !== handle.netId) { return undefined; }
  return network;
}

// NetConnection has no off(). Retain the object AND its callbacks until native
// unregistration is confirmed, including late success after a business timeout.
const retainedRegistrations: Array<NetworkRegistration> = [];

class NetworkRegistration {
  active: boolean = true;
  released: boolean = false;
  private registerPending: boolean = false;
  private registered: boolean = false;
  private unregisterPending: boolean = false;
  private releaseResolve: () => void = (): void => {};
  readonly releasedPromise: Promise<void>;
  private readonly native: connection.NetConnection;
  private readonly notify: () => void;

  constructor(onChange: () => void) {
    this.native = connection.createNetConnection();
    this.releasedPromise = new Promise<void>((resolve) => { this.releaseResolve = resolve; });
    this.notify = (): void => {
      if (!this.active || this.released) { return; }
      try { onChange(); } catch (_) { /* A consumer exception must not escape a native callback. */ }
    };
    retainedRegistrations.push(this);
  }

  private release(): void {
    if (this.released) { return; }
    this.active = false;
    this.released = true;
    const index = retainedRegistrations.indexOf(this);
    if (index >= 0) { retainedRegistrations.splice(index, 1); }
    this.releaseResolve();
  }

  register(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.native.on('netAvailable', this.notify);
        this.native.on('netLost', this.notify);
        this.native.on('netUnavailable', this.notify);
        this.native.on('netCapabilitiesChange', this.notify);
        this.native.on('netConnectionPropertiesChange', this.notify);
        this.native.on('netBlockStatusChange', this.notify);
      } catch (_) {
        this.release();
        reject(new Error(WATCH_FAILED));
        return;
      }
      this.registerPending = true;
      let completed: boolean = false;
      try {
        this.native.register((error) => {
          if (completed) { return; }
          completed = true;
          this.registerPending = false;
          if (error) {
            this.release();
            reject(new Error(WATCH_FAILED));
            return;
          }
          this.registered = true;
          if (!this.active) { this.close(); }
          resolve();
        });
      } catch (_) {
        if (completed) { return; }
        completed = true;
        this.registerPending = false;
        // A synchronous failure cannot prove that native registration had no
        // effect. Confirm absence with unregister, instead of dropping its owner.
        this.registered = true;
        this.active = false;
        this.close();
        reject(new Error(WATCH_FAILED));
      }
    });
  }

  close(): void {
    this.active = false;
    if (this.released || this.registerPending || this.unregisterPending) { return; }
    if (!this.registered) { this.release(); return; }
    this.unregisterPending = true;
    let completed: boolean = false;
    try {
      this.native.unregister((error) => {
        if (completed) { return; }
        completed = true;
        this.unregisterPending = false;
        // 2101007 means the callback does not exist: absence is confirmed.
        if (!error || error.code === 2101007) { this.registered = false; this.release(); }
        // Other errors keep the strong owner. A later stop() can retry cleanup.
      });
    } catch (_) { this.unregisterPending = false; }
  }
}

export class PhysicalNetworkWatcher {
  private registration?: NetworkRegistration;

  async start(onChange: () => void): Promise<void> {
    if (this.registration && !this.registration.released) { throw new Error(WATCH_FAILED); }
    let registration: NetworkRegistration;
    let deadline: number;
    try {
      deadline = uptimeMillis() + API_TIMEOUT_MS;
      registration = new NetworkRegistration(onChange);
      this.registration = registration;
    } catch (_) { throw new Error(WATCH_FAILED); }
    try {
      await bounded(() => registration.register(), deadline, () => registration.active,
        WATCH_FAILED, WATCH_FAILED, WATCH_STOPPED);
    } catch (_) {
      registration.close();
      throw new Error(WATCH_FAILED);
    }
  }

  async stop(): Promise<void> {
    const registration = this.registration;
    if (!registration || registration.released) { return; }
    registration.close();
    try {
      await bounded(() => registration.releasedPromise, uptimeMillis() + API_TIMEOUT_MS, () => true,
        WATCH_CLEANUP_FAILED, WATCH_CLEANUP_FAILED, WATCH_CLEANUP_FAILED);
    } catch (_) { throw new Error(WATCH_CLEANUP_FAILED); }
  }
}

function canonicalIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part: string) =>
    /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}

function ipv4Address(address: connection.NetAddress): boolean {
  return (address.family === undefined || address.family === 1) && canonicalIpv4(address.address);
}

export async function resolvePhysicalIpv4(host: string, network: PhysicalNetwork,
  isCurrent: () => boolean): Promise<string> {
  try { return await resolveCurrentPhysicalIpv4(host, network, isCurrent); }
  catch (error) {
    const message: string = (error as Error).message;
    const known: Array<string> = [LOOKUP_FAILED, LOOKUP_TIMEOUT, LOOKUP_CANCELLED, NETWORK_CHANGED];
    throw new Error(known.includes(message) ? message : LOOKUP_FAILED);
  }
}

async function resolveCurrentPhysicalIpv4(host: string, network: PhysicalNetwork,
  isCurrent: () => boolean): Promise<string> {
  const expectedNetId: number = network.netId;
  const expectedKey: string = network.key;
  let deadline: number;
  try { deadline = uptimeMillis() + RESOLVE_TIMEOUT_MS; }
  catch (_) { throw new Error(LOOKUP_FAILED); }
  if (host.length === 0 || host.length > 253 || /[\u0000-\u0020\u007f\/:@?#]/.test(host)) {
    throw new Error(LOOKUP_FAILED);
  }
  if (!validNetId(expectedNetId)) { throw new Error(NETWORK_CHANGED); }
  const handle = await bounded(() => connection.getDefaultNet(), deadline, isCurrent,
    NETWORK_CHANGED, LOOKUP_TIMEOUT, LOOKUP_CANCELLED);
  if (handle.netId !== expectedNetId) { throw new Error(NETWORK_CHANGED); }
  const capabilities = await bounded(() => connection.getNetCapabilities(handle), deadline, isCurrent,
    NETWORK_CHANGED, LOOKUP_TIMEOUT, LOOKUP_CANCELLED);
  if (!physicalCapabilities(capabilities)) { throw new Error(NETWORK_CHANGED); }
  const properties = await bounded(() => connection.getConnectionProperties(handle), deadline, isCurrent,
    NETWORK_CHANGED, LOOKUP_TIMEOUT, LOOKUP_CANCELLED);
  const initial = networkFromProperties(handle.netId, capabilities, properties);
  if (!initial || initial.key !== expectedKey) { throw new Error(NETWORK_CHANGED); }
  const addresses = await bounded(() => handle.getAddressesByNameWithOptions(host,
    { family: connection.FamilyType.FAMILY_TYPE_IPV4 }), deadline, isCurrent,
    LOOKUP_FAILED, LOOKUP_TIMEOUT, LOOKUP_CANCELLED);
  let selected: string = '';
  for (const address of addresses) {
    if (ipv4Address(address)) { selected = address.address; break; }
  }
  if (selected.length === 0) { throw new Error(LOOKUP_FAILED); }
  const latest = await readCurrentPhysicalNetwork(deadline, isCurrent, LOOKUP_TIMEOUT, LOOKUP_CANCELLED);
  if (!latest || latest.netId !== expectedNetId || latest.key !== expectedKey) { throw new Error(NETWORK_CHANGED); }
  return selected;
}
