param(
    [Parameter(Mandatory)][ValidatePattern('^\d{13}$')][string]$RunId,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{8}$')][string]$ExpectedMarker,
    [string]$HdcPath='C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
)
$ErrorActionPreference='Stop'
$taskTargets=@(& $HdcPath list targets -v | Where-Object {$_ -match '\sUSB\s+Connected\s'})
if($taskTargets.Count -ne 1){throw 'Expected one USB Connected phone.'}
$taskDevice=($taskTargets[0] -split '\s+')[0]
$taskRemote='/data/local/tmp/harmonyvpnlab-browser-check.json'
try {
    & $HdcPath -t $taskDevice shell uitest dumpLayout -p $taskRemote | Out-Null
    $taskJson=(& $HdcPath -t $taskDevice shell cat $taskRemote) -join "`n"
} finally { & $HdcPath -t $taskDevice shell rm -f $taskRemote | Out-Null }
function Read-TaskNodes($n){if($n.attributes){$n.attributes};foreach($c in $n.children){Read-TaskNodes $c}}
$taskNodes=@(Read-TaskNodes ($taskJson | ConvertFrom-Json))
$taskTrace=@($taskNodes | Where-Object {$_.visible -eq 'true' -and $_.text -match '(?m)^h=www\.cloudflare\.com\r?$' -and $_.text -match '(?m)^visit_scheme=https\r?$'})
if($taskTrace.Count -ne 1){throw 'Expected one visible Cloudflare HTTPS trace in the foreground browser.'}
$taskIp=[regex]::Match($taskTrace[0].text,'(?m)^ip=([^\r\n]+)').Groups[1].Value.Trim()
$taskParsed=[System.Net.IPAddress]::None
if(![System.Net.IPAddress]::TryParse($taskIp,[ref]$taskParsed) -or $taskParsed.AddressFamily -ne 'InterNetwork'){throw 'Trace has no valid IPv4 exit.'}
$taskTraceTime=[double][regex]::Match($taskTrace[0].text,'(?m)^ts=([0-9.]+)').Groups[1].Value
$taskNow=[datetimeoffset]::UtcNow.ToUnixTimeSeconds()
if($taskTraceTime -lt ([double]$RunId/1000) -or $taskTraceTime -gt ($taskNow+10)){throw 'Trace timestamp does not belong to this connection session.'}
[uint64]$taskHash=2166136261
foreach($taskChar in ($RunId+'|'+$taskIp).ToCharArray()){$taskHash=(($taskHash -bxor [int]$taskChar)*16777619) -band 4294967295}
$taskMarker=$taskHash.ToString('x8')
$taskResult=[ordered]@{runId=$RunId;checkedAt=([datetimeoffset]::Now.ToString('o'));appMarker=$ExpectedMarker;browserMarker=$taskMarker;exitMatches=($taskMarker -eq $ExpectedMarker);browserHttps=$true;traceTimestamp=$taskTraceTime}
$taskDirectory=Join-Path (Split-Path -Parent $PSScriptRoot) 'build\connection-tests'
New-Item -ItemType Directory -Force -Path $taskDirectory | Out-Null
$taskResult | ConvertTo-Json | Set-Content (Join-Path $taskDirectory "$RunId-browser-exit.json") -Encoding utf8
$taskResult | ConvertTo-Json
if(!$taskResult.exitMatches){throw 'Browser and app exit markers do not match.'}
