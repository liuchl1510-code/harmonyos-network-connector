# 从 C++ Primer Plus 到 forward_bridge.cpp

这份讲义面向已经学完《C++ Primer Plus》、尚未独立完成 C++ 项目的读者。目标是让你能解释每段代码为何存在、数据如何流动、资源由谁释放，并能在理解后自己重写主要结构。

源码基准：`entry/src/main/cpp/forward_bridge.cpp`，520 行；核对日期：2026-09-08；SHA256：d8833aea342bce210c25ef9ebed3201215daeaee2139283147d1098fc8d13c01。下文 L 数字均指原始源码行号。代码块从该文件自动提取，完整覆盖 1—520 行；空行和纯括号不重复解释，跨行的同一条语句合在一起解释。本轮只做源码导读，没有重新构建、连接 VPN 或进行真机验收。

## 先知道这个文件解决什么问题

用户在鸿蒙应用里点击“连接”，界面和 VPN 扩展的主要逻辑使用 ArkTS。真正处理网络数据的 Hev 和 Xray 是原生库。两边的数据类型、调用接口、执行时间和资源管理方式不同，不能直接把一个 ArkTS 字符串当作 C++ 对象传过去。

`forward_bridge.cpp` 是这两边之间的桥接与生命周期管理模块。它做五件事：校验上层参数；把部分操作安排到后台；启动和停止 Hev；加载并调用 Xray；向上层返回结果、诊断信息并处理资源清理。

实际调用关系是：

```text
ArkTS VPN 扩展 VpnProbeAbility
  ├─ 通过系统 API 创建 VPN / TUN，取得原始 fd
  └─ 调用 CoreProbe.ets
       └─ native.startHev / native.xrayCall 等
            └─ libvpnbridge.so 中的 N-API 回调
                 └─ forward_bridge.cpp
                      ├─ 调用 Hev 的 C 接口
                      └─ 加载 libxray.so，调用其 C ABI 接口
```

普通真实节点连接的数据通路则是：

```text
被 VPN 路由捕获的应用流量
       ↕ IP 数据包
      TUN
       ↕ Hev 读写 TUN
  Hev tun2socks
       ↕ 本机 SOCKS5
  Xray 的 SOCKS 入站
       ↕ 节点协议连接
    远程代理节点 ↔ 目标服务
```

第一幅图回答“谁调用谁”，第二幅图回答“网络数据经过谁”。`forward_bridge.cpp` 通常在启动、停止和查询时工作，并不是在这里用一个循环逐包实现完整转发。

本文件还有本地测试模式：`ProbeSocksServer` 是受限的 SOCKS 测试服务，只接受约定的测试目的地和带 token 的 HTTP 请求。直接测试 Hev 时，可以让 Hev 连接这个服务；另一种集成测试可以把 Xray 串在二者之间。测试 fixture 不等于真实代理节点。

## 学完教材之后，还需要补什么

《C++ Primer Plus》的不同版本覆盖程度不完全相同。下面按“项目需要理解什么”分类，不假设你完全没见过 C++11。

| 知识层 | 本文件中的例子 | 学到什么程度即可开始 |
| --- | --- | --- |
| 教材知识的复习 | 指针、引用、结构体、函数指针、字符串、异常、模板、位运算 | 能解释变量类型、对象在哪里、什么时候析构 |
| 现代 C++ 的组合使用 | lambda、`std::function`、`unique_ptr`、`std::move`、RAII | 能追踪捕获值和所有权；教材见过也需要工程练习 |
| 线程与同步 | `thread`、`mutex`、`lock_guard`、`atomic`、`join` | 分清互斥、通知、等待退出；读到相关行时补 acquire/release |
| 操作系统接口 | fd、`close`、`fcntl`、非阻塞 I/O、`errno` | 知道整数 fd 是资源句柄，关闭顺序影响正在工作的线程 |
| 网络基础 | IPv4、IP 包、端口、TCP/UDP、回环地址、SOCKS5、TUN | 能复述上面的数据通路，无须先手写完整 TCP/IP 栈 |
| 跨语言调用 | ArkTS、N-API、`napi_value`、Promise、异步回调 | 分清脚本值、C++ 值，知道后台线程不能随意操作脚本对象 |
| 编译、链接与 ABI | 头文件、`.so`、CMake、C 接口、`dlopen/dlsym` | 分清“编译器认识声明”和“运行时能调用实现” |
| 数据与配置 | JSON、转义、YAML、Base64、CA 证书路径 | 能区分配置、编码与加密；Base64 不是加密 |

本项目 CMake 要求 **C++17**，目标是鸿蒙 arm64 的共享库，不是单独用普通 Windows C++ 编译器编译一个 `main.cpp`。这里大多数语法来自 C++11，C++17 的一个实际使用点是非 const `std::string::data()` 返回可写 `char*`。

第一次阅读建议顺序是：先看整体 → 读 L1—63 的类型与状态 → 读 L65—228 的桥接工具 → 读 Hev 启停 → 读 Xray 和资源释放 → 回到末尾看接口注册。下面保持源码从上到下的顺序。

## 1. 头文件：先分清标准库、系统接口和项目接口（L1—31）

<!-- source-lines:1-31 -->
```cpp
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


```

`#include` 在预处理阶段引入头文件内容，通常让编译器看到声明、类型和模板定义；它不是“运行这个库”。双引号常用于项目头文件，尖括号常用于标准库和平台头文件；具体搜索顺序由编译器及构建配置决定。

| 行 | 头文件 | 此处要认识的内容 |
| --- | --- | --- |
| 1 | `forward_bridge.h` | 声明末尾的注册函数，并通过 `napi/native_api.h` 引入 N-API 类型 |
| 2 | `probe_socks.h` | 声明本地测试服务 `ProbeSocksServer` |
| 3 | `poll_edge_probe.h` | 声明 `RunPollEdgeControls`，用于本地 socket 事件诊断 |
| 4 | Hev 的 `hev-main.h` | 声明 Hev 的运行与退出接口；真实实现来自 Hev 库 |
| 5 | Hev 的统计头文件 | 声明 I/O 统计接口与统计项数量 |
| 7 | `algorithm` | L257 的 `std::all_of` |
| 8 | `atomic` | 跨线程共享的原子变量 |
| 9 | `cerrno` | 系统调用失败后的 `errno` |
| 10 | `chrono` | 单调时钟、毫秒、秒和截止时间 |
| 11 | `climits` | `INT_MAX` |
| 12 | `cmath` | `isfinite`、`floor`，校验脚本数字 |
| 13 | `cstdint` | `uint64_t`、`uint16_t` 等定宽整数 |
| 14 | `cstring` | C 字符串与内存操作工具；这个文件没有直接使用其中的函数 |
| 15 | `cstdlib` | C 通用工具；本文件的 `setenv` 是 POSIX 扩展，不能因此视为 ISO C++ 标准函数 |
| 16 | `dlfcn.h` | `dlopen/dlsym`，运行时加载共享库和查询函数地址 |
| 17 | `fcntl.h` | fd 复制、标志设置和打开文件的标志 |
| 18 | `functional` | `std::function` 保存一个“稍后执行的动作” |
| 19 | `memory` | `std::unique_ptr` 管理对象及自定义释放方式 |
| 20 | `mutex` | 互斥锁和 RAII 锁包装 |
| 21 | `netinet/in.h` | IPv4 socket 地址结构、网络相关常量与字节序接口 |
| 22 | `pthread.h` | POSIX 线程接口；此处设置线程名称 |
| 23 | `stdexcept` | `std::runtime_error` |
| 24 | `string` | `std::string` 和 `to_string` |
| 25 | `sys/socket.h` | `socket/bind/getsockname` |
| 26 | `sys/stat.h` | `fstat`、文件类型和大小 |
| 27 | `thread` | `std::thread` 和 `sleep_for` |
| 28 | `unistd.h` | `close` 等 POSIX 接口 |
| 29 | `vector` | 动态字符缓冲区 |

标准库之外的名字不需要靠猜。遇到新函数，应先确认它由哪个头文件声明、参数与返回值是什么，再读错误处理。

