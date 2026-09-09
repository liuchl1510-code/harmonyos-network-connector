#include "napi/native_api.h"
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstdint>
#include <signal.h>
#include <unistd.h>

// This separate x86_64 module has no Hev, Xray, TUN, sockets or probe code.
// Keep the regular module's JS surface so imports load, then fail explicitly
// if a caller crosses a capability guard. Never fabricate successful results.
namespace {
napi_value Unsupported(napi_env env, napi_callback_info)
{
    napi_throw_error(env, "ERR_UI_PREVIEW_UNSUPPORTED",
        "UI preview only: VPN, Xray, forwarding and network probes are unavailable in this simulator build.");
    return nullptr;
}

napi_value SelfCheck(napi_env env, napi_callback_info)
{
    napi_value value = nullptr;
    if (napi_create_string_utf8(env, "UI_PREVIEW_ONLY x86_64; VPN core unavailable; no network check performed",
        NAPI_AUTO_LENGTH, &value) != napi_ok) {
        napi_throw_error(env, nullptr, "Unable to create UI preview description");
    }
    return value;
}

napi_value CurrentProcessId(napi_env env, napi_callback_info)
{
    napi_value value = nullptr;
    if (napi_create_int32(env, static_cast<int32_t>(getpid()), &value) != napi_ok) {
        napi_throw_error(env, nullptr, "Unable to return current process id");
    }
    return value;
}

napi_value ProcessAlive(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    double number = 0;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_get_value_double(env, args[0], &number) != napi_ok || !std::isfinite(number) ||
        std::floor(number) != number || number <= 0 || number > INT_MAX) {
        napi_throw_type_error(env, nullptr, "Expected a positive integer process id");
        return nullptr;
    }
    int32_t pid = 0;
    if (napi_get_value_int32(env, args[0], &pid) != napi_ok) {
        napi_throw_type_error(env, nullptr, "Unable to convert process id to int32");
        return nullptr;
    }
    // Signal 0 sends no signal. Only ESRCH proves the process is absent.
    const int result = kill(static_cast<pid_t>(pid), 0);
    const bool aliveOrUnknown = result == 0 || errno != ESRCH;
    napi_value value = nullptr;
    if (napi_get_boolean(env, aliveOrUnknown, &value) != napi_ok) {
        napi_throw_error(env, nullptr, "Unable to return process existence result");
    }
    return value;
}

napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor properties[] = {
        {"selfCheck", nullptr, SelfCheck, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"currentProcessId", nullptr, CurrentProcessId, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"processAlive", nullptr, ProcessAlive, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspectTunAddresses", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspectFd", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"startFixture", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopFixture", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"fixtureStatus", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getFreePort", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getFreePorts", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"startHev", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stopHev", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"forwardingStatus", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"xrayCall", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"configureXrayCa", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"installSocketProtector", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"socketProtectionStats", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"runRuntimeSmoke", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) {
        napi_throw_error(env, nullptr, "Unable to register UI preview bridge");
    }
    return exports;
}
}

static napi_module previewModule = {1, 0, nullptr, Init, "vpnbridge", nullptr, {0}};
extern "C" __attribute__((constructor)) void RegisterVpnBridgePreview()
{
    napi_module_register(&previewModule);
}
