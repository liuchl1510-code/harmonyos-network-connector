param(
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray')
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskPinnedCommit = '20d70a98a1eef5227252894fa8e08c9e52a67ad6'
$taskCoreVersion = 'v1.250803.0'
$taskGo = Join-Path $BuildRoot 'bootstrap\go\bin\go.exe'
$taskManifestSource = Join-Path $BuildRoot 'sources\libXray'
$taskStage = Join-Path $BuildRoot 'host-xray-cli'
$taskOutput = Join-Path $taskProject 'build\host'
$taskExe = Join-Path $taskOutput 'xray.exe'
if (!(Test-Path -LiteralPath $taskGo)) { throw 'Official Go bootstrap is absent; run build-xray.ps1 first.' }
if ((& git -C $taskManifestSource rev-parse HEAD).Trim() -ne $taskPinnedCommit) {
    throw 'Pinned libXray dependency manifest revision mismatch.'
}
New-Item -ItemType Directory -Force -Path $taskStage, $taskOutput | Out-Null
# Compile the upstream CLI main from the immutable module cache. In particular,
# do not use stage-xray-core, the OHOS compiler, or the app's controller wrapper.
$taskManifest = [IO.File]::ReadAllText((Join-Path $taskManifestSource 'go.mod'))
if ($taskManifest -match '(?m)^replace\s') { throw 'Unexpected module replacement in the upstream manifest.' }
$taskManifest = $taskManifest.Replace('module github.com/xtls/libxray', 'module harmonyvpnlab.local/hostxray')
[IO.File]::WriteAllText((Join-Path $taskStage 'go.mod'), $taskManifest, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $taskManifestSource 'go.sum') -Destination (Join-Path $taskStage 'go.sum')
$taskKeys = @('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOMODCACHE','GOCACHE','GOPROXY','GOSUMDB','GOPATH','GOFLAGS')
$taskSaved = @{}
foreach ($taskKey in $taskKeys) { $taskSaved[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
try {
    $env:GOROOT = $null
    $env:GOENV = 'off'
    $env:GOTOOLCHAIN = 'local'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    $env:GOMODCACHE = Join-Path $BuildRoot 'cache\modules'
    $env:GOCACHE = Join-Path $BuildRoot 'cache\validation-go'
    $env:GOPATH = Join-Path $BuildRoot 'cache\gopath'
    $env:GOPROXY = 'off'
    $env:GOSUMDB = 'off'
    $env:GOFLAGS = ''
    $taskGoVersion = (& $taskGo version).Trim()
    if ($LASTEXITCODE -ne 0 -or $taskGoVersion -ne 'go version go1.24.6 windows/amd64') {
        throw 'Expected the official Windows Go 1.24.6 bootstrap.'
    }
    Push-Location -LiteralPath $taskStage
    try {
        $taskCoreJson = (& $taskGo list -m -json 'github.com/xtls/xray-core') -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve the cached core version offline.' }
        $taskCore = $taskCoreJson | ConvertFrom-Json
        if ($taskCore.Version -ne $taskCoreVersion -or $taskCore.Replace) {
            throw 'The Windows A/B executable must use the unmodified pinned core module.'
        }
        $taskIntegrity = (& $taskGo mod verify) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Cached module integrity verification failed.' }
        & $taskGo build '-mod=readonly' -trimpath '-buildvcs=false' -ldflags '-s -w' -o $taskExe 'github.com/xtls/xray-core/main'
        if ($LASTEXITCODE -ne 0) { throw 'Offline Windows Xray CLI build failed.' }
    } finally { Pop-Location }
    $taskVersionOutput = (& $taskExe version) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $taskVersionOutput -notmatch '^Xray 25\.8\.3\b') {
        throw 'Built executable did not report Xray 25.8.3.'
    }
    $taskRecord = [ordered]@{
        builtAt = [DateTime]::UtcNow.ToString('o')
        xrayVersion = '25.8.3'
        coreModule = "github.com/xtls/xray-core@$taskCoreVersion"
        toolchain = $taskGoVersion
        host = 'windows/amd64'
        libXrayDependencyManifestCommit = $taskPinnedCommit
        coreSource = 'unmodified upstream module cache; no application socket controller'
        moduleIntegrity = $taskIntegrity
        executableSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $taskExe).Hash.ToLowerInvariant()
        networkDuringBuild = 'disabled: GOPROXY=off, GOSUMDB=off, GOTOOLCHAIN=local'
    }
    $taskRecord | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskOutput 'build-verification.json') -Encoding utf8NoBOM
    Write-Output 'Built Windows Xray 25.8.3 CLI using official Go 1.24.6; no node configuration was read or started.'
} finally {
    foreach ($taskKey in $taskKeys) { [Environment]::SetEnvironmentVariable($taskKey, $taskSaved[$taskKey], 'Process') }
}
