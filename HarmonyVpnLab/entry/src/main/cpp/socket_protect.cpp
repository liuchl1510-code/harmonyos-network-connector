#include "socket_protect.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <dlfcn.h>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;
using SetProtectCallback = void (*)(void *);
constexpr size_t MAX_OUTSTANDING = 128;
constexpr auto PROTECT_TIMEOUT = std::chrono::seconds(3);

struct Counters {
    std::atomic<uint64_t> requests {0};
    std::atomic<uint64_t> succeeded {0};
    std::atomic<uint64_t> failed {0};
    std::atomic<uint64_t> timedOut {0};
    std::atomic<uint64_t> active {0};
};
Counters stats;

enum class Result { WAITING, SUCCEEDED, FAILED, TIMED_OUT };

struct Request {
    explicit Request(int fd) : duplicate(fd), deadline(Clock::now() + PROTECT_TIMEOUT) {}

    ~Request()
    {
        // The last queue/Promise/finalizer owner is gone. No future JS use exists.
        Finish(Result::FAILED);
        CloseDuplicate();
    }

    void SetResultLocked(Result next)
    {
        if (result != Result::WAITING) {
            return;
        }
        result = next;
        if (next == Result::SUCCEEDED) {
            stats.succeeded.fetch_add(1, std::memory_order_relaxed);
        } else {
            stats.failed.fetch_add(1, std::memory_order_relaxed);
            if (next == Result::TIMED_OUT) {
                stats.timedOut.fetch_add(1, std::memory_order_relaxed);
            }
        }
        condition.notify_all();
    }

    void Finish(Result next)
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (next == Result::SUCCEEDED && Clock::now() >= deadline) {
            next = Result::TIMED_OUT;
        }
        SetResultLocked(next);
    }

    void CloseDuplicate()
    {
        const int fd = duplicate.exchange(-1, std::memory_order_acq_rel);
        if (fd >= 0) {
            // Never retry close on EINTR: a retry might close a reused descriptor.
            close(fd);
            stats.active.fetch_sub(1, std::memory_order_relaxed);
        }
    }

    void Cancel()
    {
        std::lock_guard<std::mutex> lock(mutex);
        SetResultLocked(Result::FAILED);
        if (!jsStarted) {
            CloseDuplicate();
        }
        // Once protect() has started, keep the same socket alive until settlement
        // or collection of its Promise/handlers during environment destruction.
    }

    bool BeginJs()
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (result == Result::WAITING && Clock::now() >= deadline) {
            SetResultLocked(Result::TIMED_OUT);
        }
        if (result != Result::WAITING) {
            CloseDuplicate();
            return false;
        }
        jsStarted = true;
        return true;
    }

    int Wait()
    {
        std::unique_lock<std::mutex> lock(mutex);
        if (!condition.wait_until(lock, deadline, [this] { return result != Result::WAITING; })) {
            SetResultLocked(Result::TIMED_OUT);
        }
        // Timeout does not release the duplicate. The queued dispatch or late
        // Promise owns it; Go is free to close only its original fd after return.
        return result == Result::SUCCEEDED ? 0 : 1;
    }

    std::atomic<int> duplicate;
    const Clock::time_point deadline;
    std::mutex mutex;
    std::condition_variable condition;
    Result result = Result::WAITING;
    bool jsStarted = false;
};

struct State {
    explicit State(napi_env currentEnv) : env(currentEnv), jsThread(std::this_thread::get_id())
    {
        requests.reserve(MAX_OUTSTANDING);
    }
    napi_env env;
    const std::thread::id jsThread;
    std::atomic<bool> closing {false};
    std::mutex tsfnMutex;
    napi_threadsafe_function tsfn = nullptr;
    std::mutex requestsMutex;
    // A Promise can become unreachable without the underlying IPC completing.
    // Strong owners prevent GC alone from closing an in-flight duplicate.
    std::vector<std::shared_ptr<Request>> requests;
};

