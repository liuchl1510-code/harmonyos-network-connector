package main

import (
	"bytes"
	"slices"

	dnsapp "github.com/xtls/xray-core/app/dns"
	"github.com/xtls/xray-core/app/metrics"
	"github.com/xtls/xray-core/app/policy"
	"github.com/xtls/xray-core/app/router"
	"github.com/xtls/xray-core/app/stats"
	"github.com/xtls/xray-core/common/geodata"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/proxy/blackhole"
	dnsproxy "github.com/xtls/xray-core/proxy/dns"
)

// Inspect the generated messages, not the input JSON. Unknown JSON fields can
// be silently ignored by the loader; these checks must expose that mismatch.
// GetInstance here unmarshals protobuf messages, never starts core features.
func checkConnectionProto(config *core.Config) string {
	var dns *dnsapp.Config
	var routing *router.Config
	var policies *policy.Config
	metricsEnabled := false
	statsEnabled := false
	for _, app := range config.App {
		instance, err := app.GetInstance()
		if err != nil {
			return "APP_PROTO_DECODE_FAILED"
		}
		switch item := instance.(type) {
		case *dnsapp.Config:
			dns = item
		case *router.Config:
			routing = item
		case *policy.Config:
			policies = item
		case *metrics.Config:
			metricsEnabled = true
		case *stats.Config:
			statsEnabled = true
		}
	}
	if dns == nil || dns.Tag != "dns-via-node" || dns.QueryStrategy != dnsapp.QueryStrategy_USE_IP4 ||
		!dns.DisableFallback || !dns.DisableFallbackIfMatch || len(dns.StaticHosts) != 0 || len(dns.NameServer) != 1 {
		return "DNS_APP_PROTO_MISMATCH"
	}
	server := dns.NameServer[0]
	if server.Address == nil || server.Address.Address.GetDomain() != "https://1.1.1.1/dns-query" ||
		!server.SkipFallback || server.QueryStrategy != dnsapp.QueryStrategy_USE_IP4 || len(server.Domain) != 1 {
		return "DOH_SERVER_PROTO_MISMATCH"
	}
	matchAll := server.Domain[0].GetCustom()
	if matchAll == nil || matchAll.Type != geodata.Domain_Regex || matchAll.Value != ".*" {
		return "DOH_MATCH_ALL_PROTO_MISMATCH"
	}
	if !statsEnabled || policies == nil || policies.System == nil || policies.System.Stats == nil ||
		!policies.System.Stats.OutboundUplink || !policies.System.Stats.OutboundDownlink {
		return "TRAFFIC_POLICY_PROTO_MISMATCH"
	}
	if metricsEnabled {
		return "UNEXPECTED_METRICS_HTTP_FEATURE"
	}
	if len(config.Outbound) != 4 || config.Outbound[0].Tag != "nodeProxy" {
		return "PROXY_OUTBOUND_ORDER_MISMATCH"
	}
	var dnsOutbound *dnsproxy.Config
	blackholes := map[string]bool{}
	for _, outbound := range config.Outbound {
		instance, err := outbound.ProxySettings.GetInstance()
		if err != nil {
			return "OUTBOUND_PROTO_DECODE_FAILED"
		}
		switch item := instance.(type) {
		case *dnsproxy.Config:
			if outbound.Tag != "dns-out" {
				return "DNS_OUTBOUND_TAG_MISMATCH"
			}
			dnsOutbound = item
		case *blackhole.Config:
			blackholes[outbound.Tag] = true
		}
	}
	if !blackholes["block-ipv6"] || !blackholes["block-virtual"] || len(blackholes) != 2 {
		return "BLACKHOLE_OUTBOUND_PROTO_MISMATCH"
	}
	if dnsOutbound == nil || len(dnsOutbound.Rule) != 3 {
		return "DNS_PROTO_RULE_COUNT"
	}
	rules := dnsOutbound.Rule
	if rules[0].Action != dnsproxy.RuleAction_Return || !slices.Equal(rules[0].QType, []int32{28}) || rules[0].RCode != 0 ||
		rules[1].Action != dnsproxy.RuleAction_Hijack || !slices.Equal(rules[1].QType, []int32{1}) ||
		rules[2].Action != dnsproxy.RuleAction_Return || len(rules[2].QType) != 0 || rules[2].RCode != 0 {
		return "DNS_PROTO_ACTION_OR_QTYPE_MISMATCH"
	}
	if rewrite := dnsOutbound.RewriteServer; rewrite != nil &&
		(rewrite.Address != nil || rewrite.Port != 0 || rewrite.Network != xnet.Network_Unknown) {
		return "UNEXPECTED_DNS_RAW_FORWARDING_TARGET"
	}
	if routing == nil || routing.DomainStrategy != router.Config_AsIs || len(routing.Rule) != 5 {
		return "ROUTING_PROTO_MISMATCH"
	}
	if routing.Rule[0].GetTag() != "block-ipv6" || len(routing.Rule[0].Ip) != 1 {
		return "IPV6_BLOCK_RULE_NOT_FIRST"
	}
	ipRule := routing.Rule[0].Ip[0].GetCustom()
	if ipRule == nil || ipRule.ReverseMatch || ipRule.Cidr == nil || ipRule.Cidr.Prefix != 0 ||
		!bytes.Equal(ipRule.Cidr.Ip, make([]byte, 16)) {
		return "IPV6_CIDR_PROTO_MISMATCH"
	}
	if routing.Rule[1].GetTag() != "nodeProxy" || !slices.Equal(routing.Rule[1].InboundTag, []string{"dns-via-node"}) {
		return "DOH_PROXY_ROUTE_PROTO_MISMATCH"
	}
	dnsRoute := routing.Rule[2]
	if dnsRoute.GetTag() != "dns-out" || !slices.Equal(dnsRoute.InboundTag, []string{"connection-in"}) ||
		!slices.Contains(dnsRoute.Networks, xnet.Network_TCP) || !slices.Contains(dnsRoute.Networks, xnet.Network_UDP) ||
		dnsRoute.PortList == nil || len(dnsRoute.PortList.Range) != 1 || dnsRoute.PortList.Range[0].From != 53 || dnsRoute.PortList.Range[0].To != 53 {
		return "DNS_CAPTURE_ROUTE_PROTO_MISMATCH"
	}
	if routing.Rule[3].GetTag() != "block-virtual" || routing.Rule[4].GetTag() != "nodeProxy" ||
		!slices.Equal(routing.Rule[4].InboundTag, []string{"connection-in"}) {
		return "CLIENT_DEFAULT_ROUTE_PROTO_MISMATCH"
	}
	return ""
}
