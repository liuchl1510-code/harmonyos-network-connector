#include "poll_edge_probe.h"
#include <array>
#include <cerrno>
#include <netinet/in.h>
#include <poll.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace {
struct Handles {
    std::array<int, 4> fds{-1, -1, -1, -1};
    ~Handles() { for (int fd : fds) { if (fd >= 0) { ::close(fd); } } }
};

std::string Fail(int error) { return "{\"setupError\":" + std::to_string(error) + "}"; }

std::string Probe(int kind, bool edge)
{
    Handles owned;
    auto &fds = owned.fds;
    const int flags = SOCK_NONBLOCK | SOCK_CLOEXEC;
    if (kind == 0) {
        int pair[2];
        if (::socketpair(AF_UNIX, SOCK_STREAM | flags, 0, pair) < 0) { return Fail(errno); }
        fds[0] = pair[0]; fds[1] = pair[1];
    } else {
        const int type = kind == 1 ? SOCK_DGRAM : SOCK_STREAM;
        fds[0] = ::socket(AF_INET, type | flags, 0);
        if (fds[0] < 0) { return Fail(errno); }
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (::bind(fds[0], reinterpret_cast<sockaddr *>(&address), sizeof(address)) < 0) { return Fail(errno); }
        if (kind == 2) {
            socklen_t size = sizeof(address);
            if (::listen(fds[0], 1) < 0 || ::getsockname(fds[0], reinterpret_cast<sockaddr *>(&address), &size) < 0) { return Fail(errno); }
            fds[1] = fds[0];
            fds[0] = ::socket(AF_INET, SOCK_STREAM | flags, 0);
            if (fds[0] < 0) { return Fail(errno); }
            if (::connect(fds[0], reinterpret_cast<sockaddr *>(&address), sizeof(address)) < 0 && errno != EINPROGRESS) { return Fail(errno); }
            pollfd wait{fds[1], POLLIN, 0};
            if (::poll(&wait, 1, 100) <= 0) { return Fail(ETIMEDOUT); }
            fds[2] = ::accept(fds[1], nullptr, nullptr);
            if (fds[2] < 0) { return Fail(errno); }
            int connectionError = 0;
            size = sizeof(connectionError);
            if (::getsockopt(fds[0], SOL_SOCKET, SO_ERROR, &connectionError, &size) < 0) { return Fail(errno); }
            if (connectionError) { return Fail(connectionError); }
        }
    }
    fds[3] = ::epoll_create1(EPOLL_CLOEXEC);
    if (fds[3] < 0) { return Fail(errno); }
    epoll_event event{};
    event.events = EPOLLIN | EPOLLOUT | (edge ? EPOLLET : 0U);
    event.data.u64 = 1;
    if (::epoll_ctl(fds[3], EPOLL_CTL_ADD, fds[0], &event) < 0) { return Fail(errno); }
    std::string results = "[", masks = "[", errors = "[";
    int emptyReadErrno = 0;
    for (int i = 0; i < 4; ++i) {
        if (i == 2) {
            char unused;
            if (::recv(fds[0], &unused, 1, 0) < 0) { emptyReadErrno = errno; }
        }
        epoll_event ready{};
        int count = ::epoll_wait(fds[3], &ready, 1, 0);
        const int waitError = count < 0 ? errno : 0;
        if (i) { results += ","; masks += ","; errors += ","; }
        results += std::to_string(count);
        masks += std::to_string(count > 0 ? ready.events : 0U);
        errors += std::to_string(waitError);
    }
    return "{\"setupError\":0,\"counts\":" + results + "],\"masks\":" + masks +
        "],\"waitErrors\":" + errors + "],\"emptyReadErrno\":" + std::to_string(emptyReadErrno) + "}";
}
}

std::string RunPollEdgeControls()
{
    return "{\"unixEt\":" + Probe(0, true) + ",\"unixLt\":" + Probe(0, false) +
        ",\"udpEt\":" + Probe(1, true) + ",\"tcpEt\":" + Probe(2, true) + "}";
}
