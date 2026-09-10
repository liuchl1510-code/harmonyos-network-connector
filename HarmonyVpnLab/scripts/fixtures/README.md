# Temporary emulator heap probe

`EmulatorHeapProbe.ets` is an instrumentation template, outside the application's
source tree. Copy it only into an isolated diagnostic preview stage at
`entry/src/main/ets/model/EmulatorHeapProbe.ets`; its adjacent
`BuildCapabilities.ets` must have `VPN_CORE_AVAILABLE = false`. The runtime also
requires a debug application and an `x86_64` ABI. The ordinary ARM build retains
`VPN_CORE_AVAILABLE = true` and cannot execute the probe.

In that temporary stage's `EntryAbility.ets`, import
`handleHeapCapture` from `../model/EmulatorHeapProbe` and call
`handleHeapCapture(want, this.context)` inside the main-thread `onNewWant(want)`.
Call it from `onCreate(want)` too only if the intended request accompanies launch.
Do not call it from a worker or taskpool. No ordinary app integration is supplied.

The accepted string parameters are `uiHeapCapture` with one of `before`,
`after01`, `after02`, `idle`; `uiHeapGc` with `true` or `false`; and optional
`uiHeapApi` with `raw` (default) or `legacy`. Legacy accepts only `uiHeapGc=true`:
the legacy API does not expose a GC switch, so this records the request and
`gcMode: platform-default`, omits `needGC`, and never claims GC was disabled or
observed. Raw uses `gcMode: explicit-boolean` and records the passed `needGC`.
There is no input path. One request may be in flight; each label is accepted once per process,
including failures, and at most four requests are accepted. Requests rejected as
busy, duplicate or over quota are not queued or retried.

Before sending a request, the host must revalidate the complete synthetic-only
preview state and record the diagnostic HAP identity. Separate runs and process
restarts on the host; labels and receipts do not supply a cross-process run ID.
This diagnostic variant must not replace the ordinary published application.

Read `${context.cacheDir}/heap-probe-<label>.json`. Each receipt is written through
a flushed temporary file and rename. `state` is `started`, `completed` or `failed`.
Schema version 2 adds the explicitly selected `api`, `rawApiAvailable` and
`legacyApiAvailable` booleans measured with `typeof method === 'function'`.
`completed` includes `snapshotPath`, positive `snapshotSizeBytes`, GC metadata,
`needClean: false`, and ISO timestamps. Raw uses the actual SDK-returned path;
legacy uses only its internally generated `snapshotFileBase` plus `.heapsnapshot`.
Both must pass `statSync` as a nonempty regular file before completion is recorded.
`failed` contains a numeric `errorCode` (safe integer numbers or strict integer
strings, otherwise `-1`), a fixed `failureStage`, and a closed-set `errorName`
(`Error`, `TypeError`, `BusinessError`, `RangeError`, `ReferenceError`,
`SyntaxError`, `URIError`, `EvalError`, or `UnknownError`). Paths and raw heap
contents are never logged. A remaining `started` receipt does not establish
completion; a receipt-write error has only a fixed log event if persistence is
unavailable. The template does not delete the SDK's generated snapshot.

Checked against the installed DevEco SDK declarations:

- `@ohos.hidebug.d.ts`: `dumpJsRawHeapData(needGC: boolean, needClean: boolean): Promise<string>`
  is the API 24 overload for the current thread; `false` controls snapshot-cache
  cleanup, not thread selection.
- `dumpJsHeapData(filename: string, needClean: boolean): void` is synchronous;
  the API 24 overload accepts a basename without a suffix. Both the local SDK
  declaration and [official OpenHarmony API documentation](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-performance-analysis-kit/js-apis-hidebug.md#hidebugdumpjsheapdata24)
  specify `${filename}.heapsnapshot` in the application's **files** directory.
  The probe checks the four exact candidates built from UIAbility and application
  `filesDir`/`cacheDir`, deduplicates identical paths, and never lists a directory.
  Existing candidates cause rejection before capture; multiple results, missing
  output or zero-byte output cause failure. The timestamped basename is generated
  internally, and is under the documented 128-byte name limit.
- `@ohos.file.fs.d.ts`: `openSync` returns `fs.File`; `writeSync(fd, ArrayBuffer)`
  returns the bytes written; `fsyncSync`, `closeSync` and `renameSync` are available.

Legacy is selected only with `uiHeapApi=legacy` and `uiHeapGc=true`; it is never
an automatic fallback for a raw failure. `needClean=false` is supplied to both.
The platform can reject capture for quotas, developer-mode requirements, disk
space or other documented reasons. Every accepted failure remains a failure;
there is no fallback or retry. Root-task staging/build verification is required
before device use; this template alone is not evidence of a compiled or captured
heap diagnostic variant.
