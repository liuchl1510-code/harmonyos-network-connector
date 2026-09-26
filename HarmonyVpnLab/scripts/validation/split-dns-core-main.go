// Compile synthetic generated app JSON through the pinned real config loader.
// Only DNS/router protobufs reach the second (package-local DNS) test stage.
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

	"github.com/xtls/xray-core/app/dns"
	"github.com/xtls/xray-core/app/router"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/core"
	_ "github.com/xtls/xray-core/main/distro/all"
	"github.com/xtls/xray-core/transport/internet"
	"google.golang.org/protobuf/proto"
)

type dnsCase struct {
	Domain              string `json:"domain"`
	ExpectedClientIndex int    `json:"expectedClientIndex"`
	FailSelected        bool   `json:"failSelected,omitempty"`
}
type fixture struct {
	Name       string    `json:"name"`
	ConfigJSON string    `json:"configJSON"`
	Cases      []dnsCase `json:"cases"`
}
type prepared struct {
	Name         string    `json:"name"`
	ConfigSHA256 string    `json:"configSha256"`
	DNS          []byte    `json:"dnsProto"`
	Router       []byte    `json:"routerProto"`
	OutboundTags []string  `json:"outboundTags"`
	Cases        []dnsCase `json:"cases"`
}

var blocked atomic.Int64

type denyHTTP struct{}

func (denyHTTP) RoundTrip(*http.Request) (*http.Response, error) {
	blocked.Add(1)
	return nil, errors.New("NETWORK_DISABLED")
}

type denySystem struct{}

func (denySystem) Dial(context.Context, xnet.Address, xnet.Destination, *internet.SocketConfig) (xnet.Conn, error) {
	blocked.Add(1)
	return nil, errors.New("NETWORK_DISABLED")
}
func (denySystem) DestIpAddress() xnet.IP { return nil }

func build(sample fixture) (prepared, error) {
	var out prepared
	out.Name = sample.Name
	out.Cases = sample.Cases
	h := sha256.Sum256([]byte(sample.ConfigJSON))
	out.ConfigSHA256 = hex.EncodeToString(h[:])
	cfg, err := core.LoadConfig("json", strings.NewReader(sample.ConfigJSON))
	if err != nil || cfg == nil {
		return out, errors.New("CONFIG_REJECTED")
	}
	for _, o := range cfg.Outbound {
		out.OutboundTags = append(out.OutboundTags, o.Tag)
	}
	for _, a := range cfg.App {
		switch a.Type {
		case "xray.app.dns.Config":
			if out.DNS != nil {
				return out, errors.New("DUPLICATE_DNS")
			}
			v, err := a.GetInstance()
			if err != nil {
				return out, errors.New("DNS_PROTO_REJECTED")
			}
			if _, ok := v.(*dns.Config); !ok {
				return out, errors.New("WRONG_DNS_PROTO")
			}
			out.DNS, err = proto.Marshal(v)
			if err != nil {
				return out, errors.New("DNS_PROTO_ENCODE")
			}
		case "xray.app.router.Config":
			if out.Router != nil {
				return out, errors.New("DUPLICATE_ROUTER")
			}
			v, err := a.GetInstance()
			if err != nil {
				return out, errors.New("ROUTER_PROTO_REJECTED")
			}
			if _, ok := v.(*router.Config); !ok {
				return out, errors.New("WRONG_ROUTER_PROTO")
			}
			out.Router, err = proto.Marshal(v)
			if err != nil {
				return out, errors.New("ROUTER_PROTO_ENCODE")
			}
		}
	}
	if out.DNS == nil || out.Router == nil || len(out.OutboundTags) == 0 {
		return out, errors.New("REQUIRED_FEATURE_MISSING")
	}
	return out, nil
}
func run() int {
	input := flag.String("fixtures", "", "synthetic fixtures")
	output := flag.String("output", "", "prepared output")
	version := flag.String("expect-version", "", "pinned version")
	flag.Parse()
	if *input == "" || *output == "" || *version == "" || core.Version() != *version {
		fmt.Println("PIN_OR_PATH_MISMATCH")
		return 2
	}
	b, err := os.ReadFile(*input)
	if err != nil || len(b) > 4*1024*1024 {
		fmt.Println("FIXTURE_READ_FAILED")
		return 2
	}
	var fixtures []fixture
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if d.Decode(&fixtures) != nil || len(fixtures) == 0 || len(fixtures) > 64 {
		fmt.Println("INVALID_FIXTURES")
		return 2
	}
	var extra interface{}
	if d.Decode(&extra) != io.EOF {
		fmt.Println("TRAILING_FIXTURE_DATA")
		return 2
	}
	nameRE := regexp.MustCompile(`^[a-zA-Z0-9 _./:-]{1,100}$`)
	domainRE := regexp.MustCompile(`^[A-Za-z0-9_.-]{1,253}$`)
	for _, f := range fixtures {
		if !nameRE.MatchString(f.Name) || len(f.ConfigJSON) == 0 || len(f.ConfigJSON) > 256*1024 || len(f.Cases) == 0 || len(f.Cases) > 128 {
			fmt.Println("INVALID_FIXTURE_ENTRY")
			return 2
		}
		for _, c := range f.Cases {
			if !domainRE.MatchString(c.Domain) || c.ExpectedClientIndex < 0 || c.ExpectedClientIndex > 2 {
				fmt.Println("INVALID_DNS_CASE")
				return 2
			}
		}
	}
	http.DefaultTransport = denyHTTP{}
	http.DefaultClient = &http.Client{Transport: denyHTTP{}}
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		blocked.Add(1)
		return nil, errors.New("NETWORK_DISABLED")
	}}
	internet.UseAlternativeSystemDialer(denySystem{})
	log.SetOutput(io.Discard)
	out := make([]prepared, 0, len(fixtures))
	for _, f := range fixtures {
		p, e := build(f)
		if e != nil {
			fmt.Println(e.Error())
			return 1
		}
		out = append(out, p)
	}
	if blocked.Load() != 0 {
		fmt.Println("NETWORK_ATTEMPT_REJECTED")
		return 1
	}
	encoded, err := json.MarshalIndent(out, "", "  ")
	if err != nil || os.WriteFile(*output, encoded, 0600) != nil {
		fmt.Println("OUTPUT_WRITE_FAILED")
		return 1
	}
	fmt.Printf("Pinned config loader prepared %d DNS/router protobuf fixtures; no core started.\n", len(out))
	return 0
}
func main() { os.Exit(run()) }
