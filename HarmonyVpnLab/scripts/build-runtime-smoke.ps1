param([string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio')
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskSource = Join-Path $taskProject 'native\runtime-smoke'
$taskOutput = Join-Path $taskProject 'build\runtime-smoke'
$taskSdk = Join-Path $DevEcoPath 'sdk\default\openharmony\native'
$taskClang = Join-Path $taskSdk 'llvm\bin\clang.exe'
$taskReadElf = Join-Path $taskSdk 'llvm\bin\llvm-readelf.exe'
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskFlags = @('--target=aarch64-linux-ohos', ('--sysroot=' + (Join-Path $taskSdk 'sysroot')), '-O2', '-Wall', '-Wextra', '-Werror', '-fvisibility=hidden')
& $taskClang @taskFlags -fPIE -pie (Join-Path $taskSource 'loader.c') (Join-Path $taskSource 'checked_call.S') -pthread -ldl -o (Join-Path $taskOutput 'runtime-smoke-loader')
if ($LASTEXITCODE -ne 0) { throw 'Runtime loader build failed.' }
& $taskClang @taskFlags -fPIC -shared (Join-Path $taskSource 'fixture.c') -o (Join-Path $taskOutput 'libsmoke-good.so')
if ($LASTEXITCODE -ne 0) { throw 'Positive control build failed.' }
& $taskClang @taskFlags -fPIC -shared -DSMOKE_BROKEN (Join-Path $taskSource 'fixture.c') (Join-Path $taskSource 'broken_fixture.S') -o (Join-Path $taskOutput 'libsmoke-broken.so')
if ($LASTEXITCODE -ne 0) { throw 'Negative control build failed.' }
$taskFiles = @('runtime-smoke-loader', 'libsmoke-good.so', 'libsmoke-broken.so')
$taskRecords = foreach ($taskName in $taskFiles) {
    $taskFile = Join-Path $taskOutput $taskName
    $taskElf = (& $taskReadElf --file-header $taskFile) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $taskElf -notmatch 'AArch64') { throw 'Unexpected ELF target.' }
    [ordered]@{name=$taskName; sha256=(Get-FileHash -LiteralPath $taskFile).Hash.ToLowerInvariant(); bytes=(Get-Item -LiteralPath $taskFile).Length}
}
[ordered]@{builtAt=(Get-Date).ToString('o'); target='aarch64-linux-ohos'; files=$taskRecords; deviceValidated=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskOutput 'build-verification.json') -Encoding utf8
$taskPackagedLibs = Join-Path $taskProject 'entry\libs\arm64-v8a'
New-Item -ItemType Directory -Force -Path $taskPackagedLibs | Out-Null
Copy-Item -LiteralPath (Join-Path $taskOutput 'libsmoke-good.so'), (Join-Path $taskOutput 'libsmoke-broken.so') -Destination $taskPackagedLibs
Write-Output 'Built ARM64 loader and positive/negative native controls. Device validation remains required.'
