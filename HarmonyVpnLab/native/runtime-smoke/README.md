# Runtime compatibility probe

This is a diagnostic for the OpenHarmony ARM64 Go port, not a proxy traffic test.
It does not import a node configuration, start a VPN, or contact a server.

The C loader starts four native pthreads. Each thread invokes the smoke export
eight times and frees each returned C string through the matching library export.
An assembly boundary checks preservation of AAPCS64 x19–x28 for both calls.
The wrapper restores its caller's original registers even when the test library
violates the ABI, allowing it to report the failure. It does not claim to test
all AAPCS64 state (for example, SIMD callee-saved registers are not checked).

Two pure C controls validate the checker: the normal control must pass, while
the broken control deliberately corrupts x25 and must return register mask 64.
Both must complete 32 calls without reply errors. Only after these controls
are verified should a passing Go candidate be trusted.

The Go candidate must export `HarmonyGoSmoke(void)` returning an allocated
`PASS ...` or `FAIL ...` C string, and `HarmonyGoSmokeFree(char*)`. Its own Go
code must exercise goroutines, allocation, stack growth, GC and C callbacks.
The implementation and compiler provenance belong to the candidate build record.

The Pura test device denies direct execution from `/data/local/tmp`. Therefore
the verified execution route is the signed HAP's asynchronous N-API bridge.
The `runtimeSmoke=fixtures` or `runtimeSmoke=go` launch parameter opens a
dedicated diagnostic page, avoiding the normal Index page's HTTP recovery path.
Each invocation starts in a fresh UI process. The production Xray library runs
in the separate VPN extension process; the probe never loads it.

```powershell
.\HarmonyVpnLab\scripts\build.ps1
# Install the signed HAP first, then keep the phone unlocked.
.\HarmonyVpnLab\scripts\test-runtime-smoke.ps1 -Mode fixtures
.\HarmonyVpnLab\scripts\test-runtime-smoke.ps1 -Mode go
```

The Go smoke library is separately staged as
`entry/libs/arm64-v8a/libgoruntime-smoke.so` after its digest has been checked.
`build-runtime-smoke.ps1` rebuilds the native controls. `build.ps1` invokes it
before packaging. Reports are stored in `build/runtime-smoke` and verdicts are
matched to a fresh run ID, never an older successful UI state.

A native watchdog exits the diagnostic app process after 12 seconds if a
runtime blocks. A missing verdict is a failure. The library is never dlclosed;
its lifetime is the diagnostic process. These checks do not establish long-term
stability or successful Xray/REALITY traffic, which require subsequent tests.
