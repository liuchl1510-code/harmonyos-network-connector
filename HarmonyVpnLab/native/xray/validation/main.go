// This executable validates synthetic importer fixtures only. It never creates
// or starts an Xray instance and does not contact a node or an HTTPS endpoint.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/xtls/xray-core/core"
	_ "github.com/xtls/xray-core/main/distro/all"
)

type fixture struct {
	Name       string `json:"name"`
	ConfigJSON string `json:"configJSON"`
}

type result struct {
	Name    string `json:"name"`
	Passed  bool   `json:"passed"`
	Failure string `json:"failure,omitempty"`
}

type report struct {
	SchemaVersion   int      `json:"schemaVersion"`
	CheckedAtUTC    string   `json:"checkedAtUtc"`
	CoreVersion     string   `json:"coreVersion"`
	ExpectedVersion string   `json:"expectedCoreVersion"`
	VersionMatches  bool     `json:"coreVersionMatches"`
	FixtureSHA256   string   `json:"fixtureSha256"`
	ValidationScope string   `json:"validationScope"`
	CoreStarted     bool     `json:"coreInstanceStarted"`
	BlockedAttempts int64    `json:"blockedHttpOrDnsAttempts"`
	SampleCount     int      `json:"sampleCount"`
	PassedCount     int      `json:"passedCount"`
	Results         []result `json:"results"`
}

var blockedAttempts atomic.Int64

type denyHTTP struct{}

func (denyHTTP) RoundTrip(*http.Request) (*http.Response, error) {
	blockedAttempts.Add(1)
	return nil, errors.New("NETWORK_DISABLED_FOR_STATIC_VALIDATION")
}

func validate(sample fixture) (out result) {
	out.Name = sample.Name
	defer func() {
		if recover() != nil {
			out.Passed = false
			out.Failure = "XRAY_CONFIG_BUILD_PANIC"
		}
	}()
	config, err := core.LoadConfig("json", strings.NewReader(sample.ConfigJSON))
	if err != nil || config == nil {
		out.Failure = "XRAY_CONFIG_REJECTED"
		return
	}
	if len(config.Outbound) == 0 {
		out.Failure = "NO_OUTBOUND_IN_BUILT_CONFIG"
		return
	}
	out.Passed = true
	return
}

func run() int {
	fixturePath := flag.String("fixtures", "", "Path to generated synthetic fixture JSON")
	outputPath := flag.String("output", "", "Output verification JSON path")
	expectedVersion := flag.String("expect-version", "", "Required exact core.Version() value")
	flag.Parse()
	if *fixturePath == "" || *outputPath == "" {
		fmt.Println("VALIDATION_PATHS_REQUIRED")
		return 2
	}
	if *expectedVersion == "" || core.Version() != *expectedVersion {
		fmt.Println("CORE_VERSION_MISMATCH_OR_EXPECTATION_MISSING")
		return 2
	}
	raw, err := os.ReadFile(*fixturePath)
	if err != nil || len(raw) > 4*1024*1024 {
		fmt.Println("INVALID_FIXTURE_FILE")
		return 2
	}
	var samples []fixture
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&samples) != nil || len(samples) == 0 || len(samples) > 64 {
		fmt.Println("INVALID_SYNTHETIC_FIXTURE_ARRAY")
		return 2
	}
	validName := regexp.MustCompile(`^[a-zA-Z0-9 _./:-]{1,100}$`)
	for _, sample := range samples {
		if !validName.MatchString(sample.Name) || len(sample.ConfigJSON) == 0 || len(sample.ConfigJSON) > 64*1024 {
			fmt.Println("INVALID_SYNTHETIC_FIXTURE_ENTRY")
			return 2
		}
	}

	// Defense in depth for unexpected config-loader behavior: no HTTP retrieval
	// or DNS network operation is permitted. No core.New/core.StartInstance/Start
	// exists in this program; input is an io.Reader, never a remote config URL.
	http.DefaultTransport = denyHTTP{}
	http.DefaultClient = &http.Client{Transport: denyHTTP{}}
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		blockedAttempts.Add(1)
		return nil, errors.New("NETWORK_DISABLED_FOR_STATIC_VALIDATION")
	}}
	log.SetOutput(io.Discard)
	consoleOut, consoleErr := os.Stdout, os.Stderr
	discard, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		fmt.Println("COULD_NOT_SUPPRESS_CONFIG_LOGS")
		return 2
	}
	os.Stdout, os.Stderr = discard, discard
	results := make([]result, 0, len(samples))
	passed := 0
	for _, sample := range samples {
		item := validate(sample)
		results = append(results, item)
		if item.Passed {
			passed++
		}
	}
	os.Stdout, os.Stderr = consoleOut, consoleErr
	_ = discard.Close()
	hash := sha256.Sum256(raw)
	verification := report{
		SchemaVersion: 2, CheckedAtUTC: time.Now().UTC().Format(time.RFC3339),
		CoreVersion: core.Version(), FixtureSHA256: hex.EncodeToString(hash[:]),
		ExpectedVersion: *expectedVersion, VersionMatches: core.Version() == *expectedVersion,
		ValidationScope: "synthetic JSON -> core.LoadConfig -> built protobuf config only",
		CoreStarted:     false, BlockedAttempts: blockedAttempts.Load(),
		SampleCount: len(samples), PassedCount: passed, Results: results,
	}
	encoded, err := json.MarshalIndent(verification, "", "  ")
	if err != nil || os.WriteFile(*outputPath, append(encoded, '\n'), 0600) != nil {
		fmt.Println("VERIFICATION_REPORT_WRITE_FAILED")
		return 2
	}
	for _, item := range results {
		if item.Passed {
			fmt.Printf("%s: PASS\n", item.Name)
		} else {
			fmt.Printf("%s: %s\n", item.Name, item.Failure)
		}
	}
	if passed != len(samples) || verification.BlockedAttempts != 0 {
		return 1
	}
	return 0
}

func main() { os.Exit(run()) }
