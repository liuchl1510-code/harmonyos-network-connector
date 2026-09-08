#include "probe_socks.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <exception>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace {
using Clock = std::chrono::steady_clock;
constexpr int kPollMilliseconds = 50;
constexpr size_t kMaximumHeaders = 8192;

class OwnedFd final {
public:
    explicit OwnedFd(int fd) : fd_(fd) {}
    ~OwnedFd() { if (fd_ >= 0) { ::close(fd_); } }
    OwnedFd(const OwnedFd &) = delete;
    OwnedFd &operator=(const OwnedFd &) = delete;
    int get() const { return fd_; }
    int release() { const int fd = fd_; fd_ = -1; return fd; }
private:
    int fd_;
};

std::string SocketError(const char *operation)
{
    return std::string(operation) + " failed, errno=" + std::to_string(errno);
}

bool ConfigureFd(int fd, std::string &error)
{
    const int status = ::fcntl(fd, F_GETFL);
    if (status < 0 || ::fcntl(fd, F_SETFL, status | O_NONBLOCK) < 0) {
        error = SocketError("fcntl O_NONBLOCK");
        return false;
    }
    const int descriptorFlags = ::fcntl(fd, F_GETFD);
    if (descriptorFlags < 0 || ::fcntl(fd, F_SETFD, descriptorFlags | FD_CLOEXEC) < 0) {
        error = SocketError("fcntl FD_CLOEXEC");
        return false;
    }
    return true;
}

bool WaitReady(int fd, short events, Clock::time_point deadline,
               const std::atomic<bool> &stopping, std::string &error)
{
    while (!stopping.load()) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now());
        if (remaining.count() <= 0) {
            error = "SOCKS/HTTP request exceeded 3-second deadline";
            return false;
        }
        pollfd item{fd, events, 0};
        const int timeout = static_cast<int>(std::min<int64_t>(kPollMilliseconds, remaining.count()));
        const int result = ::poll(&item, 1, timeout);
        if (result < 0) {
            if (errno == EINTR) { continue; }
            error = SocketError("poll");
            return false;
        }
        if (result == 0) { continue; }
        if ((item.revents & events) != 0) { return !stopping.load(); }
        if ((item.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
            error = "SOCKS client disconnected or socket failed";
            return false;
        }
    }
    return false;
}

bool ReadExact(int fd, uint8_t *buffer, size_t length, Clock::time_point deadline,
               const std::atomic<bool> &stopping, std::string &error)
{
    size_t received = 0;
    while (received < length) {
        if (!WaitReady(fd, POLLIN, deadline, stopping, error)) { return false; }
        const ssize_t count = ::recv(fd, buffer + received, length - received, 0);
        if (count > 0) { received += static_cast<size_t>(count); continue; }
        if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) { continue; }
        error = count == 0 ? "SOCKS client closed an incomplete request" : SocketError("recv");
        return false;
    }
    return true;
}

bool WriteAll(int fd, const void *data, size_t length, Clock::time_point deadline,
              const std::atomic<bool> &stopping, std::string &error)
{
    const auto *buffer = static_cast<const uint8_t *>(data);
    size_t sent = 0;
    while (sent < length) {
        if (!WaitReady(fd, POLLOUT, deadline, stopping, error)) { return false; }
        const ssize_t count = ::send(fd, buffer + sent, length - sent, MSG_NOSIGNAL);
        if (count > 0) { sent += static_cast<size_t>(count); continue; }
        if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) { continue; }
        error = count == 0 ? "SOCKS client write made no progress" : SocketError("send");
        return false;
    }
    return true;
}

bool Reply(int fd, uint8_t code, Clock::time_point deadline,
           const std::atomic<bool> &stopping, std::string &error)
{
    // No outbound connection is created; the synthetic bound address is zero.
    const std::array<uint8_t, 10> response{5, code, 0, 1, 0, 0, 0, 0, 0, 0};
    return WriteAll(fd, response.data(), response.size(), deadline, stopping, error);
}

