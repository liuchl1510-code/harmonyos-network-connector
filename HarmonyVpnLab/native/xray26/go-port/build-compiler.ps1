param(
    [string]$SourceRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-go126-port\src-go'),
    [string]$BootstrapRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray\bootstrap\go')
)
$ErrorActionPreference='Stop'
$taskKeys=@('GOROOT_BOOTSTRAP','GOROOT','GOTOOLCHAIN','GOENV','GOOS','GOARCH','CGO_ENABLED','GOCACHE')
$taskSaved=@{}
foreach($taskKey in $taskKeys){$taskSaved[$taskKey]=[Environment]::GetEnvironmentVariable($taskKey,'Process')}
$taskLogDir=Join-Path (Split-Path $SourceRoot) 'logs'
New-Item -ItemType Directory -Force -Path $taskLogDir | Out-Null
$taskLog=Join-Path $taskLogDir ('bootstrap-'+(Get-Date).ToString('yyyyMMdd-HHmmss')+'.log')
try {
    $env:GOROOT_BOOTSTRAP=$BootstrapRoot;$env:GOROOT=$null;$env:GOTOOLCHAIN='local';$env:GOENV='off'
    $env:GOOS='windows';$env:GOARCH='amd64';$env:CGO_ENABLED='0';$env:GOCACHE=Join-Path (Split-Path $SourceRoot) 'cache\compiler'
    Push-Location -LiteralPath (Join-Path $SourceRoot 'src')
    try {
        & .\make.bat 2>&1 | ForEach-Object {
            $taskLine=$_.ToString()
            Add-Content -Encoding utf8NoBOM -LiteralPath $taskLog -Value $taskLine
            if($taskLine.Length -lt 1200){Write-Output $taskLine}
        }
        $taskExit=$LASTEXITCODE
    } finally {Pop-Location}
    Write-Output "BootstrapLog=$taskLog"
    if($taskExit -ne 0){throw "Port compiler bootstrap failed (exit $taskExit); full diagnostics are in the log."}
} finally {foreach($taskKey in $taskKeys){[Environment]::SetEnvironmentVariable($taskKey,$taskSaved[$taskKey],'Process')}}
