#ifndef HARMONY_VPN_LAB_PROBE_SOCKS_H
#define HARMONY_VPN_LAB_PROBE_SOCKS_H

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

// Local test fixture, never a general-purpose proxy. Only the synthetic
// 198.18.0.1:18080 destination and GET /probe/<token> are accepted.
class ProbeSocksServer final {
public:
    ProbeSocksServer() = default;
    ~ProbeSocksServer();
    ProbeSocksServer(const ProbeSocksServer &) = delete;
    ProbeSocksServer &operator=(const ProbeSocksServer &) = delete;

    // Binds IPv4 loopback. Port 0 selects a free port. Token must contain
    // 1-64 ASCII letters/digits. Call stop() before starting an active server.
    // A successful start resets request count and diagnostics.
    bool start(uint16_t requestedPort, const std::string &token, std::string &error);
    void stop();
    uint16_t port() const;
    uint64_t requests() const;
    std::string lastError() const;

private:
    void run(int listener, std::string token);
    bool serve(int client, const std::string &token, std::string &error);
    void setError(const std::string &error);

    // Only start/stop owns listenerFd_; run borrows it until join completes.
    std::mutex lifecycleMutex_;
    int listenerFd_ = -1;
    std::thread worker_;
    std::atomic<bool> stopping_{true};
    std::atomic<uint16_t> port_{0};
    std::atomic<uint64_t> requests_{0};
    mutable std::mutex errorMutex_;
    std::string lastError_;
};

#endif
