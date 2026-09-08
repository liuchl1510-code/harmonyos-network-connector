# Xray 25.8.3 historical build

This directory preserves the earlier 25.8.3 experiment. The current 0.5.0 app
uses Xray 26.6.1 and the Go 1.26 OHOS port documented in `../xray26/`.
Use `scripts/build-xray-legacy.ps1` explicitly to reproduce this older library;
the default `scripts/build-xray.ps1` now builds the newer core.

This directory owns the Windows-to-OpenHarmony Xray build and its C ABI. The
application has **one Go runtime** (`libxray.so`); Hev is a separate C library.

## Source and version pins

| Component | Exact revision | Source / license |
| --- | --- | --- |
| Bootstrap Go | `go1.24.6`, Windows amd64 | <https://go.dev/dl/>; BSD-3-Clause |
| OpenHarmony Go fork | `302a5306b6fad2f47196360b82561d1db1f954cf`, branch `release-branch.go1.24`, reports `go1.24.5` | <https://gitcode.com/openharmony-sig/ohos_golang_go>; Go BSD license |
| libXray | `20d70a98a1eef5227252894fa8e08c9e52a67ad6` | <https://github.com/XTLS/libXray>; MIT |
| Xray-core | `v1.250803.0` (`25.8.3`) | <https://github.com/XTLS/Xray-core>; MPL-2.0 |
| Build architecture reference | Hey `a02a6a51fe02707a5e1ac5fecd90b3966452ef2d`, `scripts/build_libxray_ohos.sh` | <https://github.com/popsiclelmlm/Hey>; reference only, not executed |

The official bootstrap archive is
`https://go.dev/dl/go1.24.6.windows-amd64.zip`, SHA256
`4fbc8af2cfca9e5059019b5150a426eb78e1e57718bf08f0e52b1c942a2782bf`.
It was checked against the official `https://go.dev/dl/?mode=json&include=all`
download metadata and the downloaded bytes.

## Rebuild on this computer

Run from the workspace in PowerShell 7:

```powershell
& .\HarmonyVpnLab\scripts\build-xray-legacy.ps1
```

The script downloads the official bootstrap if absent, pins both source trees,
builds the OHOS Go compiler with its native Windows `make.bat`, creates a separate
staging copy of libXray, and runs the cross-build using the Windows OHOS
`clang.exe`. It uses `%TEMP%\HarmonyVpnLab-xray` as an ASCII working path. No Go
installation, PATH, registry, SDK contents, or global Go settings are changed.
The executable accepts `-DevEcoPath`, `-BuildRoot`, and `-PythonPath` overrides.
Use `-OutputPath` and `-EvidencePath` together to produce a review candidate
without replacing the application's current library or its verification record.

The Go fork is **not** stock Go with `GOOS=android` or `GOOS=linux`. It provides
the OpenHarmony arm64 dynamic TLS implementation. The build uses
`CGO_ENABLED=1`, `GOOS=openharmony`, `GOARCH=arm64`, `-buildmode=c-shared`,
`-ftls-model=global-dynamic`, and the official SDK sysroot. The shell wrapper
shipped in the Windows SDK is not invoked; compiler arguments are supplied
directly and the entire `--sysroot=...` argument is quoted to preserve spaces.

Local source adaptations, confined to the staging copy:

1. Top-level `package libXray` declarations become `package main` for c-shared.
2. `go.mod`'s `go 1.24.6` requirement is changed to `go 1.24.5`, the fork's actual
   version. Xray-core itself requests `go 1.24`. This is an explicit compatibility
   experiment verified by compiling all imported packages; the version is not
   disguised by editing the compiler version string.
3. `main.go.template` supplies eight C exports, lifecycle serialization, panic-to-
   error conversion on the calling goroutine, and an explicit allocator-matched
   release function. It does not recover arbitrary panics in background
   goroutines.
4. `patches/0001-run-json-start-once.patch` removes the pinned libXray JSON
   wrapper's second `coreServer.Start()` call. Its inner `core.StartInstance()`
   has already started all features. Without this patch the metrics feature
   binds the same listening address twice in a single start request. The build
   checks the original source hash and matches one complete function before
   applying the single hunk; the verification record includes the patch hash.
