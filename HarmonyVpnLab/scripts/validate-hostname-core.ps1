param(
    [string]$GoRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-go126-port\src-go'),
    [string]$ModuleCache = (Join-Path $env:TEMP 'HarmonyVpnLab-xray\cache\modules'),
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-hostname-core-validation')
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskNative = Join-Path $taskProject 'native\xray26'
$taskFixtures = Join-Path $taskProject 'build\connection-hostname-fixtures.json'
$taskSource = Join-Path $taskNative 'hostname-check\main.go'
$taskOutput = Join-Path $taskProject 'build\hostname-core-verification.json'
$taskLock = Get-Content -Raw -LiteralPath (Join-Path $taskNative 'sources.lock.json') | ConvertFrom-Json
$taskGo = Join-Path $GoRoot 'bin\go.exe'
if (!(Test-Path -LiteralPath $taskFixtures)) { throw 'Run test-connection-core.cjs to generate synthetic hostname fixtures first.' }
if (!(Test-Path -LiteralPath $taskGo)) { throw 'Prepared Go 1.26 compiler is required.' }
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
$taskManifest = [IO.File]::ReadAllText((Join-Path $taskNative 'upstream\go.mod')).Replace('module github.com/xtls/libxray', 'module harmonyvpnlab.local/hostnamevalidation')
[IO.File]::WriteAllText((Join-Path $BuildRoot 'go.mod'), $taskManifest, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $taskNative 'upstream\go.sum') -Destination $BuildRoot
Copy-Item -LiteralPath $taskSource -Destination (Join-Path $BuildRoot 'main.go')
$taskKeys = @('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOMODCACHE','GOCACHE','GOPROXY','GOSUMDB','GOPATH','GOFLAGS','GOWORK')
$taskSaved = @{}; foreach ($taskKey in $taskKeys) { $taskSaved[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
try {
    $env:GOROOT = $GoRoot; $env:GOENV = 'off'; $env:GOTOOLCHAIN = 'local'; $env:GOOS = 'windows'; $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'; $env:GOFLAGS = ''; $env:GOWORK = 'off'; $env:GOMODCACHE = $ModuleCache
    $env:GOCACHE = Join-Path $env:TEMP 'HarmonyVpnLab-connection-core-validation\cache'
    $env:GOPATH = Join-Path $BuildRoot 'gopath'; $env:GOPROXY = 'off'; $env:GOSUMDB = 'off'
    Push-Location $BuildRoot
    try {
        $taskVersion = (& $taskGo version) -join ''
        if ($taskVersion -notmatch '^go version go1\.26\.[0-9]+ windows/amd64$') { throw 'Expected prepared Windows Go 1.26 compiler.' }
        $taskModule = ((& $taskGo list '-mod=readonly' -m -json github.com/xtls/xray-core) -join "`n") | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $taskModule.Version -ne $taskLock.xrayCore.moduleVersion -or $taskModule.Replace) { throw 'Expected the pinned unmodified 26.6.1 core.' }
        $taskIntegrity = (& $taskGo mod verify) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Cached dependency integrity failed.' }
        & $taskGo build '-mod=readonly' -trimpath '-buildvcs=false' -o (Join-Path $BuildRoot 'validate-hostname.exe') .
        if ($LASTEXITCODE -ne 0) { throw 'Offline hostname validator build failed.' }
    } finally { Pop-Location }
    $taskFresh = Join-Path $BuildRoot ('result-' + [guid]::NewGuid().ToString('N') + '.json')
    & (Join-Path $BuildRoot 'validate-hostname.exe') -fixtures $taskFixtures -output $taskFresh
    $taskExit = $LASTEXITCODE
    if (!(Test-Path -LiteralPath $taskFresh)) { throw 'No fresh hostname verification result.' }
    $taskReport = Get-Content -Raw -LiteralPath $taskFresh | ConvertFrom-Json -AsHashtable
    $taskReport.coreModule = 'github.com/xtls/xray-core@' + $taskModule.Version
    $taskReport.toolchain = $taskVersion
    $taskReport.moduleIntegrity = $taskIntegrity
    $taskReport.validatorSourceSha256 = (Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskReport.configSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $taskProject 'entry\src\main\ets\model\ConnectionConfig.ets') -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskReport.bootstrapSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $taskProject 'entry\src\main\ets\model\NodeBootstrap.ets') -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskReport | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8NoBOM -LiteralPath $taskOutput
    if ($taskExit -ne 0 -or $taskReport.coreVersion -ne '26.6.1' -or $taskReport.passedCount -ne 4) { throw 'Hostname real-core verification failed.' }
    # The application rejects both orders. These synthetic mutations bypass its
    # builder to prove why preserving a case-variant key would defeat ForceIPv4.
    foreach ($taskOrder in @('alias-last', 'canonical-last')) {
        $taskCaseFixtures = Join-Path $taskProject ('build\connection-hostname-' + $taskOrder + '-fixtures.json')
        if (!(Test-Path -LiteralPath $taskCaseFixtures)) { throw 'Generate fresh hostname case-order fixtures first.' }
        $taskCaseFresh = Join-Path $BuildRoot ('case-' + [guid]::NewGuid().ToString('N') + '.json')
        $taskCaseLog = Join-Path $BuildRoot ('case-' + $taskOrder + '.log')
        & (Join-Path $BuildRoot 'validate-hostname.exe') -fixtures $taskCaseFixtures -output $taskCaseFresh *> $taskCaseLog
        $taskCaseExit = $LASTEXITCODE
        if (!(Test-Path -LiteralPath $taskCaseFresh)) { throw 'No fresh case-order control report.' }
        $taskCaseReport = Get-Content -Raw -LiteralPath $taskCaseFresh | ConvertFrom-Json -AsHashtable
        if ($taskOrder -eq 'alias-last') {
            if ($taskCaseExit -eq 0 -or $taskCaseReport.passedCount -ne 3 -or $taskCaseReport.results[0].failure -ne 'FORCE_IPV4_PROTO') {
                throw 'Case-variant alias no longer exposes the expected ForceIPv4 overwrite; inspect the control.'
            }
        } elseif ($taskCaseExit -ne 0 -or $taskCaseReport.passedCount -ne 4) {
            throw 'Canonical-last control did not retain ForceIPv4.'
        }
        $taskCaseReport.caseOrder = $taskOrder
        $taskCaseReport.expectedFailure = $taskOrder -eq 'alias-last'
        $taskCaseReport.applicationPolicy = 'Both key orders are rejected before core startup; this fixture deliberately bypasses the application builder.'
        $taskCaseReport.coreModule = $taskReport.coreModule
        $taskCaseReport.validatorSourceSha256 = $taskReport.validatorSourceSha256
        $taskCaseReport | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskProject ('build\hostname-core-' + $taskOrder + '-control.json'))
        Write-Output ('Real-core JSON case-order control verified: ' + $taskOrder)
    }
} finally { foreach ($taskKey in $taskKeys) { [Environment]::SetEnvironmentVariable($taskKey, $taskSaved[$taskKey], 'Process') } }