bool ValidToken(const std::string &token)
{
    return !token.empty() && token.size() <= 64 &&
        std::all_of(token.begin(), token.end(), [](unsigned char c) {
            return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        });
}
} // namespace

ProbeSocksServer::~ProbeSocksServer()
{
    stop();
}

bool ProbeSocksServer::start(uint16_t requestedPort, const std::string &token, std::string &error)
{
    std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
    error.clear();
    const auto fail = [this, &error](const std::string &message) {
        error = message;
        setError(message);
        return false;
    };
    if (worker_.joinable()) { return fail("SOCKS probe is already started; call stop before restart"); }
    if (!ValidToken(token)) { return fail("Probe token must contain 1-64 ASCII letters or digits"); }

    OwnedFd listener(::socket(AF_INET, SOCK_STREAM, 0));
    if (listener.get() < 0) { return fail(SocketError("socket")); }
    if (!ConfigureFd(listener.get(), error)) { return fail(error); }
    const int reuseAddress = 1;
    if (::setsockopt(listener.get(), SOL_SOCKET, SO_REUSEADDR, &reuseAddress, sizeof(reuseAddress)) < 0) {
        return fail(SocketError("setsockopt SO_REUSEADDR"));
    }
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(requestedPort);
    if (::bind(listener.get(), reinterpret_cast<const sockaddr *>(&address), sizeof(address)) < 0) {
        return fail(SocketError("bind loopback"));
    }
    if (::listen(listener.get(), 4) < 0) { return fail(SocketError("listen")); }
    socklen_t addressLength = sizeof(address);
    if (::getsockname(listener.get(), reinterpret_cast<sockaddr *>(&address), &addressLength) < 0) {
        return fail(SocketError("getsockname"));
    }

    const uint64_t previousRequests = requests_.exchange(0);
    setError("");
    stopping_.store(false);
    port_.store(ntohs(address.sin_port));
    try {
        worker_ = std::thread(&ProbeSocksServer::run, this, listener.get(), token);
    } catch (const std::exception &exception) {
        stopping_.store(true);
        port_.store(0);
        requests_.store(previousRequests);
        return fail(std::string("Unable to start SOCKS worker: ") + exception.what());
    }
    listenerFd_ = listener.release();
    return true;
}

void ProbeSocksServer::stop()
{
    std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
    stopping_.store(true);
    if (worker_.joinable()) { worker_.join(); }
    // The worker no longer borrows this descriptor. Never close it concurrently.
    if (listenerFd_ >= 0) {
        ::close(listenerFd_);
        listenerFd_ = -1;
    }
    port_.store(0);
}

uint16_t ProbeSocksServer::port() const { return port_.load(); }
uint64_t ProbeSocksServer::requests() const { return requests_.load(); }

std::string ProbeSocksServer::lastError() const
{
    std::lock_guard<std::mutex> errorLock(errorMutex_);
    return lastError_;
}

void ProbeSocksServer::setError(const std::string &error)
{
    std::lock_guard<std::mutex> errorLock(errorMutex_);
    lastError_ = error;
}

void ProbeSocksServer::run(int listener, std::string token)
{
    try {
        while (!stopping_.load()) {
            pollfd item{listener, POLLIN, 0};
            const int ready = ::poll(&item, 1, kPollMilliseconds);
            if (stopping_.load()) { break; }
            if (ready < 0) {
                if (errno == EINTR) { continue; }
                setError(SocketError("listener poll"));
                break;
            }
            if (ready == 0) { continue; }
            if ((item.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
                setError("SOCKS listener socket failed");
                break;
            }
            if ((item.revents & POLLIN) == 0) { continue; }
            OwnedFd client(::accept(listener, nullptr, nullptr));
            if (client.get() < 0) {
                if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue; }
                setError(SocketError("accept"));
                break;
            }
            std::string error;
            if (!ConfigureFd(client.get(), error) || !serve(client.get(), token, error)) {
                if (!stopping_.load() && !error.empty()) { setError(error); }
            }
        }
    } catch (const std::exception &exception) {
        setError(std::string("SOCKS worker exception: ") + exception.what());
    } catch (...) {
        setError("SOCKS worker encountered an unknown exception");
    }
    port_.store(0);
}

