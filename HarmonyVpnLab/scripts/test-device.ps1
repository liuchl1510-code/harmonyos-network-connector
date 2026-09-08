param(
    [ValidateSet('Observe', 'Request', 'Normal', 'EarlyStop', 'Hev', 'Xray', 'Node', 'RejectProtection', 'OpenConfig')][string]$Mode = 'Observe',
    [string]$HdcPath = 'C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
)
$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskOutput = Join-Path $taskProject 'build\device-tests'
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskTargets = @(& $HdcPath list targets -v | Where-Object { $_ -match '\sUSB\s+Connected\s' })
if ($taskTargets.Count -ne 1) { throw 'Expected exactly one USB Connected device.' }
$taskDevice = ($taskTargets[0] -split '\s+')[0]
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskBeforeLogs = @(& $HdcPath -t $taskDevice shell hilog -x -T HarmonyVpnLab)
$taskPriorRequest = @($taskBeforeLogs | Where-Object { $_ -match 'VPN_START_REQUESTED runId=' } | Select-Object -Last 1)

function Get-ProbeNodes($taskNode) {
    if ($taskNode.attributes) { Write-Output $taskNode.attributes }
    foreach ($taskChild in $taskNode.children) { Get-ProbeNodes $taskChild }
}

function Read-ProbeLayout([string]$taskLabel) {
    $taskDump = & $HdcPath -t $taskDevice shell uitest dumpLayout -b com.example.harmonyvpnlab -p /data/local/tmp/harmonyvpnlab-layout.json
    if (($taskDump -join "`n") -notmatch 'DumpLayout saved') { throw 'Cannot inspect the app window. Keep the device unlocked and the app foreground.' }
    $taskJson = (& $HdcPath -t $taskDevice shell cat /data/local/tmp/harmonyvpnlab-layout.json) -join "`n"
    $taskJson | Set-Content -LiteralPath (Join-Path $taskOutput "$taskStamp-$taskLabel.json") -Encoding utf8
    $taskNodes = @(Get-ProbeNodes ($taskJson | ConvertFrom-Json))
    if (@($taskNodes | Where-Object { $_.visible -eq 'true' }).Count -eq 0) {
        throw 'The app layout is empty. Keep the phone unlocked and open HarmonyVpnLab in the foreground before testing.'
    }
    return $taskNodes
}

function Click-ProbeButton([string]$taskId) {
    $taskButton = @()
    for ($taskAttempt = 0; $taskAttempt -lt 4; $taskAttempt++) {
        $taskNodes = Read-ProbeLayout $taskId
        $taskButton = @($taskNodes | Where-Object { $_.id -eq $taskId -and $_.enabled -eq 'true' -and $_.visible -eq 'true' })
        if ($taskButton.Count -eq 1) { break }
        if (@($taskNodes | Where-Object { $_.id -eq $taskId -and $_.enabled -eq 'false' }).Count -gt 0) {
            throw "Button is disabled: $taskId"
        }
        $taskScroll = @($taskNodes | Where-Object { $_.type -eq 'Scroll' -and $_.visible -eq 'true' })
        if ($taskScroll.Count -ne 1) { throw 'No unique scrollable app view.' }
        $taskViewport = @([regex]::Matches($taskScroll[0].bounds, '-?\d+') | ForEach-Object { [int]$_.Value })
        $taskMidX = [int](($taskViewport[0] + $taskViewport[2]) / 2)
        $taskUpperY = [int]($taskViewport[1] + 0.25 * ($taskViewport[3] - $taskViewport[1]))
        $taskLowerY = [int]($taskViewport[1] + 0.8 * ($taskViewport[3] - $taskViewport[1]))
        if ($taskId -match '^mode') {
            & $HdcPath -t $taskDevice shell uitest uiInput swipe $taskMidX $taskUpperY $taskMidX $taskLowerY | Out-Null
        } else {
            & $HdcPath -t $taskDevice shell uitest uiInput swipe $taskMidX $taskLowerY $taskMidX $taskUpperY | Out-Null
        }
    }
    if ($taskButton.Count -ne 1) { throw "No unique enabled button: $taskId" }
    $taskBounds = @([regex]::Matches($taskButton[0].bounds, '-?\d+') | ForEach-Object { [int]$_.Value })
    if ($taskBounds.Count -ne 4) { throw 'Unexpected button bounds.' }
    $taskX = [int][math]::Floor(($taskBounds[0] + $taskBounds[2]) / 2)
    $taskY = [int][math]::Floor(($taskBounds[1] + $taskBounds[3]) / 2)
    $taskClick = & $HdcPath -t $taskDevice shell uitest uiInput click $taskX $taskY
    if (($taskClick -join "`n") -notmatch 'No Error') { throw 'UI input failed.' }
}

