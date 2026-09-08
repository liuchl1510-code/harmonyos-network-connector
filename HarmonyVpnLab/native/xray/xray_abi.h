#ifndef HARMONY_VPN_LAB_XRAY_ABI_H
#define HARMONY_VPN_LAB_XRAY_ABI_H

#ifdef __cplusplus
extern "C" {
#endif

// Input: null-terminated base64 UTF-8 JSON {"datDir":"...", "configJSON":"..."}.
// All returned pointers belong to libxray and must be released with CGoFree.
// Reply: base64 UTF-8 JSON {"success":true|false,"data":...,"error":"..."}.
char *CGoRunXrayFromJSON(char *request);
char *CGoStopXray(void);
char *CGoXrayVersion(void);
// Read-only runtime clock/version metadata; never starts a core or a network call.
// data: {"unixMillis":number,"goVersion":string,"goos":string,"goarch":string}.
char *CGoRuntimeInfo(void);
char *CGoPing(char *request);
char *CGoQueryStats(char *request);
void CGoFree(char *result);

// Register int (*callback)(int fd): 0 means protected; all other results fail
// the outbound socket operation before connect/bind. NULL disables protection
// and fails subsequent outbound attempts. The callback must not close fd.
// Keep callback code alive until all in-flight calls finish; stop Xray before
// clearing it. Setter is thread-safe and does not wait for in-flight callbacks.
void CGoSetSocketProtectCallback(void *callback);

#ifdef __cplusplus
}
#endif
#endif
