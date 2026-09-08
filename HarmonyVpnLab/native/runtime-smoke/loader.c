#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// Calls an AAPCS64 function with x0=argument and checks preserved x19..x28.
// Smoke(void) ignores the extra register argument; Free(char*) consumes it.
extern uint32_t harmony_checked_call(void *function, void *argument, void **reply);

enum { WORKERS = 4, CALLS_PER_WORKER = 8 };
static void *smoke_address;
static void *free_address;
static atomic_uint register_failures;
static atomic_uint reply_failures;
static atomic_uint completed_calls;
static atomic_bool finished;

static void *watchdog(void *unused)
{
    (void)unused;
    const struct timespec tick = { .tv_sec = 0, .tv_nsec = 100000000 };
    for (int i = 0; i < 120; ++i) {
        if (atomic_load(&finished)) return NULL;
        nanosleep(&tick, NULL);
    }
    fputs("{\"passed\":false,\"error\":\"native-watchdog-timeout\"}\n", stdout);
    fflush(stdout);
    _exit(124);
}

static void *worker(void *unused)
{
    (void)unused;
    for (int i = 0; i < CALLS_PER_WORKER; ++i) {
        void *reply = NULL;
        const uint32_t mask = harmony_checked_call(smoke_address, NULL, &reply);
        atomic_fetch_or(&register_failures, mask);
        if (reply == NULL || strncmp((const char *)reply, "PASS ", 5) != 0) {
            atomic_fetch_add(&reply_failures, 1);
        }
        if (reply != NULL) {
            const uint32_t free_mask = harmony_checked_call(free_address, reply, NULL);
            atomic_fetch_or(&register_failures, free_mask);
        }
        atomic_fetch_add(&completed_calls, 1);
    }
    return NULL;
}

// Serialized by the embedding N-API bridge, or called once by standalone main.
char *HarmonyRunRuntimeSmoke(const char *library_path)
{
    atomic_store(&register_failures, 0);
    atomic_store(&reply_failures, 0);
    atomic_store(&completed_calls, 0);
    atomic_store(&finished, 0);
    pthread_t timer;
    if (pthread_create(&timer, NULL, watchdog, NULL) != 0)
        return strdup("{\"passed\":false,\"error\":\"watchdog-creation-failed\"}");
    // The watchdog also bounds Go runtime initialization during dlopen.
    void *library = dlopen(library_path, RTLD_NOW | RTLD_LOCAL);
    if (library == NULL) {
        atomic_store(&finished, 1);
        pthread_join(timer, NULL);
        return strdup("{\"passed\":false,\"error\":\"dlopen-failed\"}");
    }
    smoke_address = dlsym(library, "HarmonyGoSmoke");
    free_address = dlsym(library, "HarmonyGoSmokeFree");
    if (smoke_address == NULL || free_address == NULL) {
        atomic_store(&finished, 1);
        pthread_join(timer, NULL);
        return strdup("{\"passed\":false,\"error\":\"smoke-exports-missing\"}");
    }
    pthread_t threads[WORKERS];
    int created = 0;
    for (; created < WORKERS; ++created) {
        if (pthread_create(&threads[created], NULL, worker, NULL) != 0) break;
    }
    for (int i = 0; i < created; ++i) pthread_join(threads[i], NULL);
    atomic_store(&finished, 1);
    pthread_join(timer, NULL);
    const unsigned mask = atomic_load(&register_failures);
    const unsigned errors = atomic_load(&reply_failures);
    const unsigned calls = atomic_load(&completed_calls);
    const int passed = created == WORKERS && calls == WORKERS * CALLS_PER_WORKER && mask == 0 && errors == 0;
    char result[256];
    snprintf(result, sizeof(result), "{\"passed\":%s,\"workers\":%d,\"completedCalls\":%u,\"registerFailureMask\":%u,\"replyFailures\":%u}",
        passed ? "true" : "false", created, calls, mask, errors);
    // Never dlclose a live Go runtime. This dedicated process owns its lifetime.
    return strdup(result);
}

#ifndef HARMONY_SMOKE_EMBEDDED
int main(int argc, char **argv)
{
    if (argc != 2) return 1;
    char *result = HarmonyRunRuntimeSmoke(argv[1]);
    if (result == NULL) return 1;
    puts(result);
    const int passed = strstr(result, "\"passed\":true") != NULL;
    free(result);
    return passed ? 0 : 2;
}
#endif
