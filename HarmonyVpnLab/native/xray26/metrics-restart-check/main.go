package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"github.com/xtls/xray-core/core"
	stats "github.com/xtls/xray-core/features/stats"
	_ "github.com/xtls/xray-core/main/distro/all"
	"net"
	"net/http"
	"os"
	"time"
)

func restart(config string) (panicked string, err error) {
	defer func() {
		if r := recover(); r != nil {
			panicked = fmt.Sprint(r)
		}
	}()
	s, e := core.StartInstance("json", []byte(config))
	if e != nil {
		return "", e
	}
	return "", s.Close()
}
func main() {
	mode := flag.String("mode", "metrics", "metrics or no-metrics")
	output := flag.String("output", "", "report path")
	flag.Parse()
	report := map[string]interface{}{"coreVersion": core.Version(), "mode": *mode, "remoteNetworkUsed": false, "privateConfigRead": false}
	cfg := `{"log":{"loglevel":"none"},"stats":{},"policy":{"system":{"statsOutboundUplink":true,"statsOutboundDownlink":true}},"outbounds":[{"tag":"synthetic","protocol":"blackhole","settings":{}}]}`
	if *mode == "metrics" {
		l, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			panic(e)
		}
		address := l.Addr().String()
		l.Close()
		cfg = cfg[:len(cfg)-1] + `,"metrics":{"tag":"local-metrics","listen":"` + address + `"}}`
		s, e := core.StartInstance("json", []byte(cfg))
		report["firstStartOk"] = e == nil
		if e != nil {
			panic(e)
		}
		client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
		resp, e := client.Get("http://" + address + "/debug/vars")
		report["firstLoopbackMetricsOk"] = e == nil && resp.StatusCode == 200
		if e == nil {
			resp.Body.Close()
		}
		e = s.Close()
		report["firstStopOk"] = e == nil
		l, e = net.Listen("tcp", address)
		report["metricsListenerStillBoundAfterStop"] = e != nil
		if e == nil {
			l.Close()
		}
		p, e := restart(cfg)
		report["secondStartPanic"] = p
		report["secondStartError"] = fmt.Sprint(e)
	} else {
		reports := []map[string]interface{}{}
		var prior stats.Manager
		for i := 1; i <= 3; i++ {
			s, e := core.StartInstance("json", []byte(cfg))
			if e != nil {
				panic(e)
			}
			manager := s.GetFeature(stats.ManagerType()).(stats.Manager)
			counter, e := stats.GetOrRegisterCounter(manager, "outbound>>>synthetic>>>traffic>>>uplink")
			if e != nil {
				panic(e)
			}
			initial := counter.Value()
			counter.Add(int64(i * 100))
			actual := counter.Value()
			fresh := prior == nil || manager != prior
			prior = manager
			e = s.Close()
			reports = append(reports, map[string]interface{}{"iteration": i, "newStatsManager": fresh, "initialValue": initial, "updatedValue": actual, "stopOk": e == nil})
		}
		report["threeRestartCycles"] = reports
	}
	b, _ := json.MarshalIndent(report, "", "  ")
	fmt.Println(string(b))
	if *output != "" {
		os.WriteFile(*output, append(b, '\n'), 0600)
	}
}
