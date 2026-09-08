param(
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnNative-01a07b6e\hev')
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskWorkspace = Split-Path -Parent $taskProject
$taskNative = Join-Path $taskProject 'native\hev'
$taskSource = Join-Path $taskWorkspace '.tooling\sources\hev-socks5-tunnel'
$taskLock = Get-Content -LiteralPath (Join-Path $taskNative 'source-lock.json') -Raw | ConvertFrom-Json
$taskBuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if ($taskBuildRoot -match '[^\x00-\x7F]') { throw 'BuildRoot must be a real ASCII path.' }
New-Item -ItemType Directory -Force -Path $taskBuildRoot | Out-Null
# Do not use junctions to disguise a non-ASCII source path: Clang resolves them.
$taskAncestor = Get-Item -LiteralPath $taskBuildRoot
while ($null -ne $taskAncestor) {
    if ($taskAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "BuildRoot may not contain reparse points: $($taskAncestor.FullName)"
    }
    $taskAncestor = $taskAncestor.Parent
}
$taskSdk = Join-Path $DevEcoPath 'sdk\default\openharmony\native'
$taskCmake = Join-Path $taskSdk 'build-tools\cmake\bin\cmake.exe'
$taskNinja = Join-Path $taskSdk 'build-tools\cmake\bin\ninja.exe'
$taskReadElf = Join-Path $taskSdk 'llvm\bin\llvm-readelf.exe'
$taskNm = Join-Path $taskSdk 'llvm\bin\llvm-nm.exe'
$taskToolchain = Join-Path $taskSdk 'build\cmake\ohos.toolchain.cmake'
foreach ($taskTool in @($taskCmake, $taskNinja, $taskReadElf, $taskNm, $taskToolchain)) {
    if (!(Test-Path -LiteralPath $taskTool)) { throw "Missing DevEco tool: $taskTool" }
}

# Clone each gitlink explicitly: this also works in minimal Windows Git installs
# where git-submodule's external POSIX utilities are unavailable.
foreach ($taskRepo in $taskLock.repositories) {
    $taskRepoPath = if ($taskRepo.path -eq '.') { $taskSource } else { Join-Path $taskSource $taskRepo.path }
    $taskFresh = $false
    if (!(Test-Path -LiteralPath (Join-Path $taskRepoPath '.git'))) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskRepoPath) | Out-Null
        & git -c http.sslBackend=openssl clone --no-checkout $taskRepo.url $taskRepoPath
        if ($LASTEXITCODE -ne 0) { throw "Clone failed: $($taskRepo.url)" }
        $taskFresh = $true
    }
    if (!$taskFresh) {
        $taskDirty = & git -C $taskRepoPath status --porcelain --untracked-files=no --ignore-submodules=all
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect source checkout' }
        if ($taskDirty) { throw "Source has tracked edits; preserve them before rebuilding: $taskRepoPath" }
    }
    & git -C $taskRepoPath checkout --detach $taskRepo.commit
    if ($LASTEXITCODE -ne 0) { throw "Cannot checkout pinned commit: $($taskRepo.commit)" }
    $taskHead = (& git -C $taskRepoPath rev-parse HEAD).Trim()
    if ($taskHead -ne $taskRepo.commit) { throw "Source pin mismatch: $taskRepoPath" }
    if ($taskRepo.path -ne '.') {
        $taskGitlink = & git -C $taskSource ls-tree HEAD -- $taskRepo.path
        if ($taskGitlink -notmatch ('^160000 commit ' + $taskRepo.commit + '\s')) {
            throw "Submodule commit does not match the parent gitlink: $($taskRepo.path)"
        }
    }
}

