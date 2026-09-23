// Validate generated synthetic routing configurations against the pinned Xray
// router and packaged geodata. No core instance, listeners, or real DNS client
// are created. Default-outbound fallback mirrors the core dispatcher.
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
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/xtls/xray-core/app/router"
	"github.com/xtls/xray-core/common"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/dns"
	_ "github.com/xtls/xray-core/main/distro/all"
)

type routeCase struct {
	Name               string   `json:"name"`
	Domain             string   `json:"domain,omitempty"`
	IPs                []string `json:"ips,omitempty"`
	ResolvedIPs        []string `json:"resolvedIPs,omitempty"`
	Network            string   `json:"network,omitempty"`
	Port               uint16   `json:"port,omitempty"`
	InboundTag         string   `json:"inboundTag,omitempty"`
	Protocol           string   `json:"protocol,omitempty"`
	ExpectedTag        string   `json:"expectedTag"`
	ExpectedDNSLookups int      `json:"expectedDnsLookups,omitempty"`
}

type fixture struct {
	Name       string      `json:"name"`
	ConfigJSON string      `json:"configJSON"`
	Cases      []routeCase `json:"cases"`
}

type caseResult struct {
	Name        string `json:"name"`
	ExpectedTag string `json:"expectedTag"`
	ActualTag   string `json:"actualTag,omitempty"`
	Passed      bool   `json:"passed"`
	Failure     string `json:"failure,omitempty"`
	DNSLookups  int    `json:"stubDnsLookups"`
	Fallback    bool   `json:"defaultOutboundFallback"`
}

type fixtureResult struct {
	Name           string       `json:"name"`
	Passed         bool         `json:"passed"`
	Failure        string       `json:"failure,omitempty"`
	ConfigSHA256   string       `json:"configSha256"`
	DomainStrategy string       `json:"domainStrategy,omitempty"`
	RuleCount      int          `json:"ruleCount"`
	Cases          []caseResult `json:"cases"`
}

type report struct {
	SchemaVersion   int               `json:"schemaVersion"`
	CheckedAtUTC    string            `json:"checkedAtUtc"`
	CoreVersion     string            `json:"coreVersion"`
	FixtureSHA256   string            `json:"fixtureSha256"`
	AssetSHA256     map[string]string `json:"assetSha256"`
	ValidationScope string            `json:"validationScope"`
	CoreStarted     bool              `json:"coreInstanceStarted"`
	BlockedAttempts int64             `json:"blockedHttpOrDnsAttempts"`
	SampleCount     int               `json:"sampleCount"`
	PassedCount     int               `json:"passedCount"`
	CaseCount       int               `json:"caseCount"`
	PassedCaseCount int               `json:"passedCaseCount"`
	Results         []fixtureResult   `json:"results"`
}

var blockedAttempts atomic.Int64

type denyHTTP struct{}

func (denyHTTP) RoundTrip(*http.Request) (*http.Response, error) {
	blockedAttempts.Add(1)
	return nil, errors.New("NETWORK_DISABLED_FOR_ROUTING_VALIDATION")
}

type fixtureDNS struct {
	domain  string
	ips     []xnet.IP
	lookups int
}

func (*fixtureDNS) Type() interface{} { return dns.ClientType() }
func (*fixtureDNS) Start() error      { return nil }
func (*fixtureDNS) Close() error      { return nil }
func (d *fixtureDNS) LookupIP(domain string, _ dns.IPOption) ([]xnet.IP, uint32, error) {
	d.lookups++
	if domain != d.domain || len(d.ips) == 0 {
		return nil, 0, dns.ErrEmptyResponse
	}
	return d.ips, dns.DefaultTTL, nil
}

type fixtureContext struct {
	sample routeCase
	ips    []xnet.IP
}

func (c fixtureContext) GetInboundTag() string            { return c.sample.InboundTag }
func (c fixtureContext) GetSourceIPs() []xnet.IP          { return nil }
func (c fixtureContext) GetSourcePort() xnet.Port         { return 0 }
func (c fixtureContext) GetTargetIPs() []xnet.IP          { return c.ips }
func (c fixtureContext) GetLocalIPs() []xnet.IP           { return nil }
func (c fixtureContext) GetLocalPort() xnet.Port          { return 0 }
func (c fixtureContext) GetTargetDomain() string          { return c.sample.Domain }
func (c fixtureContext) GetProtocol() string              { return c.sample.Protocol }
func (c fixtureContext) GetUser() string                  { return "" }
func (c fixtureContext) GetVlessRoute() xnet.Port         { return 0 }
func (c fixtureContext) GetAttributes() map[string]string { return nil }
func (c fixtureContext) GetSkipDNSResolve() bool          { return false }
func (c fixtureContext) GetTargetPort() xnet.Port {
	if c.sample.Port == 0 {
		return 443
	}
	return xnet.Port(c.sample.Port)
}
func (c fixtureContext) GetNetwork() xnet.Network {
	if c.sample.Network == "udp" {
		return xnet.Network_UDP
	}
	return xnet.Network_TCP
}

