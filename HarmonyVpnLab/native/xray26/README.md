# Xray 26.6.1 for HarmonyOS

This directory contains the reproducible source recipe for the **real Xray
26.6.1** library originally verified in application version 0.5.0, with the
ninth per-instance statistics ABI added during the 0.8 recovery work. It uses a local
OpenHarmony ARM64 port of Go 1.26.7. The core's version constants and the
upstream libXray `go 1.26.3` requirement are unchanged.

`sources.lock.json` records the complete source pins and archive hashes:

- libXray `1a6c2baedcf102053c1117ea08b3510d6dada895`.
- Xray-core `v1.260327.1-0.20260601021109-94ffd50060f1`, full commit
  `94ffd50060f1cfd5d7482ec90a23a92bdefdff68`.
- Go 1.26 base `3cc00d9c2b8ac231a5432ececa784814cc1eb075`, plus the reviewed
  `go-port/go1.26.7-openharmony-arm64.patch`.
- Official Windows Go 1.24.6 bootstrap ZIP, SHA256-checked before extraction.

The pinned Go 1.26 branch itself lacks the OpenHarmony port. The complete local
patch is provided here; no manual edits to the compiler source are required.
`go-port/port-manifest.json` records all 125 changed-file hashes, the inherited
OpenHarmony Go 1.24 platform patch origin, generator versions and semantic
adaptations. The TLS-GD macro preserves AAPCS64 x25, early GODEBUG parsing uses
borrowed C environment memory before allocation is available, and new Go 1.26
GC/compiler changes are preserved.

From the HarmonyVpnLab project directory:

Application 0.26.0 adds `patches/0002-doh-session-transport-pool.patch` to the
isolated core source, alongside the socket-controller patch. Within one DNS
instance, ordinary remote HTTPS nameservers with the same full URL and effective
inbound tag share an HTTP2 transport; clients, DNS caches and query policies stay
separate. Local/h2c endpoints and different tags or core instances do not share.
The transport owns cancellation, active raw connections and late dial cleanup;
`DNS.Close()` closes its scope without claiming to drain every DNS goroutine.

`dns-pool/manifest.json` pins the four affected Go files. `apply_patch.py` requires
clean pinned inputs, fixes LF output independently of Git settings, and checks
the resulting byte hashes. The standard native build runs the local real-HTTP2
and lifecycle fixture in `validation/doh_transport_test.go.template` before
publishing an output library. Policy validation is separately available through
`scripts/validate-split-dns-core.ps1 -DoHTransportPool`; Linux race and device
checks remain separate. Artifact hashes and validation boundaries for this change
are recorded in [phase33](../../docs/phase33-doh-pool.md); the source-lock and
historical baseline artifact hashes are not promises of identical future binaries.

```powershell
& .\scripts\build-xray.ps1
```

`build-xray.ps1` delegates to `build-xray26.ps1`. The command prepares fixed
sources and a compiler cache if missing, verifies/reuses an existing matching
compiler, builds the library in a temporary staging directory, runs four
TCP/UDP protection tests and two expected-failing original-core controls,
checks ELF/TLSDESC and nine C exports, collects dependency licenses, and only
then copies the requested output. Defaults are the application
`entry/libs/arm64-v8a/libxray.so` and `build/native/xray26-verification.json`.

To build a separate candidate without replacing the application library:

```powershell
& .\scripts\build-xray26.ps1 `
  -OutputPath "$PWD\build\candidate\libxray.so" `
  -EvidencePath "$PWD\build\candidate\verification.json"
```

Common options remain `-DevEcoPath`, `-BuildRoot`, `-PythonPath`, `-OutputPath`
and `-EvidencePath`. `-PortRoot` may point to an already reviewed compiler source
tree; all 125 ported-source hashes and its target support are checked before
reuse. `-ValidateCacheOnly` inspects ready or empty caches without downloads,
builds or output writes. `-ForceCompilerRebuild` bypasses compiler-cache reuse.
Use an ASCII build-cache path. Git, Python and the official Windows DevEco SDK
are required; all Go downloads, sources and generated files stay in the build
cache, with process environment changes restored.

The nine-function contract is in `xray_abi.h`. Every returned C string is
released with `CGoFree`. `CGoSetSocketProtectCallback` retains the fail-closed
socket protection behavior; both TCP and UDP propagate rejection before the
socket connects/binds. The new upstream JSON startup path already starts only
once, so the old startup patch is not applied. Hev retains TUN ownership: the
shim exports no native-core TUN-FD setter, and application configs use SOCKS
inbounds. One Go runtime is allowed per process, and the runtime is not unloaded
with `dlclose`.

`CGoConnectionStats()` returns the current running instance's fixed `nodeProxy`
uplink/downlink counters in the normal base64 reply. It holds the same lifecycle
mutex as Run/Stop and reads `stats.Manager` directly. Missing core or counters
is an error; it does not fabricate zero, enumerate other statistics, or use
HTTP. The original `CGoQueryStats(request)` retains its upstream HTTP behavior.
`connection_stats.go.template` is copied into the staged libXray `xray` package
without editing its existing implementation or any Xray metrics/expvar source.

Application configs using this new accessor omit Xray's `metrics` feature.
In the pinned core, its constructor republishes process-global expvar names,
and its `Close()` does not close the direct TCP listener. The retained
`metrics-restart-check/main.go` and `scripts/validate-metrics-restart.ps1`
reproduce the second-start panic and bound-port leak using only loopback.
They also confirm three fresh core instances work when metrics is absent.
The standard native build additionally runs the actual wrapper accessor test:
three start/read/update/stop cycles with counters reset per instance, plus
rejection after stop and when policy counters are absent. These checks use no
private node or remote endpoint; device recovery validation remains separate.

`upstream/go.mod` and `upstream/go.sum` are the unmodified dependency manifests
from the fixed libXray commit. `licenses` retains notices for all 42 linked
modules and the Go/libXray licenses. The historical 25.8.3 recipe is preserved
byte-for-byte as `scripts/build-xray-legacy.ps1`, using `native/xray`.

`verification-baseline.json` distinguishes actual compiler/library builds,
clean-base patch application, four-thread/32-call phone ABI/GC tests, app-local
loopback, protection rejection and two successful IPv4 HTTPS tests. The authored
entry scripts originally passed syntax, ready/empty-cache and fresh-source
preparation checks after packaging, without a repeated full cold-cache build at
that historical checkpoint. Public-release preparation subsequently completed a
new cold native build and an unsigned HAP build; see
[the public build record](../../docs/publication-validation.json).

The public port patch removes machine-specific paths only from a generated
stringer comment. Its patch and affected-file digests were updated together;
the historical verification baseline is retained as a record of its earlier
artifact, not rewritten to claim that it tested this newly built binary. Source
recipes are pinned, but binary hashes may differ across build paths/toolchains.
These bounded checks do not establish all-device compatibility or full v2rayNG
feature coverage.
