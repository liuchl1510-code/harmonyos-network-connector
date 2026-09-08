// Safe to persist for the UI: no node JSON, endpoint, SNI, UUID or password.
export class ConnectionSnapshot {
  active: boolean = false;
  startedAt: number = 0;
  sampledAt: number = 0;
  coreVersion: string = '';
  uplink: number = 0;
  downlink: number = 0;
  protectionRequests: number = 0;
  protectionSucceeded: number = 0;
  protectionFailed: number = 0;
  protectionTimedOut: number = 0;
  protectionActive: number = 0;
  ipv6BlockedRequests: number = 0;
  dnsRequests: number = 0;
}
