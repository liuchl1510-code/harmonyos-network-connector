param(
    [Parameter(Mandatory=$true)][string]$BuildRoot,
    [Parameter(Mandatory=$true)][string]$CacheRoot
)
$ErrorActionPreference='Stop'
$taskLock=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'sources.lock.json') | ConvertFrom-Json
$taskArchive=Join-Path $BuildRoot $taskLock.libXray.archiveName
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
if(Test-Path -LiteralPath $taskArchive){
    if((Get-FileHash -Algorithm SHA256 $taskArchive).Hash.ToLowerInvariant() -ne $taskLock.libXray.archiveSHA256){throw 'Cached libXray archive does not match pinned source.'}
    return
}
$taskRepo=Join-Path $CacheRoot 'sources\libXray'
if(!(Test-Path -LiteralPath (Join-Path $taskRepo '.git'))){
    $taskRepo=Join-Path $BuildRoot 'sources\libXray'
    if(!(Test-Path -LiteralPath (Join-Path $taskRepo '.git'))){
        & git -c http.sslBackend=openssl clone --no-checkout $taskLock.libXray.repository $taskRepo
        if($LASTEXITCODE -ne 0){throw 'Pinned wrapper repository clone failed.'}
    }
}
& git -c ('safe.directory='+$taskRepo.Replace('\','/')) -C $taskRepo cat-file -e ($taskLock.libXray.commit+'^{commit}')
if($LASTEXITCODE -ne 0){
    & git -c http.sslBackend=openssl -c ('safe.directory='+$taskRepo.Replace('\','/')) -C $taskRepo fetch --depth 1 origin $taskLock.libXray.commit
    if($LASTEXITCODE -ne 0){throw 'Pinned wrapper commit fetch failed.'}
}
& git -c ('safe.directory='+$taskRepo.Replace('\','/')) -C $taskRepo archive --format=tar ('--output='+$taskArchive) $taskLock.libXray.commit
if($LASTEXITCODE -ne 0){throw 'Pinned wrapper archive creation failed.'}
if((Get-FileHash -Algorithm SHA256 $taskArchive).Hash.ToLowerInvariant() -ne $taskLock.libXray.archiveSHA256){throw 'Created wrapper archive differs from verified archive.'}
