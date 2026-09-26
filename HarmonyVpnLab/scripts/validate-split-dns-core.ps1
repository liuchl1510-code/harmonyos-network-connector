param(
    [string]$GoRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-go126-port\src-go'),
    [string]$ModuleCache = (Join-Path $env:TEMP 'HarmonyVpnLab-xray\cache\modules'),
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-split-dns-core-validation'),
    [string]$AssetsRoot = '',
    [string]$FixturesPath = '',
    [switch]$DoHTransportPool,
    [string]$PythonPath = ''
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
if (!$FixturesPath) { $FixturesPath = Join-Path $taskProject 'build\split-dns-core-fixtures.json' }
if (!$AssetsRoot) { $AssetsRoot = Join-Path $taskProject 'entry\src\main\resources\rawfile' }
$taskNative = Join-Path $taskProject 'native\xray26'
$taskPolicyTest = Join-Path $PSScriptRoot 'validation\split-dns-core_test.go'
$taskTestName = '^TestSplitDNSCoreFixtures$'
$taskOutputName = 'split-dns-core-verification.json'
$taskNegativeOutputName = 'split-dns-core-negative-control.json'
if ($DoHTransportPool) {
    $taskPolicyTest = Join-Path $taskNative 'validation\split_dns_pool_policy_test.go.template'
    $taskTestName = '^TestHarmonySplitDNSPoolPolicyFixtures$'
    $taskOutputName = 'split-dns-pool-core-verification.json'
    $taskNegativeOutputName = 'split-dns-pool-core-negative-control.json'
    $taskPoolManifestPath = Join-Path $taskNative 'dns-pool\manifest.json'
    $taskPoolManifest = Get-Content -Raw -LiteralPath $taskPoolManifestPath | ConvertFrom-Json
    if (!$PythonPath) {
        $taskPythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($taskPythonCommand -and $taskPythonCommand.Source -notmatch '[\\/]WindowsApps[\\/]') { $PythonPath = $taskPythonCommand.Source }
        else {
            foreach ($taskPythonCandidate in @((Join-Path $env:USERPROFILE 'anaconda3\python.exe'), (Join-Path $env:USERPROFILE 'miniconda3\python.exe'))) {
                if (Test-Path -LiteralPath $taskPythonCandidate -PathType Leaf) { $PythonPath = $taskPythonCandidate; break }
            }
        }
    }
    if (!$PythonPath) { throw 'DoHTransportPool requires Python 3; provide -PythonPath with its executable path.' }
    $taskPythonCommand = Get-Command $PythonPath -ErrorAction SilentlyContinue
    if (!$taskPythonCommand -or $taskPythonCommand.CommandType -ne 'Application') { throw 'PythonPath must resolve to a Python executable.' }
    $taskPython = $taskPythonCommand.Source
}
$taskLockPath = Join-Path $taskNative 'sources.lock.json'
$taskLock = Get-Content -Raw -LiteralPath $taskLockPath | ConvertFrom-Json
$taskRuleLockPath = Join-Path $taskProject 'rules\sources.lock.json'
$taskRuleLock = Get-Content -Raw -LiteralPath $taskRuleLockPath | ConvertFrom-Json
$taskGo = Join-Path $GoRoot 'bin\go.exe'
if (!(Test-Path -LiteralPath $taskGo) -or !(Test-Path -LiteralPath $FixturesPath)) { throw 'Prepared Go 1.26 and generated synthetic split-DNS fixtures are required.' }
$taskInputPaths = @($FixturesPath, $taskLockPath, $taskRuleLockPath, $PSCommandPath,
    (Join-Path $PSScriptRoot 'validation\split-dns-core-main.go'),
    $taskPolicyTest,
    (Join-Path $taskNative 'upstream\go.mod'), (Join-Path $taskNative 'upstream\go.sum'))
if ($DoHTransportPool) {
    $taskInputPaths += @($taskPoolManifestPath, (Join-Path $taskNative 'dns-pool\apply_patch.py'),
        (Join-Path $taskNative 'dns-pool\doh_transport.go'),
        (Join-Path $taskNative 'patches\0002-doh-session-transport-pool.patch'))
}
foreach ($taskAsset in $taskRuleLock.assets) {
    $taskAssetPath = Join-Path $AssetsRoot $taskAsset.name
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $taskAssetPath).Hash.ToLowerInvariant() -ne $taskAsset.output.sha256) { throw 'Packaged routing asset differs from the fixed lock.' }
    $taskInputPaths += $taskAssetPath
}
$taskInputHashes = @($taskInputPaths | ForEach-Object { (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant() })
$taskRun = Join-Path $BuildRoot ('run-' + [guid]::NewGuid().ToString('N'))
$taskHelper = Join-Path $taskRun 'prepare'
$taskCoreCopy = Join-Path $taskRun 'core'
New-Item -ItemType Directory -Force -Path $taskHelper | Out-Null
$taskManifest = [IO.File]::ReadAllText((Join-Path $taskNative 'upstream\go.mod')).Replace('module github.com/xtls/libxray', 'module harmonyvpnlab.local/splitdnsvalidation')
[IO.File]::WriteAllText((Join-Path $taskHelper 'go.mod'), $taskManifest, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $taskNative 'upstream\go.sum') -Destination $taskHelper
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'validation\split-dns-core-main.go') -Destination (Join-Path $taskHelper 'main.go')
function Get-CoreManifest([string]$Root) {
    $taskResolved = (Resolve-Path -LiteralPath $Root).Path
    return @(Get-ChildItem -LiteralPath $taskResolved -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{ path = [IO.Path]::GetRelativePath($taskResolved, $_.FullName).Replace('\', '/'); sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant() }
    })
}
function Get-ManifestDigest($Manifest) {
    $taskLines = ($Manifest | ForEach-Object { $_.path + "`t" + $_.sha256 }) -join "`n"
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskLines))).ToLowerInvariant()
}
$taskKeys = @('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOMODCACHE','GOCACHE','GOPROXY','GOSUMDB','GOPATH','GOFLAGS','GOWORK','XRAY_LOCATION_ASSET','xray.location.asset','HARMONY_SPLIT_DNS_PREPARED','HARMONY_SPLIT_DNS_RESULT')
$taskSaved = @{}
foreach ($taskKey in $taskKeys) { $taskSaved[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
try {
    $env:GOROOT = $GoRoot; $env:GOENV = 'off'; $env:GOTOOLCHAIN = 'local'; $env:GOOS = 'windows'; $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'; $env:GOFLAGS = ''; $env:GOWORK = 'off'; $env:GOMODCACHE = $ModuleCache
    $env:GOCACHE = Join-Path $BuildRoot 'cache'; $env:GOPATH = Join-Path $BuildRoot 'gopath'; $env:GOPROXY = 'off'; $env:GOSUMDB = 'off'
    $env:XRAY_LOCATION_ASSET = (Resolve-Path -LiteralPath $AssetsRoot).Path
    [Environment]::SetEnvironmentVariable('xray.location.asset', $env:XRAY_LOCATION_ASSET, 'Process')
    $taskExe = Join-Path $taskHelper 'prepare.exe'
    Push-Location -LiteralPath $taskHelper
    try {
        $taskVersion = (& $taskGo version) -join ''
        if ($taskVersion -notmatch '^go version go1\.26\.[0-9]+ windows/amd64$') { throw 'Expected Windows Go 1.26 toolchain.' }
        $taskModule = ((& $taskGo list '-mod=readonly' -m -json github.com/xtls/xray-core) -join "`n") | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $taskModule.Version -ne $taskLock.xrayCore.moduleVersion -or $taskModule.Sum -ne $taskLock.xrayCore.moduleSum -or $taskModule.GoModSum -ne $taskLock.xrayCore.goModSum -or $taskModule.Replace) { throw 'Exact core module/version/content pin is required.' }
        $taskIntegrity = (& $taskGo mod verify) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'Module cache verification failed.' }
        & $taskGo build '-mod=readonly' '-buildvcs=false' -trimpath -o $taskExe .
        if ($LASTEXITCODE -ne 0) { throw 'Offline config preparer build failed.' }
    } finally { Pop-Location }
    $taskOriginalManifest = @(Get-CoreManifest $taskModule.Dir)
    $taskOriginalDigest = Get-ManifestDigest $taskOriginalManifest
    $taskOriginalManifest | ConvertTo-Json -Depth 4 -AsArray | Set-Content -LiteralPath (Join-Path $taskRun 'core-source-inputs.json') -Encoding utf8NoBOM
    Copy-Item -LiteralPath $taskModule.Dir -Destination $taskCoreCopy -Recurse
    if ((Get-ManifestDigest (Get-CoreManifest $taskCoreCopy)) -ne $taskOriginalDigest) { throw 'Isolated core copy does not match fixed cached source.' }
    $taskExpectedDigest = $taskOriginalDigest
    if ($DoHTransportPool) {
        $taskPoolRunner = Join-Path $taskRun 'apply-doh-pool.py'
        @'
import json, runpy, sys
from pathlib import Path
core, stage, recipe, output = sys.argv[1:]
apply = runpy.run_path(str(Path(recipe)/'dns-pool/apply_patch.py'))['apply_pool_patch']
evidence = apply(core, stage, recipe)
Path(output).write_text(json.dumps(evidence, indent=2)+'\n', encoding='utf-8')
'@ | Set-Content -LiteralPath $taskPoolRunner -Encoding utf8NoBOM
        $taskPoolEvidencePath = Join-Path $taskRun 'doh-pool-patch-evidence.json'
        & $taskPython $taskPoolRunner $taskModule.Dir $taskCoreCopy $taskNative $taskPoolEvidencePath
        if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $taskPoolEvidencePath)) { throw 'Strict DoH pool patch application failed.' }
        $taskPoolEvidence = Get-Content -Raw -LiteralPath $taskPoolEvidencePath | ConvertFrom-Json -AsHashtable
        $taskAllowedDelta = @('app/dns/dns.go', 'app/dns/nameserver.go', 'app/dns/nameserver_doh.go', 'app/dns/doh_transport.go')
        if ($taskPoolManifest.files.Count -ne 4 -or @($taskPoolManifest.files.path | Sort-Object -Unique).Count -ne 4 -or
            @($taskPoolManifest.files.path | Where-Object { $_ -notin $taskAllowedDelta }).Count -ne 0) { throw 'DoH pool patch must name exactly four audited source files.' }
        $taskExpectedHashes = @{}
        foreach ($taskSource in $taskOriginalManifest) { $taskExpectedHashes[$taskSource.path] = $taskSource.sha256 }
        foreach ($taskPatchFile in $taskPoolManifest.files) {
            if ($taskPatchFile.originalSHA256LF) {
                if ($taskExpectedHashes[$taskPatchFile.path] -ne $taskPatchFile.originalSHA256LF) { throw 'DoH patch original source hash does not match the pinned full manifest.' }
            } elseif ($taskExpectedHashes.ContainsKey($taskPatchFile.path)) { throw 'DoH patch added source already exists in the pinned manifest.' }
            $taskExpectedHashes[$taskPatchFile.path] = $taskPatchFile.patchedSHA256LF
        }
        $taskExpectedManifest = @($taskExpectedHashes.Keys | Sort-Object | ForEach-Object {
            [ordered]@{ path = $_; sha256 = $taskExpectedHashes[$_] }
        })
        $taskExpectedDigest = Get-ManifestDigest $taskExpectedManifest
        $taskExpectedManifest | ConvertTo-Json -Depth 4 -AsArray | Set-Content -LiteralPath (Join-Path $taskRun 'core-source-expected-patched.json') -Encoding utf8NoBOM
        if ((Get-ManifestDigest (Get-CoreManifest $taskCoreCopy)) -ne $taskExpectedDigest) { throw 'Patched all-source manifest differs from the exact four-file expected delta.' }
    }
    $taskOverlayMap = @{}
    # Hide upstream test-only inputs instead of fetching their extra modules.
    # Default production files are byte-identical. The opt-in candidate has only
    # the four audited DoH source changes and uses its matching policy fixture.
    Get-ChildItem -LiteralPath (Join-Path $taskCoreCopy 'app\dns') -Filter '*_test.go' -File | ForEach-Object { $taskOverlayMap[$_.FullName] = '' }
    $taskOverlayMap[(Join-Path $taskCoreCopy 'app\dns\harmony_split_dns_test.go')] = $taskPolicyTest
    $taskOverlay = Join-Path $taskRun 'overlay.json'
    @{Replace = $taskOverlayMap} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $taskOverlay -Encoding utf8NoBOM
    $taskPrepared = Join-Path $taskRun 'prepared.json'
    & $taskExe -fixtures $FixturesPath -output $taskPrepared -expect-version $taskLock.xrayCore.reportedVersion
    if ($LASTEXITCODE -ne 0) { throw 'Pinned real loader rejected split-DNS fixtures.' }
    $taskFresh = Join-Path $taskRun 'verification.json'
    $env:HARMONY_SPLIT_DNS_PREPARED = $taskPrepared; $env:HARMONY_SPLIT_DNS_RESULT = $taskFresh
    Push-Location -LiteralPath $taskCoreCopy
    try {
        & $taskGo test '-mod=readonly' '-buildvcs=false' '-overlay' $taskOverlay './app/dns' '-run' $taskTestName '-count=1' '-v' 2>&1 | Set-Content -LiteralPath (Join-Path $taskRun 'test.log') -Encoding utf8NoBOM
        $taskExit = $LASTEXITCODE
    } finally { Pop-Location }
    if (!(Test-Path -LiteralPath $taskFresh)) { throw 'No fresh DNS query/selection report.' }
    $taskReport = Get-Content -Raw -LiteralPath $taskFresh | ConvertFrom-Json -AsHashtable
    $taskReport.toolchain = $taskVersion; $taskReport.coreModule = 'github.com/xtls/xray-core@' + $taskModule.Version
    $taskReport.moduleIntegrity = $taskIntegrity; $taskReport.moduleSum = $taskModule.Sum
    $taskReport.coreSourceFileCount = $taskOriginalManifest.Count; $taskReport.coreSourceManifestSha256 = $taskOriginalDigest
    $taskReport.cacheSourceUnchanged = (Get-ManifestDigest (Get-CoreManifest $taskModule.Dir)) -eq $taskOriginalDigest
    $taskFinalCoreManifest = @(Get-CoreManifest $taskCoreCopy)
    $taskFinalCoreDigest = Get-ManifestDigest $taskFinalCoreManifest
    $taskReport.isolatedProductionFilesUnchanged = $taskFinalCoreDigest -eq $taskOriginalDigest
    $taskSourceValid = $taskReport.isolatedProductionFilesUnchanged
    if ($DoHTransportPool) {
        $taskOriginalHashes = @{}
        foreach ($taskSource in $taskOriginalManifest) { $taskOriginalHashes[$taskSource.path] = $taskSource.sha256 }
        $taskFinalHashes = @{}
        foreach ($taskSource in $taskFinalCoreManifest) { $taskFinalHashes[$taskSource.path] = $taskSource.sha256 }
        $taskDelta = @($taskFinalHashes.Keys | Where-Object { !$taskOriginalHashes.ContainsKey($_) -or $taskOriginalHashes[$_] -ne $taskFinalHashes[$_] })
        $taskRemoved = @($taskOriginalHashes.Keys | Where-Object { !$taskFinalHashes.ContainsKey($_) })
        $taskReport.doHTransportPool = $true
        $taskReport.expectedPatchedSourceManifestSha256 = $taskExpectedDigest
        $taskReport.patchedSourceManifestSha256 = $taskFinalCoreDigest
        $taskReport.patchedSourceFileCount = $taskFinalCoreManifest.Count
        $taskReport.sourceDeltaPaths = @($taskDelta | Sort-Object)
        $taskReport.sourceMatchesExpectedPatch = $taskFinalCoreDigest -eq $taskExpectedDigest -and $taskDelta.Count -eq 4 -and
            $taskRemoved.Count -eq 0 -and @($taskDelta | Where-Object { $_ -notin $taskAllowedDelta }).Count -eq 0
        $taskReport.doHTransportPatch = $taskPoolEvidence
        $taskSourceValid = $taskReport.sourceMatchesExpectedPatch -and !$taskReport.isolatedProductionFilesUnchanged
    }
    $taskReport.inputFilesUnchanged = $true
    $taskReport.inputSha256 = @{}
    $taskReport.inputPathSha256 = @{}
    for ($taskIndex = 0; $taskIndex -lt $taskInputPaths.Count; $taskIndex++) {
        $taskReport.inputSha256[[IO.Path]::GetFileName($taskInputPaths[$taskIndex])] = $taskInputHashes[$taskIndex]
        $taskReport.inputPathSha256[[IO.Path]::GetRelativePath($taskProject, $taskInputPaths[$taskIndex]).Replace('\', '/')] = $taskInputHashes[$taskIndex]
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $taskInputPaths[$taskIndex]).Hash.ToLowerInvariant() -ne $taskInputHashes[$taskIndex]) { $taskReport.inputFilesUnchanged = $false }
    }
    $taskReport.controllerPatchScope = 'Unmodified pinned DNS/router code; shipped native socket-controller patch and device network lifecycle are separate runtime checks.'
    if ($DoHTransportPool) { $taskReport.controllerPatchScope = 'Only the audited four-file DoH transport patch is applied to isolated pinned DNS code; native socket-controller patch and device network lifecycle are separate runtime checks.' }
    $taskOutput = Join-Path (Join-Path $taskProject 'build') $taskOutputName
    $taskReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskOutput -Encoding utf8NoBOM
    if ($taskExit -ne 0 -or !$taskReport.passed -or $taskReport.coreVersion -ne $taskLock.xrayCore.reportedVersion -or !$taskReport.cacheSourceUnchanged -or !$taskSourceValid -or !$taskReport.inputFilesUnchanged) { throw 'Pinned DNS validation failed; inspect fresh report.' }
    # Unknown fields can load silently. A typo in finalQuery must fail the real
    # protobuf guard; JSON acceptance alone is not a verification pass.
    $taskNegativeSamples = @(Get-Content -Raw -LiteralPath $FixturesPath | ConvertFrom-Json -AsHashtable)
    $taskNegativeFound = $false
    foreach ($taskSample in $taskNegativeSamples) {
        $taskConfig = $taskSample.configJSON | ConvertFrom-Json -AsHashtable
        if ($taskConfig.dns.servers.Count -eq 3) {
            $taskConfig.dns.servers[0].finalQuerz = $true
            $taskConfig.dns.servers[0].Remove('finalQuery')
            $taskSample.configJSON = $taskConfig | ConvertTo-Json -Depth 50 -Compress
            $taskNegativeFound = $true
            break
        }
    }
    if (!$taskNegativeFound) { throw 'At least one split fixture is required for the negative control.' }
    $taskNegativeFixture = Join-Path $taskRun 'negative-fixtures.json'
    $taskNegativeSamples | ConvertTo-Json -Depth 12 -AsArray | Set-Content -LiteralPath $taskNegativeFixture -Encoding utf8NoBOM
    $taskNegativePrepared = Join-Path $taskRun 'negative-prepared.json'
    & $taskExe -fixtures $taskNegativeFixture -output $taskNegativePrepared -expect-version $taskLock.xrayCore.reportedVersion
    if ($LASTEXITCODE -ne 0) { throw 'Negative control failed before the intended protobuf guard.' }
    $taskNegativeFresh = Join-Path $taskRun 'negative-verification.json'
    $env:HARMONY_SPLIT_DNS_PREPARED = $taskNegativePrepared; $env:HARMONY_SPLIT_DNS_RESULT = $taskNegativeFresh
    Push-Location -LiteralPath $taskCoreCopy
    try {
        & $taskGo test '-mod=readonly' '-buildvcs=false' '-overlay' $taskOverlay './app/dns' '-run' $taskTestName '-count=1' '-v' 2>&1 | Set-Content -LiteralPath (Join-Path $taskRun 'negative-test.log') -Encoding utf8NoBOM
        $taskNegativeExit = $LASTEXITCODE
    } finally { Pop-Location }
    $taskNegative = Get-Content -Raw -LiteralPath $taskNegativeFresh | ConvertFrom-Json -AsHashtable
    if ($taskNegativeExit -eq 0 -or $taskNegative.passed -or @($taskNegative.results | Where-Object failure -eq 'PROTO_FINAL_QUERY').Count -ne 1 -or $taskNegative.blockedNetworkAttempts -ne 0) { throw 'Ignored finalQuery typo was not rejected by the expected guard.' }
    $taskNegative.expectedFailure = $true
    $taskNegative | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path (Join-Path $taskProject 'build') $taskNegativeOutputName) -Encoding utf8NoBOM
    if ($DoHTransportPool) {
        # Bind the entire opt-in run, including the failing negative control,
        # rather than checking immutable inputs only before that final test.
        $taskReport.cacheSourceUnchanged = (Get-ManifestDigest (Get-CoreManifest $taskModule.Dir)) -eq $taskOriginalDigest
        $taskReport.sourceMatchesExpectedPatch = $taskReport.sourceMatchesExpectedPatch -and
            (Get-ManifestDigest (Get-CoreManifest $taskCoreCopy)) -eq $taskExpectedDigest
        for ($taskIndex = 0; $taskIndex -lt $taskInputPaths.Count; $taskIndex++) {
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $taskInputPaths[$taskIndex]).Hash.ToLowerInvariant() -ne $taskInputHashes[$taskIndex]) { $taskReport.inputFilesUnchanged = $false }
        }
        $taskReport.negativeControlPassed = $true
        $taskReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskOutput -Encoding utf8NoBOM
        if (!$taskReport.cacheSourceUnchanged -or !$taskReport.sourceMatchesExpectedPatch -or !$taskReport.inputFilesUnchanged) { throw 'DoH pool sources or bound inputs changed during the negative control.' }
    }
    if ($DoHTransportPool) { Write-Output 'Patched-core split DNS policy and independent cache/tag behavior passed with the audited DoH transport pool. Ignored finalQuery typo rejected. No network or device used.' }
    else { Write-Output 'Fixed-core split DNS selection, failure isolation, cache/tag isolation and actual DNS-tag routing passed. Ignored finalQuery typo rejected. No network or device used.' }
} finally {
    foreach ($taskKey in $taskKeys) { [Environment]::SetEnvironmentVariable($taskKey, $taskSaved[$taskKey], 'Process') }
}
# The last Go process is an intentionally failing negative control. Report
# overall success only after its expected failure and all source checks passed.
exit 0