struct RetiredRequests {
    RetiredRequests() { requests.reserve(MAX_OUTSTANDING); }
    std::mutex mutex;
    std::vector<std::shared_ptr<Request>> requests;
};

RetiredRequests &Retired()
{
    // Deliberately process-lived. If an environment disappears before protect's
    // IPC finishes, no JS settlement may ever be deliverable. Closing its fd on
    // Promise GC or addon teardown would risk acting on a reused descriptor.
    // A delivered late handler can still close it; otherwise the OS reclaims it
    // on process exit. The global active-slot bound also covers these requests.
    static auto *registry = new RetiredRequests();
    return *registry;
}

struct StateOwner {
    explicit StateOwner(std::shared_ptr<State> value) : state(std::move(value)) {}
    std::shared_ptr<State> state;
};

struct QueuedRequest {
    explicit QueuedRequest(std::shared_ptr<Request> value) : request(std::move(value)) {}
    std::shared_ptr<Request> request;
};

struct HandlerData {
    HandlerData(std::shared_ptr<Request> value, bool ok) : request(std::move(value)), succeeded(ok) {}
    std::shared_ptr<Request> request;
    const bool succeeded;
};

std::mutex installationMutex;
std::shared_ptr<State> installed;
// The Go runtime and callback address must remain mapped for the process lifetime.
// Re-opening this soname reuses the existing libxray.so; there is deliberately no dlclose.
void *xrayHandle = nullptr;
SetProtectCallback setProtectCallback = nullptr;

void ClearPendingException(napi_env env)
{
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
        napi_value ignored = nullptr;
        napi_get_and_clear_last_exception(env, &ignored);
    }
}

void DetachInstalled(const std::shared_ptr<State> &state)
{
    std::lock_guard<std::mutex> lock(installationMutex);
    if (installed == state) {
        // The Go controller treats an absent callback as a dial error, never as
        // permission to connect without protection.
        if (setProtectCallback != nullptr) {
            setProtectCallback(nullptr);
        }
        installed.reset();
    }
}

void CancelRequests(State &state)
{
    // Do not hold the registry lock while notifying waiters or releasing owners.
    std::vector<std::shared_ptr<Request>> pending;
    {
        std::lock_guard<std::mutex> lock(state.requestsMutex);
        pending.swap(state.requests);
    }
    for (const auto &request : pending) {
        request->Cancel();
        if (request->duplicate.load(std::memory_order_acquire) >= 0) {
            auto &retired = Retired();
            std::lock_guard<std::mutex> lock(retired.mutex);
            auto &items = retired.requests;
            items.erase(std::remove_if(items.begin(), items.end(),
                [](const std::shared_ptr<Request> &item) {
                    return item->duplicate.load(std::memory_order_acquire) < 0;
                }), items.end());
            items.push_back(request);
        }
    }
}

void Cleanup(void *data)
{
    std::unique_ptr<StateOwner> owner(static_cast<StateOwner *>(data));
    const auto state = owner->state;
    state->closing.store(true, std::memory_order_release);
    DetachInstalled(state);
    CancelRequests(*state);
    napi_threadsafe_function tsfn = nullptr;
    {
        std::lock_guard<std::mutex> lock(state->tsfnMutex);
        tsfn = state->tsfn;
        state->tsfn = nullptr;
    }
    if (tsfn != nullptr) {
        // Releases the installation's initial thread count and aborts new work.
        // Pending queue data is owned until CallJs(env=null) drains it.
        napi_release_threadsafe_function(tsfn, napi_tsfn_abort);
    }
    // No joins, Go calls that stop the core, or condition-variable waits here.
}

void TsfnFinalized(napi_env, void *data, void *)
{
    std::unique_ptr<StateOwner> owner(static_cast<StateOwner *>(data));
    const auto state = owner->state;
    state->closing.store(true, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(state->tsfnMutex);
        state->tsfn = nullptr;
    }
    DetachInstalled(state);
    CancelRequests(*state);
    // Unsettled, already-dispatched protection is retained by Retired(), not
    // closed here. Queued items that never invoked JS can be reclaimed normally.
}

