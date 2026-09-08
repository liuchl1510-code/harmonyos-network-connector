// Synthetic no-network verification of the pinned core's configuration loader,
// static hosts, and DialSystem boundary. Never starts a core or creates a socket.
package main

import (
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
	"strings"
	"sync/atomic"
	"time"

	dnsapp "github.com/xtls/xray-core/app/dns"
	"github.com/xtls/xray-core/app/proxyman"
	"github.com/xtls/xray-core/common/geodata"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/core"
	fdns "github.com/xtls/xray-core/features/dns"
	_ "github.com/xtls/xray-core/main/distro/all"
	vless "github.com/xtls/xray-core/proxy/vless/outbound"
	"github.com/xtls/xray-core/transport/internet"
	grpc "github.com/xtls/xray-core/transport/internet/grpc"
	"github.com/xtls/xray-core/transport/internet/reality"
	xtls "github.com/xtls/xray-core/transport/internet/tls"
	"github.com/xtls/xray-core/transport/internet/websocket"
)

type fixture struct {
	Name       string `json:"name"`
	ConfigJSON string `json:"configJSON"`
}
type result struct {
	Name    string `json:"name"`
	Passed  bool   `json:"passed"`
	Checks  int    `json:"checks"`
	Failure string `json:"failure,omitempty"`
}
type hostDNS struct {
	hosts *dnsapp.StaticHosts
	calls int
	fail  bool
}

func (d *hostDNS) Type() interface{} { return fdns.ClientType() }
func (d *hostDNS) Start() error      { return nil }
func (d *hostDNS) Close() error      { return nil }
func (d *hostDNS) LookupIP(domain string, opt fdns.IPOption) ([]xnet.IP, uint32, error) {
	d.calls++
	if d.fail {
		return nil, 0, errors.New("SYNTHETIC_DNS_FAILURE")
	}
	// DNS.LookupIP applies this same FQDN trimming before its static host lookup.
	addresses, err := d.hosts.Lookup(strings.TrimSuffix(domain, "."), opt)
	if err != nil {
		return nil, 0, err
	}
	ips := []xnet.IP{}
	for _, address := range addresses {
		ips = append(ips, address.IP())
	}
	return ips, 10, nil
}

type recordingDialer struct {
	calls   int
	address string
}

var blockedNetworkAttempts atomic.Int64

type denyHTTP struct{}

func (denyHTTP) RoundTrip(*http.Request) (*http.Response, error) {
	blockedNetworkAttempts.Add(1)
	return nil, errors.New("NETWORK_DISABLED_FOR_HOSTNAME_VALIDATION")
}

