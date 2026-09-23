param(
    [string]$GoRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-go126-port\src-go'),
    [string]$ModuleCache = (Join-Path $env:TEMP 'HarmonyVpnLab-xray\cache\modules'),
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-whitelist-core-validation'),
    [string]$AssetsRoot = ''
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskFixtures = Join-Path $taskProject 'build\whitelist-core-fixtures.json'
$taskOutput = Join-Path $taskProject 'build\whitelist-core-verification.json'
$taskNative = Join-Path $taskProject 'native\xray26'
$taskLock = Get-Content -Raw -LiteralPath (Join-Path $taskNative 'sources.lock.json') | ConvertFrom-Json
$taskGo = Join-Path $GoRoot 'bin\go.exe'
if (!$AssetsRoot) { $AssetsRoot = Join-Path $taskProject 'entry\src\main\resources\rawfile' }
if (!(Test-Path -LiteralPath $taskFixtures)) { throw 'Generate synthetic build/whitelist-core-fixtures.json first.' }
if (!(Test-Path -LiteralPath $taskGo)) { throw 'Prepared Windows Go 1.26 toolchain is required.' }
foreach ($taskAsset in @('geosite.dat', 'geoip.dat')) {
    if (!(Test-Path -LiteralPath (Join-Path $AssetsRoot $taskAsset))) { throw ('Missing packaged resource: ' + $taskAsset) }
}
$taskInputPaths = @($taskFixtures, (Join-Path $AssetsRoot 'geosite.dat'), (Join-Path $AssetsRoot 'geoip.dat'))
$taskInputHashes = @($taskInputPaths | ForEach-Object { (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant() })
$taskRun = Join-Path $BuildRoot ('run-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $taskRun | Out-Null
$taskManifest = [IO.File]::ReadAllText((Join-Path $taskNative 'upstream\go.mod')).Replace('module github.com/xtls/libxray', 'module harmonyvpnlab.local/whitelistvalidation')
[IO.File]::WriteAllText((Join-Path $taskRun 'go.mod'), $taskManifest, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $taskNative 'upstream\go.sum') -Destination $taskRun
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'validation\whitelist-core-main.go') -Destination (Join-Path $taskRun 'main.go')
$taskKeys = @('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOMODCACHE','GOCACHE','GOPROXY','GOSUMDB','GOPATH','GOFLAGS','GOWORK')
$taskSaved = @{}
foreach ($taskKey in $taskKeys) { $taskSaved[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
try {
    $env:GOROOT = $GoRoot; $env:GOENV = 'off'; $env:GOTOOLCHAIN = 'local'; $env:GOOS = 'windows'; $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'; $env:GOFLAGS = ''; $env:GOWORK = 'off'; $env:GOMODCACHE = $ModuleCache
    $env:GOCACHE = Join-Path $BuildRoot 'cache'; $env:GOPATH = Join-Path $BuildRoot 'gopath'; $env:GOPROXY = 'off'; $env:GOSUMDB = 'off'
    Push-Location $taskRun
    try {
        $taskVersion = (& $taskGo version) -join ''
        if ($taskVersion -notmatch '^go version go1\.26\.[0-9]+ windows/amd64$') { throw 'Expected prepared Windows Go 1.26 toolchain.' }
        $taskModule = ((& $taskGo list '-mod=readonly' -m -json github.com/xtls/xray-core) -join "`n") | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $taskModule.Version -ne $taskLock.xrayCore.moduleVersion -or $taskModule.Replace) { throw 'Validation requires the exact pinned real Xray core module.' }
        $taskIntegrity = (& $taskGo mod verify) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Cached dependency integrity failed.' }
        & $taskGo build '-mod=readonly' -trimpath '-buildvcs=false' -o (Join-Path $taskRun 'validate-whitelist.exe') .
        if ($LASTEXITCODE -ne 0) { throw 'Offline whitelist validator build failed.' }
    } finally { Pop-Location }
    $taskFresh = Join-Path $taskRun 'verification.json'
    & (Join-Path $taskRun 'validate-whitelist.exe') -fixtures $taskFixtures -assets $AssetsRoot -output $taskFresh -expect-version $taskLock.xrayCore.reportedVersion
    $taskExit = $LASTEXITCODE
    if (!(Test-Path -LiteralPath $taskFresh)) { throw 'No fresh real-core whitelist validation report.' }
    $taskReport = Get-Content -Raw -LiteralPath $taskFresh | ConvertFrom-Json -AsHashtable
    $taskReport.coreModule = 'github.com/xtls/xray-core@' + $taskModule.Version
    $taskReport.toolchain = $taskVersion
    $taskReport.moduleIntegrity = $taskIntegrity
    $taskReport.validatorSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskRun 'main.go')).Hash.ToLowerInvariant()
    $taskReport.controllerPatchScope = 'Unmodified pinned core routing only; HarmonyOS socket-controller runtime patch is not executed.'
    $taskReport.inputFilesUnchanged = $true
    for ($taskIndex = 0; $taskIndex -lt $taskInputPaths.Count; $taskIndex++) {
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $taskInputPaths[$taskIndex]).Hash.ToLowerInvariant() -ne $taskInputHashes[$taskIndex]) { $taskReport.inputFilesUnchanged = $false }
    }
    $taskReport | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8NoBOM -LiteralPath $taskOutput
    if ($taskExit -ne 0 -or $taskReport.coreVersion -ne $taskLock.xrayCore.reportedVersion -or !$taskReport.inputFilesUnchanged) { throw 'Real-core whitelist route validation failed; inspect the fresh build report.' }
    # A valid config must not count as a route assertion pass. Deliberately give
    # one case an impossible tag and require the exact mismatch verdict.
    $taskNegativeSamples = @(Get-Content -Raw -LiteralPath $taskFixtures | ConvertFrom-Json -AsHashtable)
    $taskNegativeSamples[0].cases[0].expectedTag = 'negative-impossible-outbound'
    $taskNegativeFixture = Join-Path $taskRun 'negative-fixture.json'
    $taskNegativeSamples | ConvertTo-Json -Depth 12 -AsArray | Set-Content -Encoding utf8NoBOM -LiteralPath $taskNegativeFixture
    $taskNegativeOutput = Join-Path $taskRun 'negative-verification.json'
    & (Join-Path $taskRun 'validate-whitelist.exe') -fixtures $taskNegativeFixture -assets $AssetsRoot -output $taskNegativeOutput -expect-version $taskLock.xrayCore.reportedVersion
    $taskNegativeExit = $LASTEXITCODE
    $taskNegative = Get-Content -Raw -LiteralPath $taskNegativeOutput | ConvertFrom-Json -AsHashtable
    if ($taskNegativeExit -eq 0 -or $taskNegative.results[0].cases[0].failure -ne 'ROUTE_TAG_MISMATCH') { throw 'Incorrect expected-route negative control was not rejected.' }
    $taskNegative.expectedFailure = $true
    $taskNegative | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskProject 'build\whitelist-core-negative-control.json')
    Write-Output 'Real-core route assertions passed; incorrect expected-route negative control rejected. No network or core instance was started.'
} finally {
    foreach ($taskKey in $taskKeys) { [Environment]::SetEnvironmentVariable($taskKey, $taskSaved[$taskKey], 'Process') }
}
