#include "napi/native_api.h"
#include "forward_bridge.h"
#include "socket_protect.h"
#include "runtime_smoke_bridge.h"
#include <cerrno>
#include <cmath>
#include <climits>
#include <fcntl.h>
#include <string>
#include <sys/socket.h>
#include <signal.h>
#include <arpa/inet.h>
#include <cstring>
#include <ifaddrs.h>
#include <net/if.h>
#include <linux/if_tun.h>
#include <sys/ioctl.h>
#include <unistd.h>

static napi_value Text(napi_env env, const std::string &value)
{
    napi_value result = nullptr;
    if (napi_create_string_utf8(env, value.c_str(), value.size(), &result) != napi_ok) {
        napi_throw_error(env, nullptr, "Unable to create native result");
    }
    return result;
}

static napi_value SelfCheck(napi_env env, napi_callback_info)
{
    const int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return Text(env, "NATIVE_FAILED socket errno=" + std::to_string(errno));
    }
    const int flags = fcntl(fd, F_GETFD);
    const int savedError = errno;
    const int closeResult = close(fd);
    if (flags < 0 || closeResult != 0) {
        return Text(env, "NATIVE_FAILED fd-check errno=" + std::to_string(flags < 0 ? savedError : errno));
    }
    return Text(env, "NATIVE_OK pointerBits=" + std::to_string(sizeof(void *) * 8) + " socket=create/check/close");
}

static napi_value CurrentProcessId(napi_env env, napi_callback_info)
{
    napi_value value = nullptr;
    napi_create_int32(env, static_cast<int32_t>(getpid()), &value);
    return value;
}

static napi_value ProcessAlive(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    int32_t pid = 0;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_get_value_int32(env, args[0], &pid) != napi_ok || pid <= 0) {
        napi_throw_type_error(env, nullptr, "Expected a positive process id");
        return nullptr;
    }
    // Signal 0 performs an existence/permission check; it sends no signal.
    const int result = kill(static_cast<pid_t>(pid), 0);
    const bool aliveOrUnknown = result == 0 || errno != ESRCH;
    napi_value value = nullptr;
    napi_get_boolean(env, aliveOrUnknown, &value);
    return value;
}

static napi_value InspectTunAddresses(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    int32_t fd = -1;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_get_value_int32(env, args[0], &fd) != napi_ok || fd < 0) {
        napi_throw_type_error(env, nullptr, "Expected a TUN descriptor");
        return nullptr;
    }
    ifreq request{};
    if (ioctl(fd, TUNGETIFF, &request) != 0) {
        return Text(env, "{\"inspected\":false,\"reason\":\"tun-name-unavailable\"}");
    }
    request.ifr_name[IFNAMSIZ - 1] = '\0';
    ifaddrs *list = nullptr;
    if (getifaddrs(&list) != 0) {
        return Text(env, "{\"inspected\":false,\"reason\":\"addresses-unavailable\"}");
    }
    in_addr expected4{};
    in6_addr expected6{};
    inet_pton(AF_INET, "198.18.0.2", &expected4);
    inet_pton(AF_INET6, "fdfe:dcba:9876::1", &expected6);
    bool found4 = false, found6 = false, any6 = false;
    for (const ifaddrs *entry = list; entry != nullptr; entry = entry->ifa_next) {
        if (!entry->ifa_addr || !entry->ifa_name || std::strcmp(entry->ifa_name, request.ifr_name) != 0) continue;
        if (entry->ifa_addr->sa_family == AF_INET) {
            found4 |= std::memcmp(&reinterpret_cast<sockaddr_in *>(entry->ifa_addr)->sin_addr, &expected4, sizeof(expected4)) == 0;
        } else if (entry->ifa_addr->sa_family == AF_INET6) {
            any6 = true;
            found6 |= std::memcmp(&reinterpret_cast<sockaddr_in6 *>(entry->ifa_addr)->sin6_addr, &expected6, sizeof(expected6)) == 0;
        }
    }
    freeifaddrs(list);
    return Text(env, std::string("{\"inspected\":true,\"expectedIpv4\":") + (found4 ? "true" : "false") +
        ",\"expectedIpv6\":" + (found6 ? "true" : "false") + ",\"anyIpv6\":" + (any6 ? "true" : "false") + "}");
}

// The VPN extension owns fd. This function never reads, duplicates, or closes it.
static napi_value InspectFd(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    double value = -1;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_get_value_double(env, args[0], &value) != napi_ok || !std::isfinite(value) ||
        std::floor(value) != value || value < 0 || value > INT_MAX) {
        napi_throw_type_error(env, nullptr, "fd must be a non-negative integer");
        return nullptr;
    }
    int32_t fd = -1;
    if (napi_get_value_int32(env, args[0], &fd) != napi_ok) {
        napi_throw_type_error(env, nullptr, "Unable to convert fd to int32");
        return nullptr;
    }
    if (fcntl(fd, F_GETFD) < 0) {
        napi_throw_error(env, nullptr, ("Invalid VPN fd: errno=" + std::to_string(errno)).c_str());
        return nullptr;
    }
    return Text(env, "TUN_FD_OK fd=" + std::to_string(fd));
}

static napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor properties[] = {
        {"selfCheck", nullptr, SelfCheck, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"currentProcessId", nullptr, CurrentProcessId, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"processAlive", nullptr, ProcessAlive, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspectTunAddresses", nullptr, InspectTunAddresses, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspectFd", nullptr, InspectFd, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
    RegisterForwardingApis(env, exports);
    RegisterSocketProtectionApis(env, exports);
    RegisterRuntimeSmoke(env, exports);
    return exports;
}

static napi_module module = {1, 0, nullptr, Init, "vpnbridge", nullptr, {0}};
extern "C" __attribute__((constructor)) void RegisterVpnBridge()
{
    napi_module_register(&module);
}
