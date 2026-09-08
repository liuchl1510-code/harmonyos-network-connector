#include "forward_bridge.h"
#include "probe_socks.h"
#include "poll_edge_probe.h"
#include "../../../../native/hev/include/hev-main.h"
#include "../../../../native/hev/include/hev-ohos-io-stats.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <dlfcn.h>
#include <fcntl.h>
#include <functional>
#include <memory>
#include <mutex>
#include <netinet/in.h>
#include <pthread.h>
#include <stdexcept>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>


namespace {
constexpr size_t kMaximumXrayRequest = 8 * 1024 * 1024;
using Clock = std::chrono::steady_clock;

struct XrayApi {
    void *module = nullptr;
    char *(*start)(char *) = nullptr;
    char *(*stop)() = nullptr;
    char *(*version)() = nullptr;
    char *(*runtimeInfo)() = nullptr;
    char *(*connectionStats)() = nullptr;
    void (*freeResult)(char *) = nullptr;
};

struct NativeState {
    std::mutex control;
    ProbeSocksServer fixture;
    std::thread hevWorker;
    std::atomic<bool> hevDone{true};
    std::atomic<int> hevExit{0};
    int ownedTunFd = -1;
    bool hevFailed = false;
    std::string pollEdgeControl = "{}";
    XrayApi xray;
};

NativeState &State()
{
    // Process lifetime ownership is deliberate. A stop timeout must never
    // destroy a joinable thread or unload code that it can still execute.
    static NativeState *state = new NativeState();
    return *state;
}

std::string HevIoSnapshot()
{
    static const char *keys[] = {"epollCalls", "timeoutZero", "timeoutPositive", "timeoutNegative",
        "epollErrors", "epollZero", "epollReady", "epollLastErrno",
        "readCalls", "readEagain", "readZero", "readOtherErrors",
        "readyIn", "readyOut", "readyErr", "readyHup", "readyRdhup"};
    uint64_t values[HEV_IO_STATS_COUNT]{};
    hev_ohos_io_stats(values, HEV_IO_STATS_COUNT);
    std::string result = "{";
    for (size_t i = 0; i < HEV_IO_STATS_COUNT; ++i) {
        if (i) { result += ","; }
        result += std::string("\"") + keys[i] + "\":" + std::to_string(values[i]);
    }
    return result + "}";
}

std::string JsonString(const std::string &value)
{
    std::string result = "\"";
    for (unsigned char ch : value) {
        switch (ch) {
            case '"': result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            default:
                if (ch < 0x20) {
                    const char hex[] = "0123456789abcdef";
                    result += "\\u00";
                    result += hex[ch >> 4];
                    result += hex[ch & 15];
                } else {
                    result += static_cast<char>(ch);
                }
        }
    }
    return result + '"';
}

napi_value Text(napi_env env, const std::string &text)
{
    napi_value value = nullptr;
    if (napi_create_string_utf8(env, text.data(), text.size(), &value) != napi_ok) {
        napi_throw_error(env, nullptr, "Cannot allocate native response");
    }
    return value;
}

napi_value ErrorValue(napi_env env, const std::string &message)
{
    napi_value error = nullptr;
    napi_value text = Text(env, message);
    if (!text || napi_create_error(env, nullptr, text, &error) != napi_ok) { return nullptr; }
    return error;
}

napi_value Reject(napi_env env, const char *message)
{
    napi_deferred deferred = nullptr;
    napi_value promise = nullptr;
    if (napi_create_promise(env, &deferred, &promise) != napi_ok) {
        napi_throw_error(env, nullptr, "Cannot allocate native promise");
        return nullptr;
    }
    napi_value error = ErrorValue(env, message);
    if (error) { napi_reject_deferred(env, deferred, error); }
    return promise;
}

struct AsyncCall {
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
    std::function<std::string()> operation;
    std::string result;
    std::string error;
};

void Execute(napi_env, void *data)
{
    auto *call = static_cast<AsyncCall *>(data);
    try {
        std::lock_guard<std::mutex> lock(State().control);
        call->result = call->operation();
    } catch (const std::exception &error) {
        call->error = error.what();
    } catch (...) {
        call->error = "Unexpected native operation failure";
    }
}

void Complete(napi_env env, napi_status status, void *data)
{
    std::unique_ptr<AsyncCall> call(static_cast<AsyncCall *>(data));
    if (status != napi_ok && call->error.empty()) { call->error = "Native operation was cancelled"; }
    if (call->error.empty()) {
        napi_value result = Text(env, call->result);
        if (result) { napi_resolve_deferred(env, call->deferred, result); }
    } else {
        napi_value error = ErrorValue(env, call->error);
        if (error) { napi_reject_deferred(env, call->deferred, error); }
    }
    napi_delete_async_work(env, call->work);
}

napi_value Queue(napi_env env, const char *name, std::function<std::string()> operation)
{
    std::unique_ptr<AsyncCall> call(new AsyncCall());
    call->operation = std::move(operation);
    napi_value promise = nullptr;
    if (napi_create_promise(env, &call->deferred, &promise) != napi_ok) {
        napi_throw_error(env, nullptr, "Cannot allocate native promise");
        return nullptr;
    }
    napi_value label = Text(env, name);
    if (!label || napi_create_async_work(env, nullptr, label, Execute, Complete, call.get(), &call->work) != napi_ok) {
        napi_value error = ErrorValue(env, "Cannot create native work");
        if (error) { napi_reject_deferred(env, call->deferred, error); }
        return promise;
    }
    if (napi_queue_async_work(env, call->work) != napi_ok) {
        napi_value error = ErrorValue(env, "Cannot queue native work");
        if (error) { napi_reject_deferred(env, call->deferred, error); }
        napi_delete_async_work(env, call->work);
        return promise;
    }
    call.release();
    return promise;
}

bool Arguments(napi_env env, napi_callback_info info, size_t expected, napi_value *values)
{
    // Capacity is one greater than expected so extra arguments are rejected.
    size_t count = expected + 1;
    return napi_get_cb_info(env, info, &count, values, nullptr, nullptr) == napi_ok && count == expected;
}

bool StringArgument(napi_env env, napi_value value, size_t maximum, std::string &text)
{
    napi_valuetype type;
    size_t length = 0;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > maximum) {
        return false;
    }
    std::vector<char> buffer(length + 1);
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &copied) != napi_ok || copied != length) {
        return false;
    }
    text.assign(buffer.data(), length);
    return text.find('\0') == std::string::npos;
}