func parseIPs(values []string) ([]xnet.IP, bool) {
	ips := make([]xnet.IP, 0, len(values))
	for _, value := range values {
		ip := net.ParseIP(value)
		if ip == nil {
			return nil, false
		}
		ips = append(ips, ip)
	}
	return ips, true
}

func hashBytes(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func validate(sample fixture) (out fixtureResult) {
	out.Name, out.ConfigSHA256 = sample.Name, hashBytes([]byte(sample.ConfigJSON))
	defer func() {
		if recover() != nil {
			out.Passed = false
			out.Failure = "XRAY_ROUTING_VALIDATION_PANIC"
		}
	}()
	config, err := core.LoadConfig("json", strings.NewReader(sample.ConfigJSON))
	if err != nil || config == nil {
		out.Failure = "XRAY_CONFIG_REJECTED"
		return
	}
	if len(config.Outbound) == 0 || config.Outbound[0].Tag == "" {
		out.Failure = "NO_DEFAULT_OUTBOUND"
		return
	}
	tags := map[string]bool{}
	for _, outbound := range config.Outbound {
		tags[outbound.Tag] = true
	}
	var routingConfig *router.Config
	for _, app := range config.App {
		if app.Type != "xray.app.router.Config" {
			continue
		}
		instance, loadErr := app.GetInstance()
		if loadErr != nil {
			out.Failure = "ROUTER_PROTO_REJECTED"
			return
		}
		if routingConfig != nil {
			out.Failure = "DUPLICATE_ROUTER_CONFIG"
			return
		}
		routingConfig, _ = instance.(*router.Config)
	}
	if routingConfig == nil {
		out.Failure = "NO_ROUTER_CONFIG"
		return
	}
	// These synthetic tests must never create webhook clients, balancing probes,
	// dispatchers, or process matchers. Only pure domain/IP/port rules are allowed.
	if len(routingConfig.BalancingRule) != 0 {
		out.Failure = "BALANCERS_FORBIDDEN"
		return
	}
	for _, rule := range routingConfig.Rule {
		if rule.Webhook != nil || rule.GetBalancingTag() != "" || len(rule.Process) != 0 {
			out.Failure = "IMPURE_ROUTING_RULE_FORBIDDEN"
			return
		}
		if !tags[rule.GetTag()] {
			out.Failure = "ROUTE_OUTBOUND_NOT_FOUND"
			return
		}
	}
	out.DomainStrategy = routingConfig.DomainStrategy.String()
	out.RuleCount = len(routingConfig.Rule)
	out.Passed = true
	for _, test := range sample.Cases {
		result := caseResult{Name: test.Name, ExpectedTag: test.ExpectedTag}
		ips, _ := parseIPs(test.IPs)
		resolved, _ := parseIPs(test.ResolvedIPs)
		dnsClient := &fixtureDNS{domain: test.Domain, ips: resolved}
		r := &router.Router{}
		if err := r.Init(context.Background(), routingConfig, dnsClient, nil, nil); err != nil {
			result.Failure = "ROUTER_INIT_REJECTED"
		} else {
			route, pickErr := r.PickRoute(fixtureContext{sample: test, ips: ips})
			if pickErr == common.ErrNoClue {
				result.ActualTag, result.Fallback = config.Outbound[0].Tag, true
			} else if pickErr != nil || route == nil {
				result.Failure = "ROUTE_PICK_FAILED"
			} else {
				result.ActualTag = route.GetOutboundTag()
			}
			_ = r.Close()
		}
		result.DNSLookups = dnsClient.lookups
		if result.Failure == "" && result.ActualTag != test.ExpectedTag {
			result.Failure = "ROUTE_TAG_MISMATCH"
		}
		if result.Failure == "" && result.DNSLookups != test.ExpectedDNSLookups {
			result.Failure = "DNS_LOOKUP_COUNT_MISMATCH"
		}
		result.Passed = result.Failure == ""
		if !result.Passed {
			out.Passed = false
		}
		out.Cases = append(out.Cases, result)
	}
	return
}

func run() int {
	fixturePath := flag.String("fixtures", "", "Generated synthetic fixture JSON")
	assetRoot := flag.String("assets", "", "Directory containing packaged geosite.dat and geoip.dat")
	outputPath := flag.String("output", "", "Fresh verification output path")
	expectedVersion := flag.String("expect-version", "", "Required exact core version")
	flag.Parse()
	if *fixturePath == "" || *assetRoot == "" || *outputPath == "" || *expectedVersion == "" {
		fmt.Println("VALIDATION_ARGUMENTS_REQUIRED")
		return 2
	}
	if core.Version() != *expectedVersion {
		fmt.Println("CORE_VERSION_MISMATCH")
		return 2
	}
	raw, err := os.ReadFile(*fixturePath)
	if err != nil || len(raw) > 8*1024*1024 {
		fmt.Println("INVALID_FIXTURE_FILE")
		return 2
	}
	var samples []fixture
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&samples) != nil || len(samples) == 0 || len(samples) > 64 {
		fmt.Println("INVALID_FIXTURE_ARRAY")
		return 2
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		fmt.Println("TRAILING_FIXTURE_DATA")
		return 2
	}
	validName := regexp.MustCompile(`^[a-zA-Z0-9 _./:-]{1,100}$`)
	validTag := regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
	for _, sample := range samples {
		if !validName.MatchString(sample.Name) || len(sample.ConfigJSON) == 0 || len(sample.ConfigJSON) > 256*1024 || len(sample.Cases) == 0 || len(sample.Cases) > 128 {
			fmt.Println("INVALID_FIXTURE_ENTRY")
			return 2
		}
		for _, test := range sample.Cases {
			_, ipsValid := parseIPs(test.IPs)
			_, resolvedValid := parseIPs(test.ResolvedIPs)
			if !validName.MatchString(test.Name) || !validTag.MatchString(test.ExpectedTag) ||
				(test.Network != "" && test.Network != "tcp" && test.Network != "udp") ||
				!ipsValid || !resolvedValid || len(test.IPs) > 16 || len(test.ResolvedIPs) > 16 ||
				len(test.Domain) > 253 || len(test.InboundTag) > 64 || len(test.Protocol) > 64 || test.ExpectedDNSLookups < 0 || test.ExpectedDNSLookups > 16 {
				fmt.Println("INVALID_ROUTE_CASE")
				return 2
			}
		}
	}
	assetHashes := map[string]string{}
	for _, name := range []string{"geosite.dat", "geoip.dat"} {
		asset, readErr := os.ReadFile(filepath.Join(*assetRoot, name))
		if readErr != nil || len(asset) == 0 || len(asset) > 128*1024*1024 {
			fmt.Println("REQUIRED_GEODATA_UNAVAILABLE")
			return 2
		}
		assetHashes[name] = hashBytes(asset)
	}
	// Set both accepted forms so an inherited environment cannot override assets.
	if os.Setenv("xray.location.asset", *assetRoot) != nil || os.Setenv("XRAY_LOCATION_ASSET", *assetRoot) != nil {
		fmt.Println("ASSET_ENVIRONMENT_FAILED")
		return 2
	}
	http.DefaultTransport = denyHTTP{}
	http.DefaultClient = &http.Client{Transport: denyHTTP{}}
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		blockedAttempts.Add(1)
		return nil, errors.New("NETWORK_DISABLED_FOR_ROUTING_VALIDATION")
	}}
	log.SetOutput(io.Discard)
	consoleOut, consoleErr := os.Stdout, os.Stderr
	discard, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		fmt.Println("COULD_NOT_SUPPRESS_CONFIG_LOGS")
		return 2
	}
	os.Stdout, os.Stderr = discard, discard
	verification := report{
		SchemaVersion: 1, CheckedAtUTC: time.Now().UTC().Format(time.RFC3339), CoreVersion: core.Version(),
		FixtureSHA256: hashBytes(raw), AssetSHA256: assetHashes, SampleCount: len(samples),
		ValidationScope: "synthetic generated JSON -> core.LoadConfig -> real router.Init/PickRoute with supplied IPs and offline DNS stub; no outbound dispatch",
	}
	for _, sample := range samples {
		item := validate(sample)
		verification.Results = append(verification.Results, item)
		if item.Passed {
			verification.PassedCount++
		}
		verification.CaseCount += len(sample.Cases)
		for _, result := range item.Cases {
			if result.Passed {
				verification.PassedCaseCount++
			}
		}
	}
	os.Stdout, os.Stderr = consoleOut, consoleErr
	_ = discard.Close()
	verification.BlockedAttempts = blockedAttempts.Load()
	encoded, err := json.MarshalIndent(verification, "", "  ")
	if err != nil || os.WriteFile(*outputPath, append(encoded, '\n'), 0600) != nil {
		fmt.Println("VERIFICATION_REPORT_WRITE_FAILED")
		return 2
	}
	fmt.Printf("Real Xray routing cases: %d/%d; configurations: %d/%d\n", verification.PassedCaseCount, verification.CaseCount, verification.PassedCount, verification.SampleCount)
	if verification.PassedCount != verification.SampleCount || verification.BlockedAttempts != 0 {
		return 1
	}
	return 0
}

func main() { os.Exit(run()) }
