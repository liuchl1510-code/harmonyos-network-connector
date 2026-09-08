#requires -Version 7.2
param(
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-01a07b6e'),
    [switch]$NoSign
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if ($BuildRoot -match '[^\x00-\x7F]') { throw 'BuildRoot must use an ASCII path for Hvigor.' }
$taskRequiredLibraries = @('libhevsocks5tun.so', 'libxray.so', 'libgoruntime-smoke.so')
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
& (Join-Path $PSScriptRoot 'build-runtime-smoke.ps1') -DevEcoPath $DevEcoPath
if ($LASTEXITCODE -ne 0) { throw 'Native runtime test controls failed to build.' }
# Every unsigned invocation has a fresh stage, separate from the signed project.
$taskRunId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$taskStageRoot = if ($NoSign) { Join-Path $BuildRoot "unsigned\$taskRunId" } else { $BuildRoot }
$taskCacheRoot = if ($NoSign) { Join-Path $BuildRoot 'unsigned\cache' } else { Join-Path $BuildRoot 'cache' }
$taskBuildProject = Join-Path $taskStageRoot 'project'
$taskEnvironmentKeys = @('DEVECO_SDK_HOME', 'JAVA_HOME', 'HVIGOR_USER_HOME', 'npm_config_cache', 'PATH')
$taskSavedEnvironment = @{}
foreach ($taskKey in $taskEnvironmentKeys) { $taskSavedEnvironment[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
function Copy-AppSources([string]$SourceDirectory) {
    foreach ($taskItem in Get-ChildItem -LiteralPath $SourceDirectory -Force) {
        if ($taskItem.Name -match '^\.' -or $taskItem.Name -in @('build', 'oh_modules', 'node_modules')) { continue }
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
    foreach ($taskTree in @('AppScope', 'entry', 'hvigor', 'native\runtime-smoke', 'native\hev\include')) {
        Copy-AppSources (Join-Path $taskProject $taskTree)
    }
    foreach ($taskFile in @('hvigorfile.ts', 'oh-package.json5')) {
        Copy-Item -LiteralPath (Join-Path $taskProject $taskFile) -Destination $taskBuildProject -Force
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
      "compatibleSdkVersion": "26.0.0",
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
    } elseif (!(Test-Path -LiteralPath $taskStageProfile)) {
        $taskLocalConfig = Join-Path $taskProject 'build-profile.json5'
        if (!(Test-Path -LiteralPath $taskLocalConfig)) { $taskLocalConfig = Join-Path $taskProject 'build-profile.example.json5' }
        Copy-Item -LiteralPath $taskLocalConfig -Destination $taskStageProfile
    }
    Write-Output "Build project: $taskBuildProject"
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
        $taskOutput = Join-Path $taskProject $(if ($NoSign) { 'build\artifacts\unsigned' } else { 'build\artifacts' })
        New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
        $taskVersion = (Get-Content -Raw -LiteralPath (Join-Path $taskProject 'AppScope\app.json5') | ConvertFrom-Json).app.versionName
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
