#include "runtime_smoke_bridge.h"
#include <cstdlib>
#include <memory>
#include <mutex>
#include <string>

extern "C" char *HarmonyRunRuntimeSmoke(const char *library_path);
namespace {
std::mutex smoke_mutex;
struct Work {
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
    const char *library = nullptr;
    std::string result;
};
void Execute(napi_env, void *data)
{
    auto *job = static_cast<Work *>(data);
    std::lock_guard<std::mutex> lock(smoke_mutex);
    std::unique_ptr<char, decltype(&std::free)> result(HarmonyRunRuntimeSmoke(job->library), &std::free);
    job->result = result ? result.get() : "{\"passed\":false,\"error\":\"result-allocation-failed\"}";
}
void Complete(napi_env env, napi_status status, void *data)
{
    std::unique_ptr<Work> job(static_cast<Work *>(data));
    napi_value result = nullptr;
    const std::string text = status == napi_ok ? job->result : "{\"passed\":false,\"error\":\"native-work-cancelled\"}";
    napi_create_string_utf8(env, text.c_str(), text.size(), &result);
    napi_resolve_deferred(env, job->deferred, result);
    napi_delete_async_work(env, job->work);
}
napi_value Run(napi_env env, napi_callback_info info)
{
    size_t count = 1;
    napi_value args[1] = {nullptr};
    char kind[16] = {0};
    size_t length = 0;
    if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 1 ||
        napi_get_value_string_utf8(env, args[0], kind, sizeof(kind), &length) != napi_ok || length >= sizeof(kind) - 1) {
        napi_throw_type_error(env, nullptr, "Expected a runtime smoke kind");
        return nullptr;
    }
    const std::string value(kind, length);
    const char *library = value == "good" ? "libsmoke-good.so" :
        value == "broken" ? "libsmoke-broken.so" : value == "go" ? "libgoruntime-smoke.so" : nullptr;
    if (library == nullptr) {
        napi_throw_type_error(env, nullptr, "Unsupported runtime smoke kind");
        return nullptr;
    }
    std::unique_ptr<Work> job(new Work());
    job->library = library;
    napi_value promise = nullptr;
    napi_value name = nullptr;
    if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
        napi_create_string_utf8(env, "HarmonyRuntimeSmoke", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_async_work(env, nullptr, name, Execute, Complete, job.get(), &job->work) != napi_ok) {
        napi_throw_error(env, nullptr, "Cannot prepare runtime smoke worker");
        return nullptr;
    }
    if (napi_queue_async_work(env, job->work) != napi_ok) {
        napi_delete_async_work(env, job->work);
        napi_throw_error(env, nullptr, "Cannot start runtime smoke worker");
        return nullptr;
    }
    job.release();
    return promise;
}
}
void RegisterRuntimeSmoke(napi_env env, napi_value exports)
{
    napi_property_descriptor property = {"runRuntimeSmoke", nullptr, Run, nullptr, nullptr, nullptr, napi_default, nullptr};
    napi_define_properties(env, exports, 1, &property);
}
