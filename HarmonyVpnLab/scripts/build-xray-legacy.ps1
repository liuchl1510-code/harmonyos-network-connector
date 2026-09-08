param(
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray'),
    [string]$PythonPath = 'C:\Python314\python.exe',
    [string]$OutputPath = '',
    [string]$EvidencePath = ''
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskNative = Join-Path $taskProject 'native\xray'
if ($BuildRoot -match '[^\x00-\x7F]') { throw 'BuildRoot must be ASCII for this Windows cross-build.' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
$taskOhosCommit = '302a5306b6fad2f47196360b82561d1db1f954cf'
$taskLibCommit = '20d70a98a1eef5227252894fa8e08c9e52a67ad6'
$taskBootstrapSha = '4fbc8af2cfca9e5059019b5150a426eb78e1e57718bf08f0e52b1c942a2782bf'
$taskSources = Join-Path $BuildRoot 'sources'
$taskOhosGo = Join-Path $taskSources 'ohos-go'
$taskLibSource = Join-Path $taskSources 'libXray'
$taskBootstrap = Join-Path $BuildRoot 'bootstrap\go'
$taskZip = Join-Path $BuildRoot 'go1.24.6.windows-amd64.zip'
$taskStage = Join-Path $BuildRoot 'stage'
$taskCoreStage = Join-Path $BuildRoot 'stage-xray-core'
$taskSdkNative = Join-Path $DevEcoPath 'sdk\default\openharmony\native'
$taskClang = Join-Path $taskSdkNative 'llvm\bin\clang.exe'
$taskReadElf = Join-Path $taskSdkNative 'llvm\bin\llvm-readelf.exe'
$taskNm = Join-Path $taskSdkNative 'llvm\bin\llvm-nm.exe'
$taskGo = Join-Path $taskOhosGo 'bin\go.exe'
$taskOutput = Join-Path $taskProject 'entry\libs\arm64-v8a\libxray.so'
$taskEvidence = Join-Path $taskProject 'build\native\xray-verification.json'
if ($OutputPath) { $taskOutput = [IO.Path]::GetFullPath($OutputPath) }
if ($EvidencePath) { $taskEvidence = [IO.Path]::GetFullPath($EvidencePath) }
if (!(Test-Path -LiteralPath $taskClang)) { throw "OHOS clang not found: $taskClang" }
New-Item -ItemType Directory -Force -Path $taskSources, $taskStage, (Split-Path $taskOutput), (Split-Path $taskEvidence) | Out-Null

function Invoke-CheckedGit([string[]]$GitArgs) {
    & git -c http.sslBackend=openssl @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git failed (exit $LASTEXITCODE)." }
}
function Verify-PinnedSource([string]$Path, [string]$Expected) {
    $taskHead = (& git -C $Path rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $taskHead -ne $Expected) { throw "Unexpected source revision in $Path : $taskHead" }
}

# The bootstrap is an official Go archive, checked against go.dev's published SHA256.
if (!(Test-Path -LiteralPath (Join-Path $taskBootstrap 'bin\go.exe'))) {
    if (!(Test-Path -LiteralPath $taskZip)) {
        Write-Output 'Downloading official Windows Go 1.24.6 bootstrap (87 MB).'
        & $PythonPath -c 'import sys,urllib.request; urllib.request.urlretrieve("https://go.dev/dl/go1.24.6.windows-amd64.zip",sys.argv[1])' $taskZip
        if ($LASTEXITCODE -ne 0) { throw 'Bootstrap download failed.' }
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $taskZip).Hash.ToLowerInvariant() -ne $taskBootstrapSha) { throw 'Go bootstrap SHA256 mismatch.' }
    & $PythonPath -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' $taskZip (Join-Path $BuildRoot 'bootstrap')
    if ($LASTEXITCODE -ne 0) { throw 'Bootstrap extraction failed.' }
}
if (!(Test-Path -LiteralPath (Join-Path $taskOhosGo '.git'))) {
    Invoke-CheckedGit @('clone', '--depth', '1', '--branch', 'release-branch.go1.24', 'https://gitcode.com/openharmony-sig/ohos_golang_go.git', $taskOhosGo)
    if ((& git -C $taskOhosGo rev-parse HEAD).Trim() -ne $taskOhosCommit) {
        Invoke-CheckedGit @('-C', $taskOhosGo, 'fetch', '--depth', '1', 'origin', $taskOhosCommit)
        Invoke-CheckedGit @('-C', $taskOhosGo, 'checkout', '--detach', $taskOhosCommit)
    }
}
Verify-PinnedSource $taskOhosGo $taskOhosCommit
if (!(Test-Path -LiteralPath (Join-Path $taskLibSource '.git'))) {
    Invoke-CheckedGit @('clone', 'https://github.com/XTLS/libXray.git', $taskLibSource)
    Invoke-CheckedGit @('-C', $taskLibSource, 'checkout', '--detach', $taskLibCommit)
}
Verify-PinnedSource $taskLibSource $taskLibCommit

# Environment changes are process-local and restored when this script finishes.
$taskEnvKeys = @('GOROOT_BOOTSTRAP','GOROOT','GOTOOLCHAIN','GOENV','GOOS','GOARCH','CGO_ENABLED','GOCACHE','GOMODCACHE','GOPATH','CC','CXX','CGO_CFLAGS','CGO_CXXFLAGS','CGO_LDFLAGS')
$taskSavedEnv = @{}
foreach ($taskKey in $taskEnvKeys) { $taskSavedEnv[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
try {
    $env:GOROOT_BOOTSTRAP = $taskBootstrap
    $env:GOROOT = $null
    $env:GOTOOLCHAIN = 'local'
    $env:GOENV = 'off'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    $env:GOCACHE = Join-Path $BuildRoot 'cache\go'
    $env:GOMODCACHE = Join-Path $BuildRoot 'cache\modules'
    $env:GOPATH = Join-Path $BuildRoot 'cache\gopath'
    if (!(Test-Path -LiteralPath $taskGo)) {
        Write-Output 'Building pinned OpenHarmony Go compiler for the Windows host.'
        Push-Location -LiteralPath (Join-Path $taskOhosGo 'src')
        try {
            & .\make.bat
            if ($LASTEXITCODE -ne 0) { throw "OpenHarmony Go bootstrap failed ($LASTEXITCODE)." }
        } finally { Pop-Location }
    }
    $taskGoVersion = (& $taskGo version).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Built Go compiler cannot run.' }

    # Copy original upstream source into a separate staging tree; never patch module cache.
    Get-ChildItem -LiteralPath $taskLibSource -Recurse -File | ForEach-Object {
        $taskRelative = [IO.Path]::GetRelativePath($taskLibSource, $_.FullName)
        if ($taskRelative -match '^\.git([\\/]|$)') { return }
        $taskDestination = Join-Path $taskStage $taskRelative
        New-Item -ItemType Directory -Force -Path (Split-Path $taskDestination) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $taskDestination
    }
    Get-ChildItem -LiteralPath $taskStage -Filter '*.go' -File | ForEach-Object {
        $taskText = [IO.File]::ReadAllText($_.FullName)
        $taskText = [regex]::Replace($taskText, '(?m)^package libXray\r?$', 'package main')
        [IO.File]::WriteAllText($_.FullName, $taskText, [Text.UTF8Encoding]::new($false))
    }
    Copy-Item -LiteralPath (Join-Path $taskNative 'main.go.template') -Destination (Join-Path $taskStage 'main.go')
    Copy-Item -LiteralPath (Join-Path $taskNative 'libxray.exports') -Destination (Join-Path $BuildRoot 'libxray.exports')
    # core.StartInstance in StartXrayFromJSON already starts the instance. The
    # pinned wrapper must not call Start again (metrics would bind twice).
    & $PythonPath (Join-Path $taskNative 'patches\apply_start_once.py') $taskStage
    if ($LASTEXITCODE -ne 0) { throw 'Audited single-start source patch failed validation.' }
    Push-Location -LiteralPath $taskStage
    try {
        # Upstream asks for 1.24.6; this OHOS fork is 1.24.5. This explicit local
        # manifest change is validated by compiling all imported core packages.
        & $taskGo mod edit '-go=1.24.5'
        if ($LASTEXITCODE -ne 0) { throw 'go.mod adaptation failed.' }
        $taskCoreModule = (& $taskGo mod download -json 'github.com/xtls/xray-core@v1.250803.0') -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Pinned Xray-core module lookup failed.' }
        $taskCoreMetadata = $taskCoreModule | ConvertFrom-Json
        $taskCoreSource = $taskCoreMetadata.Dir
        $taskOriginalModuleVerification = (& $taskGo mod verify) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Original upstream module integrity verification failed.' }
        # Patch a private fresh copy, never the immutable shared module cache.
        & $PythonPath (Join-Path $taskNative 'patches\apply_fail_closed.py') $taskCoreSource $taskCoreStage
        if ($LASTEXITCODE -ne 0) { throw 'Audited fail-closed socket controller patch failed validation.' }
        & $taskGo mod edit ('-replace=github.com/xtls/xray-core=' + $taskCoreStage.Replace('\','/'))
        if ($LASTEXITCODE -ne 0) { throw 'Staged Xray-core replacement failed.' }
        $taskValidationStage = Join-Path $taskStage 'harmony_socket_validation'
        New-Item -ItemType Directory -Force -Path $taskValidationStage | Out-Null
        Copy-Item -LiteralPath (Join-Path $taskNative 'validation\socket_protect_test.go.template') -Destination (Join-Path $taskValidationStage 'socket_protect_test.go')
        # Synthetic controllers use loopback only and the actual libXray module
        # graph (core's own tests select older, separately pinned dependencies).
        $taskProtectionTests = (& $taskGo test -count=1 -run '^TestHarmonySocketProtection' -v ./harmony_socket_validation 2>&1) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw "Socket protection host verification failed:`n$taskProtectionTests" }
        Write-Output $taskProtectionTests
        # Negative control: these rejection tests must expose the original core's
        # swallowed errors. Use another manifest so the build replacement stays
        # untouched, and keep every test address on the Windows loopback device.
        $taskBaselineStage = Join-Path $BuildRoot 'validation-unpatched'
        New-Item -ItemType Directory -Force -Path $taskBaselineStage | Out-Null
        Copy-Item -LiteralPath (Join-Path $taskStage 'go.mod'), (Join-Path $taskStage 'go.sum'), (Join-Path $taskValidationStage 'socket_protect_test.go') -Destination $taskBaselineStage
        Push-Location -LiteralPath $taskBaselineStage
        try {
            & $taskGo mod edit ('-replace=github.com/xtls/xray-core=' + $taskCoreSource.Replace('\','/'))
            if ($LASTEXITCODE -ne 0) { throw 'Unpatched negative-control manifest setup failed.' }
            $taskProtectionBaseline = (& $taskGo test -count=1 -run '^TestHarmonySocketProtection/(tcp|udp)/reject$' -v . 2>&1) -join "`n"
            if ($LASTEXITCODE -eq 0 -or ([regex]::Matches($taskProtectionBaseline,'rejected socket continued: conn=true err=<nil> nextControllers=1')).Count -ne 2) {
                throw "Unpatched negative control did not expose both expected errors:`n$taskProtectionBaseline"
            }
            Write-Output 'Unpatched negative control confirmed: both TCP and UDP incorrectly continue after controller rejection.'
        } finally { Pop-Location }
        $env:GOOS = 'openharmony'
        $env:GOARCH = 'arm64'
        $env:CGO_ENABLED = '1'
        $taskSysroot = (Join-Path $taskSdkNative 'sysroot').Replace('\','/')
        $taskClangSlash = $taskClang.Replace('\','/')
        $env:CC = '"' + $taskClangSlash + '" --target=aarch64-linux-ohos "--sysroot=' + $taskSysroot + '" -D__MUSL__'
        $env:CXX = $env:CC + ' -x c++'
        $env:CGO_CFLAGS = '-O2 -g -ftls-model=global-dynamic'
        $env:CGO_CXXFLAGS = '-O2 -g -ftls-model=global-dynamic'
        $env:CGO_LDFLAGS = ''
        $taskExportPath = (Join-Path $BuildRoot 'libxray.exports').Replace('\','/')
        $taskLdFlags = '-s -w -checklinkname=0 -linkmode external -extldflags "-Wl,--version-script=' + $taskExportPath + ' -Wl,-z,lazy"'
        $taskBuiltSo = Join-Path $BuildRoot 'libxray.so'
        Write-Output 'Cross-compiling libXray and Xray-core for openharmony/arm64.'
        & $taskGo build -trimpath "-ldflags=$taskLdFlags" -buildmode=c-shared -o $taskBuiltSo .
        if ($LASTEXITCODE -ne 0) { throw "Xray cross-build failed ($LASTEXITCODE)." }
        $taskModuleInfo = (& $taskGo version -m $taskBuiltSo) -join "`n"
        $taskModuleVerification = (& $taskGo mod verify) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Downloaded Go module verification failed.' }
    } finally { Pop-Location }
    $taskElf = (& $taskReadElf -h -l -d -r $taskBuiltSo) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'ELF inspection failed.' }
    if ($taskElf -notmatch 'AArch64' -or $taskElf -notmatch 'R_AARCH64_TLSDESC' -or $taskElf -notmatch ' TLS ') { throw 'Expected arm64 dynamic TLS ELF characteristics are missing.' }
    if ($taskElf -match 'R_AARCH64_TLS_TPREL64') { throw 'Initial-exec TLS relocation found; do not ship this library for dlopen on musl.' }
    $taskExports = (& $taskNm -D --defined-only $taskBuiltSo) -join "`n"
    $taskExportNames = @($taskExports -split "`n" | Where-Object { $_ -match '\s(\w+)$' } | ForEach-Object { ([regex]::Match($_,'\s(\w+)$')).Groups[1].Value })
    $taskExpectedExports = @('CGoFree','CGoPing','CGoQueryStats','CGoRunXrayFromJSON','CGoRuntimeInfo','CGoSetSocketProtectCallback','CGoStopXray','CGoXrayVersion')
    if (Compare-Object ($taskExportNames | Sort-Object) ($taskExpectedExports | Sort-Object)) { throw 'Unexpected libxray export set.' }
    Copy-Item -LiteralPath $taskBuiltSo -Destination $taskOutput
    $taskEvidencePrefix = [IO.Path]::GetFileNameWithoutExtension($taskEvidence) -replace '-verification$', ''
    $taskElfPath = Join-Path (Split-Path $taskEvidence) ($taskEvidencePrefix + '-readelf.txt')
    $taskModulePath = Join-Path (Split-Path $taskEvidence) ($taskEvidencePrefix + '-module-info.txt')
    $taskElf | Set-Content -Encoding utf8NoBOM -LiteralPath $taskElfPath
    $taskModuleInfo | Set-Content -Encoding utf8NoBOM -LiteralPath $taskModulePath
    $taskNeededLibraries = @([regex]::Matches($taskElf, 'Shared library: \[([^\]]+)\]') | ForEach-Object { $_.Groups[1].Value })
    $taskRecord = [ordered]@{
        schemaVersion = 1; builtAtUtc = [DateTime]::UtcNow.ToString('o'); host = 'windows/amd64'; target = 'openharmony/arm64'
        bootstrap = @{ version='go1.24.6'; url='https://go.dev/dl/go1.24.6.windows-amd64.zip'; sha256=$taskBootstrapSha }
        goFork = @{ repository='https://gitcode.com/openharmony-sig/ohos_golang_go'; commit=$taskOhosCommit; version=$taskGoVersion }
        libXray = @{ repository='https://github.com/XTLS/libXray'; commit=$taskLibCommit; license='MIT'; adaptedGoDirective='1.24.5' }
        patches = @(
            @{ file='native/xray/patches/0001-run-json-start-once.patch'; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskNative 'patches\0001-run-json-start-once.patch')).Hash.ToLowerInvariant(); originalSourceSha256LF='d558e729b91600b663cddfea9ed93620bcd1d3ec60754a1327dea3154898f8e9'; reason='Remove duplicate core.Start after core.StartInstance; otherwise metrics binds the same port twice.' },
            (Get-Content -Raw -LiteralPath (Join-Path $taskCoreStage 'harmony-patch-evidence.json') | ConvertFrom-Json)
        )
        xrayCore = @{ version='v1.250803.0'; license='MPL-2.0'; source=$taskCoreSource; upstreamModuleSum=$taskCoreMetadata.Sum; upstreamGoModSum=$taskCoreMetadata.GoModSum; originalModuleIntegrity=$taskOriginalModuleVerification; patchedReplacement=$taskCoreStage }
        socketProtection = @{ callbackAbi='int (*)(int fd); 0=protected, nonzero=reject'; export='CGoSetSocketProtectCallback'; registration='atomic pointer, process-lifetime controller'; wrapperSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskNative 'main.go.template')).Hash.ToLowerInvariant(); rejectsMissingCallback=$true; closesOriginalFd=$false; controllerErrorsPropagated=@('TCP Dialer.Control','UDP ListenConfig.Control'); hostTests=$taskProtectionTests; unpatchedNegativeControl=$taskProtectionBaseline }
        output = @{ path=$taskOutput; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $taskOutput).Hash.ToLowerInvariant(); bytes=(Get-Item -LiteralPath $taskOutput).Length }
        compiler = @{ path=$taskClang; version=((& $taskClang --version) -join "`n"); sysroot=$taskSysroot }
        buildFlags = @{ cc=$env:CC; cflags=$env:CGO_CFLAGS; ldflags=$taskLdFlags; trimpath=$true; mode='c-shared'; cgoEnabled=$true }
        exports = $taskExportNames
        elf = @{ machine='AArch64'; hasProgramTls=$true; tlsdescRelocationCount=([regex]::Matches($taskElf,'R_AARCH64_TLSDESC')).Count; initialExecTlsRelocationCount=0; neededLibraries=$taskNeededLibraries }
        elfInspectionPath=$taskElfPath; moduleInfoPath=$taskModulePath
        dependencyCount=([regex]::Matches($taskModuleInfo,'(?m)^\s*dep\s')).Count
        moduleIntegrity=$taskModuleVerification
        buildValidated=$true; deviceValidated=$false
    }
    $taskRecord | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM -LiteralPath $taskEvidence
    & $PythonPath (Join-Path $taskNative 'collect_licenses.py') --verification $taskEvidence --module-cache $env:GOMODCACHE --output (Join-Path $taskNative 'licenses\dependencies')
    if ($LASTEXITCODE -ne 0) { throw 'Linked dependency license inventory needs review.' }
    Write-Output "Built and statically verified: $taskOutput"
    Write-Output "Evidence: $taskEvidence"
} finally {
    foreach ($taskKey in $taskEnvKeys) { [Environment]::SetEnvironmentVariable($taskKey, $taskSavedEnv[$taskKey], 'Process') }
}