## 2. 内部作用域、常量和 Xray 函数指针表（L32—43）

<!-- source-lines:32-43 -->
```cpp
namespace {
constexpr size_t kMaximumXrayRequest = 8 * 1024 * 1024;
using Clock = std::chrono::steady_clock;

struct XrayApi {
    void *module = nullptr;
    char *(*start)(char *) = nullptr;
    char *(*stop)() = nullptr;
    char *(*version)() = nullptr;
    char *(*runtimeInfo)() = nullptr;
    void (*freeResult)(char *) = nullptr;
};
```

- **L32**：匿名命名空间。这里的名字用于当前翻译单元内部，避免和其他 `.cpp` 的同名实现相互冲突。它不是创建线程，也不是启动时执行一个任务。
- **L33**：`constexpr` 声明编译期可确定的常量；`size_t` 是用于大小的无符号整数类型。上限为 8,388,608 字节，即 8 MiB。它限制传给 Xray 桥接接口的请求字符串长度，不表示预分配了 8 MiB，也不直接等于原始配置 JSON 的最大长度。
- **L34**：类型别名。以后 `Clock::now()` 就是 `std::chrono::steady_clock::now()`。单调时钟适合计算“等了多久”，不会因用户调整墙上时钟而跳变。
- **L36**：定义 `XrayApi` 类型；此处没有自动启动 Xray。`struct` 的成员默认 public。
- **L37**：`module` 是动态库句柄，初始空。`void*` 可以承载这个平台 API 返回的不透明地址，但不能直接写 `*module` 来访问一个未知类型的对象。
- **L38**：`start` 是成员名；`(*start)` 表示它是函数指针；右侧 `(char*)` 表示被调用函数接收一个 `char*`；最左 `char*` 表示返回一个 `char*`。初始空，加载成功后才能调用。
- **L39—41**：三个无参数、返回 `char*` 的函数指针，分别用于停止、版本、运行时信息。此处是 C++，空括号表示无参数。
- **L42**：保存释放回复字符串的函数地址；接收 `char*`，返回 `void`。
- **L43**：结束结构体定义；定义类型后需要分号。

把 L38 暂时改写成以下等价的类型解释，会更容易读：

```cpp
using StartFunction = char* (*)(char*);
StartFunction start = nullptr;
// 假定已经成功赋值，才可以：char* reply = start(request);
```

`char *start(char *)` 是函数声明；`char *(*start)(char *)` 是函数指针变量。括号改变了声明结构。这个表的作用是记住“库在哪里”和“需要调用的几个函数在哪里”。

## 3. 运行状态以及谁拥有它（L44—63）

<!-- source-lines:44-63 -->
```cpp

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
```

- **L45**：定义所有原生运行状态的集合 `NativeState`。
- **L46**：`control` 是互斥锁，后台控制操作执行时会取得它。锁本身不会自动保护整个结构体，只有遵守加锁约定的代码受其协调。
- **L47**：内嵌一个测试服务对象，生命周期随 `NativeState`。
- **L48**：线程对象，初始不关联任何线程。它管理稍后运行 Hev 的线程，不是线程函数本身。
- **L49**：原子完成标志，初始 `true` 表示当前没有尚未结束的 Hev 工作。原子变量让多个线程读写这个标志不发生普通变量的数据竞争。
- **L50**：原子退出码，初始 0。开始时的 0 是初值，不能据此宣称 Hev 初始化已成功。
- **L51**：本模块拥有的 TUN fd，`-1` 表示没有有效 fd。fd 是操作系统资源表中的整数句柄；`0` 仍可能是合法 fd，所以判断有效性使用 `>= 0`。
- **L52**：记录曾观察到的 Hev 失败。它不是原子变量，因为相应控制路径通过 `control` 串行访问。
- **L53**：保存事件诊断结果的 JSON 文本，初值为空对象字符串。
- **L54—55**：内嵌前面定义的 Xray API 表，结束结构体。
- **L57**：`NativeState &State()` 是函数声明形式，表示“无参数，返回一个 NativeState 的引用”。不是声明一个名叫 State 的引用变量。
- **L59—60**：注释解释特殊的生命周期设计：即使停止超时，仍不能析构一个还可 join 的线程对象，也不能卸载该线程可能继续执行的代码。
- **L61**：第一次调用时在堆上创建对象，把地址保存到函数局部静态指针。后续调用复用同一指针。C++11 起，局部静态变量的初始化具有线程安全保证；这并不让对象后续的每个成员操作自动线程安全。
- **L62**：解引用指针，再以引用形式返回原对象，没有复制 `NativeState`。

这里有三个需要分开的实体：静态指针变量 `state`、堆上的 `NativeState` 对象、返回给调用者的引用。返回引用不会转移所有权，也不会在调用结束时销毁对象。

为什么不写 `static NativeState state; return state;`？那样进程/库的正常静态对象清理可能触发析构。若其中 `std::thread` 仍是 joinable，其析构会调用 `std::terminate`。当前写法有意不 delete 这个堆对象，使它保持到进程结束，由操作系统回收剩余资源。这是为了特殊退出边界所作的取舍，不是日常对象管理应普遍采用的写法。

## 4. 把 Hev 的统计数组变成 JSON（L64—79）

<!-- source-lines:64-79 -->
```cpp

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
```

- **L65**：返回 C++ 字符串的普通函数，还没有直接返回 ArkTS 对象。
- **L67—70**：静态数组，每个元素是指向常量字符的指针，对应一个统计项名字。顺序必须与统计头文件中的枚举一致。`epoll` 是等待 I/O 就绪事件的系统机制；此处只读取它的计数，没有实现事件循环。
- **L71**：创建 17 个 `uint64_t` 的数组并零初始化；数量取自 `HEV_IO_STATS_COUNT`，没有把 17 再写死。
- **L72**：把数组首地址和容量传给 Hev 的统计函数，由该函数填写内容。这是输出参数的典型用法。
- **L73**：开始拼接 JSON 对象文本。
- **L74**：遍历每个统计槽位。
- **L75**：只有第二项起加逗号，避免开头多一个逗号。
- **L76**：生成形如 `"readCalls":123` 的片段；源码中的 `\"` 代表最终字符串里的双引号。`to_string` 把整数变成十进制文本。
- **L78**：补上右花括号并返回。

统计头文件明确说：每个槽位原子读取，但整个数组不是事务快照；统计是进程累计值，不会在每次连接时清零。因此这适合诊断和区间差值，不应解释为全部字段来自同一瞬间。

## 5. 正确转义 JSON 字符串（L80—103）

<!-- source-lines:80-103 -->
```cpp

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
```

- **L81**：用 const 引用接收输入，避免复制，也不修改调用者字符串。
- **L83**：结果以一个双引号开头。JSON 中字符串值必须有引号。
- **L84**：范围 for 逐字节访问输入，使用 `unsigned char`，避免高位字节在有符号 char 平台被当成负数。
- **L85**：按字符类别处理。
- **L86**：输入双引号，输出反斜杠加双引号。
- **L87**：输入反斜杠，输出两个反斜杠。
- **L88—90**：实际换行、回车和制表符分别输出可放进 JSON 的转义文本。源码字符串 `"\\n"` 含两个字符，不能与实际换行字符 `'\n'` 混为一谈。
- **L91—92**：其余字节中，0x20 以下是控制字符，JSON 不能原样放进去。
- **L93—96**：用十六进制表生成 `\u00XX`。右移 4 位取高半字节，与 15 按位与取低半字节；例如字节 1 输出 `\u0001`。
- **L97—98**：其他字节原样加入结果；这里没有验证完整 UTF-8，也没有把每个中文字符拆成 Unicode 转义。
- **L102**：在末尾追加双引号。

为什么不直接 `"\"" + message + "\""`？因为错误信息自身可能包含引号和换行，那会破坏 JSON。这个函数负责字符串转义，不是完整 JSON 解析器。

## 6. 把 C++ 字符串转换成脚本值（L104—120）

<!-- source-lines:104-120 -->
```cpp

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
```