bool IntegerArgument(napi_env env, napi_value value, int minimum, int maximum, int &result)
{
    napi_valuetype type;
    double number;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
        napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) ||
        std::floor(number) != number || number < minimum || number > maximum) { return false; }
    return napi_get_value_int32(env, value, &result) == napi_ok;
}

int StopHevWorker(NativeState &state, std::chrono::milliseconds limit)
{
    if (!state.hevWorker.joinable()) { return state.hevExit.load(); }
    const auto deadline = Clock::now() + limit;
    while (!state.hevDone.load(std::memory_order_acquire)) {
        if (Clock::now() >= deadline) {
            throw std::runtime_error("Hev stop exceeded 5 seconds; restart the VPN extension before retrying");
        }
        // quit before Hev creates its wakeup pipe is ignored. Repeating it
        // handles early stop without a readiness claim or unsafe stats call.
        hev_socks5_tunnel_quit();
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    state.hevWorker.join();
    if (state.ownedTunFd >= 0) {
        ::close(state.ownedTunFd);
        state.ownedTunFd = -1;
    }
    const int result = state.hevExit.load();
    if (result < 0) { state.hevFailed = true; }
    return result;
}

napi_value StartFixture(napi_env env, napi_callback_info info)
{
    napi_value values[2]{};
    std::string token;
    if (!Arguments(env, info, 1, values) || !StringArgument(env, values[0], 64, token) || token.empty() ||
        !std::all_of(token.begin(), token.end(), [](unsigned char ch) {
            return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
        })) { return Reject(env, "token must contain 1-64 ASCII letters or digits"); }
    return Queue(env, "startFixture", [token]() {
        std::string error;
        if (!State().fixture.start(0, token, error)) { throw std::runtime_error(error); }
        return "{\"port\":" + std::to_string(State().fixture.port()) + ",\"requests\":0}";
    });
}

napi_value StopFixture(napi_env env, napi_callback_info info)
{
    napi_value values[1]{};
    if (!Arguments(env, info, 0, values)) { return Reject(env, "stopFixture expects no arguments"); }
    return Queue(env, "stopFixture", []() {
        State().fixture.stop();
        return "{\"requests\":" + std::to_string(State().fixture.requests()) + "}";
    });
}

napi_value StartHev(napi_env env, napi_callback_info info)
{
    napi_value values[4]{};
    int fd, port;
    size_t count = 4;
    bool captureIpv6 = false;
    if (napi_get_cb_info(env, info, &count, values, nullptr, nullptr) != napi_ok ||
        (count != 2 && count != 3) || !IntegerArgument(env, values[0], 0, INT_MAX, fd) ||
        !IntegerArgument(env, values[1], 1, 65535, port)) {
        return Reject(env, "startHev requires a valid nonnegative fd and port 1-65535");
    }
    if (count == 3 && napi_get_value_bool(env, values[2], &captureIpv6) != napi_ok) {
        return Reject(env, "startHev captureIpv6 must be a boolean");
    }
    return Queue(env, "startHev", [fd, port, captureIpv6]() {
        NativeState &state = State();
        if (state.hevWorker.joinable()) { throw std::runtime_error("Hev is already owned; stop it before starting again"); }
        if (state.hevFailed) { throw std::runtime_error("Hev initialization failed earlier; restart the VPN extension"); }
        state.pollEdgeControl = RunPollEdgeControls();
        const int owned = ::fcntl(fd, F_DUPFD_CLOEXEC, 0);
        if (owned < 0) { throw std::runtime_error("Cannot duplicate TUN descriptor, errno=" + std::to_string(errno)); }
        const int flags = ::fcntl(owned, F_GETFL);
        if (flags < 0 || ::fcntl(owned, F_SETFL, flags | O_NONBLOCK) < 0) {
            const int saved = errno;
            ::close(owned);
            throw std::runtime_error("Cannot configure TUN descriptor, errno=" + std::to_string(saved));
        }
        const std::string config = std::string("tunnel:\n  mtu: 1400\n") +
            (captureIpv6 ? "  ipv6: 'fdfe:dcba:9876::1'\n" : "") + "socks5:\n  address: 127.0.0.1\n  port: " +
            std::to_string(port) + "\n  pipeline: false\n  udp: udp\nmisc:\n  log-file: stderr\n  log-level: warn\n"
            "  connect-timeout: 5000\n  read-write-timeout: " + (captureIpv6 ? "300000\n" : "5000\n");
        state.ownedTunFd = owned;
        state.hevDone.store(false);
        state.hevExit.store(0);
        try {
            state.hevWorker = std::thread([owned, config, &state]() {
                pthread_setname_np(pthread_self(), "harmony-hev");
                const int result = hev_socks5_tunnel_main_from_str(
                    reinterpret_cast<const unsigned char *>(config.data()),
                    static_cast<unsigned int>(config.size()), owned);
                state.hevExit.store(result);
                state.hevDone.store(true, std::memory_order_release);
            });
        } catch (...) {
            state.hevDone.store(true);
            state.ownedTunFd = -1;
            ::close(owned);
            throw;
        }
        return std::string("{\"workerStarted\":true}");
    });
}

napi_value ForwardingStatus(napi_env env, napi_callback_info info)
{
    napi_value values[1]{};
    if (!Arguments(env, info, 0, values)) { return Reject(env, "forwardingStatus expects no arguments"); }
    const bool running = !State().hevDone.load(std::memory_order_acquire);
    const std::string result = std::string("{\"hevRunning\":") + (running ? "true" : "false") +
        ",\"hevExit\":" + std::to_string(State().hevExit.load()) + ",\"io\":" + HevIoSnapshot() + "}";
    return Text(env, result);
}

napi_value StopHev(napi_env env, napi_callback_info info)
{
    napi_value values[1]{};
    if (!Arguments(env, info, 0, values)) { return Reject(env, "stopHev expects no arguments"); }
    return Queue(env, "stopHev", []() {
        const int exitCode = StopHevWorker(State(), std::chrono::seconds(5));
        return "{\"stopped\":true,\"exitCode\":" + std::to_string(exitCode) + ",\"io\":" + HevIoSnapshot() +
            ",\"edgeControl\":" + State().pollEdgeControl + "}";
    });
}

void LoadXray(XrayApi &api)
{
    if (!api.module) { api.module = ::dlopen("libxray.so", RTLD_NOW | RTLD_LOCAL); }
    if (!api.module) { throw std::runtime_error("Unable to load packaged libxray.so"); }
    if (!api.start) {
        api.start = reinterpret_cast<char *(*)(char *)>(::dlsym(api.module, "CGoRunXrayFromJSON"));
        api.stop = reinterpret_cast<char *(*)()>(::dlsym(api.module, "CGoStopXray"));
        api.version = reinterpret_cast<char *(*)()>(::dlsym(api.module, "CGoXrayVersion"));
        api.runtimeInfo = reinterpret_cast<char *(*)()>(::dlsym(api.module, "CGoRuntimeInfo"));
        api.connectionStats = reinterpret_cast<char *(*)()>(::dlsym(api.module, "CGoConnectionStats"));
        api.freeResult = reinterpret_cast<void (*)(char *)>(::dlsym(api.module, "CGoFree"));
    }
    if (!api.start || !api.stop || !api.version || !api.runtimeInfo || !api.connectionStats || !api.freeResult) {
        throw std::runtime_error("Packaged Xray library does not expose the expected CGo API");
    }
}

napi_value ConfigureXrayCa(napi_env env, napi_callback_info info)
{
    napi_value values[2]{};
    std::string path;
    if (!Arguments(env, info, 1, values) || !StringArgument(env, values[0], 4096, path) ||
        path.empty() || path.front() != '/') {
        return Reject(env, "CA bundle requires an absolute application file path");
    }
    return Queue(env, "configureXrayCa", [path]() {
        if (State().xray.module) { throw std::runtime_error("Configure CA before loading Xray; restart the extension"); }
        const int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
        if (fd < 0) { throw std::runtime_error("CA bundle is not readable"); }
        struct stat info{};
        const bool valid = ::fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_size > 0 && info.st_size < 2 * 1024 * 1024;
        ::close(fd);
        if (!valid || ::setenv("SSL_CERT_FILE", path.c_str(), 1) != 0) {
            throw std::runtime_error("Cannot configure the application CA bundle");
        }
        return std::string("{\"configured\":true}");
    });
}

napi_value XrayCall(napi_env env, napi_callback_info info)
{
    napi_value values[3]{};
    std::string operation, request;
    if (!Arguments(env, info, 2, values) || !StringArgument(env, values[0], 7, operation) ||
        !StringArgument(env, values[1], kMaximumXrayRequest, request) ||
        (operation != "start" && operation != "stop" && operation != "version" && operation != "runtime" && operation != "stats") ||
        (operation == "start" && request.empty()) || (operation == "stats" && !request.empty())) {
        return Reject(env, "xrayCall requires start/stop/version/runtime/stats and a bounded request string");
    }
    return Queue(env, "xrayCall", [operation, request]() mutable {
        XrayApi &api = State().xray;
        LoadXray(api);
        char *raw = operation == "stats" ? api.connectionStats() : operation == "start" ? api.start(request.data()) :
            (operation == "stop" ? api.stop() : (operation == "runtime" ? api.runtimeInfo() : api.version()));
        if (!raw) { throw std::runtime_error("Xray returned a null response"); }
        // Even if string allocation throws, only this library's CGoFree releases
        // Go's C-allocated reply. Request/configuration is never logged here.
        std::unique_ptr<char, void (*)(char *)> owned(raw, api.freeResult);
        return std::string(owned.get());
    });
}

napi_value FixtureStatus(napi_env env, napi_callback_info info)
{
    napi_value values[1]{};
    if (!Arguments(env, info, 0, values)) {
        napi_throw_type_error(env, nullptr, "fixtureStatus expects no arguments");
        return nullptr;
    }
    // These getters use atomics and the fixture's short diagnostic mutex, so
    // they never wait on a start/stop or Go call holding the control mutex.
    const auto &fixture = State().fixture;
    return Text(env, "{\"port\":" + std::to_string(fixture.port()) +
        ",\"requests\":" + std::to_string(fixture.requests()) +
        ",\"error\":" + JsonString(fixture.lastError()) + "}");
}

napi_value GetFreePort(napi_env env, napi_callback_info info)
{
    napi_value values[1]{};
    if (!Arguments(env, info, 0, values)) {
        napi_throw_type_error(env, nullptr, "getFreePort expects no arguments");
        return nullptr;
    }
    const int fd = ::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { napi_throw_error(env, nullptr, "Cannot allocate port probe socket"); return nullptr; }
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t length = sizeof(address);
    const bool okay = ::bind(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == 0 &&
        ::getsockname(fd, reinterpret_cast<sockaddr *>(&address), &length) == 0;
    ::close(fd);
    if (!okay) { napi_throw_error(env, nullptr, "Cannot select a free loopback port"); return nullptr; }
    napi_value result = nullptr;
    napi_create_uint32(env, ntohs(address.sin_port), &result);
    // The reservation ends here; the caller must treat bind failure as possible.
    return result;
}

napi_value GetFreePorts(napi_env env, napi_callback_info info)
{
    napi_value values[1]{};
    if (!Arguments(env, info, 0, values)) {
        napi_throw_type_error(env, nullptr, "getFreePorts expects no arguments");
        return nullptr;
    }
    int sockets[2] = {-1, -1};
    uint16_t ports[2] = {0, 0};
    bool okay = true;
    for (int index = 0; index < 2; ++index) {
        sockets[index] = ::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
        if (sockets[index] < 0) { okay = false; break; }
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        socklen_t length = sizeof(address);
        if (::bind(sockets[index], reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 ||
            ::getsockname(sockets[index], reinterpret_cast<sockaddr *>(&address), &length) != 0) {
            okay = false;
            break;
        }
        ports[index] = ntohs(address.sin_port);
    }
    // Hold the first reservation while selecting the second so the OS cannot
    // immediately hand out the same just-released port twice.
    for (int fd : sockets) { if (fd >= 0) { ::close(fd); } }
    if (!okay || ports[0] == ports[1]) {
        napi_throw_error(env, nullptr, "Cannot select two distinct loopback ports");
        return nullptr;
    }
    return Text(env, "{\"socksPort\":" + std::to_string(ports[0]) +
        ",\"metricsPort\":" + std::to_string(ports[1]) + "}");
}

void Cleanup(void *)
{
    NativeState &state = State();
    std::unique_lock<std::mutex> lock(state.control, std::try_to_lock);
    if (!lock.owns_lock()) { return; }
    try {
        StopHevWorker(state, std::chrono::seconds(5));
        state.fixture.stop();
    } catch (...) {
        // Process teardown reclaims remaining handles. Never detach a worker,
        // dlclose a Go runtime, or join indefinitely from the cleanup hook.
    }
    // Xray stop has no bounded cancellation ABI. Explicit xrayCall("stop", "")
    // is the normal lifecycle path; cleanup does not risk an unbounded Go call.
}
} // namespace

void RegisterForwardingApis(napi_env env, napi_value exports)
{
    napi_property_descriptor properties[] = {
        {"startFixture", nullptr, StartFixture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopFixture", nullptr, StopFixture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"fixtureStatus", nullptr, FixtureStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"startHev", nullptr, StartHev, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopHev", nullptr, StopHev, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"forwardingStatus", nullptr, ForwardingStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getFreePort", nullptr, GetFreePort, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getFreePorts", nullptr, GetFreePorts, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"configureXrayCa", nullptr, ConfigureXrayCa, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"xrayCall", nullptr, XrayCall, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok ||
        napi_add_env_cleanup_hook(env, Cleanup, nullptr) != napi_ok) {
        napi_throw_error(env, nullptr, "Cannot register native forwarding APIs");
    }
}
