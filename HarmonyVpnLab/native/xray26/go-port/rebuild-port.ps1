param(
    [string]$WorkingRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-go126-port'),
    [string]$BaseCheckout = (Join-Path $env:TEMP 'HarmonyVpnLab-xray-next\sources\ohos-go'),
    [string]$BootstrapRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray\bootstrap\go'),
    [string]$PythonPath = 'C:\Python314\python.exe',
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$SourceRoot = '',
    [switch]$ValidateCacheOnly,
    [switch]$ForceRebuild
)
$ErrorActionPreference='Stop'
if($WorkingRoot -match '[^\x00-\x7F]'){throw 'Use an ASCII WorkingRoot for the Windows native toolchain.'}
$taskManifest=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'port-manifest.json') | ConvertFrom-Json
$taskPatch=Join-Path $PSScriptRoot $taskManifest.finalPatchFile
if((Get-FileHash -Algorithm SHA256 $taskPatch).Hash.ToLowerInvariant() -ne $taskManifest.finalPatchSHA256){throw 'Frozen compiler patch SHA mismatch.'}
if(!$SourceRoot){$SourceRoot=Join-Path $WorkingRoot 'src-go'}
$taskSource=[IO.Path]::GetFullPath($SourceRoot);$taskArchive=Join-Path $WorkingRoot 'go126-original.tar'
$taskCacheJson=(& $PythonPath (Join-Path $PSScriptRoot 'verify-cache.py') $taskSource) -join "`n"
if($LASTEXITCODE -ne 0){throw $taskCacheJson}
$taskCache=$taskCacheJson | ConvertFrom-Json
if($ValidateCacheOnly){Write-Output $taskCacheJson;return}
if($taskCache.cacheReady -and !$ForceRebuild){Write-Output "Reusing reviewed Go1.26.7 OHOS compiler: $taskSource";return}
New-Item -ItemType Directory -Force -Path $WorkingRoot | Out-Null
if(!(Test-Path -LiteralPath (Join-Path $BootstrapRoot 'bin\go.exe'))){
    $taskZip=Join-Path $WorkingRoot 'go1.24.6.windows-amd64.zip'
    if(!(Test-Path -LiteralPath $taskZip)){
        & $PythonPath -c 'import urllib.request,sys; urllib.request.urlretrieve("https://go.dev/dl/go1.24.6.windows-amd64.zip",sys.argv[1])' $taskZip
        if($LASTEXITCODE -ne 0){throw 'Official bootstrap download failed.'}
    }
    if((Get-FileHash -Algorithm SHA256 $taskZip).Hash.ToLowerInvariant() -ne '4fbc8af2cfca9e5059019b5150a426eb78e1e57718bf08f0e52b1c942a2782bf'){throw 'Official bootstrap SHA mismatch.'}
    & $PythonPath -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' $taskZip (Join-Path $WorkingRoot 'bootstrap')
    if($LASTEXITCODE -ne 0){throw 'Bootstrap extraction failed.'}
    $BootstrapRoot=Join-Path $WorkingRoot 'bootstrap\go'
}
if(!(Test-Path -LiteralPath $taskArchive)){
    if(!(Test-Path -LiteralPath (Join-Path $BaseCheckout '.git'))){
        $BaseCheckout=Join-Path $WorkingRoot 'base-source'
        & git -c http.sslBackend=openssl clone --no-checkout --depth 1 --branch release-branch.go1.26 https://gitcode.com/openharmony-sig/ohos_golang_go.git $BaseCheckout
        if($LASTEXITCODE -ne 0){throw 'Official Go fork source clone failed.'}
    }
    & git -c ('safe.directory='+$BaseCheckout.Replace('\','/')) -C $BaseCheckout cat-file -e ($taskManifest.baseCommit+'^{commit}')
    if($LASTEXITCODE -ne 0){
        & git -c http.sslBackend=openssl -c ('safe.directory='+$BaseCheckout.Replace('\','/')) -C $BaseCheckout fetch --depth 1 origin $taskManifest.baseCommit
        if($LASTEXITCODE -ne 0){throw 'Fixed compiler commit fetch failed.'}
    }
    & git -c ('safe.directory='+$BaseCheckout.Replace('\','/')) -C $BaseCheckout archive --format=tar ('--output='+$taskArchive) $taskManifest.baseCommit
    if($LASTEXITCODE -ne 0){throw 'Fixed compiler source archive failed.'}
}
if((Get-FileHash -Algorithm SHA256 $taskArchive).Hash.ToLowerInvariant() -ne $taskManifest.baseArchiveSHA256){throw 'Compiler base archive SHA mismatch.'}
if(!(Test-Path -LiteralPath (Join-Path $taskSource 'VERSION'))){
    & $PythonPath -c 'import pathlib,tarfile,sys; p=pathlib.Path(sys.argv[2]); p.mkdir(parents=True,exist_ok=True); tarfile.open(sys.argv[1]).extractall(p,filter="data")' $taskArchive $taskSource
    if($LASTEXITCODE -ne 0){throw 'Safe compiler source extraction failed.'}
    & git -C $taskSource apply --check $taskPatch
    if($LASTEXITCODE -ne 0){throw 'Final port patch does not match clean base.'}
    & git -C $taskSource apply $taskPatch
    if($LASTEXITCODE -ne 0){throw 'Final port patch application failed.'}
}
# A nonempty directory must already equal the reviewed port; never reset it.
& $PythonPath -c 'import pathlib,json,hashlib,sys; p=pathlib.Path(sys.argv[1]); d=json.loads(pathlib.Path(sys.argv[2]).read_text()); bad=[x["path"] for x in d["files"] if not (p/x["path"]).is_file() or hashlib.sha256((p/x["path"]).read_bytes().replace(b"\r\n",b"\n")).hexdigest()!=x["portedSHA256"]]; assert not bad, "Existing source differs from frozen port: "+str(bad)' $taskSource (Join-Path $PSScriptRoot 'port-manifest.json')
if($LASTEXITCODE -ne 0){throw 'Use a fresh WorkingRoot or review local source changes.'}
& (Join-Path $PSScriptRoot 'build-compiler.ps1') -SourceRoot $taskSource -BootstrapRoot $BootstrapRoot
$taskKeys=@('GOROOT','GOENV','GOTOOLCHAIN','GOOS','GOARCH','CGO_ENABLED','GOCACHE','GOPROXY','PATH')
$taskSaved=@{};foreach($taskKey in $taskKeys){$taskSaved[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey,'Process')}
try {
    $env:GOROOT=$taskSource;$env:GOENV='off';$env:GOTOOLCHAIN='local';$env:GOOS='windows';$env:GOARCH='amd64';$env:CGO_ENABLED='0';$env:GOPROXY='off';$env:GOCACHE=Join-Path $WorkingRoot 'cache\compiler';$env:PATH=(Join-Path $taskSource 'bin')+';'+$env:PATH
    $taskGo=Join-Path $taskSource 'bin\go.exe'
    & $taskGo generate internal/platform internal/goos
    if($LASTEXITCODE -ne 0){throw 'Official platform/GOOS generation verification failed.'}
    & $taskGo install cmd/asm cmd/compile cmd/link cmd/cgo cmd/go cmd/dist
    if($LASTEXITCODE -ne 0){throw 'Compiler tools refresh failed.'}
    & $taskGo test cmd/internal/obj/arm64 cmd/asm/internal/asm
    if($LASTEXITCODE -ne 0){throw 'ARM64 assembler regression tests failed.'}
    & $taskGo test runtime -run '^TestHeapAddrBitsValue$' -count=1
    if($LASTEXITCODE -ne 0){throw 'Heap-address-width host regression test failed.'}
    $taskTargets=@(& $taskGo tool dist list)
    if($taskTargets -notcontains 'openharmony/arm64'){throw 'Rebuilt compiler lacks requested target.'}
} finally {foreach($taskKey in $taskKeys){[Environment]::SetEnvironmentVariable($taskKey,$taskSaved[$taskKey],'Process')}}
& (Join-Path $PSScriptRoot 'build-smoke.ps1') -SourceRoot $taskSource -DevEcoPath $DevEcoPath
Write-Output 'Compiler and minimal OHOS library rebuilt from the frozen final patch.'
