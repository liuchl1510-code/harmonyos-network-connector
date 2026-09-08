#include "include/hev-ohos-io-stats.h"

#include <errno.h>
#include <stdatomic.h>
#include <stddef.h>
#include <sys/epoll.h>
#include <sys/types.h>
#include <unistd.h>

/* This diagnostic must not add locks or call into another runtime. */
_Static_assert(ATOMIC_LONG_LOCK_FREE == 2 && ATOMIC_LLONG_LOCK_FREE == 2,
               "Hev IO diagnostics require lock-free 64-bit atomics");
static _Atomic uint64_t io_stats[HEV_IO_STATS_COUNT];

extern int __real_epoll_wait(int fd, struct epoll_event *events, int count,
                             int timeout);
extern ssize_t __real_read(int fd, void *buffer, size_t count);

static void increment(unsigned int index)
{
    atomic_fetch_add_explicit(&io_stats[index], 1, memory_order_relaxed);
}

int __wrap_epoll_wait(int fd, struct epoll_event *events, int count, int timeout)
{
    increment(HEV_IO_EPOLL_CALLS);
    increment(timeout == 0 ? HEV_IO_EPOLL_TIMEOUT_ZERO :
              timeout > 0 ? HEV_IO_EPOLL_TIMEOUT_POSITIVE :
                            HEV_IO_EPOLL_TIMEOUT_NEGATIVE);
    int result = __real_epoll_wait(fd, events, count, timeout);
    int saved_errno = errno;
    if (result < 0) {
        increment(HEV_IO_EPOLL_ERRORS);
        atomic_store_explicit(&io_stats[HEV_IO_EPOLL_LAST_ERRNO],
                              (uint64_t)saved_errno, memory_order_relaxed);
    } else {
        increment(result == 0 ? HEV_IO_EPOLL_ZERO : HEV_IO_EPOLL_READY);
        for (int i = 0; i < result; ++i) {
            uint32_t ready = events[i].events;
            if (ready & EPOLLIN) increment(HEV_IO_READY_IN);
            if (ready & EPOLLOUT) increment(HEV_IO_READY_OUT);
            if (ready & EPOLLERR) increment(HEV_IO_READY_ERR);
            if (ready & EPOLLHUP) increment(HEV_IO_READY_HUP);
            if (ready & EPOLLRDHUP) increment(HEV_IO_READY_RDHUP);
        }
    }
    errno = saved_errno;
    return result;
}

ssize_t __wrap_read(int fd, void *buffer, size_t count)
{
    increment(HEV_IO_READ_CALLS);
    ssize_t result = __real_read(fd, buffer, count);
    int saved_errno = errno;
    if (result == 0) {
        increment(HEV_IO_READ_ZERO);
    } else if (result < 0) {
        increment(saved_errno == EAGAIN || saved_errno == EWOULDBLOCK ?
                      HEV_IO_READ_EAGAIN : HEV_IO_READ_OTHER_ERRORS);
    }
    errno = saved_errno;
    return result;
}

void hev_ohos_io_stats(uint64_t *values, unsigned int count)
{
    if (values == NULL) {
        return;
    }
    unsigned int limit = count < HEV_IO_STATS_COUNT ? count : HEV_IO_STATS_COUNT;
    for (unsigned int i = 0; i < limit; ++i) {
        values[i] = atomic_load_explicit(&io_stats[i], memory_order_relaxed);
    }
}