void HandlerFinalized(napi_env, void *data, void *)
{
    // Both then branches own data independently. GC frees the branch that never
    // runs as well as the branch that did; callbacks never delete their own data.
    delete static_cast<HandlerData *>(data);
}

napi_value PromiseSettled(napi_env env, napi_callback_info info)
{
    void *data = nullptr;
    size_t argc = 0;
    if (napi_get_cb_info(env, info, &argc, nullptr, nullptr, &data) != napi_ok || data == nullptr) {
        return nullptr;
    }
    const auto *handler = static_cast<HandlerData *>(data);
    handler->request->Finish(handler->succeeded ? Result::SUCCEEDED : Result::FAILED);
    // It is now safe even if the Go callback timed out and its fd was closed.
    handler->request->CloseDuplicate();
    napi_value undefined = nullptr;
    napi_get_undefined(env, &undefined);
    return undefined;
}

bool MakeHandler(napi_env env, const std::shared_ptr<Request> &request, bool succeeded, napi_value *result)
{
    auto *data = new (std::nothrow) HandlerData(request, succeeded);
    if (data == nullptr) {
        return false;
    }
    if (napi_create_function(env, succeeded ? "protected" : "protectionRejected", NAPI_AUTO_LENGTH,
            PromiseSettled, data, result) != napi_ok) {
        delete data;
        return false;
    }
    if (napi_add_finalizer(env, *result, data, HandlerFinalized, nullptr, nullptr) != napi_ok) {
        // This function has not escaped or been passed to then(), so no caller
        // can invoke it after its private native data has been released.
        delete data;
        return false;
    }
    return true;
}

void PromiseFinalized(napi_env, void *data, void *)
{
    delete static_cast<QueuedRequest *>(data);
}

bool AnchorPromise(napi_env env, napi_value promise, const std::shared_ptr<Request> &request)
{
    auto *owner = new (std::nothrow) QueuedRequest(request);
    if (owner == nullptr) {
        return false;
    }
    if (napi_add_finalizer(env, promise, owner, PromiseFinalized, nullptr, nullptr) != napi_ok) {
        delete owner;
        return false;
    }
    return true;
}

void CallJs(napi_env env, napi_value callback, void *context, void *data)
{
    std::unique_ptr<QueuedRequest> queued(static_cast<QueuedRequest *>(data));
    if (!queued) {
        return;
    }
    const auto request = queued->request;
    auto *state = static_cast<State *>(context);
    if (env == nullptr || callback == nullptr || state == nullptr ||
        state->closing.load(std::memory_order_acquire)) {
        request->Cancel();
        return;
    }
    napi_value handlers[2] = {nullptr, nullptr};
    napi_value undefined = nullptr;
    napi_value argument = nullptr;
    if (!MakeHandler(env, request, true, &handlers[0]) || !MakeHandler(env, request, false, &handlers[1]) ||
        napi_get_undefined(env, &undefined) != napi_ok ||
        napi_create_int32(env, request->duplicate.load(std::memory_order_acquire), &argument) != napi_ok) {
        ClearPendingException(env);
        request->Finish(Result::FAILED);
        request->CloseDuplicate();
        return;
    }
    // Check expiry immediately before invoking JS. Setup above cannot let a
    // cancelled queue item call protect() with a descriptor that was reused.
    if (!request->BeginJs()) {
        return;
    }
    napi_value promise = nullptr;
    if (napi_call_function(env, undefined, callback, 1, &argument, &promise) != napi_ok) {
        ClearPendingException(env);
        request->Finish(Result::FAILED);
        // A callback could start async work and then throw. The registry keeps
        // its duplicate until teardown retirement, rather than guessing it is idle.
        return;
    }
    bool isPromise = false;
    if (napi_is_promise(env, promise, &isPromise) != napi_ok || !isPromise) {
        ClearPendingException(env);
        request->Finish(Result::FAILED);
        // An invalid callback could have started async work before returning a
        // non-Promise. Keep its duplicate for teardown retirement/process exit.
        return;
    }
    // The anchor also covers failure while retrieving/calling then(). It keeps
    // an in-flight duplicate alive even when neither handler could be installed.
    if (!AnchorPromise(env, promise, request)) {
        ClearPendingException(env);
        request->Finish(Result::FAILED);
        return;
    }
    napi_value then = nullptr;
    napi_value chained = nullptr;
    napi_valuetype type = napi_undefined;
    if (napi_get_named_property(env, promise, "then", &then) != napi_ok ||
        napi_typeof(env, then, &type) != napi_ok || type != napi_function ||
        napi_call_function(env, promise, then, 2, handlers, &chained) != napi_ok) {
        ClearPendingException(env);
        request->Finish(Result::FAILED);
        // Do not close here: the anchored protection Promise may still be active.
    }
}