先认识三个名字：`napi_env` 是当前脚本运行环境的句柄；`napi_value` 是脚本值的句柄；`napi_ok` 表示 API 调用成功。`napi_value` 不等于 `std::string`，不能把两者直接赋值转换。

- **L105**：`Text` 把 C++ 文本包装为脚本字符串值。
- **L107**：先把输出句柄设为空。
- **L108**：传入环境、字节地址、明确的字节数及输出参数地址。`&value` 让 N-API 把新值的句柄写回本地变量，不是把业务字符串的地址返回给 ArkTS。
- **L109**：创建失败时向脚本环境报告错误；第二个参数为空表示未指定单独的错误码文本。这和 C++ 的 `throw` 不同，不能假设它会立即按 C++ 异常方式展开栈。
- **L111**：返回创建好的句柄，失败路径可能返回空。
- **L114**：`ErrorValue` 要创建脚本 Error 对象。
- **L116—117**：准备错误对象输出句柄，先把 message 转为脚本字符串。
- **L118**：短路判断：text 为空时不调用后面的创建 API；否则创建 Error，失败也返回空。
- **L119**：返回 Error 对象句柄。

`&` 在参数 `const std::string &text` 中表示引用，在表达式 `&value` 中表示取地址。先判断它出现在声明还是表达式中，不能看到 `&` 就统一理解成一种含义。

## 7. 构造失败的 Promise（L121—133）

<!-- source-lines:121-133 -->
```cpp

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
```

Promise 可以先返回一个代表“未来结果”的对象；之后成功完成或失败完成它。`promise` 是交给 ArkTS 的对象，`deferred` 是原生端用来完成这个 Promise 的句柄，二者不能混用。

- **L122**：`Reject` 用于参数错误等无需安排后台任务的情况。
- **L124—125**：初始化两个不同用途的句柄。
- **L126**：同时取得 Promise 和对应 deferred。
- **L127—128**：若连 Promise 都无法创建，则报告脚本错误并返回空。
- **L130**：创建脚本 Error。
- **L131**：若创建成功，用该 Error 拒绝 Promise。
- **L132**：返回处于失败状态的 Promise，供上层 `await` / catch 处理。

这是“返回失败的异步结果”，不是在这里创建了一个线程。底层分配 API 失败仍有其异常边界，不能把这个辅助函数解释成在任何内存故障下都保证成功 settle 的完整框架。

## 8. 保存跨回调的数据，并执行后台工作（L134—154）

<!-- source-lines:134-154 -->
```cpp

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
```

- **L135**：定义一次异步调用需要携带的上下文。
- **L136**：N-API 异步工作句柄；之后要通过相应 API 删除。
- **L137**：当前调用要完成的 Promise 的 deferred。
- **L138**：`std::function<std::string()>` 能保存一个无参数、返回字符串的可调用对象，包括匹配签名的 lambda。这里保存“怎么做”，不是保存已经做完的结果。
- **L139—140**：分别保存正常结果和异常说明；字符串默认构造为空。
- **L143**：后台执行回调。签名要求有 `napi_env` 参数，但函数不用它，所以未写参数名。`void* data` 是排队时传入的上下文指针。
- **L145**：把无类型指针恢复为 `AsyncCall*`。它必须真的指向对应类型；转换不会验证实际对象类型，也不创建对象。
- **L146—148**：进入 try，取得全局控制锁，调用之前保存的动作，把结果写入上下文。
- **L147**：`lock_guard` 构造时加锁，离开作用域时自动解锁。发生异常也能解锁，这就是 RAII 在锁上的使用。
- **L149—150**：捕获标准异常，通过 `what()` 保存说明。
- **L151—152**：捕获其他 C++ 异常，用统一文本记录，避免业务动作的 C++ 异常直接逃出这个 C 回调。

`Execute` 运行在 N-API 调度的工作线程上；它只处理本地数据。普通 N-API 脚本值操作不应放到这个工作回调里。注意这里只保护了 try 中的业务执行路径，不能把它夸大成进程级万能崩溃防护。

`control` 保证控制操作不会同时进入受保护部分，但不保证多个已排队任务按提交顺序取得锁。如果启动、停止存在依赖，上层仍要正确 `await` 和管理状态。

## 9. 回到脚本线程交付结果并释放上下文（L155—168）

<!-- source-lines:155-168 -->
```cpp

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
```

- **L156**：完成回调，运行时把执行状态及同一个 data 指针传回来。它在对应脚本事件循环线程中执行，不是刚才的工作线程；VPN 扩展的脚本线程也不应一概叫作界面 UI 线程。
- **L158**：用 `unique_ptr<AsyncCall>` 接管上下文。函数退出时自动 delete，连同内部字符串和函数对象一起释放。
- **L159**：工作未成功完成且业务层尚未记录错误时，补一个取消说明。
- **L160—162**：业务没有错误时，把结果转为脚本字符串，然后 resolve Promise。
- **L163—165**：业务有错误时创建 Error，然后 reject Promise。
- **L167**：删除 N-API 异步工作资源。它与 L158 管理的 C++ 对象是不同资源，两种释放都需要。
- **L168**：离开作用域，`unique_ptr` 析构，释放 `AsyncCall`。

理解 RAII 时要问“管理的是哪一个资源”。`unique_ptr<AsyncCall>` 不会自动知道 `napi_async_work` 应该用哪个 API 删除；它也不会自动 close 任意整数 fd。

## 10. 把动作加入异步队列：所有权转交的核心（L169—193）

<!-- source-lines:169-193 -->
```cpp

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
```

- **L170**：接收环境、任务名称和动作。`std::function` 按值传入，Queue 可以取得并保存它。
- **L172**：在堆上创建上下文，立即交给 `unique_ptr` 管理。不能只放一个栈对象再把地址交给异步回调，因为 Queue 返回后栈对象会失效。
- **L173**：把动作移动到上下文。`std::move` 本身是转换为可移动形式，实际移动由目标类型的赋值操作完成；它不是启动执行，也不是手动复制字节。
- **L174—175**：创建要返回的 Promise，把 deferred 存入上下文。
- **L176—177**：创建失败则报告错误并返回；局部 unique_ptr 自动释放上下文。
- **L179**：创建工作名称的脚本字符串。
- **L180**：创建异步工作，登记 `Execute`、`Complete`、上下文地址和工作句柄输出地址。`call.get()` 只取出地址，不放弃所有权。创建工作尚不等于入队执行。
- **L181—183**：创建失败，拒绝已创建的 Promise，再返回；上下文依旧由局部 unique_ptr 释放。
- **L185**：真正把工作交给运行时调度。
- **L186—189**：入队失败则拒绝 Promise，删除已创建的工作，再返回；上下文自动释放。
- **L191**：入队成功后调用 `release()`，当前 unique_ptr 不再管理对象，也不会删除它。地址早已通过 L180 交给运行时。
- **L192**：把 Promise 交回 ArkTS。之后 L158 的 Complete 负责接管并最终 delete 上下文。

下面表示所有权交接，不是严格的线程调度顺序；Execute 可能在 Queue 返回前就已经开始执行。

所有权时间线：

```text
Queue: new AsyncCall → 局部 unique_ptr 拥有
  ├─ 排队前失败 → 局部 unique_ptr 析构 → 删除对象
  └─ 成功排队 → release 放弃本地所有权
                    ↓ 回调协议继续保留这个地址
             Execute 借用对象，写 result/error
                    ↓
             Complete 重新用 unique_ptr 接管
                    ↓
             回调结束 → 删除对象
```

`get()` 是“借地址”；`release()` 是“放弃所有权而不删除”；`reset()` 通常会释放原来管理的对象。混淆三者，会导致重复释放、悬空指针或泄漏。

## 11. 严格检查参数个数（L194—200）

<!-- source-lines:194-200 -->
```cpp

bool Arguments(napi_env env, napi_callback_info info, size_t expected, napi_value *values)
{
    // Capacity is one greater than expected so extra arguments are rejected.
    size_t count = expected + 1;
    return napi_get_cb_info(env, info, &count, values, nullptr, nullptr) == napi_ok && count == expected;
}
```

