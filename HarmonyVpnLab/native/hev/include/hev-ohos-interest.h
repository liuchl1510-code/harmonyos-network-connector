#ifndef HEV_OHOS_INTEREST_H
#define HEV_OHOS_INTEREST_H

#include <poll.h>
#include <hev-task.h>

/* All calls belong to one cooperative Hev scheduler thread. The caller's mask
 * must describe its own descriptor registration, never another task's dup.
 * A zero mask removes the registration, including implicit HUP/ERR wakeups.
 */
static inline int
hev_ohos_update_interest(HevTask *task, int fd, unsigned int *current,
                         unsigned int desired)
{
    int result;
    if (*current == desired)
        return 0;
    if (desired == 0)
        result = hev_task_del_fd(task, fd);
    else if (*current == 0)
        result = hev_task_add_fd(task, fd, desired);
    else
        result = hev_task_mod_fd(task, fd, desired);
    if (result < 0)
        return -1;
    *current = desired;
    return 0;
}

#endif