func (d *recordingDialer) DestIpAddress() xnet.IP { return nil }
func (d *recordingDialer) Dial(_ context.Context, _ xnet.Address, dest xnet.Destination, _ *internet.SocketConfig) (xnet.Conn, error) {
	d.calls++
	d.address = dest.Address.String()
	return nil, errors.New("RECORDED_WITHOUT_SOCKET")
}
func require(out *result, ok bool, code string) {
	if !ok {
		panic(code)
	}
	out.Checks++
}
func validate(sample fixture) (out result) {
	out.Name = sample.Name
	defer func() {
		if failure := recover(); failure != nil {
			out.Failure = fmt.Sprint(failure)
			out.Passed = false
		}
	}()
	cfg, err := core.LoadConfig("json", strings.NewReader(sample.ConfigJSON))
	require(&out, err == nil && cfg != nil, "LOAD_CONFIG")
	var dnsConfig *dnsapp.Config
	for _, app := range cfg.App {
		message, e := app.GetInstance()
		require(&out, e == nil, "APP_PROTO")
		if d, ok := message.(*dnsapp.Config); ok {
			dnsConfig = d
		}
	}
	require(&out, dnsConfig != nil && len(dnsConfig.StaticHosts) == 1, "ONE_STATIC_HOST")
	host := dnsConfig.StaticHosts[0]
	rule := host.Domain.GetCustom()
	require(&out, rule != nil && rule.Type == geodata.Domain_Full && rule.Value == "node.example.test", "FULL_HOST_PROTO")
	require(&out, len(host.Ip) == 1 && xnet.IP(host.Ip[0]).String() == "192.0.2.123", "HOST_IPV4_PROTO")
	hosts, err := dnsapp.NewStaticHosts(dnsConfig.StaticHosts)
	require(&out, err == nil, "STATIC_HOSTS_CONSTRUCTOR")
	require(&out, len(cfg.Outbound) == 4 && cfg.Outbound[0].Tag == "nodeProxy", "OUTBOUND_ORDER")
	p, err := cfg.Outbound[0].ProxySettings.GetInstance()
	require(&out, err == nil, "PROXY_PROTO")
	node, ok := p.(*vless.Config)
	require(&out, ok && node.Vnext != nil && node.Vnext.Address.GetDomain() == "Node.Example.Test.", "ENDPOINT_DOMAIN_PRESERVED")
	s, err := cfg.Outbound[0].SenderSettings.GetInstance()
	require(&out, err == nil, "SENDER_PROTO")
	sender, ok := s.(*proxyman.SenderConfig)
	require(&out, ok && sender.StreamSettings != nil, "STREAM_PROTO")
	stream := sender.StreamSettings
	require(&out, stream.SocketSettings != nil && stream.SocketSettings.DomainStrategy == internet.DomainStrategy_FORCE_IP4, "FORCE_IPV4_PROTO")
	require(&out, stream.SocketSettings.AddressPortStrategy == internet.AddressPortStrategy_None, "NO_SRV_TXT_PROTO")
	dns := &hostDNS{hosts: hosts}
	recorder := &recordingDialer{}
	internet.InitSystemDialer(dns, nil)
	internet.UseAlternativeSystemDialer(recorder)
	dest := xnet.TCPDestination(xnet.DomainAddress("Node.Example.Test."), 443)
	internet.DialSystem(context.Background(), dest, stream.SocketSettings)
	require(&out, dns.calls == 1 && recorder.calls == 1 && recorder.address == "192.0.2.123", "TCP_PINNED")
	require(&out, dest.Address.Domain() == "Node.Example.Test.", "ORIGINAL_DESTINATION_UNCHANGED")
	memory, err := internet.ToMemoryStreamConfig(stream)
	require(&out, err == nil, "MEMORY_STREAM")
	if tlsConfig := xtls.ConfigFromStreamSettings(memory); tlsConfig != nil {
		tls := tlsConfig.GetTLSConfig(xtls.WithDestination(dest))
		expected := "sni.example.test"
		if tlsConfig.ServerName == "" {
			expected = "Node.Example.Test."
		}
		require(&out, tls.ServerName == expected && !tls.InsecureSkipVerify, "TLS_SNI_AND_VERIFICATION")
	} else {
		r := reality.ConfigFromStreamSettings(memory)
		require(&out, r != nil && r.ServerName == "sni.example.test", "REALITY_SNI_PRESERVED")
	}
	switch settings := memory.ProtocolSettings.(type) {
	case *websocket.Config:
		require(&out, settings.Host == "front.example.test" && strings.HasPrefix(settings.Path, "/synthetic"), "WS_HOST_PATH_PRESERVED")
	case *grpc.Config:
		require(&out, settings.Authority == "authority.example.test" && settings.ServiceName == "synthetic", "GRPC_AUTHORITY_PRESERVED")
	}
	udp := dest
	udp.Network = xnet.Network_UDP
	internet.DialSystem(context.Background(), udp, stream.SocketSettings)
	require(&out, recorder.calls == 2 && recorder.address == "192.0.2.123", "UDP_PINNED")
	dns.fail = true
	previous := recorder.calls
	internet.DialSystem(context.Background(), dest, stream.SocketSettings)
	require(&out, recorder.calls == previous, "FORCE_FAILURE_STOPS_SYSTEM_DIAL")
	use := *stream.SocketSettings
	use.DomainStrategy = internet.DomainStrategy_USE_IP4
	internet.DialSystem(context.Background(), dest, &use)
	require(&out, recorder.calls == previous+1 && recorder.address == "Node.Example.Test.", "USE_IPV4_NEGATIVE_CONTROL")
	out.Passed = true
	return
}
func main() {
	fixturesPath := flag.String("fixtures", "", "Generated synthetic hostname fixtures")
	outputPath := flag.String("output", "", "Fresh evidence JSON path")
	flag.Parse()
	if core.Version() != "26.6.1" || *fixturesPath == "" || *outputPath == "" {
		fmt.Println("INVALID_VERSION_OR_PATHS")
		os.Exit(2)
	}
	log.SetOutput(io.Discard)
	http.DefaultTransport = denyHTTP{}
	http.DefaultClient = &http.Client{Transport: denyHTTP{}}
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		blockedNetworkAttempts.Add(1)
		return nil, errors.New("NETWORK_DISABLED_FOR_HOSTNAME_VALIDATION")
	}}
	raw, err := os.ReadFile(*fixturesPath)
	if err != nil || len(raw) > 1024*1024 {
		fmt.Println("INVALID_FIXTURES")
		os.Exit(2)
	}
	var samples []fixture
	if json.Unmarshal(raw, &samples) != nil || len(samples) != 4 {
		fmt.Println("INVALID_SAMPLE_COUNT")
		os.Exit(2)
	}
	results := []result{}
	passed := 0
	for _, sample := range samples {
		r := validate(sample)
		results = append(results, r)
		if r.Passed {
			passed++
		}
	}
	digest := sha256.Sum256(raw)
	report := map[string]interface{}{
		"schemaVersion": 1, "checkedAtUtc": time.Now().UTC().Format(time.RFC3339), "coreVersion": core.Version(),
		"coreInstanceStarted": false, "socketsCreated": 0, "privateNodeRead": false, "fixtureSha256": hex.EncodeToString(digest[:]),
		"blockedHttpOrDnsAttempts": blockedNetworkAttempts.Load(),
		"scope":                    "Generated application configs -> real pinned loader/protobuf -> real StaticHosts and DialSystem with DNS failure control and non-network recording SystemDialer. TLS/WS/gRPC/REALITY fields inspected; no remote handshake.",
		"sampleCount":              len(samples), "passedCount": passed, "results": results,
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil || os.WriteFile(*outputPath, append(encoded, '\n'), 0600) != nil {
		fmt.Println("REPORT_WRITE_FAILED")
		os.Exit(2)
	}
	fmt.Printf("Hostname core checks: %d/%d; no sockets created\n", passed, len(samples))
	if passed != len(samples) || blockedNetworkAttempts.Load() != 0 {
		os.Exit(1)
	}
}