- **L195**：values 指向调用者提供的参数数组；expected 是预期个数。
- **L197—198**：提供比预期多一个的容量，专门用于发现多传参数。
- **L199**：取调用参数；API 成功且得到的个数恰好符合 expected 才返回 true。`&&` 从左到右短路求值。

例如要求 1 个参数却只给容量 1，不能可靠地用“复制进来的数量是 1”排除第 2 个参数。这里容量设为 2。调用者必须真的准备至少 `expected + 1` 个数组元素，否则容量声明会与实际内存不符。

## 12. 安全读取脚本字符串（L201—218）

<!-- source-lines:201-218 -->
```cpp

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

```

- **L202**：maximum 限制 UTF-8 字节数，text 是输出引用。
- **L204—205**：准备类型和长度输出变量。
- **L206—208**：要求脚本值确实是字符串；先用空缓冲区查询字节长度；超过限制即拒绝。短路行为避免在前一步失败时使用无效结果。
- **L210**：申请 `length + 1` 个字符，为 C 风格字符串末尾的 `\0` 留空间。
- **L211—213**：真正复制 UTF-8 数据，同时核对复制的有效字节数与查询长度一致。
- **L215**：用显式长度写入 std::string，而不是依赖第一个 `\0` 判断结束。
- **L216**：拒绝内容中的内嵌 NUL。`npos` 表示未找到。末尾正常终止符不在 `text` 的逻辑长度内，所以不被此检查拒绝。

为什么要拒绝内嵌 NUL？脚本字符串或 std::string 可以包含它，但后面某些 C API 会在首个 NUL 停止读取，导致“校验的是整串，底层看见的是前半串”。

## 13. 安全读取整数（L219—228）

<!-- source-lines:219-228 -->
```cpp
bool IntegerArgument(napi_env env, napi_value value, int minimum, int maximum, int &result)
{
    napi_valuetype type;
    double number;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
        napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) ||
        std::floor(number) != number || number < minimum || number > maximum) { return false; }
    return napi_get_value_int32(env, value, &result) == napi_ok;
}

```

- **L219**：接收允许的范围，用 int 引用输出结果。
- **L221—222**：准备脚本类型和 double 值。
- **L223**：只接受脚本 number，不把字符串 `"123"` 偷偷转为数值。
- **L224**：读取为 double，要求不是 NaN、正无穷或负无穷。
- **L225**：用 floor 判断没有小数部分，再检查上下界。
- **L226**：经过检查后才取 int32 值；本工程目标平台的 int 用于接收它。

fd 不能是 3.5，端口不能是 -1 或 70000。这里的先验证、后转换用于避免底层数值转换发生截断后误接收非法输入；非负整数 fd 是否真的可用，还要由后面的系统调用检验。

## 14. 停止 Hev：请求退出、等待结束、回收资源（L229—251）

<!-- source-lines:229-251 -->
```cpp
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

```

- **L229**：接收共享状态的引用和等待期限，返回 Hev 退出码。这里的 limit 是时间长度，不是一个时刻。
- **L231**：如果线程对象不关联待回收的线程，就直接返回保存的退出码。`joinable()` 不是“线程现在一定仍在运行”；线程函数已经返回但还没 join 时，joinable 仍可为 true。
- **L232**：计算单调时钟上的截止时刻。`auto` 让编译器推导时间点类型，不代表运行时动态类型。
- **L233**：只要还没有观察到完成标志，就继续等待；acquire 与工作线程的 release 写入形成配套的跨线程发布机制。
- **L234—235**：超时则抛异常。它表示未能确认停止完成，不表示已经强制终止线程，也不表示 fd 已关闭。
- **L237—239**：反复调用 Hev 的 quit。源码注释说明，太早请求退出时 Hev 可能还没建立唤醒管道，退出请求会被忽略，所以要重试。
- **L240**：等待 100 毫秒再检查。它减少此停止等待循环的忙转，不是 Hev 正常转发事件循环的性能修复。
- **L242**：观察到完成后 join，等待线程真正结束并收回线程管理资源。工作线程发布 done 之后仍可能有很短的函数收尾，所以依然需要 join。
- **L243—245**：先确认持有有效 fd，再 close，最后置为 -1，避免后续重复关闭。前导 `::` 表示从全局命名空间找系统函数。
- **L247—249**：取退出码；负数记录失败；把退出码返回调用者。

这里采用协作退出。为了不让 Hev 访问一个已关闭、甚至被系统复用成其他资源的 fd，正常顺序是“请求退出 → 完成 → join → close”。如果等待超时，就保留尚未安全回收的状态，要求更上层按失败流程处理。

5 秒是等待循环使用的期限，不是实时系统意义上对整个停止函数的严格耗时上限；线程调度、被调用函数和后续 join 仍各有边界。

## 15. 启动本地测试服务（L252—266）

<!-- source-lines:252-266 -->
```cpp
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

```

- **L252**：标准 N-API 方法回调签名；info 包含脚本调用参数等信息。
- **L254**：预留两个句柄槽位，因为要求一个参数并检查是否多传。
- **L255**：准备保存 token。
- **L256**：要求恰好一个参数，读取最多 64 字节的字符串，且不能为空。
- **L257—259**：`all_of` 要求每个字符满足 lambda：ASCII 大写字母、小写字母或数字。`[]` 表示不捕获外部变量；这个短 lambda 被算法立即调用。空串已在上一行拒绝。
- **L259**：任何校验失败，返回 rejected Promise。
- **L260**：把启动操作交给 Queue；`[token]` 按值捕获字符串，使回调稍后执行时仍有有效副本。不能捕获局部 token 的引用后让它随外层函数返回而悬空。
- **L261—262**：调用测试服务 start，端口 0 表示请系统选择可用端口；失败说明由 error 输出引用传回，再转换为 C++ 异常，让 Execute 统一记录。
- **L263**：返回端口和初始请求数的 JSON 文本。
- **L264**：结束 lambda 和 Queue 调用，将其 Promise 返回。

两个 lambda 的生命周期不同：L257 的字符判断立即执行；L260 的后台动作可能在 StartFixture 返回后才执行。判断能否捕获引用，要依据生命周期，而不是依据写起来是否简短。

## 16. 停止本地测试服务（L267—276）

<!-- source-lines:267-276 -->
```cpp
napi_value StopFixture(napi_env env, napi_callback_info info)
{
    napi_value values[1]{};
    if (!Arguments(env, info, 0, values)) { return Reject(env, "stopFixture expects no arguments"); }
    return Queue(env, "stopFixture", []() {
        State().fixture.stop();
        return "{\"requests\":" + std::to_string(State().fixture.requests()) + "}";
    });
}

```

- **L269—270**：容量为 1，用来确认实际参数为 0。
- **L271**：无捕获 lambda，未来执行时通过 State 取得对象。
- **L272**：让测试服务停止；服务自身负责其 socket 和线程管理。
- **L273**：返回累计处理的请求数，便于上层核验测试路径是否真的经过此服务。
- **L274**：Queue 返回 Promise。虽然 start/stop 的具体动作不同，其参数校验、异常传播和后台调度模式相同。

## 17. 读取 Hev 启动参数（L277—290）

<!-- source-lines:277-290 -->
```cpp
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
```

- **L279**：留 4 个参数槽位；允许 2 或 3 个参数，多一个槽位用于识别超额。
- **L280—282**：准备 fd、port、容量和默认不开启的 captureIpv6。
- **L283**：读取实际调用参数。
- **L284—286**：只允许 2 或 3 个参数；fd 必须是 0 至 INT_MAX 的整数；端口必须是 1—65535 的整数。Hev 要连接已有 SOCKS 服务，所以这里端口 0 不合法。
- **L288—289**：如提供第三个参数，要求是布尔值，不能把字符串 `"true"` 当成 true。

`captureIpv6` 在这里控制 Hev 配置中的 IPv6 项及超时。系统是否把 IPv6 捕获进 TUN，由上层 VPN 配置共同决定；最终代理还是阻断，由 Xray 路由配置决定。单独一个布尔参数不能证明完整 IPv6 代理能力。