bool ReserveDuplicateSlot()
{
    uint64_t active = stats.active.load(std::memory_order_relaxed);
    while (active < MAX_OUTSTANDING) {
        if (stats.active.compare_exchange_weak(active, active + 1, std::memory_order_acq_rel)) {
            return true;
        }
    }
    return false;
}

int ProtectImpl(int originalFd, std::shared_ptr<Request> &request)
{
    std::shared_ptr<State> state;
    {
        std::lock_guard<std::mutex> lock(installationMutex);
        state = installed;
    }
    if (!state || state->closing.load(std::memory_order_acquire) || originalFd < 0 ||
        std::this_thread::get_id() == state->jsThread) {
        return 1;
    }
    if (!ReserveDuplicateSlot()) {
        return 1;
    }
    int duplicate = -1;
    do {
        duplicate = fcntl(originalFd, F_DUPFD_CLOEXEC, 3);
    } while (duplicate < 0 && errno == EINTR);
    if (duplicate < 0) {
        stats.active.fetch_sub(1, std::memory_order_relaxed);
        return 1;
    }
    try {
        request = std::make_shared<Request>(duplicate);
    } catch (...) {
        close(duplicate);
        stats.active.fetch_sub(1, std::memory_order_relaxed);
        throw;
    }
    {
        std::lock_guard<std::mutex> lock(state->requestsMutex);
        if (state->closing.load(std::memory_order_acquire)) {
            request->Cancel();
            return 1;
        }
        auto &requests = state->requests;
        requests.erase(std::remove_if(requests.begin(), requests.end(),
            [](const std::shared_ptr<Request> &item) {
                return item->duplicate.load(std::memory_order_acquire) < 0;
            }), requests.end());
        requests.push_back(request);
    }
    // Acquiring and submitting are serialized with environment cleanup. No
    // request mutex or registry mutex is held while JS runs or Go waits.
    napi_status queuedStatus = napi_closing;
    auto queued = std::make_unique<QueuedRequest>(request);
    {
        std::lock_guard<std::mutex> lock(state->tsfnMutex);
        const auto tsfn = state->tsfn;
        if (!state->closing.load(std::memory_order_acquire) && tsfn != nullptr &&
            napi_acquire_threadsafe_function(tsfn) == napi_ok) {
            queuedStatus = napi_call_threadsafe_function(tsfn, queued.get(), napi_tsfn_nonblocking);
            if (queuedStatus == napi_ok) {
                queued.release();
            }
            napi_release_threadsafe_function(tsfn, napi_tsfn_release);
        }
    }
    if (queuedStatus != napi_ok) {
        request->Finish(Result::FAILED);
        request->CloseDuplicate();
        return 1;
    }
    return request->Wait();
}

extern "C" int ProtectSocket(int originalFd)
{
    stats.requests.fetch_add(1, std::memory_order_relaxed);
    std::shared_ptr<Request> request;
    int result = 1;
    try {
        result = ProtectImpl(originalFd, request);
    } catch (...) {
        // Never unwind a C++ exception into the Go runtime.
        if (request) {
            request->Cancel();
        }
    }
    if (!request) {
        stats.failed.fetch_add(1, std::memory_order_relaxed);
    }
    return result;
}

