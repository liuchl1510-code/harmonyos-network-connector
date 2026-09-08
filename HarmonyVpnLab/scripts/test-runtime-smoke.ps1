param(
    [ValidateSet('fixtures','go')][string]$Mode = 'fixtures',
    [string]$HdcPath = 'C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskOutput = Join-Path $taskProject 'build\runtime-smoke'
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskTargets = @(& $HdcPath list targets -v | Where-Object { $_ -match '\sUSB\s+Connected\s' })
if ($taskTargets.Count -ne 1) { throw 'Expected one USB Connected test device.' }
$taskDevice = ($taskTargets[0] -split '\s+')[0]
$taskPrior = @(& $HdcPath -t $taskDevice shell hilog -x -T HarmonyVpnLab | Where-Object { $_ -match 'RUNTIME_SMOKE_BEGIN' } | Select-Object -Last 1)
& $HdcPath -t $taskDevice shell aa force-stop com.example.harmonyvpnlab | Out-Null
$taskStart = (& $HdcPath -t $taskDevice shell aa start -a EntryAbility -b com.example.harmonyvpnlab --ps runtimeSmoke $Mode) -join "`n"
if ($taskStart -notmatch 'start ability successfully') {
    if ($taskStart -match '10106102') { throw 'Phone screen is locked. Unlock it before running the runtime smoke.' }
    throw 'Runtime smoke ability did not start.'
}
$taskDeadline = (Get-Date).AddSeconds(18)
$taskRunId = ''
$taskRunLogs = @()
do {
    Start-Sleep -Milliseconds 700
    $taskLines = @(& $HdcPath -t $taskDevice shell hilog -x -T HarmonyVpnLab)
    $taskBegin = @($taskLines | Where-Object { $_ -match "RUNTIME_SMOKE_BEGIN runId=\d+ mode=$Mode" } | Select-Object -Last 1)
    if ($taskBegin.Count -eq 1 -and ($taskPrior.Count -eq 0 -or $taskBegin[0] -ne $taskPrior[0])) {
        $taskRunId = [regex]::Match($taskBegin[0], 'runId=(\d+)').Groups[1].Value
        $taskRunLogs = @($taskLines | Where-Object { $_ -match "RUNTIME_SMOKE_.*runId=$taskRunId\b" })
        if (($taskRunLogs -join "`n") -match 'RUNTIME_SMOKE_VERDICT|RUNTIME_SMOKE_ERROR') { break }
    }
} while ((Get-Date) -lt $taskDeadline)
$taskPassed = $taskRunId.Length -gt 0 -and ($taskRunLogs -join "`n") -match "RUNTIME_SMOKE_VERDICT runId=$taskRunId mode=$Mode passed=true"
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskLogName = "$taskStamp-$Mode.log"
$taskRunLogs | Set-Content -LiteralPath (Join-Path $taskOutput $taskLogName) -Encoding utf8
[ordered]@{recordedAt=(Get-Date).ToString('o'); mode=$Mode; runId=$taskRunId; passed=$taskPassed; log=$taskLogName; freshProcess=$true; usesVpn=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskOutput "$taskStamp-$Mode.json") -Encoding utf8
$taskRunLogs
if (!$taskPassed) { throw 'Runtime smoke did not produce a new passing verdict. Inspect its saved log.' }