bool ProbeSocksServer::serve(int client, const std::string &token, std::string &error)
{
    // One deadline covers greeting, CONNECT, HTTP headers, and the response.
    const auto deadline = Clock::now() + std::chrono::seconds(3);
    std::array<uint8_t, 2> greeting{};
    if (!ReadExact(client, greeting.data(), greeting.size(), deadline, stopping_, error)) { return false; }
    if (greeting[0] != 5) { error = "Only SOCKS5 is accepted"; return false; }
    std::array<uint8_t, 255> methods{};
    if (!ReadExact(client, methods.data(), greeting[1], deadline, stopping_, error)) { return false; }
    const bool hasNoAuth = std::find(methods.begin(), methods.begin() + greeting[1], 0) !=
        methods.begin() + greeting[1];
    const std::array<uint8_t, 2> negotiation{5, static_cast<uint8_t>(hasNoAuth ? 0 : 255)};
    if (!WriteAll(client, negotiation.data(), negotiation.size(), deadline, stopping_, error)) { return false; }
    if (!hasNoAuth) { error = "SOCKS client did not offer no-authentication method"; return false; }

    std::array<uint8_t, 4> request{};
    if (!ReadExact(client, request.data(), request.size(), deadline, stopping_, error)) { return false; }
    uint8_t rejectCode = 0;
    if (request[0] != 5 || request[2] != 0) { rejectCode = 1; error = "Invalid SOCKS5 CONNECT header"; }
    else if (request[1] != 1) { rejectCode = 7; error = "Only SOCKS5 CONNECT is accepted"; }
    else if (request[3] != 1) { rejectCode = 8; error = "Only SOCKS5 IPv4 destinations are accepted"; }
    if (rejectCode != 0) {
        std::string replyError;
        Reply(client, rejectCode, deadline, stopping_, replyError);
        return false;
    }
    std::array<uint8_t, 6> destination{};
    if (!ReadExact(client, destination.data(), destination.size(), deadline, stopping_, error)) { return false; }
    // 18080 == 0x46a0. Never open a socket to this or any other destination.
    const std::array<uint8_t, 6> allowedDestination{198, 18, 0, 1, 0x46, 0xa0};
    if (destination != allowedDestination) {
        std::string replyError;
        Reply(client, 2, deadline, stopping_, replyError);
        error = "SOCKS destination must be synthetic probe 198.18.0.1:18080";
        return false;
    }
    if (!Reply(client, 0, deadline, stopping_, error)) { return false; }

    std::string headers;
    headers.reserve(1024);
    while (headers.find("\r\n\r\n") == std::string::npos) {
        if (headers.size() >= kMaximumHeaders) { error = "HTTP headers exceed 8192 bytes"; return false; }
        if (!WaitReady(client, POLLIN, deadline, stopping_, error)) { return false; }
        std::array<char, 1024> chunk{};
        const size_t capacity = std::min(chunk.size(), kMaximumHeaders - headers.size());
        const ssize_t count = ::recv(client, chunk.data(), capacity, 0);
        if (count > 0) { headers.append(chunk.data(), static_cast<size_t>(count)); continue; }
        if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) { continue; }
        error = count == 0 ? "HTTP client closed incomplete headers" : SocketError("HTTP recv");
        return false;
    }
    const std::string expected = "GET /probe/" + token + " HTTP/1.1\r\n";
    if (headers.compare(0, expected.size(), expected) != 0) {
        error = "HTTP request must be GET /probe/<matching-token> HTTP/1.1";
        return false;
    }
    const std::string body = "{\"token\":\"" + token + "\",\"via\":\"local-socks-fixture\"}";
    const std::string response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
        std::to_string(body.size()) + "\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n" + body;
    if (!WriteAll(client, response.data(), response.size(), deadline, stopping_, error)) { return false; }
    requests_.fetch_add(1);
    return true;
}