napi_value InstallImpl(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value callback = nullptr;
    napi_valuetype type = napi_undefined;
    if (napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
        napi_throw_type_error(env, nullptr, "Socket protector must be a function returning Promise<void>");
        return nullptr;
    }
    std::unique_lock<std::mutex> installLock(installationMutex);
    if (installed) {
        napi_throw_error(env, nullptr, "A socket protector is already installed in this process");
        return nullptr;
    }
    auto state = std::make_shared<State>(env);
    // Allocate teardown storage before callbacks can arrive, avoiding allocation
    // in cleanup for the bounded set of still-active requests.
    Retired();
    auto finalizeOwner = std::make_unique<StateOwner>(state);
    auto cleanupOwner = std::make_unique<StateOwner>(state);
    napi_value resourceName = nullptr;
    if (napi_create_string_utf8(env, "XraySocketProtection", NAPI_AUTO_LENGTH, &resourceName) != napi_ok ||
        napi_create_threadsafe_function(env, callback, nullptr, resourceName, MAX_OUTSTANDING, 1,
            finalizeOwner.get(), TsfnFinalized, state.get(), CallJs, &state->tsfn) != napi_ok) {
        napi_throw_error(env, nullptr, "Unable to create socket protection dispatch queue");
        return nullptr;
    }
    finalizeOwner.release();
    const auto abortInstall = [&state, &installLock]() {
        state->closing.store(true, std::memory_order_release);
        const auto tsfn = state->tsfn;
        state->tsfn = nullptr;
        // A runtime may finalize synchronously when the last owner is released.
        // The finalizer must be able to acquire installationMutex independently.
        installLock.unlock();
        napi_release_threadsafe_function(tsfn, napi_tsfn_abort);
    };
    if (xrayHandle == nullptr) {
        xrayHandle = dlopen("libxray.so", RTLD_NOW | RTLD_LOCAL);
    }
    if (xrayHandle != nullptr && setProtectCallback == nullptr) {
        setProtectCallback = reinterpret_cast<SetProtectCallback>(dlsym(xrayHandle, "CGoSetSocketProtectCallback"));
    }
    if (setProtectCallback == nullptr) {
        abortInstall();
        napi_throw_error(env, nullptr, "libxray.so does not provide the socket protection callback ABI");
        return nullptr;
    }
    if (napi_unref_threadsafe_function(env, state->tsfn) != napi_ok ||
        napi_add_env_cleanup_hook(env, Cleanup, cleanupOwner.get()) != napi_ok) {
        abortInstall();
        napi_throw_error(env, nullptr, "Unable to register socket protection environment cleanup");
        return nullptr;
    }
    cleanupOwner.release();
    installed = state;
    setProtectCallback(reinterpret_cast<void *>(&ProtectSocket));
    napi_value undefined = nullptr;
    napi_get_undefined(env, &undefined);
    return undefined;
}

napi_value Install(napi_env env, napi_callback_info info)
{
    try {
        return InstallImpl(env, info);
    } catch (...) {
        napi_throw_error(env, nullptr, "Unable to allocate socket protection state");
        return nullptr;
    }
}

napi_value ProtectionStats(napi_env env, napi_callback_info)
{
    const auto text = std::string("{\"requests\":") + std::to_string(stats.requests.load()) +
        ",\"succeeded\":" + std::to_string(stats.succeeded.load()) +
        ",\"failed\":" + std::to_string(stats.failed.load()) +
        ",\"timedOut\":" + std::to_string(stats.timedOut.load()) +
        ",\"active\":" + std::to_string(stats.active.load()) + "}";
    napi_value result = nullptr;
    if (napi_create_string_utf8(env, text.c_str(), text.size(), &result) != napi_ok) {
        napi_throw_error(env, nullptr, "Unable to read socket protection counters");
    }
    return result;
}

} // namespace

void RegisterSocketProtectionApis(napi_env env, napi_value exports)
{
    napi_property_descriptor properties[] = {
        {"installSocketProtector", nullptr, Install, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"socketProtectionStats", nullptr, ProtectionStats, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
}