$taskStageSource = Join-Path $taskBuildRoot 'source'
$taskStageNative = Join-Path $taskBuildRoot 'cmake'
$taskStageBuild = Join-Path $taskBuildRoot 'build'
if (Test-Path -LiteralPath $taskStageSource) {
    $taskResolved = (Resolve-Path -LiteralPath $taskStageSource).Path
    if ($taskResolved -ne $taskStageSource -or
        !($taskResolved.StartsWith($taskBuildRoot + '\', [StringComparison]::OrdinalIgnoreCase)) -or
        ((Get-Item -LiteralPath $taskResolved).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Refusing to replace a staging directory outside the verified build root.'
    }
    Remove-Item -LiteralPath $taskResolved -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $taskStageSource, $taskStageNative, $taskStageBuild | Out-Null
$taskMaterialized = 0
$taskSourceCount = 0
foreach ($taskRepo in $taskLock.repositories) {
    $taskRepoPath = if ($taskRepo.path -eq '.') { $taskSource } else { Join-Path $taskSource $taskRepo.path }
    $taskRepoStage = if ($taskRepo.path -eq '.') { $taskStageSource } else { Join-Path $taskStageSource $taskRepo.path }
    $taskEntries = & git -C $taskRepoPath ls-files --stage
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate tracked source files' }
    foreach ($taskEntry in $taskEntries) {
        if ($taskEntry -notmatch '^(\d{6}) [0-9a-f]+ 0\t(.+)$') { throw "Unexpected git index entry: $taskEntry" }
        $taskMode = $Matches[1]
        $taskRelative = $Matches[2]
        if ($taskMode -eq '160000') { continue }
        $taskFrom = Join-Path $taskRepoPath $taskRelative
        $taskTo = Join-Path $taskRepoStage $taskRelative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskTo) | Out-Null
        if ($taskMode -eq '120000') {
            # Git's core.symlinks=false writes link targets as text. Materialize
            # the tracked header's target into the disposable stage only.
            $taskTarget = (& git -C $taskRepoPath show ("HEAD:" + $taskRelative)).Trim()
            if ($LASTEXITCODE -ne 0) { throw "Cannot inspect symlink: $taskRelative" }
            $taskFrom = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $taskFrom) $taskTarget))
            if (!$taskFrom.StartsWith($taskRepoPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw "Source link escapes its pinned repository: $taskRelative"
            }
            $taskMaterialized++
        }
        Copy-Item -LiteralPath $taskFrom -Destination $taskTo
        $taskSourceCount++
    }
}
Copy-Item -LiteralPath (Join-Path $taskNative 'CMakeLists.txt'), (Join-Path $taskNative 'exports.map'), (Join-Path $taskNative 'ohos-io-stats.c') -Destination $taskStageNative
New-Item -ItemType Directory -Force -Path (Join-Path $taskStageNative 'include') | Out-Null
Copy-Item -LiteralPath (Join-Path $taskNative 'include\hev-ohos-io-stats.h') -Destination (Join-Path $taskStageNative 'include')
Copy-Item -LiteralPath (Join-Path $taskNative 'include\hev-ohos-interest.h') -Destination (Join-Path $taskStageSource 'src\misc')

# Apply the reviewed session-interest patch only to disposable staged sources.
# Git for Windows may check out CRLF; normalize these two verified files first.
$taskPatchPath = Join-Path $taskNative 'patches\demand-driven-io.patch'
$taskPatchLock = Get-Content -LiteralPath (Join-Path $taskNative 'patches\demand-driven-io.json') -Raw | ConvertFrom-Json
$taskPatchHash = (Get-FileHash -LiteralPath $taskPatchPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($taskPatchHash -ne $taskPatchLock.patchSHA256) { throw 'Hev session patch hash mismatch' }
$taskUtf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($taskPatchedFile in $taskPatchLock.files) {
    $taskPatchedPath = Join-Path $taskStageSource $taskPatchedFile.path
    $taskPatchedText = [IO.File]::ReadAllText($taskPatchedPath).Replace("`r`n", "`n")
    [IO.File]::WriteAllText($taskPatchedPath, $taskPatchedText, $taskUtf8)
    $taskOriginalHash = (Get-FileHash -LiteralPath $taskPatchedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($taskOriginalHash -ne $taskPatchedFile.beforeSHA256) { throw 'Hev session patch requires the exact pinned baseline' }
}
& git -c core.autocrlf=false -C $taskStageSource apply --check -- $taskPatchPath
if ($LASTEXITCODE -ne 0) { throw 'Hev session patch clean apply check failed' }
& git -c core.autocrlf=false -C $taskStageSource apply -- $taskPatchPath
if ($LASTEXITCODE -ne 0) { throw 'Hev session patch apply failed' }
foreach ($taskPatchedFile in $taskPatchLock.files) {
    $taskPatchedHash = (Get-FileHash -LiteralPath (Join-Path $taskStageSource $taskPatchedFile.path) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($taskPatchedHash -ne $taskPatchedFile.afterSHA256) { throw 'Hev session patch output hash mismatch' }
}

& $taskCmake -S $taskStageNative -B $taskStageBuild -G Ninja "-DCMAKE_MAKE_PROGRAM=$taskNinja" `
    "-DCMAKE_TOOLCHAIN_FILE=$taskToolchain" '-DOHOS_ARCH=arm64-v8a' '-DOHOS_STL=none' `
    '-DOHOS_COMPATIBLE_SDK_VERSION=26' '-DCMAKE_BUILD_TYPE=Release' "-DHEV_SOURCE_DIR=$taskStageSource"
if ($LASTEXITCODE -ne 0) { throw 'Hev CMake configure failed' }
& $taskCmake --build $taskStageBuild --parallel 8
if ($LASTEXITCODE -ne 0) { throw 'Hev CMake build failed' }

$taskLibrary = Join-Path $taskStageBuild 'libhevsocks5tun.so'
$taskElf = & $taskReadElf -h -d $taskLibrary
if ($LASTEXITCODE -ne 0) { throw 'ELF inspection failed' }
$taskElfText = $taskElf -join "`n"
if ($taskElfText -notmatch 'Machine:\s+AArch64' -or $taskElfText -notmatch 'Type:\s+DYN') {
    throw 'Output is not an AArch64 ELF shared library'
}
$taskDefined = @(& $taskNm -D --defined-only --just-symbol-name $taskLibrary)
if ($LASTEXITCODE -ne 0) { throw 'Export inspection failed' }
$taskRequired = @('hev_socks5_tunnel_main', 'hev_socks5_tunnel_main_from_file',
    'hev_socks5_tunnel_main_from_str', 'hev_socks5_tunnel_quit', 'hev_socks5_tunnel_stats', 'hev_ohos_io_stats')
foreach ($taskExport in $taskRequired) {
    if ($taskExport -notin $taskDefined) { throw "Missing public API: $taskExport" }
}
$taskUndefined = @(& $taskNm -D --undefined-only --just-symbol-name $taskLibrary)
if ($LASTEXITCODE -ne 0) { throw 'Undefined symbol inspection failed' }
$taskUnresolvedHev = @($taskUndefined | Where-Object { $_ -match '^hev_' })
if ($taskUnresolvedHev.Count) { throw "Unresolved internal symbols: $($taskUnresolvedHev -join ', ')" }
$taskNeeded = @($taskElf | Where-Object { $_ -match '\(NEEDED\)' } | ForEach-Object {
    if ($_ -match '\[(.+)\]') { $Matches[1] }
})
# SDK 26's official toolchain adds deviceinfo_ndk.z when a compatible SDK level
# is set (ohos.toolchain.cmake); it is a platform library, not another core.
if (@($taskNeeded | Where-Object { $_ -notin @('libc.so', 'libm.so', 'libdl.so', 'libdeviceinfo_ndk.z.so') }).Count) {
    throw "Unexpected runtime dependency: $($taskNeeded -join ', ')"
}
$taskStrongImports = @(& $taskNm -D --undefined-only --format=posix $taskLibrary |
    Where-Object { $_ -match '^\S+ U ' } | ForEach-Object { ($_ -split '\s+')[0] })
if ($LASTEXITCODE -ne 0) { throw 'Strong import inspection failed' }
$taskProviders = @()
foreach ($taskDependency in $taskNeeded) {
    $taskProvider = Join-Path $taskSdk ("sysroot\usr\lib\aarch64-linux-ohos\" + $taskDependency)
    if (!(Test-Path -LiteralPath $taskProvider)) { throw "Missing SDK dependency: $taskProvider" }
    $taskProviders += @(& $taskNm -D --defined-only --just-symbol-name $taskProvider)
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect SDK dependency: $taskProvider" }
}
$taskMissingImports = @($taskStrongImports | Where-Object { $_ -notin $taskProviders })
if ($taskMissingImports.Count) { throw "Strong imports absent from SDK: $($taskMissingImports -join ', ')" }
$taskOutput = Join-Path $taskProject 'entry\libs\arm64-v8a'
$taskReportDir = Join-Path $taskProject 'build\native'
New-Item -ItemType Directory -Force -Path $taskOutput, $taskReportDir | Out-Null
$taskInstalledLibrary = Join-Path $taskOutput 'libhevsocks5tun.so'
Copy-Item -LiteralPath $taskLibrary -Destination $taskInstalledLibrary
$taskReport = [ordered]@{
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    upstream = $taskLock
    sourceFilesStaged = $taskSourceCount
    trackedSymlinksMaterialized = $taskMaterialized
    buildRoot = $taskBuildRoot
    sdkNative = $taskSdk
    target = 'aarch64-linux-ohos26.0.0'
    artifact = $taskInstalledLibrary
    sizeBytes = (Get-Item -LiteralPath $taskInstalledLibrary).Length
    sha256 = (Get-FileHash -LiteralPath $taskInstalledLibrary -Algorithm SHA256).Hash.ToLowerInvariant()
    publicExports = $taskDefined
    ioDiagnostics = [ordered]@{
        abi = 'void hev_ohos_io_stats(uint64_t *values, unsigned int count)'
        slotCount = 17
        scope = 'Process-lifetime per-slot relaxed atomics; Hev DSO read and epoll_wait references only'
        wraps = @('epoll_wait', 'read')
        sourceSha256 = (Get-FileHash -LiteralPath (Join-Path $taskNative 'ohos-io-stats.c') -Algorithm SHA256).Hash.ToLowerInvariant()
        headerSha256 = (Get-FileHash -LiteralPath (Join-Path $taskNative 'include\hev-ohos-io-stats.h') -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    sessionInterestPatch = [ordered]@{
        sha256 = $taskPatchHash
        cleanBaselineAndPatchedOutputsVerified = $true
        changedFiles = @($taskPatchLock.files | ForEach-Object { $_.path })
        helperSHA256 = (Get-FileHash -LiteralPath (Join-Path $taskNative 'include\hev-ohos-interest.h') -Algorithm SHA256).Hash.ToLowerInvariant()
        behavior = 'Demand-driven TCP read/write and UDP write readiness; no polling sleep or retry backoff'
    }
    unresolvedHevSymbols = $taskUnresolvedHev
    neededLibraries = $taskNeeded
    linkNoUndefined = $true
    strongImportsResolvedAgainstSdk = $taskStrongImports.Count
    elfInspection = $taskElf
    undefinedSystemSymbols = $taskUndefined
    deviceRuntimeValidated = $false
}
$taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskReportDir 'hev-verification.json') -Encoding utf8
Write-Output "Built and verified: $taskInstalledLibrary"
Write-Output "SHA256: $($taskReport.sha256)"
