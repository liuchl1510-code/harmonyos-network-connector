# Static Xray config validation

`main.go` compiles a standalone Windows executable using the official Go 1.24.6
bootstrap and the same dependency manifest as pinned libXray
`20d70a98a1eef5227252894fa8e08c9e52a67ad6` (Xray-core `v1.250803.0`). It reads
only the generated synthetic importer fixtures, never the user's saved node.

```powershell
& .\HarmonyVpnLab\scripts\validate-node-import-core.ps1
```

The script builds and executes with `GOPROXY=off` using the existing module
cache. Any missing platform-specific dependencies must first be prepared as a
separate toolchain operation against the pinned upstream `go.sum`.

For each fixture the only core operation is
`core.LoadConfig("json", strings.NewReader(configJSON))`. This performs JSON
decoding and Xray's protobuf-config construction. It does not call `core.New`,
`StartInstance`, `Start`, dial a proxy, send an HTTPS request, or validate remote
credentials. Standard HTTP and DNS calls are blocked defensively. Names and
fixed pass/failure codes are the only per-fixture output; config contents and
upstream error text are suppressed.

Results are saved to `build/node-import-core-verification.json`, including the
fixture hash, executable hash, toolchain and core versions. A passing fixture
establishes compatibility with this core's config loader. It does not establish
that credentials, target servers, TLS handshakes or actual traffic work.

## Socket-controller regression verification

`socket_protect_test.go.template` is copied into a private test package by
`scripts/build-xray.ps1`. It uses the same libXray dependency graph and the
patched Xray module selected by `replace`. Four Windows host cases exercise
TCP and UDP with a synthetic controller that allows or rejects each operation.
Only loopback addresses are used. Rejected TCP attempts must not arrive at the
local listener; rejected TCP and UDP attempts must preserve the sentinel error,
return no connection, and skip the next controller.

The script also runs the two rejection cases against the unpatched fixed core
as a negative control. Both must fail with the original behavior (a connection
is returned and the second controller runs). Its expected failure is recorded
separately from the four passing patched-core cases in the native verification
JSON. This proves that the tests detect the patched defect. Neither test loads
the C bridge or checks actual HarmonyOS socket marking; device validation is a
separate acceptance step.
