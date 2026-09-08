# Persistent core contract (0.8)

`CoreProbe.startConnection(fd, context, protectSocket, bootstrap?, sessionOutboundJson?)` starts the selected single
node, Xray SOCKS ingress and Hev without a TCP/HTTPS preflight, automatic
verification or stop timer. The owning VPN ability supplies per-FD protection,
serializes session lifetime and awaits `stop()`. Stop drains an in-flight native
start before cleanup so a late queued start cannot resurrect native resources.

`readConnectionSnapshot()` returns `ConnectionSnapshot`: active engine state,
start/sample times, core version, node outbound byte totals, protection counts,
and observed `dnsRequests` / `ipv6BlockedRequests`. No node JSON, address, SNI,
UUID or password is included. A failed atomic `forwardingStatus()` check throws
a fixed error. `active` means current core counters and forwarding-worker health, not an
independent authentication or Internet-availability test.

Counters are read through `CGoConnectionStats()` from the running instance's
stats manager under the native lifecycle mutex. Stats and outbound byte-count
policy remain enabled; application configs contain no metrics HTTP feature.
The fixed core's metrics feature republishes global expvar names on restart
and does not close its direct listener. The independent statistics ABI avoids
both paths without changing Xray's metrics implementation or expvar globals.

The VPN owner supplies IPv4 `198.18.0.2/30`, DNS `198.18.0.1`, an IPv4 default
route, and captures IPv6 with `fdfe:dcba:9876::1/126` plus `::/0`, interface
`vpn-tun` and gateway `fe80::` (`hasGateway: false`, `isDefaultRoute: true`).
Address/route family is 2, with explicit port 0 and `isIPv6Accepted: true`.
This complete combination passed phone UDP6 capture tests; do not revert to
the older address/route parameters, which allowed bypass on the test phone.
Hev is called
with its optional IPv6-capture argument enabled. Xray's first route blackholes
IPv6 destinations under `block-ipv6`; this is IPv6 blocking, not dual-stack
support. Node endpoints may be canonical IPv4 literals or ASCII DNS names.
Domain endpoints require a validated session-local `NodeBootstrap` binding to
one IPv4 address before core startup. The full domain hosts mapping plus
`ForceIPv4` makes the core dial that address; the original endpoint and
TLS/REALITY SNI, WS Host and gRPC authority remain unchanged. SRV/TXT address
rewrites, additional ECH bootstrap paths and case-variant strategy keys are
rejected. Physical-network DNS resolution is performed by the owning ability;
the core never falls back to a system resolver after a pin lookup failure.

DNS behavior is deliberately **A-only**:

- App TCP/UDP port-53 flows enter `dns-out`.
- A questions are hijacked into Xray's built-in DNS, using the sole fixed
  `https://1.1.1.1/dns-query` endpoint. The `dns-via-node` route sends that DoH
  connection through `nodeProxy`.
- AAAA and all other question types receive empty NOERROR replies. This is not
  complete DNS protocol, DNSSEC, TXT, HTTPS/SVCB or service-discovery support.
- No `localhost`, `+local`, system hosts, DNS `direct` action or Freedom fallback
  is present. Failed DoH does not switch to a local plaintext resolver.

The implementation was checked against the fixed 26.6.1 source rather than
assuming current web examples match the installed core:

- [`app/dns/nameserver_doh.go`](https://github.com/XTLS/Xray-core/blob/94ffd50060f1cfd5d7482ec90a23a92bdefdff68/app/dns/nameserver_doh.go): ordinary HTTPS uses the dispatcher and verifies TLS; local mode bypasses it.
- [`app/dns/dns.go`](https://github.com/XTLS/Xray-core/blob/94ffd50060f1cfd5d7482ec90a23a92bdefdff68/app/dns/dns.go): tag selection and DNS server/fallback ordering.
- [`infra/conf/dns_proxy.go`](https://github.com/XTLS/Xray-core/blob/94ffd50060f1cfd5d7482ec90a23a92bdefdff68/infra/conf/dns_proxy.go) and [`proxy/dns/dns.go`](https://github.com/XTLS/Xray-core/blob/94ffd50060f1cfd5d7482ec90a23a92bdefdff68/proxy/dns/dns.go): `rules`, string port-list `qType`, `hijack` and empty `return` replies.

Diagnostic counters count observed dispatcher route decisions, not exact packet
or DNS-question totals. A UDP flow can carry several questions. The private
core info log is read incrementally, capped at a 1 MiB tail and truncated when
consumed; targets and query names are never copied into snapshots or hilog by
this code. Large bursts/rotation can undercount diagnostics. The pinned logger
opens the file with O_APPEND, allowing same-file truncation.

Offline checks:

```powershell
node .\scripts\test-connection-core.cjs
& .\scripts\validate-connection-core.ps1
& .\scripts\validate-hostname-core.ps1
```

The first checks pure configuration and mocked SDK/native lifecycle. The second
uses the pinned real core's `LoadConfig` plus explicit generated-protobuf
assertions for DNS rules, DoH/tag/IPv4/fallback settings, direct-counter policy,
absence of metrics HTTP, and route order. Its negative control misspells
`rules` as `rulez`: LoadConfig accepts the
unknown JSON field, but the protobuf rule-count assertion rejects it. It uses
existing modules and no network. A second negative control proves that adding
the metrics feature fails before a core can start. The hostname validator
checks generated hosts/transport protobufs and real DialSystem pinning through
a non-network recording dialer, including strategy alias order controls.
These checks do not replace actual ArkTS compilation or phone verification.
