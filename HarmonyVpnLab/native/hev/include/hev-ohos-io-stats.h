#ifndef HEV_OHOS_IO_STATS_H
#define HEV_OHOS_IO_STATS_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum HevOhosIoStatsIndex {
    HEV_IO_EPOLL_CALLS = 0,
    HEV_IO_EPOLL_TIMEOUT_ZERO,
    HEV_IO_EPOLL_TIMEOUT_POSITIVE,
    HEV_IO_EPOLL_TIMEOUT_NEGATIVE,
    HEV_IO_EPOLL_ERRORS,
    HEV_IO_EPOLL_ZERO,
    HEV_IO_EPOLL_READY,
    HEV_IO_EPOLL_LAST_ERRNO,
    HEV_IO_READ_CALLS,
    HEV_IO_READ_EAGAIN,
    HEV_IO_READ_ZERO,
    HEV_IO_READ_OTHER_ERRORS,
    HEV_IO_READY_IN,
    HEV_IO_READY_OUT,
    HEV_IO_READY_ERR,
    HEV_IO_READY_HUP,
    HEV_IO_READY_RDHUP,
    HEV_IO_STATS_COUNT
};

/* Process-lifetime totals; each slot is atomic, the array is not transactional.
 * Writes min(count, HEV_IO_STATS_COUNT) slots. NULL is a no-op. Never resets.
 * LAST_ERRNO is the most recent failed epoll_wait errno (zero before a failure).
 * Wrapping covers references linked into this Hev DSO, not other libraries.
 */
void hev_ohos_io_stats(uint64_t *values, unsigned int count);

#ifdef __cplusplus
}
#endif

#endif
