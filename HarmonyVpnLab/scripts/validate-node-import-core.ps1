param(
    [ValidateSet('26.6.1', '25.8.3')]
    [string]$CoreVersion = '26.6.1',
    [string]$BuildRoot = '',
    [string]$FixturesPath = '',
    [string]$GoRoot = '',
    [string]$ModuleCache = ''
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskLegacy = $CoreVersion -eq '25.8.3'
if (!$BuildRoot) { $BuildRoot = Join-Path $env:TEMP $(if ($taskLegacy) { 'HarmonyVpnLab-xray' } else { 'HarmonyVpnLab-xray26' }) }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if (!$FixturesPath) { $FixturesPath = Join-Path $taskProject 'build\node-import-core-fixtures.json' }
$FixturesPath = [IO.Path]::GetFullPath($FixturesPath)
if (!$ModuleCache) { $ModuleCache = Join-Path $env:TEMP 'HarmonyVpnLab-xray\cache\modules' }
$ModuleCache = [IO.Path]::GetFullPath($ModuleCache)
if (!$GoRoot) {
    $GoRoot = if ($taskLegacy) { Join-Path $BuildRoot 'bootstrap\go' } else { Join-Path $env:TEMP 'HarmonyVpnLab-go126-port\src-go' }
}
$taskGo = Join-Path $GoRoot 'bin\go.exe'
$taskStage = Join-Path $BuildRoot $(if ($taskLegacy) { 'validation-25.8.3' } else { 'validation26' })
$taskVerification = Join-Path $taskProject $(if ($taskLegacy) { 'build\node-import-core-verification-25.8.3.json' } else { 'build\node-import-core-verification.json' })
$taskRunReport = Join-Path $taskStage ('result-' + [guid]::NewGuid().ToString('N') + '.json')
$taskLibCommit = if ($taskLegacy) { '20d70a98a1eef5227252894fa8e08c9e52a67ad6' } else { '1a6c2baedcf102053c1117ea08b3510d6dada895' }
$taskCoreModuleVersion = if ($taskLegacy) { 'v1.250803.0' } else { 'v1.260327.1-0.20260601021109-94ffd50060f1' }
$taskSource = if ($taskLegacy) { Join-Path $BuildRoot 'sources\libXray' } else { Join-Path $BuildRoot 'stage' }
$taskExpectedReplacement = $null
$taskDeploymentMetadata = $null
if (!(Test-Path -LiteralPath $taskGo)) { throw 'Required Windows Go toolchain is absent; no fallback to a different core is allowed.' }
if (!(Test-Path -LiteralPath $FixturesPath)) { throw 'Generated synthetic fixture file is absent.' }
if (!(Test-Path -LiteralPath $ModuleCache)) { throw 'Existing module cache is absent; this validator never downloads dependencies.' }
if (!(Test-Path -LiteralPath (Join-Path $taskSource 'go.mod'))) { throw 'Selected core dependency manifest is absent; no legacy fallback is allowed.' }
if ($taskLegacy) {
    if ((& git -C $taskSource rev-parse HEAD).Trim() -ne $taskLibCommit) { throw 'Legacy libXray source revision mismatch.' }
} else {
    $taskMetadataPath = Join-Path $taskProject 'build\native\xray26-verification.json'
    if (!(Test-Path -LiteralPath $taskMetadataPath)) { throw 'Current core build verification metadata is absent.' }
    $taskDeploymentMetadata = Get-Content -LiteralPath $taskMetadataPath -Raw | ConvertFrom-Json -AsHashtable
    if ($taskDeploymentMetadata.xrayVersion -ne $CoreVersion -or
        $taskDeploymentMetadata.libXrayCommit -ne $taskLibCommit -or
        $taskDeploymentMetadata.xrayCore.version -ne $taskCoreModuleVersion) {
        throw 'Current core build metadata does not match the selected pinned version.'
    }
    if ($taskDeploymentMetadata.exports.Count -ne 9 -or $taskDeploymentMetadata.exports -notcontains 'CGoConnectionStats') {
        throw 'Current core build metadata must describe the nine-export library with per-instance connection statistics.'
    }
    $taskDeployedLibrary = [IO.Path]::GetFullPath($taskDeploymentMetadata.output.path)
    if (!(Test-Path -LiteralPath $taskDeployedLibrary) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $taskDeployedLibrary).Hash.ToLowerInvariant() -ne $taskDeploymentMetadata.output.sha256) {
        throw 'Current deployed library does not match its standard build metadata.'
    }
    $taskExpectedReplacement = [IO.Path]::GetFullPath($taskDeploymentMetadata.xrayCore.patchedReplacement)
    $taskControllerSource = Join-Path $taskExpectedReplacement 'transport\internet\system_dialer.go'
    if (!(Test-Path -LiteralPath $taskControllerSource)) { throw 'The deployed core replacement source is absent.' }
    $taskControllerText = [IO.File]::ReadAllText($taskControllerSource).Replace("`r`n", "`n")
    $taskControllerHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskControllerText))).ToLowerInvariant()
    $taskProtectionPatch = @($taskDeploymentMetadata.patches | Where-Object { $_.patchedSourceSha256LF })
    if ($taskProtectionPatch.Count -ne 1 -or $taskControllerHash -ne $taskProtectionPatch[0].patchedSourceSha256LF) {
        throw 'The core replacement does not match the recorded deployed controller patch.'
    }
}
New-Item -ItemType Directory -Force -Path $taskStage, (Split-Path $taskVerification) | Out-Null
Copy-Item -LiteralPath (Join-Path $taskProject 'native\xray\validation\main.go') -Destination (Join-Path $taskStage 'main.go')
$taskManifestFile = Join-Path $taskSource 'go.mod'
$taskSumFile = Join-Path $taskSource 'go.sum'
$taskSourceManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $taskManifestFile).Hash.ToLowerInvariant()
$taskSourceSumHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $taskSumFile).Hash.ToLowerInvariant()
$taskManifest = [IO.File]::ReadAllText($taskManifestFile)
if ($taskManifest -notmatch '(?m)^module github.com/xtls/libxray\r?$') { throw 'Unexpected source module identity.' }
$taskManifest = $taskManifest.Replace('module github.com/xtls/libxray', 'module harmonyvpnlab.local/corevalidation')
# Only the validation module's name changes. The current deployed absolute
# core replacement stays read-only; neither source stage nor cache is patched.
[IO.File]::WriteAllText((Join-Path $taskStage 'go.mod'), $taskManifest, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $taskSumFile -Destination (Join-Path $taskStage 'go.sum')
$taskKeys = @('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOMODCACHE','GOCACHE','GOPROXY','GOSUMDB','GOPATH','GOFLAGS','GOWORK')
$taskSaved = @{}
foreach ($taskKey in $taskKeys) { $taskSaved[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
try {
    $env:GOROOT = $null
    $env:GOENV = 'off'
    $env:GOTOOLCHAIN = 'local'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    $env:GOMODCACHE = $ModuleCache
    $env:GOCACHE = Join-Path $taskStage 'cache\go'
    $env:GOPATH = Join-Path $taskStage 'cache\gopath'
    $env:GOPROXY = 'off'
    $env:GOSUMDB = 'off'
    $env:GOFLAGS = ''
    $env:GOWORK = 'off'
    $taskGoVersion = (& $taskGo version).Trim()
    if ($LASTEXITCODE -ne 0 -or (!$taskLegacy -and $taskGoVersion -notmatch '^go version go1\.26\.[0-9]+ windows/amd64$')) {
        throw 'The current validator requires the prepared Windows Go 1.26 toolchain.'
    }
    Push-Location -LiteralPath $taskStage
    try {
        $taskModuleText = (& $taskGo list '-mod=readonly' -m -json 'github.com/xtls/xray-core') -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the selected cached core offline.' }
        $taskModule = $taskModuleText | ConvertFrom-Json -AsHashtable
        if ($taskModule.Version -ne $taskCoreModuleVersion) { throw 'Resolved core module version mismatch.' }
        if ($taskLegacy) {
            if ($taskModule.ContainsKey('Replace')) { throw 'Legacy validation unexpectedly has a module replacement.' }
        } elseif (!$taskModule.ContainsKey('Replace') -or
            [IO.Path]::GetFullPath($taskModule.Replace.Dir) -ne $taskExpectedReplacement) {
            throw 'Current validation must read the exact recorded deployed core replacement.'
        }
        $taskModuleIntegrity = (& $taskGo mod verify) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Cached module integrity verification failed.' }
        & $taskGo build '-mod=readonly' -trimpath '-buildvcs=false' -o (Join-Path $taskStage 'validate-core.exe') .
        if ($LASTEXITCODE -ne 0) { throw 'Offline validator compilation failed; no test configuration was started.' }
    } finally { Pop-Location }
    & (Join-Path $taskStage 'validate-core.exe') -fixtures $FixturesPath -output $taskRunReport -expect-version $CoreVersion
    $taskValidationExit = $LASTEXITCODE
    if (!(Test-Path -LiteralPath $taskRunReport)) { throw 'This validator run produced no fresh report; previous success reports are not reused.' }
    $taskRecord = Get-Content -LiteralPath $taskRunReport -Raw | ConvertFrom-Json -AsHashtable
    if ($taskRecord.coreVersion -ne $CoreVersion -or !$taskRecord.coreVersionMatches) {
        throw 'Runtime core.Version does not match the requested validator target.'
    }
    $taskRecord.host = 'windows/amd64'
    $taskRecord.mode = if ($taskLegacy) { 'explicit-legacy' } else { 'current-deployed-core' }
    $taskRecord.toolchain = $taskGoVersion
    $taskRecord.libXrayDependencyManifestCommit = $taskLibCommit
    $taskRecord.xrayCoreModule = "github.com/xtls/xray-core@$taskCoreModuleVersion"
    $taskRecord.sourceManifestSHA256 = $taskSourceManifestHash
    $taskRecord.sourceGoSumSHA256 = $taskSourceSumHash
    $taskRecord.moduleIntegrity = $taskModuleIntegrity
    $taskRecord.moduleCachePolicy = 'Existing cache only; GOPROXY=off; no source/cache patches; separate validator build cache.'
    $taskRecord.validatorSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskStage 'validate-core.exe')).Hash.ToLowerInvariant()
    $taskRecord.validationSourceSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskStage 'main.go')).Hash.ToLowerInvariant()
    if (!$taskLegacy) {
        $taskRecord.deployedBuildLibrarySHA256 = $taskDeploymentMetadata.output.sha256
        $taskRecord.deployedBuildMetadataPath = $taskMetadataPath
        $taskRecord.deployedAbiExportCount = $taskDeploymentMetadata.exports.Count
        $taskRecord.coreReplacement = $taskExpectedReplacement
        $taskRecord.coreControllerSourceSHA256LF = $taskControllerHash
    }
    $taskRecord | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM -LiteralPath $taskVerification
    Write-Output ("Validated core {0}: {1}/{2}; core started={3}; blocked network attempts={4}." -f $CoreVersion, $taskRecord.passedCount, $taskRecord.sampleCount, $taskRecord.coreInstanceStarted, $taskRecord.blockedHttpOrDnsAttempts)
    if ($taskValidationExit -ne 0) { throw 'Static core validation failed; inspect fixed failure codes in the fresh verification report.' }
} finally {
    foreach ($taskKey in $taskKeys) { [Environment]::SetEnvironmentVariable($taskKey, $taskSaved[$taskKey], 'Process') }
}
