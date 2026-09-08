#requires -Version 7.2
param(
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$PythonPath = '',
    [string]$CacheRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-native-source'),
    [string]$BuildRoot = '',
    [switch]$Cold
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
if (!$BuildRoot) { $BuildRoot = Join-Path $CacheRoot 'build' }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
foreach ($taskRoot in @($CacheRoot, $BuildRoot)) {
    if ($taskRoot -match '[^\x00-\x7F]') { throw 'CacheRoot and BuildRoot must be real ASCII paths.' }
    $taskAncestorPath = $taskRoot
    while (!(Test-Path -LiteralPath $taskAncestorPath)) { $taskAncestorPath = Split-Path -Parent $taskAncestorPath }
    $taskAncestor = Get-Item -LiteralPath $taskAncestorPath
    while ($null -ne $taskAncestor) {
        if ($taskAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Native roots cannot contain reparse points: $($taskAncestor.FullName)" }
        $taskAncestor = $taskAncestor.Parent
    }
    if ($Cold -and (Test-Path -LiteralPath $taskRoot) -and @(Get-ChildItem -LiteralPath $taskRoot -Force).Count) {
        throw "-Cold requires absent or empty CacheRoot and BuildRoot. Choose new paths; nothing was removed: $taskRoot"
    }
}
if (!$PythonPath) {
    $taskPythonCommand = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$taskPythonCommand) { $taskPythonCommand = Get-Command python3 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if (!$taskPythonCommand) { throw 'Python 3.12+ was not found on PATH. Supply -PythonPath with the full python.exe path.' }
    $PythonPath = $taskPythonCommand.Source
}
if (!(Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw "Python executable not found: $PythonPath" }
& $PythonPath -c 'import sys; assert sys.version_info >= (3,12), "Python 3.12+ is required for safe tar extraction"'
if ($LASTEXITCODE -ne 0) { throw 'Python preflight failed. Supply a working Python 3.12+ executable with -PythonPath.' }
if (!(Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { throw 'Git for Windows must be installed and available on PATH.' }
$taskSdk = Join-Path $DevEcoPath 'sdk\default\openharmony\native'
foreach ($taskRelativeTool in @('llvm\bin\clang.exe', 'llvm\bin\llvm-readelf.exe', 'llvm\bin\llvm-nm.exe',
    'build-tools\cmake\bin\cmake.exe', 'build-tools\cmake\bin\ninja.exe', 'build\cmake\ohos.toolchain.cmake')) {
    $taskTool = Join-Path $taskSdk $taskRelativeTool
    if (!(Test-Path -LiteralPath $taskTool -PathType Leaf)) { throw "Missing DevEco SDK tool: $taskTool" }
}
New-Item -ItemType Directory -Force -Path $CacheRoot, $BuildRoot | Out-Null
$taskLibraries = Join-Path $taskProject 'entry\libs\arm64-v8a'
$taskEvidence = Join-Path $taskProject 'build\native'
New-Item -ItemType Directory -Force -Path $taskLibraries, $taskEvidence | Out-Null

# build-hev.ps1 keeps its pinned checkout relative to its workspace. Running a
# minimal source-only copy puts that checkout under this explicit CacheRoot,
# never in the caller's historical workspace/.tooling tree.
$taskHevProject = Join-Path $CacheRoot 'hev-input\HarmonyVpnLab'
$taskHevScripts = Join-Path $taskHevProject 'scripts'
$taskHevNative = Join-Path $taskHevProject 'native\hev'
New-Item -ItemType Directory -Force -Path $taskHevScripts, $taskHevNative | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build-hev.ps1') -Destination $taskHevScripts -Force
$taskHevFiles = @('source-lock.json', 'CMakeLists.txt', 'exports.map', 'ohos-io-stats.c',
    'include\hev-ohos-io-stats.h', 'include\hev-ohos-interest.h', 'include\hev-main.h',
    'patches\demand-driven-io.patch', 'patches\demand-driven-io.json')
foreach ($taskFile in $taskHevFiles) {
    $taskDestination = Join-Path $taskHevNative $taskFile
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskDestination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskProject "native\hev\$taskFile") -Destination $taskDestination -Force
}
Write-Output 'Step 1/4: build pinned Hev sources and verify its ARM64 ABI.'
& (Join-Path $taskHevScripts 'build-hev.ps1') -DevEcoPath $DevEcoPath -BuildRoot (Join-Path $BuildRoot 'hev')
$taskHevLibrary = Join-Path $taskHevProject 'entry\libs\arm64-v8a\libhevsocks5tun.so'
$taskHevRecord = Get-Content -Raw -LiteralPath (Join-Path $taskHevProject 'build\native\hev-verification.json') | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $taskHevLibrary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskHevRecord.sha256) {
    throw 'Hev output no longer matches its verification record.'
}
Copy-Item -LiteralPath $taskHevLibrary -Destination $taskLibraries -Force
$taskHevRecord.artifact = Join-Path $taskLibraries 'libhevsocks5tun.so'
$taskHevRecord | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath (Join-Path $taskEvidence 'hev-verification.json') -Encoding utf8NoBOM

$taskGoScripts = Join-Path $taskProject 'native\xray26\go-port'
$taskXrayRoot = Join-Path $BuildRoot 'xray26'
$taskCompilerRoot = Join-Path $taskXrayRoot 'go-toolchain'
$taskPortRoot = Join-Path $taskCompilerRoot 'src-go'
# Always override these older scripts' historical TEMP defaults explicitly.
$taskBaseCheckout = Join-Path $taskCompilerRoot 'base-source'
$taskBootstrap = Join-Path $taskCompilerRoot 'bootstrap\go'
Write-Output 'Step 2/4: rebuild or verify the pinned Go OHOS compiler, then build Xray.'
& (Join-Path $taskGoScripts 'rebuild-port.ps1') -WorkingRoot $taskCompilerRoot -SourceRoot $taskPortRoot `
    -BaseCheckout $taskBaseCheckout -BootstrapRoot $taskBootstrap -PythonPath $PythonPath -DevEcoPath $DevEcoPath
$taskCompilerCheck = (& $PythonPath (Join-Path $taskGoScripts 'verify-cache.py') $taskPortRoot) -join "`n"
if ($LASTEXITCODE -ne 0 -or !($taskCompilerCheck | ConvertFrom-Json).cacheReady) {
    throw 'The explicitly prepared compiler is not ready; refusing any fallback to historical compiler/bootstrap caches.'
}
& (Join-Path $PSScriptRoot 'build-xray26.ps1') -DevEcoPath $DevEcoPath -PythonPath $PythonPath `
    -BuildRoot $taskXrayRoot -CacheRoot (Join-Path $CacheRoot 'xray26') -PortRoot $taskPortRoot

Write-Output 'Step 3/4: build and verify the Go runtime smoke library before packaging it.'
$taskSmokeOutput = Join-Path $taskCompilerRoot 'artifacts\package-smoke'
& (Join-Path $taskGoScripts 'build-smoke.ps1') -SourceRoot $taskPortRoot -DevEcoPath $DevEcoPath -OutputDir $taskSmokeOutput
$taskSmokeSource = Join-Path $taskSmokeOutput 'libharmonygo_smoke.so'
$taskSmokeRecord = Get-Content -Raw -LiteralPath (Join-Path $taskSmokeOutput 'build-verification.json') | ConvertFrom-Json
$taskSmokeHash = (Get-FileHash -LiteralPath $taskSmokeSource -Algorithm SHA256).Hash.ToLowerInvariant()
$taskExpectedExports = @('HarmonyGoSmoke', 'HarmonyGoSmokeFree')
if ($taskSmokeHash -ne $taskSmokeRecord.sha256 -or $taskSmokeRecord.target -ne 'openharmony/arm64' -or
    !$taskSmokeRecord.hasProgramTls -or $taskSmokeRecord.initialExecTlsRelocationCount -ne 0 -or
    $taskSmokeRecord.tlsdescRelocationCount -lt 1 -or (Compare-Object @($taskSmokeRecord.exports) $taskExpectedExports)) {
    throw 'Go smoke evidence does not match the required hash, target, TLS model or exports.'
}
$taskActualExports = @(& (Join-Path $taskSdk 'llvm\bin\llvm-nm.exe') -D --defined-only --just-symbol-name $taskSmokeSource)
if ($LASTEXITCODE -ne 0 -or (Compare-Object $taskActualExports $taskExpectedExports)) { throw 'Go smoke exports failed direct verification.' }
$taskPackagedSmoke = Join-Path $taskLibraries 'libgoruntime-smoke.so'
Copy-Item -LiteralPath $taskSmokeSource -Destination $taskPackagedSmoke -Force
if ((Get-FileHash -LiteralPath $taskPackagedSmoke -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskSmokeHash) { throw 'Go smoke copy hash mismatch.' }
[ordered]@{
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceArtifact = $taskSmokeSource
    packagedArtifact = $taskPackagedSmoke
    sha256 = $taskSmokeHash
    renameOnly = $true
    verifiedExports = $taskActualExports
    sourceBuild = $taskSmokeRecord
    deviceValidated = $false
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskEvidence 'goruntime-smoke-verification.json') -Encoding utf8NoBOM

Write-Output 'Step 4/4: build the native positive/negative runtime controls.'
& (Join-Path $PSScriptRoot 'build-runtime-smoke.ps1') -DevEcoPath $DevEcoPath
if ($LASTEXITCODE -ne 0) { throw 'Native runtime control build failed.' }
$taskFiles = foreach ($taskName in @('libhevsocks5tun.so', 'libxray.so', 'libgoruntime-smoke.so', 'libsmoke-good.so', 'libsmoke-broken.so')) {
    $taskFile = Join-Path $taskLibraries $taskName
    [ordered]@{ name = $taskName; bytes = (Get-Item -LiteralPath $taskFile).Length; sha256 = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant() }
}
[ordered]@{
    preparedAtUtc = [DateTime]::UtcNow.ToString('o')
    coldRootsRequired = [bool]$Cold
    cacheRoot = $CacheRoot
    buildRoot = $BuildRoot
    hevSourceRoot = Join-Path $CacheRoot 'hev-input\.tooling\sources\hev-socks5-tunnel'
    compilerWorkingRoot = $taskCompilerRoot
    compilerBaseCheckout = $taskBaseCheckout
    compilerBootstrapRoot = $taskBootstrap
    python = $PythonPath
    files = @($taskFiles)
    deviceValidated = $false
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskEvidence 'prepare-native-verification.json') -Encoding utf8NoBOM
Write-Output "Prepared five ARM64 libraries: $taskLibraries"
Write-Output "Build evidence: $taskEvidence"
Write-Output 'Next: pwsh -File scripts/build.ps1 -NoSign (from HarmonyVpnLab). Device checks are a separate step.'
