param(
    [string]$SourceRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-go126-port\src-go'),
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$OutputDir = ''
)
$ErrorActionPreference='Stop'
$taskGo=Join-Path $SourceRoot 'bin\go.exe'
$taskStage=Join-Path (Split-Path $SourceRoot) 'smoke'
$taskSmokeSource=Join-Path $PSScriptRoot 'smoke'
if(!$OutputDir){$OutputDir=Join-Path (Split-Path $SourceRoot) 'artifacts\smoke'}
$taskOutput=[IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskNative=Join-Path $DevEcoPath 'sdk\default\openharmony\native'
New-Item -ItemType Directory -Force -Path $taskStage | Out-Null
Copy-Item -LiteralPath (Join-Path $taskSmokeSource 'main.go'),(Join-Path $taskSmokeSource 'exports.map') -Destination $taskStage
"module harmonyvpnlab.local/go126smoke`n`ngo 1.26.7`n" | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskStage 'go.mod')
$taskKeys=@('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOCACHE','GOPROXY','CC','CXX','CGO_CFLAGS','CGO_CXXFLAGS','CGO_LDFLAGS')
$taskSaved=@{}
foreach($taskKey in $taskKeys){$taskSaved[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey,'Process')}
try {
    $env:GOROOT=$SourceRoot;$env:GOENV='off';$env:GOTOOLCHAIN='local';$env:GOOS='openharmony';$env:GOARCH='arm64';$env:CGO_ENABLED='1';$env:GOPROXY='off'
    $env:GOCACHE=Join-Path (Split-Path $SourceRoot) 'cache\smoke'
    $env:CC='"'+(Join-Path $taskNative 'llvm\bin\clang.exe').Replace('\','/')+'" --target=aarch64-linux-ohos "--sysroot='+(Join-Path $taskNative 'sysroot').Replace('\','/')+'" -D__MUSL__'
    $env:CXX=$env:CC+' -x c++';$env:CGO_CFLAGS='-O2 -g -ftls-model=global-dynamic';$env:CGO_CXXFLAGS=$env:CGO_CFLAGS;$env:CGO_LDFLAGS=''
    $taskFlags='-s -w -linkmode external -extldflags "-Wl,--version-script='+(Join-Path $taskStage 'exports.map').Replace('\','/')+' -Wl,-z,lazy"'
    $taskSo=Join-Path $taskStage 'libharmonygo_smoke.so'
    Push-Location $taskStage
    try {
        & $taskGo build -trimpath "-ldflags=$taskFlags" -buildmode=c-shared -o $taskSo . 2>&1 | Tee-Object -FilePath (Join-Path $taskOutput 'build.log')
        if($LASTEXITCODE -ne 0){throw 'Minimal OHOS c-shared compilation failed.'}
    } finally {Pop-Location}
    $taskElf=(& (Join-Path $taskNative 'llvm\bin\llvm-readelf.exe') -h -l -d -r $taskSo) -join "`n"
    if($LASTEXITCODE -ne 0 -or $taskElf -notmatch 'AArch64' -or $taskElf -notmatch ' TLS ' -or $taskElf -notmatch 'R_AARCH64_TLSDESC' -or $taskElf -match 'R_AARCH64_TLS_TPREL64'){throw 'Minimal library ELF/TLS requirements not met.'}
    $taskExports=@((& (Join-Path $taskNative 'llvm\bin\llvm-nm.exe') -D --defined-only $taskSo) | ForEach-Object {($_ -split '\s+')[-1]} | Sort-Object)
    if(Compare-Object $taskExports @('HarmonyGoSmoke','HarmonyGoSmokeFree')){throw 'Unexpected smoke library exports.'}
    Copy-Item -LiteralPath $taskSo -Destination $taskOutput
    $taskElf | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskOutput 'readelf.txt')
    $taskRecord=@{builtAtUtc=[DateTime]::UtcNow.ToString('o');sourceBase='3cc00d9c2b8ac231a5432ececa784814cc1eb075';compiler=((& $taskGo version) -join '');target='openharmony/arm64';buildFlags=$taskFlags;cc=$env:CC;exports=$taskExports;sha256=(Get-FileHash -Algorithm SHA256 $taskSo).Hash.ToLowerInvariant();bytes=(Get-Item $taskSo).Length;tlsdescRelocationCount=([regex]::Matches($taskElf,'R_AARCH64_TLSDESC')).Count;initialExecTlsRelocationCount=0;hasProgramTls=$true;runtimeTestsPassed=$false;plannedRuntimeChecks=@('foreign pthread C->Go entries','C->Go->C paths','R19-R28 sentinel preservation in external loader','goroutine creation','stack growth','allocation and GC consistency');abi='char* HarmonyGoSmoke(void); void HarmonyGoSmokeFree(char*)';noDlclose=$true}
    $taskRecord | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskOutput 'build-verification.json')
    Write-Output 'MINIMAL_OHOS_GO126_BUILT_AND_ELF_VERIFIED; runtime execution still pending'
} finally {foreach($taskKey in $taskKeys){[Environment]::SetEnvironmentVariable($taskKey,$taskSaved[$taskKey],'Process')}}