5. `patches/0002-socket-controller-fail-closed.patch` makes both TCP
   `Dialer.Control` and UDP `ListenConfig.Control` return a controller's error.
   The upstream implementation logs the error and continues using the socket.
   `apply_fail_closed.py` validates the fixed upstream file SHA256, matches each
   of two hunks exactly once, copies the original module to `stage-xray-core`,
   and patches only that copy. `go.mod replace` selects the private stage. The
   build verifies the original cached modules before adding the replacement.
   Repeated builds recopy the original source before applying the same patch.
6. The seventh export registers a C callback for per-socket protection. A
   process-lifetime Xray `RegisterDialerController` reads an atomic pointer and
   calls it synchronously inside `RawConn.Control`, before connect/bind. Missing
   callbacks and nonzero results return errors. The callback adapter never
   closes Go's original fd; Go retains socket ownership and cleans up a failed
   Dial/Listen operation.
7. `CGoRuntimeInfo` returns Go's current Unix milliseconds and runtime version,
   OS and architecture. This read-only call needs no running core or socket
   callback; compare its timestamp with ArkTS `Date.now()` around the call to
   check the time source used by REALITY. It never reads a node configuration
   or opens a network connection.

No gVisor source or downloaded module-cache source is patched. Hev owns TUN I/O.
No network certificate verification is disabled.

Outputs:

- `entry/libs/arm64-v8a/libxray.so`
- `build/native/xray-verification.json`: compact versions, SHA256, size, export
  table, build parameters and ELF/TLS summary. Complete `go version -m` module
  inventory and ELF inspection are separate text files in `build/native`.
- The compiler-generated header remains in `%TEMP%\HarmonyVpnLab-xray`; the
  small stable contract is `xray_abi.h` in this directory.

## C ABI

Load the library for the lifetime of the VPN extension process. Do not `dlclose`
a live Go runtime. Do not load a second Go c-shared runtime in this process.
`CGoStopXray` stops the server; it does not unload the Go runtime.

String inputs are borrowed null-terminated ASCII base64 strings; the functions
copy them synchronously. Every returned pointer is newly allocated in the
library. Copy its bytes and call **`CGoFree(result)` exactly once**, including on
error replies. `CGoFree(NULL)` is harmless. Never use `delete`, `delete[]`, or
another runtime's allocator on the pointer.

All replies decode to UTF-8 JSON:

```json
{"success":true,"data":"optional result"}
```

```json
{"success":false,"error":"failure description"}
```

The `data` and `error` keys may be absent. Test `success`; a non-null C pointer
alone does not indicate success. Avoid writing full user configurations or
upstream error replies containing sensitive configuration to logs.

| Function | Decoded input | Decoded reply data |
| --- | --- | --- |
| `CGoRunXrayFromJSON(char*)` | JSON object `{"datDir":"<app files>","configJSON":"<Xray JSON as a string>"}` | Usually absent; inspect `success` |
| `CGoStopXray()` | None | Usually absent; inspect `success` |
| `CGoXrayVersion()` | None | String `25.8.3` |
| `CGoRuntimeInfo()` | None | Object `{unixMillis: number, goVersion: string, goos: string, goarch: string}` |
| `CGoPing(char*)` | JSON object with optional `datDir`, `configPath`, `timeout`, `url`, `proxy` | Integer delay on success |
| `CGoQueryStats(char*)` | A UTF-8 server-address string, **not a JSON object** | JSON statistics encoded as a string |
| `CGoFree(char*)` | A pointer returned by this library | Void |
| `CGoSetSocketProtectCallback(void*)` | C `int (*)(int fd)` function pointer, or null | Void; callback result 0 allows the socket, nonzero rejects it |

`CGoRuntimeInfo` reads `time.Now().UnixMilli()`, `runtime.Version()`,
`runtime.GOOS` and `runtime.GOARCH`. The pinned OpenHarmony fork deliberately
reports `runtime.GOOS == "linux"` (`internal/goos/zgoos_openharmony.go`); this
does not change the `GOOS=openharmony` cross-build target. A runtime clock
comparison must bracket the call with two ArkTS `Date.now()` readings so that
bridge scheduling delay is not mistaken for a clock offset. Its returned
pointer follows the same `CGoFree` ownership contract as other reply exports.