## 18. 为 Hev 准备自己负责关闭的 TUN fd（L291—303）

<!-- source-lines:291-303 -->
```cpp
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
```

- **L291**：把三个参数按值捕获，交给异步控制动作。
- **L292**：给全局状态取一个本地引用别名，不复制对象。
- **L293**：已有 joinable 的 Hev 线程时拒绝再启动，防止覆盖仍需回收的线程对象。
- **L294**：若之前在收尾时记录了 Hev 失败，拒绝在同一扩展环境直接重试，要求重启扩展。
- **L295**：运行本地事件诊断控制，保存 JSON 结果。这不是正式转发循环，也不是联网成功检测。
- **L296**：复制传入 fd，返回一个新的 fd。第三个参数 0 是新描述符编号的下界；`F_DUPFD_CLOEXEC` 同时为新描述符设置执行新程序时关闭的标志。
- **L297**：复制失败就报告 errno。`errno` 是系统调用的错误编号；只应在相关调用失败时解释它。
- **L298**：获取这个打开对象当前的文件状态标志。
- **L299**：保留原有标志，再用按位或加入 `O_NONBLOCK`。非阻塞 I/O 在暂时没有可读数据/不能继续写时可报告 EAGAIN，而非无限等待条件出现。
- **L300—302**：先保存失败的 errno，再关闭已经复制的 fd，最后抛异常。清理操作可能改变 errno，故不能反过来再取原错误码。

这里没有复制数据包、创建第二张 TUN 网卡或复制整个网络连接。结构更像：

```text
原始 fd ─┐
         ├── 同一个底层打开对象 / TUN
复制 fd ─┘
```

两个描述符可以分别关闭，但共享底层打开状态。因此通过副本设置 `O_NONBLOCK` 也会影响原始描述符看到的状态。`CLOEXEC` 则属于描述符自身的标志。复制的目的主要是划分关闭责任，不是让所有属性完全隔离。

## 19. 构造 Hev 配置并登记状态（L304—310）

<!-- source-lines:304-310 -->
```cpp
        const std::string config = std::string("tunnel:\n  mtu: 1400\n") +
            (captureIpv6 ? "  ipv6: 'fdfe:dcba:9876::1'\n" : "") + "socks5:\n  address: 127.0.0.1\n  port: " +
            std::to_string(port) + "\n  pipeline: false\n  udp: udp\nmisc:\n  log-file: stderr\n  log-level: warn\n"
            "  connect-timeout: 5000\n  read-write-timeout: " + (captureIpv6 ? "300000\n" : "5000\n");
        state.ownedTunFd = owned;
        state.hevDone.store(false);
        state.hevExit.store(0);
```

- **L304**：创建 YAML 文本，设置 tunnel MTU 为 1400。这里的 `\n` 是实际换行，缩进也是 YAML 结构的一部分。
- **L305**：三元运算按 captureIpv6 加入 IPv6 地址行或空文本；SOCKS 服务位于 `127.0.0.1`，也就是同一设备的回环地址。
- **L306**：拼入端口，关闭 pipeline，选择 UDP 配置，设置日志输出和级别。这些键的含义来自 Hev 配置约定，不是 C++ 关键字。
- **L306—307**：相邻字符串字面量会在编译时连接，所以两行字面量之间可以没有 `+`；与 std::string 或表达式组合时再使用 `+`。连接超时设为 5000 毫秒，读写超时按模式选 300000 或 5000 毫秒。
- **L308**：把复制的 fd 登记为桥接层负责关闭的资源。
- **L309—310**：标记尚未完成，清零保存的退出码。

此时还没有发生成功转发。配置拼好了、状态写好了，并不等于底层核心已经成功初始化。

## 20. 用专用线程运行长期阻塞的 Hev 入口（L311—329）

<!-- source-lines:311-329 -->
```cpp
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

```

- **L311**：线程创建可能失败，开始异常清理保护。
- **L312**：创建 `std::thread` 并交给 state 管理。lambda 按值捕获 owned 和 config，按引用捕获 state。复制配置保证外层动作结束后仍能读配置；state 引用进程寿命对象，所以这里不会随外层函数返回而失效。
- **L313**：设置当前线程的诊断名称 `harmony-hev`，方便观察。返回值未检查；名称设置不承担线程同步或启动成功验证职责。
- **L314—316**：调用 Hev C 接口，传配置字节地址、字节数和 TUN fd。头文件明确这个入口会阻塞，直到退出请求或错误。
- **L315**：转换字符指针类型以匹配接口，不会复制配置，也不会进行编码转换。
- **L316**：把 string 的大小转换成接口要求的 unsigned int；本地生成的短配置不会接近这个类型的容量上限。
- **L317**：Hev 主入口返回后，保存退出码。
- **L318**：以 release 存储发布“已完成”。另一线程若用 acquire 读到本次发布值，就能按同步关系观察之前的写入。
- **L319**：结束 lambda，线程即将退出；线程对象随后仍需要 join。
- **L320—324**：若外层创建/交接线程失败，恢复完成标记、取消 fd 所有权记录、关闭 fd，再用裸 `throw;` 重新抛出原异常。
- **L326**：报告 workerStarted。这个结果只说明线程已成功创建，没有等待 Hev 内部初始化，更没有完成 HTTP、DNS 或远端节点验证。
- **L327**：结束后台动作，把最终 Promise 留给 N-API 完成回调交付。

两种线程承担不同工作：

```text
ArkTS 线程：调用 StartHev，接收 Promise
  ↓
N-API 池线程：Execute → 加锁 → 复制 fd、拼配置、创建 std::thread → 返回
  ↓                                      ↓
Complete 回到 ArkTS 线程              Hev 专用线程持续运行
交付 workerStarted                    等待 quit 后退出
```

外层 try 捕获的是创建线程一侧的异常，不会跨线程自动捕获线程函数内部抛出的异常。这里的 Hev C 接口按返回码报告失败，不能把它讲成“外层 catch 能罩住所有线程内错误”。

`memory_order_release/acquire` 中的词不是互斥锁的 unlock/lock。它们描述原子操作之间的可见性和排序关系。退出码本身也是原子变量；这些原子并不把整个 NativeState 变成一个一致快照。

## 21. 查询 Hev 状态（L330—339）

<!-- source-lines:330-339 -->
```cpp
napi_value ForwardingStatus(napi_env env, napi_callback_info info)
{
    napi_value values[1]{};
    if (!Arguments(env, info, 0, values)) { return Reject(env, "forwardingStatus expects no arguments"); }
    const bool running = !State().hevDone.load(std::memory_order_acquire);
    const std::string result = std::string("{\"hevRunning\":") + (running ? "true" : "false") +
        ",\"hevExit\":" + std::to_string(State().hevExit.load()) + ",\"io\":" + HevIoSnapshot() + "}";
    return Text(env, result);
}

```

- **L332—333**：要求无参数。这里非法参数调用 Reject，因此返回失败 Promise；正常路径返回字符串。这与声明中的同步 string 接口存在错误路径返回形态差异，读代码时应看清实际行为。
- **L334**：对完成标志取反，得到该程序当前记录的 running 状态。
- **L335—336**：拼接运行标志、退出码及 I/O 统计。
- **L337**：直接创建并返回脚本字符串，没有经 Queue，也没有正常结果 Promise。

它不等待控制锁，避免状态查询被慢启动/停止动作长时间拖住。但多个字段分别读取，不构成原子事务；`hevRunning` 也不是远端节点可达性检测。

## 22. 对外提供异步停止 Hev 的接口（L340—350）

<!-- source-lines:340-350 -->
```cpp
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

```

- **L342—343**：无参数校验。
- **L344**：停止可能等待，因此交给 Queue。
- **L345**：以 5 秒期限调用内部停止函数；seconds 可以转换为此处需要的 milliseconds。
- **L346—347**：只有停止函数正常返回，才生成 stopped=true、退出码、I/O 统计与本地事件控制结果。
- **L348**：结束动作。若 StopHevWorker 抛异常，则由 Execute/Complete 把 Promise 变为失败，不会执行成功结果字符串的构造。

