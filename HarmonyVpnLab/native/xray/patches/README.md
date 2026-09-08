# libXray JSON startup correction

Pinned libXray `20d70a98a1eef5227252894fa8e08c9e52a67ad6` has this call chain:

1. `xray.RunXrayFromJSON` calls `StartXrayFromJSON`.
2. `StartXrayFromJSON` calls Xray-core `core.StartInstance`.
3. `core.StartInstance` constructs the instance and calls `instance.Start()`.
4. The wrapper then calls `coreServer.Start()` again.

Xray-core `v1.250803.0`, `core/xray.go`, explicitly allows starting an instance
only once; its implementation invokes every feature's `Start()` on every call.
The metrics feature binds its listener in `Start()`. A single JSON start request
therefore bound its metrics port once, then failed with address-already-in-use
on the second call. Changing random ports does not resolve the duplicate start.

`0001-run-json-start-once.patch` removes only step 4. It does not alter config
contents, Go ABI, user nodes, metrics semantics, TLS handling or the core version.
The existing initial start's result remains checked. `apply_start_once.py`
requires the pinned source's LF-normalized SHA256 and exactly one matching
function hunk, then patches only the build staging copy.

The patch does not repair the separate upstream metrics lifecycle limitation:
`metrics.Close()` is empty and global `expvar.Publish` cannot register twice.
The application still needs a fresh VPN extension process for each metrics-
enabled session. Cross-build/ELF verification is recorded in
`build/native/xray-verification.json`; phone tests remain separate evidence.