Register the socket callback before starting a core that may initiate traffic.
The callback may run on concurrent Go threads and must complete protection
synchronously. The app's bridge bounds its wait and owns any duplicated fd;
neither the bridge nor ArkTS may close the borrowed original descriptor. Stop
Xray before clearing/releasing the callback. Clearing the atomic pointer does
not wait for calls already in flight, so callback code must remain alive until
they finish. Go does not clear it automatically on stop. A null pointer rejects
subsequent Xray system-dialer sockets rather than silently permitting them.

Only one core instance is supported. Call stop before replacing a running
configuration. The app is responsible for this state machine, per-socket
protection, SOCKS listen-address restrictions, bounded diagnostic timeouts,
background scheduling, and TUN lifecycle.

## Verification and limits

On 2026-09-07 the pinned OHOS Go compiler built and ran on Windows amd64.
The protection-enabled Xray library cross-build completed, producing 32,449,024 bytes. Static
checks confirmed AArch64, PT_TLS, `R_AARCH64_TLSDESC`, no
`R_AARCH64_TLS_TPREL64`, and exactly the original seven exports. `go mod verify`
reported `all modules verified`. Root license notices were collected for all
38 linked Go modules. These checks
establish build/ABI properties; they do not establish phone runtime behavior or
successful proxy traffic. See the separate project device-test records for
runtime acceptance.

The runtime-info build adds the eighth export and is archived separately as
`build/native/libxray-runtime-info.so`, with its build/ABI evidence in
`build/native/xray-runtime-info-verification.json`. The candidate passed the
same module, ELF and socket-protection checks, including both original patches.
It was promoted to `entry/libs/arm64-v8a/libxray.so` in app 0.4.2. Device runs
have confirmed its clock differs from the bracketing ArkTS time by 0–1 ms.
App 0.4.3 retains this same library; actual node HTTPS still requires the
compatibility work documented in `docs/phase4-core-compatibility.md` at the
project root.

The build also runs four host tests against the patched core: synthetic TCP/UDP
controllers each permit and reject a socket. TCP rejection leaves a local
listener without an accepted connection; both rejection paths stop before the
next controller. As a negative control, the same rejection tests against the
unpatched module both detect the original error-swallowing bug. These tests
use Windows loopback only and never read a user node. They validate the core's
error propagation, not the C-to-ArkTS callback or phone's protection service;
those require separate bridge/device verification. The controller only covers
sockets created through Xray's `DefaultSystemDialer`, not arbitrary Go sockets
or a replacement/custom dialer.

TLS has two distinct meanings here: Go **thread-local storage** compatibility
is checked in the ELF; encrypted network **TLS certificate validation** requires
real device tests. This Go fork's x509 code still uses Linux root-certificate
paths by default. Verify readable system CA roots or explicitly supply a
trusted CA store before accepting TLS-node support. Keep verification enabled.

These pins are an experimental compatibility baseline from 2025, not a claim
that current Xray features or later security fixes are included. Do not advertise
full v2rayNG equivalence based on this build. The complete module inventory and
license copies are retained for review before distribution.

## Application CA bundle

`entry/src/main/resources/rawfile/mozilla-ca.pem` is the unmodified Mozilla CA
snapshot distributed by the official curl project at
<https://curl.se/ca/cacert.pem>. Download provenance, fetch time, official SHA256
comparison and parser results are recorded in `ca-bundle.json`. The 2026-08-13
snapshot contains 121 CA certificates (188,900 bytes); its SHA256 is
`f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9`.
Python/OpenSSL parsed the complete file and all 121 certificates separately.

`prepareCaBundle(context)` in `vpn/CaBundle.ets` copies the packaged resource to
the application's private `filesDir`, closes its temporary file on both success
and failure, and atomically renames a completed write. The caller must set
`SSL_CERT_FILE` to the returned path **before the first libxray load / first Go
certificate-pool initialization in a fresh VPN extension process**. This only
configures the app's Go trust store; it does not install phone system certificates
or disable TLS verification. Certificate parsing alone does not verify a real
proxy node's TLS handshake.

This is a bundled snapshot without automatic updates. Update it deliberately
with source, hash and certificate-change review when maintaining the app. The
curl project documents the bundle as MPL-2.0 and notes that PEM does not preserve
all Firefox external domain/name constraints:
<https://curl.se/docs/caextract.html>. The MPL-2.0 text is already retained in
`licenses/Xray-core-MPL-2.0.txt`.