## 23. 加载 Xray 动态库，填入函数指针表（L351—366）

<!-- source-lines:351-366 -->
```cpp
void LoadXray(XrayApi &api)
{
    if (!api.module) { api.module = ::dlopen("libxray.so", RTLD_NOW | RTLD_LOCAL); }
    if (!api.module) { throw std::runtime_error("Unable to load packaged libxray.so"); }
    if (!api.start) {
        api.start = reinterpret_cast<char *(*)(char *)>(::dlsym(api.module, "CGoRunXrayFromJSON"));
        api.stop = reinterpret_cast<char *(*)()>(::dlsym(api.module, "CGoStopXray"));
        api.version = reinterpret_cast<char *(*)()>(::dlsym(api.module, "CGoXrayVersion"));
        api.runtimeInfo = reinterpret_cast<char *(*)()>(::dlsym(api.module, "CGoRuntimeInfo"));
        api.freeResult = reinterpret_cast<void (*)(char *)>(::dlsym(api.module, "CGoFree"));
    }
    if (!api.start || !api.stop || !api.version || !api.runtimeInfo || !api.freeResult) {
        throw std::runtime_error("Packaged Xray library does not expose the expected CGo API");
    }
}

```

- **L351**：引用参数，直接填写前面保存的 XrayApi 对象。
- **L353**：已有 module 就复用；没有才加载 `libxray.so`。`RTLD_NOW` 在加载阶段处理所需符号重定位；`RTLD_LOCAL` 限制该库符号用于其他动态对象解析时的可见范围，不是网络访问限制或沙箱。
- **L354**：加载失败则报错。
- **L355**：start 尚为空时，执行一组符号查找。
- **L356**：按导出名称找启动函数地址，再转成 `char* (*)(char*)` 保存。
- **L357—359**：同理找停止、版本和运行时信息函数。
- **L360**：保存库配套的释放函数。
- **L362—364**：确认所有需要的地址都存在，否则拒绝使用不满足预期接口的库。

`dlsym` 拿到的是地址。`reinterpret_cast` 不会生成一个“翻译函数”，不会把 C++ 调用自动变成 Go 调用，也不会检查真实参数和返回值的 ABI 是否匹配。双方必须预先约定导出符号、调用方式、类型以及所有权。

这里走的是 Xray/Go 导出的 **C ABI**。Hev 头文件则用 `extern "C"` 让 C++ 调用者按 C 链接约定找它的函数。名字能找到只是第一步，还需要签名和资源契约正确。

## 24. 在加载 Xray 之前设置 CA 文件路径（L367—388）

<!-- source-lines:367-388 -->
```cpp
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

```

- **L369—370**：为单个路径参数及多传参数检查准备数组和字符串。
- **L371—373**：要求长度受限的非空字符串，并以 `/` 开头，即目标鸿蒙系统上的绝对路径；这里不是 Windows 的 `C:\...` 路径格式。
- **L375**：按值捕获路径，在后台执行。
- **L376**：Xray 已加载时拒绝再配置，确保加载初始化前准备环境。
- **L377**：只读打开文件，设置执行新程序时关闭，并拒绝最终路径项是符号链接。`O_NOFOLLOW` 不等于验证整个路径每一级都无链接，也不验证路径必然属于应用目录。
- **L378**：打开失败则报错。
- **L379—380**：准备文件信息，要求 fstat 成功、类型为普通文件、大小大于 0 且小于 2 MiB。
- **L381**：验证后关闭临时 fd。
- **L382—383**：验证失败就报错；否则设置进程环境变量 `SSL_CERT_FILE`，第三个参数 1 表示允许覆盖旧值。
- **L385**：返回 configured=true 的 JSON 文本。

CA 证书集合用于 TLS 信任验证。这里仅检查文件基本属性并设置路径，没有逐张解析证书，也没有证明信任链或网络连接一定成功。环境变量作用于当前进程，不会因这句代码修改整个操作系统的证书配置。

## 25. 调用 Xray，并按库的约定释放回复（L389—411）

<!-- source-lines:389-411 -->
```cpp
napi_value XrayCall(napi_env env, napi_callback_info info)
{
    napi_value values[3]{};
    std::string operation, request;
    if (!Arguments(env, info, 2, values) || !StringArgument(env, values[0], 7, operation) ||
        !StringArgument(env, values[1], kMaximumXrayRequest, request) ||
        (operation != "start" && operation != "stop" && operation != "version" && operation != "runtime") ||
        (operation == "start" && request.empty())) {
        return Reject(env, "xrayCall requires start/stop/version/runtime and a bounded request string");
    }
    return Queue(env, "xrayCall", [operation, request]() mutable {
        XrayApi &api = State().xray;
        LoadXray(api);
        char *raw = operation == "start" ? api.start(request.data()) :
            (operation == "stop" ? api.stop() : (operation == "runtime" ? api.runtimeInfo() : api.version()));
        if (!raw) { throw std::runtime_error("Xray returned a null response"); }
        // Even if string allocation throws, only this library's CGoFree releases
        // Go's C-allocated reply. Request/configuration is never logged here.
        std::unique_ptr<char, void (*)(char *)> owned(raw, api.freeResult);
        return std::string(owned.get());
    });
}

```

- **L391—392**：允许两个参数并留一个额外槽位；operation 保存命令名，request 保存请求文本。
- **L393—394**：严格读取两个字符串，命令最多 7 字节，请求最多 8 MiB。
- **L395—396**：只接收四个固定命令；start 要求请求非空，其余命令允许空请求。
- **L397**：非法调用返回失败 Promise。
- **L399**：按值捕获命令和请求，用 mutable 让闭包中的 request 可以按非 const 字符串使用。普通 lambda 的调用运算符默认 const；C++17 中非 const `data()` 返回 `char*`，正好匹配 C API。
- **L400—401**：引用状态中的函数表，确保动态库与符号已准备好。
- **L402—403**：用嵌套三元运算选择实际函数；只有选中的分支会被求值，不会同时执行四个函数。
- **L404**：库返回空地址则报错。
- **L405—406**：注释明确，回复必须使用这个库提供的 CGoFree；这里不记录请求/配置到日志。
- **L407**：构造带自定义删除器的 unique_ptr。模板第二个参数 `void (*)(char*)` 是删除器的类型；构造函数第二个参数 `api.freeResult` 是实际函数地址。
- **L408**：从库的 NUL 终止回复复制出独立 std::string；完成复制后局部 unique_ptr 析构并调用 CGoFree。若复制时内存分配抛异常，栈展开也会正确释放 raw。

为什么不能 `delete[] raw`？因为你没有用自己的 `new[]` 申请它，跨库分配/释放要服从 ABI 契约。`free`、`delete`、`delete[]` 和库的专用释放函数不能随意互换。

为什么按值捕获 request 还要 mutable？副本解决生命周期问题；mutable 解决闭包成员在默认 const 调用运算符下的可修改性问题。二者解决的问题不同。mutable 不代表 Xray 实际一定会修改请求。

本项目的 `xray_abi.h` 约定请求和回复均为 Base64 编码的 UTF-8 JSON。CoreProbe 负责编码请求和解码回复，本桥接函数只校验大小、转交字符串。**Base64 是编码，不是加密。** 某个 C 调用正常返回字符串，也不等于回复里的业务 success 一定为 true；上层仍要 decodeReply 并检查业务结果。

## 26. 同步查询测试服务（L412—426）

<!-- source-lines:412-426 -->
```cpp
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

```

- **L414—418**：检查无参数；错误时直接向脚本抛 TypeError，再返回空。
- **L419—420**：注释说明下面的 getter 使用原子变量或短诊断锁，避免等待慢控制操作占用的全局锁。
- **L421**：const 引用绑定测试对象，只读取信息，不复制它。
- **L422—424**：获取端口、请求数和最后错误。数值直接转十进制文本，错误字符串必须用 JsonString 转义，然后整体返回脚本字符串。

