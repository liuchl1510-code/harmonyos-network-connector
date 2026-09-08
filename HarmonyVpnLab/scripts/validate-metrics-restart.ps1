param(
    [string]$GoRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-go126-port\src-go'),
    [string]$ModuleCache = (Join-Path $env:TEMP 'HarmonyVpnLab-xray\cache\modules'),
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-metrics-restart-validation')
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskNative = Join-Path $taskProject 'native\xray26'
$taskSource = Join-Path $taskNative 'metrics-restart-check\main.go'
$taskLock = Get-Content -Raw -LiteralPath (Join-Path $taskNative 'sources.lock.json') | ConvertFrom-Json
$taskGo = Join-Path $GoRoot 'bin\go.exe'
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
$taskManifest = [IO.File]::ReadAllText((Join-Path $taskNative 'upstream\go.mod')).Replace('module github.com/xtls/libxray', 'module harmonyvpnlab.local/metricsrestartvalidation')
[IO.File]::WriteAllText((Join-Path $BuildRoot 'go.mod'), $taskManifest, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $taskNative 'upstream\go.sum') -Destination $BuildRoot
Copy-Item -LiteralPath $taskSource -Destination (Join-Path $BuildRoot 'main.go')
$taskKeys = @('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOMODCACHE','GOCACHE','GOPROXY','GOSUMDB','GOPATH','GOFLAGS','GOWORK')
$taskSaved = @{}; foreach ($taskKey in $taskKeys) { $taskSaved[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
try {
    $env:GOROOT=$GoRoot; $env:GOENV='off'; $env:GOTOOLCHAIN='local'; $env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
    $env:GOFLAGS=''; $env:GOWORK='off'; $env:GOMODCACHE=$ModuleCache
    $env:GOCACHE=Join-Path $env:TEMP 'HarmonyVpnLab-connection-core-validation\cache'
    $env:GOPATH=Join-Path $BuildRoot 'gopath'; $env:GOPROXY='off'; $env:GOSUMDB='off'
    Push-Location $BuildRoot
    try {
        $taskVersion = (& $taskGo version) -join ''
        if ($taskVersion -notmatch '^go version go1\.26\.[0-9]+ windows/amd64$') { throw 'Expected prepared Windows Go 1.26 compiler.' }
        $taskModule = ((& $taskGo list '-mod=readonly' -m -json github.com/xtls/xray-core) -join "`n") | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $taskModule.Version -ne $taskLock.xrayCore.moduleVersion -or $taskModule.Replace) { throw 'Expected unmodified pinned core for metrics reproduction.' }
        $taskIntegrity = (& $taskGo mod verify) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Cached dependency integrity failed.' }
        & $taskGo build '-mod=readonly' -trimpath '-buildvcs=false' -o (Join-Path $BuildRoot 'metrics-restart.exe') .
        if ($LASTEXITCODE -ne 0) { throw 'Metrics restart audit build failed.' }
    } finally { Pop-Location }
    foreach ($taskMode in @('metrics', 'no-metrics')) {
        $taskFresh = Join-Path $BuildRoot ([guid]::NewGuid().ToString('N') + '.json')
        & (Join-Path $BuildRoot 'metrics-restart.exe') -mode $taskMode -output $taskFresh
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $taskFresh)) { throw 'No fresh successful reproduction report.' }
        $taskReport = Get-Content -Raw -LiteralPath $taskFresh | ConvertFrom-Json -AsHashtable
        if ($taskReport.coreVersion -ne '26.6.1' -or $taskReport.remoteNetworkUsed -or $taskReport.privateConfigRead) { throw 'Unexpected reproduction scope.' }
        if ($taskMode -eq 'metrics') {
            if (!$taskReport.firstStartOk -or !$taskReport.firstLoopbackMetricsOk -or !$taskReport.firstStopOk -or
                !$taskReport.metricsListenerStillBoundAfterStop -or $taskReport.secondStartPanic.Trim() -ne 'Reuse of exported var name: stats') {
                throw 'Original metrics did not expose the expected panic and listener leak.'
            }
            $taskName = 'metrics-restart-original-negative.json'
        } else {
            if ($taskReport.threeRestartCycles.Count -ne 3) { throw 'Expected three independent core instances.' }
            foreach ($taskCycle in $taskReport.threeRestartCycles) {
                if (!$taskCycle.newStatsManager -or !$taskCycle.stopOk -or $taskCycle.initialValue -ne 0 -or
                    $taskCycle.updatedValue -ne $taskCycle.iteration*100) { throw 'Core instance statistics did not reset.' }
            }
            $taskName = 'metrics-restart-without-metrics-positive.json'
        }
        $taskReport.checkedAtUtc = [DateTime]::UtcNow.ToString('o')
        $taskReport.coreModule = 'github.com/xtls/xray-core@' + $taskModule.Version
        $taskReport.toolchain = $taskVersion
        $taskReport.moduleIntegrity = $taskIntegrity
        $taskReport.sourceSha256 = (Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant()
        $taskReport | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskProject ('build\native\' + $taskName))
    }
} finally { foreach ($taskKey in $taskKeys) { [Environment]::SetEnvironmentVariable($taskKey, $taskSaved[$taskKey], 'Process') } }
