cmake_minimum_required(VERSION 3.16)
project(HarmonyHevTunnel LANGUAGES C ASM)

if(NOT CMAKE_SYSTEM_PROCESSOR STREQUAL "aarch64")
  message(FATAL_ERROR "This audited configuration targets OHOS ARM64 only")
endif()
if(NOT DEFINED HEV_SOURCE_DIR)
  message(FATAL_ERROR "HEV_SOURCE_DIR must name the staged pinned source checkout")
endif()
file(TO_CMAKE_PATH "${HEV_SOURCE_DIR}" HEV_SOURCE_DIR)

# Upstream build.mk collects all C files and preprocessed assembly (*.S).
# On Windows, GLOB also matches *.s; these are architecture includes, not units.
function(hev_source_files result root)
  file(GLOB_RECURSE candidates CONFIGURE_DEPENDS "${root}/*.c" "${root}/*.S")
  set(selected)
  foreach(path IN LISTS candidates)
    if(path MATCHES "\\.c$" OR path MATCHES "\\.S$")
      list(APPEND selected "${path}")
    endif()
  endforeach()
  set(${result} "${selected}" PARENT_SCOPE)
endfunction()

set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)
set(THIRD_PART "${HEV_SOURCE_DIR}/third-part")
hev_source_files(HEV_SOURCES "${HEV_SOURCE_DIR}/src")
hev_source_files(TASK_SOURCES "${THIRD_PART}/hev-task-system/src")
hev_source_files(YAML_SOURCES "${THIRD_PART}/yaml/src")
hev_source_files(LWIP_SOURCES "${THIRD_PART}/lwip/src")

add_library(hev_task STATIC ${TASK_SOURCES})
target_include_directories(hev_task PRIVATE
  "${THIRD_PART}/hev-task-system/src" "${THIRD_PART}/hev-task-system/include")
# Exact defaults from hev-task-system/configs.mk (pinned version 5.6.1).
target_compile_definitions(hev_task PRIVATE
  ENABLE_STACK_OVERFLOW_DETECTION ENABLE_MEMALLOC_SLICE ENABLE_IO_SPLICE_SYSCALL
  CONFIG_STACK_BACKEND=STACK_MMAP CONFIG_STACK_OVERFLOW_DETECTION=1
  CONFIG_MEMALLOC_SLICE_ALIGN=64 CONFIG_MEMALLOC_SLICE_MAX_SIZE=4096
  CONFIG_MEMALLOC_SLICE_MAX_COUNT=1000 CONFIG_SCHED_CLOCK=CLOCK_NONE)

add_library(hev_yaml STATIC ${YAML_SOURCES})
target_include_directories(hev_yaml PRIVATE "${THIRD_PART}/yaml/src")
target_compile_definitions(hev_yaml PRIVATE YAML_VERSION_MAJOR=0 YAML_VERSION_MINOR=2
  YAML_VERSION_PATCH=5 YAML_VERSION_STRING="0.2.5")

add_library(hev_lwip STATIC ${LWIP_SOURCES})
target_include_directories(hev_lwip PRIVATE
  "${THIRD_PART}/lwip/src/include" "${THIRD_PART}/lwip/src/ports/include")
target_compile_definitions(hev_lwip PRIVATE FD_SET_DEFINED SOCKLEN_T_DEFINED)

add_library(hevsocks5tun SHARED ${HEV_SOURCES} "${CMAKE_CURRENT_SOURCE_DIR}/ohos-io-stats.c")
target_include_directories(hevsocks5tun PRIVATE
  "${HEV_SOURCE_DIR}/src/misc" "${HEV_SOURCE_DIR}/src/core/include"
  "${THIRD_PART}/yaml/include" "${THIRD_PART}/lwip/src/include"
  "${THIRD_PART}/lwip/src/ports/include" "${THIRD_PART}/hev-task-system/include")
target_compile_definitions(hevsocks5tun PRIVATE
  FD_SET_DEFINED SOCKLEN_T_DEFINED COMMIT_ID="99cd2d5")

foreach(target hev_task hev_yaml hev_lwip hevsocks5tun)
  target_compile_options(${target} PRIVATE -Wall -Wextra -fvisibility=hidden)
endforeach()
# Public functions are annotated by the bridge export list; an explicit linker
# version script makes the ABI independent of accidentally visible internals.
target_compile_options(hevsocks5tun PRIVATE -fvisibility=default)
target_link_options(hevsocks5tun PRIVATE
  "-Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/exports.map"
  -Wl,--wrap=epoll_wait -Wl,--wrap=read
  -Wl,--no-undefined -Wl,-z,defs -Wl,-z,noexecstack)
# Upstream Android.mk uses archives, so duplicate list/rbtree implementations
# present in core and task-system are extracted only if needed.
target_link_libraries(hevsocks5tun PRIVATE hev_yaml hev_lwip hev_task pthread)
