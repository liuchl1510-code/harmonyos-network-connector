#requires -Version 7.2
param(
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-01a07b6e'),
    [switch]$NoSign,
    [switch]$SimulatorUI,
    [string]$SigningProfilePath = ''
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if ($BuildRoot -match '[^\x00-\x7F]') { throw 'BuildRoot must use an ASCII path for Hvigor.' }
$taskRequiredLibraries = if ($SimulatorUI) { @() } else { @('libhevsocks5tun.so', 'libxray.so', 'libgoruntime-smoke.so') }
$taskMissing = @($taskRequiredLibraries | Where-Object {
    !(Test-Path -LiteralPath (Join-Path $taskProject "entry\libs\arm64-v8a\$_") -PathType Leaf)
})
if ($taskMissing.Count) {
    throw ("Native libraries are missing: " + ($taskMissing -join ', ') + ". Run pwsh -File `"" +
        (Join-Path $PSScriptRoot 'prepare-native.ps1') + "`" -DevEcoPath `"$DevEcoPath`" first. See docs/public-build.md.")
}
$taskNode = Join-Path $DevEcoPath 'tools\node\node.exe'
$taskHvigor = Join-Path $DevEcoPath 'tools\hvigor\bin\hvigorw.js'
$taskOhpm = Join-Path $DevEcoPath 'tools\ohpm\bin\ohpm.bat'
$taskClang = Join-Path $DevEcoPath 'sdk\default\openharmony\native\llvm\bin\clang.exe'
foreach ($taskTool in @($taskNode, $taskHvigor, $taskOhpm, $taskClang)) {
    if (!(Test-Path -LiteralPath $taskTool -PathType Leaf)) { throw "Missing DevEco tool: $taskTool" }
}
if (!$SimulatorUI) {
    & (Join-Path $PSScriptRoot 'build-runtime-smoke.ps1') -DevEcoPath $DevEcoPath
    if ($LASTEXITCODE -ne 0) { throw 'Native runtime test controls failed to build.' }
}
# Every unsigned invocation has a fresh stage, separate from the signed project.
$taskRunId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$taskVariant = if ($NoSign) { 'unsigned' } else { 'signed' }
$taskStageRoot = if ($SimulatorUI) { Join-Path $BuildRoot "simulator-ui\$taskVariant\$taskRunId" } elseif ($NoSign) { Join-Path $BuildRoot "unsigned\$taskRunId" } else { $BuildRoot }
$taskCacheRoot = if ($SimulatorUI) { Join-Path $BuildRoot "simulator-ui\cache\$taskVariant" } elseif ($NoSign) { Join-Path $BuildRoot 'unsigned\cache' } else { Join-Path $BuildRoot 'cache' }
$taskBuildProject = Join-Path $taskStageRoot 'project'
$taskEnvironmentKeys = @('DEVECO_SDK_HOME', 'JAVA_HOME', 'HVIGOR_USER_HOME', 'npm_config_cache', 'PATH')
$taskSavedEnvironment = @{}
foreach ($taskKey in $taskEnvironmentKeys) { $taskSavedEnvironment[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
function Copy-AppSources([string]$SourceDirectory) {
    foreach ($taskItem in Get-ChildItem -LiteralPath $SourceDirectory -Force) {
        if ($taskItem.Name -match '^\.' -or $taskItem.Name -in @('build', 'oh_modules', 'node_modules')) { continue }
        if ($SimulatorUI -and ($taskItem.FullName -eq (Join-Path $taskProject 'entry\libs') -or $taskItem.Extension -in @('.so', '.a'))) { continue }
        if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Source staging rejects reparse points: $($taskItem.FullName)" }
        if ($taskItem.PSIsContainer) { Copy-AppSources $taskItem.FullName; continue }
        if ($taskItem.Name -in @('local.properties', 'oh-package-lock.json5') -or
            $taskItem.Extension -in @('.p12', '.pfx', '.p7b', '.cer', '.csr', '.key', '.keystore', '.jks', '.hap', '.log') -or
            ($taskItem.Extension -eq '.pem' -and $taskItem.Name -ne 'mozilla-ca.pem') -or
            $taskItem.Name -match '(?i)^(secrets?|credentials?)(\.|$)') { continue }
        $taskRelative = [IO.Path]::GetRelativePath($taskProject, $taskItem.FullName)
        $taskDestination = Join-Path $taskBuildProject $taskRelative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskDestination) | Out-Null
        Copy-Item -LiteralPath $taskItem.FullName -Destination $taskDestination -Force
    }
}
try {
    $env:DEVECO_SDK_HOME = Join-Path $DevEcoPath 'sdk'
    $env:JAVA_HOME = Join-Path $DevEcoPath 'jbr'
    $env:HVIGOR_USER_HOME = Join-Path $taskCacheRoot 'hvigor'
    $env:npm_config_cache = Join-Path $taskCacheRoot 'npm'
    $env:PATH = (Join-Path $DevEcoPath 'jbr\bin') + ';' + (Join-Path $DevEcoPath 'tools\node') + ';' + (Join-Path $DevEcoPath 'tools\ohpm\bin') + ';' + $env:PATH
    New-Item -ItemType Directory -Force -Path $taskBuildProject | Out-Null
    # Only the authored trees consumed by Hvigor/CMake enter the stage.
    $taskTrees = @('AppScope', 'entry', 'hvigor')
    if (!$SimulatorUI) { $taskTrees += @('native\runtime-smoke', 'native\hev\include') }
    foreach ($taskTree in $taskTrees) {
        Copy-AppSources (Join-Path $taskProject $taskTree)
    }
    foreach ($taskFile in @('hvigorfile.ts', 'oh-package.json5')) {
        Copy-Item -LiteralPath (Join-Path $taskProject $taskFile) -Destination $taskBuildProject -Force
    }
    if ($SimulatorUI) {
        $taskEntryProfilePath = Join-Path $taskBuildProject 'entry\build-profile.json5'
        $taskEntryProfile = Get-Content -Raw -LiteralPath $taskEntryProfilePath | ConvertFrom-Json
        $taskEntryProfile.buildOption.externalNativeOptions.abiFilters = @('x86_64')
        $taskEntryProfile.buildOption.externalNativeOptions.arguments = '-DHARMONY_UI_PREVIEW=ON'
        $taskEntryProfile | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskEntryProfilePath -Encoding utf8NoBOM
        $taskCapabilityPath = Join-Path $taskBuildProject 'entry\src\main\ets\model\BuildCapabilities.ets'
        if (!(Test-Path -LiteralPath $taskCapabilityPath -PathType Leaf)) { throw 'UI preview requires the authored BuildCapabilities.ets capability guard.' }
        $taskCapabilities = [IO.File]::ReadAllText($taskCapabilityPath)
        $taskCapabilityPattern = '(?m)^export\s+const\s+VPN_CORE_AVAILABLE\s*:\s*boolean\s*=\s*true\s*;[ \t]*\r?$'
        if ([regex]::Matches($taskCapabilities, $taskCapabilityPattern).Count -ne 1) { throw 'Expected exactly one default VPN_CORE_AVAILABLE=true guard before preparing UI preview.' }
        [IO.File]::WriteAllText($taskCapabilityPath, [regex]::Replace($taskCapabilities, $taskCapabilityPattern, 'export const VPN_CORE_AVAILABLE: boolean = false;'), [Text.UTF8Encoding]::new($false))
        $taskAppPath = Join-Path $taskBuildProject 'AppScope\app.json5'
        $taskApp = Get-Content -Raw -LiteralPath $taskAppPath | ConvertFrom-Json
        $taskApp.app.versionName = $taskApp.app.versionName + '-ui-preview'
        $taskApp | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskAppPath -Encoding utf8NoBOM
    }
    $taskStageProfile = Join-Path $taskBuildProject 'build-profile.json5'
    if ($NoSign) {
        # Do not read the user's app profile, even to remove selected fields.
        @'
{
  "app": {
    "products": [{
      "name": "default",
      "compileSdkVersion": "26.0.0",
      "compatibleSdkVersion": "6.1.1(24)",
      "targetSdkVersion": "26.0.0",
      "runtimeOS": "HarmonyOS",
      "buildOption": {
        "nativeCompiler": "BiSheng",
        "strictMode": { "caseSensitiveCheck": true, "useNormalizedOHMUrl": true }
      }
    }],
    "buildModeSet": [{ "name": "debug" }, { "name": "release" }]
  },
  "modules": [{ "name": "entry", "srcPath": "./entry", "targets": [{ "name": "default", "applyToProducts": ["default"] }] }]
}
'@ | Set-Content -LiteralPath $taskStageProfile -Encoding utf8NoBOM
    } elseif ($SimulatorUI) {
        # Read-only copy into a new preview stage. Never rewrite the local or
        # existing signed-stage profile, and never print its contents/errors.
        $taskSigningSource = $SigningProfilePath
        if (!$taskSigningSource) {
            foreach ($taskCandidate in @((Join-Path $BuildRoot 'project\build-profile.json5'), (Join-Path $taskProject 'build-profile.json5'))) {
                if (Test-Path -LiteralPath $taskCandidate -PathType Leaf) { $taskSigningSource = $taskCandidate; break }
            }
        }
        if (!$taskSigningSource -or !(Test-Path -LiteralPath $taskSigningSource -PathType Leaf)) {
            throw 'No local signing profile for UI preview. Use -NoSign or supply -SigningProfilePath with an existing local signing profile.'
        }
        try { Copy-Item -LiteralPath $taskSigningSource -Destination $taskStageProfile -Force }
        catch { throw 'The local signing profile could not be copied into the independent UI preview stage.' }
    } elseif (!(Test-Path -LiteralPath $taskStageProfile)) {
        $taskLocalConfig = Join-Path $taskProject 'build-profile.json5'
        if (!(Test-Path -LiteralPath $taskLocalConfig)) { $taskLocalConfig = Join-Path $taskProject 'build-profile.example.json5' }
        Copy-Item -LiteralPath $taskLocalConfig -Destination $taskStageProfile
    }
    # Keep the minimum OS requirement in sync with the public project, including
    # an existing signed stage. Preserve all private signing fields verbatim as
    # JSON values; never print profile contents or profile parse errors.
    try {
        $taskPublicProfile = Get-Content -Raw -LiteralPath (Join-Path $taskProject 'build-profile.example.json5') | ConvertFrom-Json
        $taskMinimumSdk = @($taskPublicProfile.app.products | Where-Object { $_.name -eq 'default' })[0].compatibleSdkVersion
        if ($taskMinimumSdk -notmatch '^\d+\.\d+\.\d+(\(\d+\))?$') { throw 'Invalid minimum SDK' }
        $taskSignedProfile = Get-Content -Raw -LiteralPath $taskStageProfile | ConvertFrom-Json
        $taskDefaultProducts = @($taskSignedProfile.app.products | Where-Object { $_.name -eq 'default' })
        if ($taskDefaultProducts.Count -ne 1) { throw 'Expected one default product' }
        $taskDefaultProducts[0].compatibleSdkVersion = $taskMinimumSdk
        $taskSignedProfile | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $taskStageProfile -Encoding utf8NoBOM
    } catch { throw 'Could not apply the public minimum SDK to the isolated build profile.' }
    Write-Output "Minimum compatible SDK: $taskMinimumSdk"
    Write-Output "Build project: $taskBuildProject"
    if ($SimulatorUI) { Write-Output 'Variant: x86_64 UI PREVIEW ONLY; VPN/core/probes unavailable; ARM libraries excluded.' }
    Write-Output $(if ($NoSign) { 'Signing: disabled (independent public profile)' } else { 'Signing: existing local configuration' })
    Push-Location -LiteralPath $taskBuildProject
    try {
        & $taskOhpm install --all --cache (Join-Path $taskCacheRoot 'ohpm') --auto_skip_install
        if ($LASTEXITCODE -ne 0) { throw "ohpm failed with exit code $LASTEXITCODE" }
        $taskHapDirectory = Join-Path $taskBuildProject 'entry\build\default\outputs\default'
        # Archive only files produced in this invocation, never previous HAPs.
        if (Test-Path -LiteralPath $taskHapDirectory) {
            $taskResolved = (Resolve-Path -LiteralPath $taskHapDirectory).Path
            if ($taskResolved -ne $taskHapDirectory -or !$taskResolved.StartsWith($taskBuildProject + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'HAP output directory is outside the staging project.'
            }
            $taskAncestor = Get-Item -LiteralPath $taskResolved
            while ($null -ne $taskAncestor) {
                if ($taskAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'HAP output ancestors cannot be reparse points.' }
                $taskAncestor = $taskAncestor.Parent
            }
            Get-ChildItem -LiteralPath $taskHapDirectory -File -Filter '*.hap' | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
        }
        & $taskNode $taskHvigor --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon --stacktrace
        if ($LASTEXITCODE -ne 0) { throw "Hvigor failed with exit code $LASTEXITCODE" }
        $taskHaps = @(Get-ChildItem -LiteralPath $taskHapDirectory -File -Filter '*.hap')
        if (!$taskHaps.Count) { throw 'Hvigor produced no HAP files.' }
        if ($NoSign -and @($taskHaps | Where-Object { $_.Name -notmatch '-unsigned\.hap$' }).Count) {
            throw 'Unsigned build produced an unexpected HAP filename; refusing to publish it.'
        }
        if ($SimulatorUI) {
            if (!$NoSign -and !@($taskHaps | Where-Object { $_.Name -match '-signed\.hap$' }).Count) { throw 'The UI preview build produced no signed HAP. Check the local signing profile or use -NoSign.' }
            foreach ($taskHap in $taskHaps) {
                $taskZip = [IO.Compression.ZipFile]::OpenRead($taskHap.FullName)
                try {
                    $taskPackagedSo = @($taskZip.Entries | Where-Object { $_.FullName -match '\.so$' } | ForEach-Object { $_.FullName })
                    if (!($taskPackagedSo -contains 'libs/x86_64/libvpnbridge.so') -or
                        @($taskPackagedSo | Where-Object { $_ -notmatch '^libs/x86_64/' -or $_ -match '(libxray|libhevsocks5tun|libgoruntime-smoke|libsmoke-)\.?' }).Count) {
                        throw 'UI preview packaging validation rejected a missing x86_64 bridge or a packaged VPN/foreign-ABI library.'
                    }
                    foreach ($taskEntry in @($taskZip.Entries | Where-Object { $_.FullName -match '\.so$' })) {
                        $taskStream = $taskEntry.Open()
                        try {
                            $taskHeader = [byte[]]::new(20)
                            $taskRead = 0
                            while ($taskRead -lt $taskHeader.Length) {
                                $taskPart = $taskStream.Read($taskHeader, $taskRead, $taskHeader.Length - $taskRead)
                                if ($taskPart -le 0) { break }
                                $taskRead += $taskPart
                            }
                            if ($taskRead -ne 20 -or $taskHeader[0] -ne 127 -or $taskHeader[1] -ne 69 -or $taskHeader[2] -ne 76 -or
                                $taskHeader[3] -ne 70 -or $taskHeader[4] -ne 2 -or $taskHeader[5] -ne 1 -or $taskHeader[18] -ne 62 -or $taskHeader[19] -ne 0) {
                                throw 'UI preview contains a library that is not an ELF64 little-endian x86_64 object.'
                            }
                        } finally { $taskStream.Dispose() }
                    }
                } finally { $taskZip.Dispose() }
            }
        }
        $taskOutput = Join-Path $taskProject $(if ($SimulatorUI) { 'build\artifacts\simulator-ui' } elseif ($NoSign) { 'build\artifacts\unsigned' } else { 'build\artifacts' })
        New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
        $taskVersion = (Get-Content -Raw -LiteralPath (Join-Path $taskBuildProject 'AppScope\app.json5') | ConvertFrom-Json).app.versionName
        if ($taskVersion -notmatch '^[0-9A-Za-z._-]+$') { throw 'Invalid version for artifact archive.' }
        $taskArchive = Join-Path $taskOutput "versioned\$taskVersion"
        New-Item -ItemType Directory -Force -Path $taskArchive | Out-Null
        foreach ($taskHap in $taskHaps) {
            Copy-Item -LiteralPath $taskHap.FullName -Destination $taskOutput -Force
            if ($NoSign -or $taskHap.Name -match '-signed\.hap$') {
                $taskHash = (Get-FileHash -LiteralPath $taskHap.FullName -Algorithm SHA256).Hash
                Copy-Item -LiteralPath $taskHap.FullName -Destination (Join-Path $taskArchive "$($taskHash.Substring(0,12))-$($taskHap.Name)") -Force
            }
        }
        Write-Output "HAP artifacts: $taskOutput"
    } finally { Pop-Location }
} finally {
    foreach ($taskKey in $taskEnvironmentKeys) { [Environment]::SetEnvironmentVariable($taskKey, $taskSavedEnvironment[$taskKey], 'Process') }
}
