#ifndef HARMONY_VPN_SOCKET_PROTECT_H
#define HARMONY_VPN_SOCKET_PROTECT_H

#include "napi/native_api.h"

// installSocketProtector((duplicatedSocketFd: number) => Promise<void>): void
//   Install once in the VPN extension environment, after libXray initialization.
//   The callback must return connection.protect(fd) without closing that fd.
// socketProtectionStats(): string
//   Process-cumulative JSON counters: requests, succeeded, failed, timedOut, active.
//   timedOut is a subset of failed; active counts owned duplicates still held.
//   A timed-out, already-dispatched IPC keeps its duplicate until settlement.
//   If the environment dies first, it is retained until a late settlement or
//   process exit. At most 128 duplicates are held across active/retired sessions.
// Calls originating on the installing JS thread fail immediately instead of
// waiting for that same event loop. Other Go callback threads wait at most 3 s.
// The Go ABI is CGoSetSocketProtectCallback(void*), accepting int (*)(int).
void RegisterSocketProtectionApis(napi_env env, napi_value exports);

#endif
