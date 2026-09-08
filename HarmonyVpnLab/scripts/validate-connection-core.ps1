param(
    [string]$GoRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-go126-port\src-go'),
    [string]$ModuleCache = (Join-Path $env:TEMP 'HarmonyVpnLab-xray\cache\modules'),
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-connection-core-validation')
)
$ErrorActionPreference='Stop'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskFixtures=Join-Path $taskProject 'build\connection-core-fixtures.json'
$taskOutput=Join-Path $taskProject 'build\connection-core-verification.json'
$taskNative=Join-Path $taskProject 'native\xray26'
$taskLock=Get-Content -Raw -LiteralPath (Join-Path $taskNative 'sources.lock.json') | ConvertFrom-Json
$taskGo=Join-Path $GoRoot 'bin\go.exe'
if(!(Test-Path -LiteralPath $taskFixtures)){throw 'Run test-connection-core.cjs to generate synthetic fixtures first.'}
if(!(Test-Path -LiteralPath $taskGo)){throw 'Prepared Go 1.26 compiler is required; no core fallback is allowed.'}
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
$taskManifest=[IO.File]::ReadAllText((Join-Path $taskNative 'upstream\go.mod')).Replace('module github.com/xtls/libxray','module harmonyvpnlab.local/connectionvalidation')
[IO.File]::WriteAllText((Join-Path $BuildRoot 'go.mod'),$taskManifest,[Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $taskNative 'upstream\go.sum') -Destination $BuildRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'validation\connection-core-main.go') -Destination (Join-Path $BuildRoot 'main.go')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'validation\connection-proto-checks.go') -Destination (Join-Path $BuildRoot 'proto-checks.go')
$taskKeys=@('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOMODCACHE','GOCACHE','GOPROXY','GOSUMDB','GOPATH','GOFLAGS','GOWORK')
$taskSaved=@{};foreach($taskKey in $taskKeys){$taskSaved[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey,'Process')}
try {
    $env:GOROOT=$GoRoot;$env:GOENV='off';$env:GOTOOLCHAIN='local';$env:GOOS='windows';$env:GOARCH='amd64';$env:CGO_ENABLED='0';$env:GOFLAGS='';$env:GOWORK='off'
    $env:GOMODCACHE=$ModuleCache;$env:GOCACHE=Join-Path $BuildRoot 'cache';$env:GOPATH=Join-Path $BuildRoot 'gopath';$env:GOPROXY='off';$env:GOSUMDB='off'
    Push-Location $BuildRoot
    try {
        $taskVersion=(& $taskGo version) -join ''
        if($taskVersion -notmatch '^go version go1\.26\.[0-9]+ windows/amd64$'){throw 'Expected prepared Windows Go 1.26 toolchain.'}
        $taskModule=((& $taskGo list '-mod=readonly' -m -json github.com/xtls/xray-core) -join "`n") | ConvertFrom-Json
        if($LASTEXITCODE -ne 0 -or $taskModule.Version -ne $taskLock.xrayCore.moduleVersion -or $taskModule.Replace){throw 'Static DNS/routing validation must use the pinned real 26.6.1 core.'}
        $taskIntegrity=(& $taskGo mod verify) -join "`n"
        if($LASTEXITCODE -ne 0){throw 'Cached dependency integrity failed.'}
        & $taskGo build '-mod=readonly' -trimpath '-buildvcs=false' -o (Join-Path $BuildRoot 'validate-core.exe') .
        if($LASTEXITCODE -ne 0){throw 'Offline connection validator build failed.'}
    } finally {Pop-Location}
    $taskFresh=Join-Path $BuildRoot ('result-'+[guid]::NewGuid().ToString('N')+'.json')
    & (Join-Path $BuildRoot 'validate-core.exe') -fixtures $taskFixtures -output $taskFresh -expect-version '26.6.1'
    $taskExit=$LASTEXITCODE
    if(!(Test-Path -LiteralPath $taskFresh)){throw 'No fresh connection core validation report.'}
    $taskReport=Get-Content -Raw -LiteralPath $taskFresh | ConvertFrom-Json -AsHashtable
    $taskReport.coreModule='github.com/xtls/xray-core@'+$taskModule.Version
    $taskReport.toolchain=$taskVersion
    $taskReport.moduleIntegrity=$taskIntegrity
    $taskReport.controllerPatchScope='Unmodified pinned core loader; socket-controller runtime patch does not affect LoadConfig and is not executed.'
    $taskReport.dnsScope='A via proxied DoH; AAAA and other qtypes empty NOERROR; no local DNS fallback.'
    $taskReport.protoAssertions='DNS actions/qTypes/rcode, routed non-local DoH/tag/IPv4/fallback policy, IPv6 CIDR blackhole order, stats manager and outbound byte-count policy enabled, metrics HTTP feature absent, client default route'
    $taskReport.statisticsScope='Per-instance counters are read through CGoConnectionStats; no metrics HTTP feature or expvar publication. This validator checks generated protobufs; actual accessor restart tests are recorded by the native build.'
    $taskReport | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8NoBOM -LiteralPath $taskOutput
    if($taskExit -ne 0 -or $taskReport.coreVersion -ne '26.6.1'){throw 'Static real-core connection configuration validation failed.'}
    Write-Output ('Connection configs accepted by real core 26.6.1: '+$taskReport.passedCount+'/'+$taskReport.sampleCount)
    # Unknown JSON keys are ignored by LoadConfig. Prove the protobuf assertion
    # catches a misspelled DNS rules key rather than accepting that silent loss.
    $taskFirst=@(Get-Content -Raw -LiteralPath $taskFixtures | ConvertFrom-Json -AsHashtable)[0]
    $taskMutated=$taskFirst.configJSON | ConvertFrom-Json -AsHashtable
    $taskDns=@($taskMutated.outbounds | Where-Object {$_.protocol -eq 'dns'})[0]
    $taskDns.settings['rulez']=$taskDns.settings.rules
    $taskDns.settings.Remove('rules')
    $taskNegativeFixture=Join-Path $BuildRoot 'unknown-field-fixture.json'
    @(@{name='negative ignored DNS rule key';configJSON=($taskMutated | ConvertTo-Json -Depth 30 -Compress)}) | ConvertTo-Json -Depth 4 -AsArray | Set-Content -Encoding utf8NoBOM -LiteralPath $taskNegativeFixture
    $taskNegativeReport=Join-Path $BuildRoot ('negative-'+[guid]::NewGuid().ToString('N')+'.json')
    & (Join-Path $BuildRoot 'validate-core.exe') -fixtures $taskNegativeFixture -output $taskNegativeReport -expect-version '26.6.1'
    $taskNegativeExit=$LASTEXITCODE
    $taskNegative=Get-Content -Raw -LiteralPath $taskNegativeReport | ConvertFrom-Json -AsHashtable
    if($taskNegativeExit -eq 0 -or $taskNegative.results[0].failure -ne 'DNS_PROTO_RULE_COUNT'){
        throw 'Unknown-field negative control did not expose silently ignored DNS rules.'
    }
    $taskNegative.expectedFailure=$true
    $taskNegative | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskProject 'build\connection-core-negative-control.json')
    Write-Output 'Unknown DNS-rule key negative control correctly rejected by protobuf checks.'
    # Reintroducing metrics would restore the process-global expvar restart bug.
    # Only build protobufs here; the unsafe core instance is never started.
    $taskWithMetrics=$taskFirst.configJSON | ConvertFrom-Json -AsHashtable
    $taskWithMetrics.metrics=@{tag='local-metrics';listen='127.0.0.1:18901'}
    $taskMetricsFixture=Join-Path $BuildRoot 'unexpected-metrics-fixture.json'
    @(@{name='negative reintroduced metrics HTTP feature';configJSON=($taskWithMetrics | ConvertTo-Json -Depth 30 -Compress)}) | ConvertTo-Json -Depth 4 -AsArray | Set-Content -Encoding utf8NoBOM -LiteralPath $taskMetricsFixture
    $taskMetricsReport=Join-Path $BuildRoot ('metrics-negative-'+[guid]::NewGuid().ToString('N')+'.json')
    & (Join-Path $BuildRoot 'validate-core.exe') -fixtures $taskMetricsFixture -output $taskMetricsReport -expect-version '26.6.1'
    $taskMetricsExit=$LASTEXITCODE
    $taskMetricsNegative=Get-Content -Raw -LiteralPath $taskMetricsReport | ConvertFrom-Json -AsHashtable
    if($taskMetricsExit -eq 0 -or $taskMetricsNegative.results[0].failure -ne 'UNEXPECTED_METRICS_HTTP_FEATURE'){
        throw 'Reintroduced metrics feature negative control did not fail.'
    }
    $taskMetricsNegative.expectedFailure=$true
    $taskMetricsNegative | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskProject 'build\connection-core-metrics-negative-control.json')
    Write-Output 'Metrics HTTP feature negative control correctly rejected before core startup.'
} finally {foreach($taskKey in $taskKeys){[Environment]::SetEnvironmentVariable($taskKey,$taskSaved[$taskKey],'Process')}}
