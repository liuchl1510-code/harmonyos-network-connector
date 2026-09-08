#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <string.h>

char *NativeSmokeBody(void) { return strdup("PASS native-control"); }
#ifndef SMOKE_BROKEN
__attribute__((visibility("default")))
char *HarmonyGoSmoke(void) { return NativeSmokeBody(); }
#endif
__attribute__((visibility("default")))
void HarmonyGoSmokeFree(char *reply) { free(reply); }