这里没有 Queue。查询并非一概都应该异步化：工作量小、读取契约清楚的查询可以直接返回，避免额外排队。但“短诊断锁”仍是锁，不能把整个查询称为严格 lock-free。

## 27. 临时探测一个可用回环端口（L427—449）

<!-- source-lines:427-449 -->
```cpp
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

```

- **L429—433**：无参数校验，错误抛 TypeError。
- **L434**：创建 IPv4、TCP 流式 socket；`SOCK_CLOEXEC` 设置执行新程序时关闭。协议参数 0 使用该地址族和类型的默认协议。
- **L435**：socket 失败，报告错误并返回。
- **L436**：地址结构零初始化，未显式赋值的 sin_port 保持 0。
- **L437**：设置地址族 IPv4。
- **L438**：设置回环地址。`htonl` 把 32 位数值转成网络字节序；网络多字节整数按大端顺序表示。
- **L439**：给 getsockname 准备结构容量；它会作为输入输出参数使用。
- **L440**：绑定到回环地址和端口 0，请系统选择当前可用的端口。不同地址结构通过通用 `sockaddr*` 传给 socket API。
- **L441**：绑定成功后查询系统实际分配的端口；bind 失败时短路，不执行 getsockname。
- **L442**：无论上述组合成功或失败，都关闭已创建的 fd。
- **L443**：若探测失败，报告错误。
- **L444—445**：准备脚本值，把网络字节序的 16 位端口转回主机字节序，再创建脚本无符号整数值。本行未显式检查创建 API 的返回状态。
- **L446—447**：返回端口号。这个时刻临时 socket 已关闭，端口已不再被此函数保留。

这个函数没有 listen、accept 或连接远端，也没有启动 SOCKS 服务。它只能提供“刚才探测时可用”的端口，真正的 Xray 绑定仍可能因竞争失败。

## 28. 一次选择两个不同的端口（L450—484）

<!-- source-lines:450-484 -->
```cpp
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

```

- **L452—456**：无参数校验。
- **L457**：两个 socket fd 都初始化为 -1，便于失败时统一清理。
- **L458**：两个端口初始化为 0。
- **L459—460**：准备成功标志，循环选择两次。
- **L461—462**：创建本轮 socket；失败则记失败并退出循环。
- **L463—466**：准备零端口的 IPv4 回环地址和输出容量，作用与前一个函数相同。
- **L467—470**：绑定或查询任一步失败，记失败并跳出循环。
- **L472**：保存本轮得到的主机字节序端口。
- **L474—476**：两次选择完成后才统一关闭 socket。选择第二个端口时第一个 socket 仍占着自己的地址/端口，避免刚释放就再次被系统分配回来。
- **L477—479**：若操作失败或出现重复，向脚本报告错误。
- **L481—482**：返回 JSON 文本，分别命名为 socksPort 和 metricsPort，供上层配置 SOCKS 服务与指标入口。

不能简单认为“调用两次 GetFreePort 就等价”。单端口函数在每次返回前会释放端口，第二次有机会取得同一个值；双端口函数把第一次的占用保留到第二次选择完成。两者都没有在返回后继续保留端口。

## 29. 脚本环境退出时的兜底清理（L485—501）

<!-- source-lines:485-501 -->
```cpp
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

```

- **L485**：环境清理钩子的签名有用户数据指针，这里不用所以不命名。
- **L487**：取得共享状态。
- **L488**：用 unique_lock 和 try_to_lock 尝试取得控制锁。与普通阻塞加锁不同，拿不到就立即返回结果；unique_lock 可以查询是否真的持锁。
- **L489**：若别的控制操作正在持锁，直接放弃本次兜底清理，避免在环境退出时无限排队。
- **L490—492**：取得锁后，尝试停止 Hev，再停止 fixture。
- **L493—495**：捕获清理中的异常，不让它逃出清理钩子；注释说明进程结束将回收剩余句柄，不 detach 活动工作线程，也不卸载 Go 运行时。
- **L497—498**：Xray stop 没有带有限取消能力的 ABI，所以清理钩子不调用它；正常生命周期应由上层显式调用 `xrayCall("stop", "")`。
- **L499**：unique_lock 析构，若持锁则自动解锁。
- **L500**：结束 L32 开始的匿名命名空间。

这是尽力清理，不是完整资源释放保证。若拿不到锁，它什么也不做；若 Hev 停止抛异常，后面的 fixture.stop 也不会执行。5 秒不约束整个 Cleanup 的所有路径。环境清理与进程结束也不是同一概念，不能把“最终由进程回收”解释成“钩子返回时已全部清干净”。

## 30. 注册接口，让 ArkTS 能找到 C++ 函数（L502—520）

<!-- source-lines:502-520 -->
```cpp
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
```

- **L502**：注册函数位于匿名命名空间之外，声明在 forward_bridge.h，由 napi_init.cpp 调用。返回 void，结果是修改 exports 并登记钩子。
- **L504**：定义属性描述符数组，每个元素描述要导出的一个接口。
- **L505—507**：分别把脚本名字 startFixture、stopFixture、fixtureStatus 绑定到对应 C++ 函数。
- **L508—510**：绑定 Hev 启动、停止、状态查询。
- **L511—512**：绑定单端口和双端口探测。
- **L513—514**：绑定 CA 路径配置与 Xray 命令入口。
- **L515**：结束数组初始化。
- **L516**：按数组元素数注册属性。`sizeof(properties)` 是整个数组字节数，除以单个元素大小得到元素个数；如果变量已经退化成指针，这个公式就不能用来计算数组长度。
- **L517**：注册环境清理钩子，附带数据为空。这里用 `||`，前一步注册失败时不会继续登记钩子。
- **L518**：任何登记失败，向脚本环境报告错误。
- **L520**：结束函数，也结束本文件。

以第一行描述符为例，8 个字段依次是：UTF-8 名字、另一种名字句柄、方法回调、getter、setter、固定值、属性标志、用户数据。本项目设置名字和方法回调，其余不需要的字段填 nullptr，属性标志使用 napi_default。它不是在此刻调用 StartFixture。

真正入口链还要结合其他文件：`napi_init.cpp` 的构造函数注册模块 → 模块初始化回调 Init → RegisterForwardingApis → exports 上有这些方法。ArkTS 的 `Index.d.ts` 提供编译期类型说明，它本身不会把字符串名字连接到 C++ 实现。

## 把整份代码串起来：以一次 startHev 为例

下面的 fd=42、port=1080 是教学示意值，不是本轮实测值，也不能拿任意整数当真实 TUN fd。步骤按调用逻辑列举；入队后的后台执行可以与 Queue 返回前的收尾交错，不能把编号当成跨线程的严格调度次序。

1. 系统先创建 VPN/TUN，上层取得实际有效的 fd。CoreProbe 已启动回环 SOCKS 服务。
2. ArkTS 调用 `await native.startHev(fd, port, true)`。
3. N-API 通过注册表进入 StartHev；它读取并验证参数。
4. StartHev 创建捕获参数的 lambda，交给 Queue。
5. Queue 创建 Promise、堆上的 AsyncCall 和 N-API 工作对象，成功入队后交出上下文所有权，并立即返回 Promise。
6. 工作线程进入 Execute，取得 control 锁，执行 lambda。
7. lambda 复制 fd、设置非阻塞、构造配置、登记状态并启动 Hev 专用线程，然后返回 workerStarted 文本。
8. Execute 保存文本并释放锁。Hev 专用线程独立持续运行。
9. Complete 回到所属 ArkTS 线程，把文本包装为脚本字符串并 resolve Promise，删除 N-API 工作和 AsyncCall。
10. ArkTS 的 await 得到字符串。后续仍要通过真实请求验证转发和节点业务状态。
11. 正常停止时，上层等待相关启动操作结束，停止 Hev、停止 Xray、停止 fixture，再关闭原始 TUN fd 并销毁 VPN。

这里 `AsyncCall` 活到一次异步操作完成，Hev 线程活到隧道工作结束，NativeState 活到进程结束。**不同对象对应不同生命周期**，这是读懂这份文件的核心。

