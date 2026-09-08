"""Maintainer helper: generate the audited patch from the pinned clean checkout."""
from pathlib import Path
import difflib
import hashlib
import json

NATIVE = Path(__file__).resolve().parent
SOURCE = NATIVE.parents[2] / '.tooling/sources/hev-socks5-tunnel'

def change_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Expected one exact source pattern')
    return text.replace(old, new, 1)

files = {}
for name in ('tcp', 'udp'):
    path = f'src/hev-socks5-session-{name}.c'
    old = (SOURCE / path).read_text(encoding='utf-8')
    files[path] = [old, old]

path = 'src/hev-socks5-session-tcp.c'
old, text = files[path]
text = change_once(text, '#include "hev-utils.h"', '#include "hev-utils.h"\n#include "hev-ohos-interest.h"')
text = change_once(text, '    int res_b = 1;\n', '    int res_b = 1;\n    unsigned int poll_events = POLLIN | POLLOUT;\n')
text = change_once(text, '''    for (;;) {
        HevTaskYieldType type;
''', '''    for (;;) {
        HevTaskYieldType type;
        unsigned int desired = 0;
''')
text = change_once(text, '''        if (task_io_yielder (type, base) < 0)
            break;
    }

    while (self->pcb) {''', '''        /* Only wait for work the session can consume. lwIP recv/sent
         * callbacks wake this task when queue data/capacity changes. */
        if (res_f >= 0 && self->queue)
            desired |= POLLOUT;
        if (res_b >= 0 &&
            hev_ring_buffer_get_use_size (self->buffer) <
                hev_ring_buffer_get_max_size (self->buffer))
            desired |= POLLIN;
        if (hev_ohos_update_interest (hev_task_self (), HEV_SOCKS5 (self)->fd,
                                      &poll_events, desired) < 0) {
            hev_socks5_set_timeout (HEV_SOCKS5 (self), 0);
            break;
        }
        if (task_io_yielder (type, base) < 0)
            break;
    }

    /* Socket EOF/HUP must not repeatedly wake ACK-only ring-buffer draining. */
    if (hev_ohos_update_interest (hev_task_self (), HEV_SOCKS5 (self)->fd,
                                  &poll_events, 0) < 0)
        hev_socks5_set_timeout (HEV_SOCKS5 (self), 0);
    while (self->pcb) {''')
files[path][1] = text

path = 'src/hev-socks5-session-udp.c'
old, text = files[path]
text = change_once(text, '#include "hev-utils.h"', '#include "hev-utils.h"\n#include "hev-ohos-interest.h"')
text = change_once(text, 'hev_socks5_session_udp_fwd_f (HevSocks5SessionUDP *self)', 'hev_socks5_session_udp_fwd_f (HevSocks5SessionUDP *self,\n                               unsigned int *poll_events)')
text = change_once(text, '''        node = hev_list_first (&self->frame_list);
        if (node)
            break;
''', '''        node = hev_list_first (&self->frame_list);
        /* The reverse task owns a separate dup registered for POLLIN. */
        if (hev_ohos_update_interest (
                hev_task_self (),
                hev_socks5_udp_get_fd (HEV_SOCKS5_UDP (self)), poll_events,
                node ? POLLOUT : 0) < 0)
            return -1;
        if (node)
            break;
''')
text = change_once(text, '''    fd = hev_task_io_dup (hev_socks5_udp_get_fd (HEV_SOCKS5_UDP (self)));
    if (fd < 0)
        return;

    if (hev_task_add_fd (task, fd, POLLIN) < 0)
        hev_task_mod_fd (task, fd, POLLIN);
''', '''    fd = hev_task_io_dup (hev_socks5_udp_get_fd (HEV_SOCKS5_UDP (self)));
    if (fd < 0)
        goto failed;

    if (hev_task_add_fd (task, fd, POLLIN) < 0) {
        close (fd);
        goto failed;
    }
''')
text = change_once(text, '''    self->alive &= ~HEV_SOCKS5_SESSION_UDP_ALIVE_B;
    hev_task_del_fd (task, fd);
    close (fd);
}''', '''    hev_task_del_fd (task, fd);
    close (fd);
failed:
    self->alive &= ~HEV_SOCKS5_SESSION_UDP_ALIVE_B;
    hev_socks5_set_timeout (HEV_SOCKS5 (self), 0);
    hev_task_wakeup (self->data.task);
}''')
text = change_once(text, '''    int stack_size;
    int fd;

    LOG_D ("%p socks5 session udp splice", self);''', '''    int stack_size;
    int fd;
    unsigned int poll_events = POLLIN | POLLOUT;

    LOG_D ("%p socks5 session udp splice", self);''')
text = change_once(text, '''    fd = hev_socks5_udp_get_fd (HEV_SOCKS5_UDP (self));
    if (hev_task_mod_fd (task, fd, POLLOUT) < 0)
        hev_task_add_fd (task, fd, POLLOUT);
''', '''    fd = hev_socks5_udp_get_fd (HEV_SOCKS5_UDP (self));
    /* UDP-in-UDP retains its TCP association channel for EOF detection,
     * but the completed handshake no longer needs TCP write readiness. */
    if (HEV_SOCKS5 (self)->type == HEV_SOCKS5_TYPE_UDP_IN_UDP &&
        hev_task_mod_fd (task, HEV_SOCKS5 (self)->fd, POLLIN) < 0)
        return;
    if (hev_ohos_update_interest (task, fd, &poll_events,
                                  hev_list_first (&self->frame_list) ?
                                      POLLOUT : 0) < 0)
        return;
''')
text = change_once(text, '''    task = hev_task_new (stack_size);
    hev_task_ref (task);''', '''    task = hev_task_new (stack_size);
    if (!task)
        return;
    hev_task_ref (task);''')
text = change_once(text, '        if (hev_socks5_session_udp_fwd_f (self) < 0)', '        if (hev_socks5_session_udp_fwd_f (self, &poll_events) < 0)')
text = change_once(text, '''    self->alive &= ~HEV_SOCKS5_SESSION_UDP_ALIVE_F;
    hev_task_join (task);''', '''    self->alive &= ~HEV_SOCKS5_SESSION_UDP_ALIVE_F;
    /* Wake the reverse task through join; its next WAITIO must terminate. */
    hev_socks5_set_timeout (HEV_SOCKS5 (self), 0);
    hev_task_join (task);''')
files[path][1] = text

patch = ''.join(''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/'+path, tofile='b/'+path)) for path,(old,new) in files.items())
outdir = NATIVE / 'patches'
outdir.mkdir(exist_ok=True)
patchpath = outdir / 'demand-driven-io.patch'
patchpath.write_text(patch, encoding='utf-8', newline='\n')
sha = lambda s: hashlib.sha256(s.encode('utf-8')).hexdigest()
manifest = {'name':'demand-driven-io', 'patchSHA256':sha(patch), 'normalization':'UTF-8 without BOM, LF in the two staged C files only', 'files':[{'path':path, 'beforeSHA256':sha(old), 'afterSHA256':sha(new)} for path,(old,new) in files.items()]}
(outdir / 'demand-driven-io.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps({'patchSHA256':manifest['patchSHA256'], 'changedFiles':len(files)}))