if ($Mode -eq 'OpenConfig') {
    Click-ProbeButton 'openNodeConfig'
    Write-Output 'Requested local node import page. No form contents will be collected.'
    return
}
if ($Mode -ne 'Observe') {
    if ($Mode -eq 'Hev') { Click-ProbeButton 'modeHev' }
    elseif ($Mode -eq 'Xray') { Click-ProbeButton 'modeXray' }
    elseif ($Mode -in @('Normal', 'EarlyStop')) { Click-ProbeButton 'modeLifecycle' }
    if ($Mode -eq 'Node') { Click-ProbeButton 'startNodeProbe' }
    elseif ($Mode -eq 'RejectProtection') { Click-ProbeButton 'startRejectProbe' }
    else { Click-ProbeButton 'startVpnProbe' }
    if ($Mode -eq 'EarlyStop') {
        Start-Sleep -Milliseconds 900
        $taskActive = Read-ProbeLayout 'before-stop'
        if (@($taskActive | Where-Object { $_.text -eq '虚拟网卡已创建' }).Count -eq 0) {
            throw 'The VPN did not reach active state before the early-stop test.'
        }
        Click-ProbeButton 'stopVpnProbe'
        Start-Sleep -Seconds 2
    } elseif ($Mode -eq 'Node') {
        $taskDeadline = (Get-Date).AddSeconds(32)
        do {
            Start-Sleep -Seconds 1
            $taskProgress = Read-ProbeLayout 'progress'
            if (@($taskProgress | Where-Object { $_.text -in @('真实流量与清理检查通过', '本次检查失败', '已停止') }).Count -gt 0) { break }
        } while ((Get-Date) -lt $taskDeadline)
    } elseif ($Mode -in @('Normal', 'Hev', 'Xray', 'RejectProtection')) {
        Start-Sleep -Seconds 7
    }
}
$taskFinal = Read-ProbeLayout 'result'
$taskLogs = & $HdcPath -t $taskDevice shell hilog -x -T HarmonyVpnLab
$taskLogs | Set-Content -LiteralPath (Join-Path $taskOutput "$taskStamp-$Mode.log") -Encoding utf8
$taskFinal | Where-Object { $_.text } | Select-Object text,id,enabled | ConvertTo-Json -Depth 3
$taskLogs | Select-Object -Last 18
if ($Mode -eq 'Normal' -and @($taskFinal | Where-Object { $_.text -eq '网卡创建与释放检查通过' }).Count -eq 0) {
    throw 'Normal test did not report success. Inspect the saved logs; authorization may still require user input.'
}
if ($Mode -in @('Hev', 'Xray', 'Node') -and @($taskFinal | Where-Object { $_.text -eq '真实流量与清理检查通过' }).Count -eq 0) {
    throw 'Real traffic verification did not pass. Inspect the saved logs.'
}
if ($Mode -eq 'EarlyStop' -and @($taskFinal | Where-Object { $_.text -eq '已停止' }).Count -eq 0) {
    throw 'Early-stop test did not report stopped. Inspect the saved logs.'
}
if ($Mode -eq 'RejectProtection' -and @($taskFinal | Where-Object { $_.text -eq '拒绝保护检查通过' }).Count -eq 0) {
    throw 'Rejected-protection device check did not pass.'
}
if ($Mode -in @('Normal', 'EarlyStop', 'Hev', 'Xray', 'Node', 'RejectProtection')) {
    $taskRequests = @($taskLogs | Where-Object { $_ -match 'VPN_START_REQUESTED runId=' })
    if ($taskRequests.Count -eq 0 -or ($taskPriorRequest.Count -gt 0 -and $taskRequests[-1] -eq $taskPriorRequest[-1])) {
        throw 'No new start request was logged. A stale UI result does not pass this test.'
    }
    $taskRunId = [regex]::Match($taskRequests[-1], 'runId=(\d+)').Groups[1].Value
    $taskRequestIndex = [array]::LastIndexOf([string[]]$taskLogs, [string]$taskRequests[-1])
    $taskRunLogs = (@($taskLogs)[$taskRequestIndex..(@($taskLogs).Count - 1)]) -join "`n"
    $taskOutcome = if ($Mode -eq 'EarlyStop') { 'stopped' } else { 'passed' }
    $taskExpected = @(
        "VPN extension created, runId=$taskRunId",
        'protectProcessNet succeeded',
        'TUN FD inspection: TUN_FD_OK',
        'TUN FD closed',
        'VPN network destroy succeeded',
        "Probe state ${taskOutcome}:",
        "VPN extension destroyed, runId=$taskRunId"
    )
    $taskPosition = 0
    foreach ($taskMarker in $taskExpected) {
        $taskFound = $taskRunLogs.IndexOf($taskMarker, $taskPosition, [StringComparison]::Ordinal)
        if ($taskFound -lt 0) { throw "Missing or out-of-order lifecycle evidence: $taskMarker" }
        $taskPosition = $taskFound + $taskMarker.Length
    }
    if ($Mode -in @('Hev', 'Xray')) {
        foreach ($taskMarker in @('HEV_WORKER_STARTED', "TRANSFER_HTTP_OK runId=$taskRunId", 'TRANSFER_TOKEN_VERIFIED', 'HEV_STOPPED', 'FIXTURE_STOPPED requests=1')) {
            if (!$taskRunLogs.Contains($taskMarker)) { throw "Missing real-traffic evidence: $taskMarker" }
        }
    }
    if ($Mode -eq 'Xray') {
        foreach ($taskMarker in @('XRAY_VERSION', 'XRAY_STARTED', 'XRAY_STOPPED')) {
            if (!$taskRunLogs.Contains($taskMarker)) { throw "Missing Xray evidence: $taskMarker" }
        }
    }
    if ($Mode -eq 'Node') {
        foreach ($taskMarker in @('XRAY_NODE_STARTED', "NODE_HTTPS_OK runId=$taskRunId", 'NODE_TRAFFIC_CONFIRMED', 'HEV_STOPPED', 'XRAY_STOPPED')) {
            if (!$taskRunLogs.Contains($taskMarker)) { throw "Missing node traffic evidence: $taskMarker" }
        }
    }
    if ($Mode -eq 'RejectProtection') {
        foreach ($taskMarker in @('PROTECTION_REJECTION_VERIFIED', 'fixtureRequests=0 active=0', 'SOCKET_PROTECTION', 'succeeded=0', 'HEV_STOPPED', 'XRAY_STOPPED')) {
            if (!$taskRunLogs.Contains($taskMarker)) { throw "Missing rejected-protection evidence: $taskMarker" }
        }
    }
    [pscustomobject]@{mode=$Mode;runId=$taskRunId;result='passed';markers=$taskExpected} |
        ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $taskOutput "$taskStamp-$Mode-result.json") -Encoding utf8
}
