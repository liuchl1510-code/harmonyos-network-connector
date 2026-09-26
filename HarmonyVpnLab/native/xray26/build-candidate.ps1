param(
    [string]$PortRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-go126-port\src-go'),
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray26'),
    [string]$CacheRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray'),
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$PythonPath = 'C:\Python314\python.exe',
    [string]$ArtifactDir = ''
)
$ErrorActionPreference='Stop'
$taskRecipe=$PSScriptRoot
if(!$ArtifactDir){$ArtifactDir=Join-Path $BuildRoot 'artifacts'}
$taskOutput=[IO.Path]::GetFullPath($ArtifactDir)
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskStage=Join-Path $BuildRoot 'stage';$taskCoreStage=Join-Path $BuildRoot 'stage-xray-core';$taskGo=Join-Path $PortRoot 'bin\go.exe'
$taskCoreVersion='v1.260327.1-0.20260601021109-94ffd50060f1';$taskLibPin='1a6c2baedcf102053c1117ea08b3510d6dada895'
$taskArchive=Join-Path $BuildRoot 'libxray-1a6c2ba.tar'
& (Join-Path $taskRecipe 'prepare-wrapper-source.ps1') -BuildRoot $BuildRoot -CacheRoot $CacheRoot
$taskLock=Get-Content -Raw -LiteralPath (Join-Path $taskRecipe 'sources.lock.json') | ConvertFrom-Json
if((Get-FileHash -Algorithm SHA256 $taskArchive).Hash.ToLowerInvariant() -ne $taskLock.libXray.archiveSHA256){throw 'Fixed libXray archive SHA mismatch'}
& $PythonPath -c 'import pathlib,sys,tarfile; p=pathlib.Path(sys.argv[2]); p.mkdir(parents=True,exist_ok=True); tarfile.open(sys.argv[1]).extractall(p,filter="data")' $taskArchive $taskStage
if($LASTEXITCODE -ne 0){throw 'Source archive extraction failed'}
$taskKeys=@('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOMODCACHE','GOCACHE','GOPATH','GOPROXY','GOSUMDB','CC','CXX','CGO_CFLAGS','CGO_CXXFLAGS','CGO_LDFLAGS','GOFLAGS')
$taskSaved=@{};foreach($taskKey in $taskKeys){$taskSaved[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey,'Process')}
try {
    $env:GOROOT=$PortRoot;$env:GOENV='off';$env:GOTOOLCHAIN='local';$env:GOOS='windows';$env:GOARCH='amd64';$env:CGO_ENABLED='0';$env:GOFLAGS=''
    $env:GOMODCACHE=Join-Path $CacheRoot 'cache\modules';$env:GOCACHE=Join-Path $BuildRoot 'cache\go';$env:GOPATH=Join-Path $BuildRoot 'cache\gopath';$env:GOPROXY='https://proxy.golang.org';$env:GOSUMDB='sum.golang.org'
    Push-Location $taskStage
    try {
        $taskCore=((& $taskGo mod download -json ('github.com/xtls/xray-core@'+$taskCoreVersion)) -join "`n") | ConvertFrom-Json
        if($LASTEXITCODE -ne 0){throw 'Pinned 26.6.1 source retrieval failed'}
        & $taskGo mod download
        if($LASTEXITCODE -ne 0){throw 'Pinned dependency retrieval failed'}
        $taskIntegrity=(& $taskGo mod verify) -join "`n"
        if($LASTEXITCODE -ne 0){throw 'Upstream dependency integrity failed'}
    } finally {Pop-Location}
    $env:GOPROXY='off';$env:GOSUMDB='off'
    & $PythonPath (Join-Path $taskRecipe 'prepare.py') $taskStage $taskCore.Dir $taskCoreStage $taskRecipe
    if($LASTEXITCODE -ne 0){throw 'Audited new-core source preparation failed'}
    # Run the real patched HTTP2 transport and lifecycle fixture. Hide upstream
    # test-only modules rather than downloading unrelated test dependencies.
    $taskDoHOverlayMap=@{}
    Get-ChildItem -LiteralPath (Join-Path $taskCoreStage 'app\dns') -Filter '*_test.go' -File | ForEach-Object { $taskDoHOverlayMap[$_.FullName]='' }
    $taskDoHFixture=Join-Path $taskRecipe 'validation\doh_transport_test.go.template'
    $taskDoHFixtureHash=(Get-FileHash -LiteralPath $taskDoHFixture -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskDoHOverlayMap[(Join-Path $taskCoreStage 'app\dns\harmony_doh_transport_test.go')]=$taskDoHFixture
    $taskDoHOverlay=Join-Path $BuildRoot 'doh-test-overlay.json'
    @{Replace=$taskDoHOverlayMap} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $taskDoHOverlay -Encoding utf8NoBOM
    Push-Location $taskCoreStage
    try {
        $taskDoHTests=(& $taskGo test '-mod=readonly' '-buildvcs=false' '-overlay' $taskDoHOverlay './app/dns' '-run' '^TestHarmonyDoHTransport$' '-count=1' '-timeout' '90s' '-v' 2>&1) -join "`n"
        $taskDoHTests | Set-Content -LiteralPath (Join-Path $taskOutput 'doh-transport-tests.txt') -Encoding utf8NoBOM
        if($LASTEXITCODE -ne 0 -or $taskDoHTests -notmatch '(?m)^--- PASS: TestHarmonyDoHTransport '){throw 'DoH transport/lifecycle fixture failed'}
        if((Get-FileHash -LiteralPath $taskDoHFixture -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskDoHFixtureHash){throw 'DoH fixture changed during verification'}
    } finally {Pop-Location}
    Copy-Item -LiteralPath (Join-Path $taskRecipe 'libxray.exports') -Destination $BuildRoot
    Push-Location $taskStage
    try {
        & $taskGo mod edit ('-replace=github.com/xtls/xray-core='+$taskCoreStage.Replace('\','/'))
        if($LASTEXITCODE -ne 0){throw 'Private core replacement failed'}
        $taskStatsTests=(& $taskGo test '-mod=readonly' -count=1 -run '^TestHarmonyConnectionStats$' -v ./xray 2>&1) -join "`n"
        if($LASTEXITCODE -ne 0){throw "Per-instance statistics restart verification failed:`n$taskStatsTests"}
        $taskStatsTests | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskOutput 'connection-stats-tests.txt')
        Write-Output $taskStatsTests
        $taskTests=(& $taskGo test '-mod=readonly' -count=1 -run '^TestHarmonySocketProtection' -v ./harmony_socket_validation 2>&1) -join "`n"
        if($LASTEXITCODE -ne 0){throw "Four protection test cases failed:`n$taskTests"}
        $taskTests | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskOutput 'socket-protection-tests.txt')
        Write-Output $taskTests
        $taskNegative=Join-Path $BuildRoot 'negative-control';New-Item -ItemType Directory -Force -Path $taskNegative | Out-Null
        Copy-Item -LiteralPath (Join-Path $taskStage 'go.mod'),(Join-Path $taskStage 'go.sum'),(Join-Path $taskStage 'harmony_socket_validation\socket_protect_test.go') -Destination $taskNegative
        Push-Location $taskNegative
        try {
            & $taskGo mod edit ('-replace=github.com/xtls/xray-core='+$taskCore.Dir.Replace('\','/'))
            if($LASTEXITCODE -ne 0){throw 'Original-core negative control setup failed'}
            $taskNegOutput=(& $taskGo test '-mod=readonly' -count=1 -run '^TestHarmonySocketProtection/(tcp|udp)/reject$' -v . 2>&1) -join "`n"
            if($LASTEXITCODE -eq 0 -or ([regex]::Matches($taskNegOutput,'rejected socket continued: conn=true err=<nil> nextControllers=1')).Count -ne 2){throw "Negative control did not expose both swallowed errors:`n$taskNegOutput"}
            $taskNegOutput | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskOutput 'unpatched-negative-control.txt')
            Write-Output 'Original new core negative control exposed both TCP and UDP rejection bugs.'
        } finally {Pop-Location}
        $taskNative=Join-Path $DevEcoPath 'sdk\default\openharmony\native'
        $env:CC='"'+(Join-Path $taskNative 'llvm\bin\clang.exe').Replace('\','/')+'" --target=aarch64-linux-ohos "--sysroot='+(Join-Path $taskNative 'sysroot').Replace('\','/')+'" -D__MUSL__'
        $env:CXX=$env:CC+' -x c++';$env:CGO_CFLAGS='-O2 -g -ftls-model=global-dynamic';$env:CGO_CXXFLAGS=$env:CGO_CFLAGS;$env:CGO_LDFLAGS=''
        $env:GOOS='openharmony';$env:GOARCH='arm64';$env:CGO_ENABLED='1'
        $taskFlags='-s -w -checklinkname=0 -linkmode external -extldflags "-Wl,--version-script='+(Join-Path $BuildRoot 'libxray.exports').Replace('\','/')+' -Wl,-z,lazy"'
        $taskSo=Join-Path $BuildRoot 'libxray.so'
        & $taskGo build '-mod=readonly' -trimpath "-ldflags=$taskFlags" -buildmode=c-shared -o $taskSo . 2>&1 | Tee-Object -FilePath (Join-Path $taskOutput 'cross-build.log')
        if($LASTEXITCODE -ne 0){throw 'Real 26.6.1 OHOS cross-build failed'}
        $taskModules=(& $taskGo version -m $taskSo) -join "`n"
        $taskIntegrity=(& $taskGo mod verify) -join "`n"
        if($LASTEXITCODE -ne 0){throw 'Final dependency integrity failed'}
    } finally {Pop-Location}
    $taskElf=(& (Join-Path $taskNative 'llvm\bin\llvm-readelf.exe') -h -l -d -r $taskSo) -join "`n"
    if($LASTEXITCODE -ne 0 -or $taskElf -notmatch 'AArch64' -or $taskElf -notmatch ' TLS ' -or $taskElf -notmatch 'R_AARCH64_TLSDESC' -or $taskElf -match 'R_AARCH64_TLS_TPREL64'){throw 'New library ELF/TLS inspection failed'}
    $taskExports=@((& (Join-Path $taskNative 'llvm\bin\llvm-nm.exe') -D --defined-only $taskSo) | ForEach-Object {($_ -split '\s+')[-1]} | Sort-Object)
    $taskExpected=@('CGoConnectionStats','CGoFree','CGoPing','CGoQueryStats','CGoRunXrayFromJSON','CGoRuntimeInfo','CGoSetSocketProtectCallback','CGoStopXray','CGoXrayVersion') | Sort-Object
    if(Compare-Object $taskExports $taskExpected){throw 'New library ABI differs from required nine exports'}
    Copy-Item -LiteralPath $taskSo -Destination $taskOutput
    $taskElfPath=Join-Path $taskOutput 'readelf.txt';$taskModulesPath=Join-Path $taskOutput 'module-info.txt'
    $taskElf | Set-Content -Encoding utf8NoBOM -LiteralPath $taskElfPath
    $taskModules | Set-Content -Encoding utf8NoBOM -LiteralPath $taskModulesPath
    $taskRecord=@{
        builtAtUtc=[DateTime]::UtcNow.ToString('o');xrayVersion='26.6.1';coreModule=('github.com/xtls/xray-core@'+$taskCoreVersion);libXrayCommit=$taskLibPin;compiler=((& $taskGo version) -join '');compilerIsLocalOhosPort=$true;compilerBaseCommit='3cc00d9c2b8ac231a5432ececa784814cc1eb075';target='openharmony/arm64';goDirectiveUnchanged='1.26.3';versionConstantsModified=$false
        sourceArchiveSHA256=(Get-FileHash -Algorithm SHA256 $taskArchive).Hash.ToLowerInvariant();xrayCore=@{version=$taskCoreVersion;origin=$taskCore.Origin;upstreamModuleSum=$taskCore.Sum;upstreamGoModSum=$taskCore.GoModSum;patchedReplacement=$taskCoreStage};patches=@((Get-Content -Raw (Join-Path $taskCoreStage 'harmony-patch-evidence.json') | ConvertFrom-Json));wrapperSHA256=(Get-FileHash -Algorithm SHA256 (Join-Path $taskRecipe 'main.go.template')).Hash.ToLowerInvariant();exports=$taskExports
        output=@{path=(Join-Path $taskOutput 'libxray.so');sha256=(Get-FileHash -Algorithm SHA256 $taskSo).Hash.ToLowerInvariant();bytes=(Get-Item $taskSo).Length};elf=@{machine='AArch64';hasProgramTls=$true;tlsdescRelocationCount=([regex]::Matches($taskElf,'R_AARCH64_TLSDESC')).Count;initialExecTlsRelocationCount=0;neededLibraries=@([regex]::Matches($taskElf,'Shared library: \[([^\]]+)\]') | ForEach-Object {$_.Groups[1].Value})};moduleInfoPath=$taskModulesPath;elfInspectionPath=$taskElfPath;moduleIntegrity=$taskIntegrity
        protectionTestCasesPassed=4;originalCoreNegativeCasesExposed=2;startupPatchNeeded=$false;nativeTunFdExported=$false;nativeTunEnabled=$false;packetPlane='Hev owns TUN; core only serves SOCKS via application configuration';canonicalArtifactsModified=$false;deviceValidated=$false;nodeConfigurationRead=$false;nodeConnectionsAttempted=$false
        connectionStats=@{restartCyclesPassed=3;missingCoreRejected=$true;missingCounterRejected=$true;readsCurrentInstance=$true;httpUsed=$false;expvarModified=$false;originalQueryStatsUnchanged=$true;sourceSha256=(Get-FileHash -Algorithm SHA256 (Join-Path $taskRecipe 'connection_stats.go.template')).Hash.ToLowerInvariant();testSourceSha256=(Get-FileHash -Algorithm SHA256 (Join-Path $taskRecipe 'validation\connection_stats_test.go.template')).Hash.ToLowerInvariant();testOutputPath=(Join-Path $taskOutput 'connection-stats-tests.txt')}
    }
    $taskEvidence=Join-Path $taskOutput 'build-verification.json';$taskRecord | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8NoBOM -LiteralPath $taskEvidence
    $taskRecord.dohTransportPool=@{passed=$true;fixtureSHA256=$taskDoHFixtureHash;testsLog=(Join-Path $taskOutput 'doh-transport-tests.txt');patch=(Get-Content -Raw (Join-Path $taskCoreStage 'harmony-patch-evidence.json') | ConvertFrom-Json).dohTransportPool;raceRun=$false;devicesContacted=$false}
    $taskRecord | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM -LiteralPath $taskEvidence
    & $PythonPath (Join-Path $taskRecipe 'collect_licenses.py') --verification $taskEvidence --module-cache $env:GOMODCACHE --output (Join-Path $taskOutput 'licenses\dependencies')
    if($LASTEXITCODE -ne 0){throw 'New core dependency license inventory incomplete'}
    New-Item -ItemType Directory -Force -Path (Join-Path $taskOutput 'licenses') | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskStage 'LICENSE') -Destination (Join-Path $taskOutput 'licenses\libXray-MIT.txt')
    Copy-Item -LiteralPath (Join-Path $PortRoot 'LICENSE') -Destination (Join-Path $taskOutput 'licenses\Go-BSD.txt')
    Write-Output 'REAL_XRAY_26_6_1_OHOS_CANDIDATE_READY; phone runtime validation remains pending'
} finally {foreach($taskKey in $taskKeys){[Environment]::SetEnvironmentVariable($taskKey,$taskSaved[$taskKey],'Process')}}