## 资源责任表

| 资源 | 谁创建/取得 | 谁使用 | 正常情况下谁释放 |
| --- | --- | --- | --- |
| 原始 TUN fd | VpnProbeAbility 调系统 create | 上层传给桥接层用于复制 | VpnProbeAbility 关闭，再销毁 VPN |
| 复制 TUN fd | StartHev 的 fcntl | Hev 借用 | StopHevWorker 在 join 后 close |
| Hev 专用线程 | StartHev | 运行 Hev 主入口 | StopHevWorker join |
| AsyncCall | Queue 的 new | Execute/Complete | Complete 的 unique_ptr；排队失败则由 Queue 释放 |
| napi_async_work | N-API create_async_work | 运行时调度 | Complete 或排队失败路径 delete_async_work |
| Xray 回复指针 | Xray C ABI | XrayCall 读取并复制 | 自定义 unique_ptr 删除器调用 CGoFree |
| libxray.so 句柄 | LoadXray 的 dlopen | Xray API 表中的函数指针 | 不主动 dlclose，保留至进程结束 |
| 测端口 socket | GetFreePort(s) | 当前函数 | 当前函数 close |
| 临时 CA 文件 fd | ConfigureXrayCa 的 open | 当前函数 fstat | 当前函数 close |

## 如何逐步达到“我能够自己写”的程度

第一遍不用背全部 API。每读一段，把下面四句话补全：输入是什么；实际执行在哪个线程；新资源交给谁；失败时执行哪条释放路径。

建议分五次动手，每次先写自己的小例子，再回来看本文件：

1. 用普通 C++ 写一个函数指针表和一个返回同一对象引用的 State 函数，解释值、地址和引用的区别。
2. 用 lambda、std::function、unique_ptr 写一个不接 N-API 的简化任务上下文，演示 get/release/重新接管。先做手动串行调用，理解所有权后再加线程。
3. 用一个可协作停止的后台计数线程练习 mutex、atomic、done 和 join，观察线程函数已返回但 joinable 仍为 true 的情况。
4. 在支持 POSIX 的开发环境写回环端口探测，观察关闭再绑定时的竞争；此处练习系统接口，无需先接 VPN。
5. 回到本工程，自己画出正常启动、参数失败、线程创建失败、停止超时四条路径，再重写一个同模式的小型 N-API 方法。

这些是后续练习任务，本轮没有创建或运行这些演示程序。复述现有实现与独立完成实现是不同的证据；做完并能解释自己的练习/修改，才能逐步形成可在面试中证明的能力。

## 第一轮自测

先不看参考答案，用自己的话回答：

1. `char *(*start)(char *)` 的成员名、参数类型和返回类型分别是什么？
2. `State()` 返回引用后，调用者拿到的是副本还是原对象？为什么这里不 delete？
3. StartHev 的参数检查为什么发生在 Queue 之前？
4. `call.get()` 与 `call.release()` 各做了什么，最终谁 delete AsyncCall？
5. 为什么已经使用 N-API 后台任务，还需要另开一个 Hev 线程？
6. Hev 线程函数结束之后，joinable 能否仍然为 true？
7. 复制 TUN fd 后关闭副本，是否等同于立刻关闭原 fd？给副本设置 O_NONBLOCK 会不会共享？
8. `workerStarted:true`、Xray ABI 返回字符串、真实 HTTPS 成功，分别证明什么？
9. 为什么必须使用 CGoFree 释放 Xray 回复？为什么要先复制再释放？
10. 获取一个空闲端口后，上层是否一定能绑定成功？

<details>
<summary>参考要点：完成自己的回答后再展开</summary>

1. 名为 start，指向接收 char*、返回 char* 的函数。
2. 原对象；进程寿命设计避免超时后仍存活线程访问已销毁状态或触发 joinable 线程析构终止。
3. 在所属脚本线程读取并转换脚本值，尽早拒绝非法参数；后台只使用独立本地数据。
4. get 借出地址，release 放弃所有权而不删除；正常完成由 Complete 的 unique_ptr 删除。
5. N-API 工作处理一次控制动作；Hev 主入口持续阻塞，需要独立长期线程。
6. 可以。joinable 说明仍需 join/detach 管理，不等于线程函数仍在执行。
7. 两个描述符分别关闭，共享底层打开状态；O_NONBLOCK 会共享。
8. 分别是线程创建成功、C ABI 返回了回复数据、某次端到端 HTTPS 请求成功；不能互相替代。
9. 分配和释放必须匹配 ABI；复制让本地 std::string 在库内存释放后仍有效。
10. 不一定，探测 socket 已关闭，后续可能发生端口竞争。

</details>

## 与简历项目的关系

这部分适合学习并逐步形成的能力是：鸿蒙原生接口、跨语言异步调用、C++ 资源管理、网络组件集成和生命周期排障。核心来源要说明：Hev 提供 tun2socks，Xray 提供代理核心，本项目的 C++ 桥接负责把它们接入平台并协调启停。

完成理解和自己的验证/改进后，可以依据实际贡献写“基于 HarmonyOS VPN Extension，完成 ArkTS/C++ N-API 桥接，集成 Hev/Xray，并管理异步任务、转发线程和 TUN 描述符”。具体使用“实现”“维护”还是“复现并扩展”，取决于你实际完成了哪些工作。

只读完本文件还不足以声称独立实现 TCP/IP 协议栈、Xray 加密协议、完整通用 SOCKS5 服务器或掌握 epoll 性能优化。后续 C++ 阅读入口可以是 `probe_socks.cpp`（socket 和协议读写）、`socket_protect.cpp`（跨线程回调与 VPN 外连保护）、`poll_edge_probe.cpp` 及 Hev 补丁（事件诊断与修复证据）。

## 依据与核对入口

项目内证据：

- `entry/src/main/cpp/CMakeLists.txt:8—16`：共享库组成、C++17、N-API/Hev 链接。
- `entry/src/main/cpp/napi_init.cpp:131—150`：模块注册与初始化调用链。
- `entry/src/main/cpp/types/libvpnbridge/Index.d.ts:6—15`：脚本侧方法类型。
- `entry/src/main/ets/vpn/VpnProbeAbility.ets:194`：创建 TUN；`:340—371`：停核心、关闭原始 fd、销毁 VPN。
- `entry/src/main/ets/vpn/CoreProbe.ets:102—135`：两种本地测试；`:224—253`：持续连接启动；`:451—484`：核心正常停止。
- `native/hev/include/hev-main.h`：阻塞式入口和退出接口；`native/hev/README.md:27—29`：外部 TUN fd 借用契约。
- `native/hev/include/hev-ohos-io-stats.h`：统计项顺序、原子槽位和非事务快照说明。
- `native/xray26/xray_abi.h:8—19`：Base64 请求/回复与 CGoFree 契约。

额外语义按主来源核对：N-API 的工作线程、完成回调、参数使用和不保序约束，见 [OpenHarmony 异步任务官方文档](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/napi/use-napi-asynchronous-task.md)。

unique_ptr 的 release 行为见 [C++ 标准草案](https://eel.is/c++draft/unique.ptr.single.modifiers)；joinable 与析构规则见 [thread 成员规范](https://eel.is/c++draft/thread.thread.member)及 [thread 析构规范](https://eel.is/c++draft/thread.thread.destr)；原子可见性见 [原子顺序规范](https://eel.is/c++draft/atomics.order)。这些网页是滚动标准草案，本讲义只引用适用于本文件的既有语义。

fd 的共享打开状态见 [POSIX dup](https://pubs.opengroup.org/onlinepubs/9799919799/functions/dup.html)及 [POSIX open](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html)；运行时装载与符号查找见 [POSIX dlopen](https://pubs.opengroup.org/onlinepubs/9699919799/functions/dlopen.html)和 [POSIX dlsym](https://pubs.opengroup.org/onlinepubs/009604299/functions/dlsym.html)。

C++17 非 const string.data 的来由见 [WG21 P0272R0](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2016/p0272r0.html)。
