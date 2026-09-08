package main

/*
#include <stdlib.h>
static inline int harmony_smoke_c_echo(int value) { return value ^ 0x55aa; }
*/
import "C"

import (
	"fmt"
	"runtime"
	"unsafe"
)

//go:noinline
func growStack(depth int, seed uint64) uint64 {
	var live [128]uint64
	for i := range live {
		live[i] = uint64(i) + seed
	}
	var total uint64
	if depth > 0 {
		total = growStack(depth-1, seed+1)
	}
	for _, value := range live {
		total += value
	}
	return total
}

func expectedStack(depth int, seed uint64) uint64 {
	var total uint64
	for i := 0; i <= depth; i++ {
		total += 128*(seed+uint64(i)) + 128*127/2
	}
	return total
}

//export HarmonyGoSmoke
func HarmonyGoSmoke() (result *C.char) {
	defer func() {
		if recover() != nil {
			result = C.CString("FAIL recovered Go panic")
		}
	}()
	if !runtime.IsOpenharmony {
		return C.CString("FAIL runtime not built for OpenHarmony")
	}
	// Keep allocations reachable across stop-the-world GC and foreign-thread
	// C->Go entries. Every byte is checked after collection.
	allocations := make([][]byte, 128)
	for i := range allocations {
		allocations[i] = make([]byte, 1024)
		for j := range allocations[i] {
			allocations[i][j] = byte(i + 3*j)
		}
	}
	answers := make(chan bool, 4)
	for worker := 0; worker < 4; worker++ {
		go func(worker int) {
			seed := uint64(worker + 11)
			stackOK := growStack(24, seed) == expectedStack(24, seed)
			// Exercise the reverse direction Go->C on goroutine worker threads.
			echoOK := int(C.harmony_smoke_c_echo(C.int(worker))) == worker^0x55aa
			answers <- stackOK && echoOK
		}(worker)
	}
	runtime.GC()
	passed := true
	for worker := 0; worker < 4; worker++ {
		passed = <-answers && passed
	}
	for i := range allocations {
		for j, value := range allocations[i] {
			if value != byte(i+3*j) {
				passed = false
			}
		}
	}
	runtime.KeepAlive(allocations)
	if !passed {
		return C.CString("FAIL allocation, stack growth, or Go-to-C consistency")
	}
	return C.CString(fmt.Sprintf("PASS go=%s goos=%s goarch=%s ohos=%t goroutines=4 stack-depth=24 gc=checked", runtime.Version(), runtime.GOOS, runtime.GOARCH, runtime.IsOpenharmony))
}

//export HarmonyGoSmokeFree
func HarmonyGoSmokeFree(value *C.char) { C.free(unsafe.Pointer(value)) }

func main() {}
