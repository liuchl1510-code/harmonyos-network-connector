param(
    [ValidateSet('Inspect','StartApp','StartGlobal','Start','Check','Ipv6','Resolve','Reconnect','Stop','Browser')][string]$Mode='Inspect',
    [string]$HdcPath='C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
)
$ErrorActionPreference='Stop'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskOutput=Join-Path $taskProject 'build\connection-tests'
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskTargets=@(& $HdcPath list targets -v | Where-Object {$_ -match '\sUSB\s+Connected\s'})
if($taskTargets.Count -ne 1){throw 'Expected one USB Connected phone.'}
$taskDevice=($taskTargets[0] -split '\s+')[0]
$taskStamp=Get-Date -Format 'yyyyMMdd-HHmmss'

function Flatten-ConnectionNodes($taskNode) {
    if($taskNode.attributes){Write-Output $taskNode.attributes}
    foreach($taskChild in $taskNode.children){Flatten-ConnectionNodes $taskChild}
}
function Read-ConnectionLayout {
    $taskRemote='/data/local/tmp/harmonyvpnlab-connection-layout.json'
    try {
        & $HdcPath -t $taskDevice shell uitest dumpLayout -p $taskRemote | Out-Null
        $taskJson=(& $HdcPath -t $taskDevice shell cat $taskRemote) -join "`n"
    } finally { & $HdcPath -t $taskDevice shell rm -f $taskRemote | Out-Null }
    try {$taskNodes=@(Flatten-ConnectionNodes ($taskJson | ConvertFrom-Json))}catch{throw 'Cannot read app layout. Keep the phone unlocked and app foreground.'}
    if(@($taskNodes | Where-Object {$_.id -eq 'nodeInput'}).Count -gt 0){throw 'Private node form is open. Return to the connection page first.'}
    if(@($taskNodes | Where-Object {$_.visible -eq 'true'}).Count -eq 0){throw 'App UI unavailable: unlock/foreground the app or handle its permission dialog.'}
    if(@($taskNodes | Where-Object {$_.visible -eq 'true' -and $_.id -in @('homePage','toggleConnection','connectionState','startConnectionAppTest')}).Count -eq 0){throw 'The current foreground UI is not the connection page; no input was sent.'}
    return $taskNodes
}
function Click-ConnectionControl([string]$taskId) {
    $taskDirections=if($taskId -in @('checkConnection','startConnectionTest','startConnectionAppTest','checkConnectionIpv6','checkPhysicalResolver')){@('down','up')}else{@('up','down')}
    foreach($taskDirection in $taskDirections){
        for($taskAttempt=0;$taskAttempt -lt 6;$taskAttempt++){
            $taskNodes=Read-ConnectionLayout
            if($Mode -eq 'Check' -and @($taskNodes | Where-Object {$_.id -eq 'connectionState' -and $_.visible -eq 'true' -and $_.text -ne '已连接'}).Count -gt 0) {
                throw 'Connection is not active; no connectivity check was requested.'
            }
            $taskMatches=@($taskNodes | Where-Object {$_.id -eq $taskId -and $_.visible -eq 'true'})
            if($taskMatches.Count -eq 1){
                if($taskMatches[0].enabled -ne 'true'){throw "Control is disabled: $taskId"}
                if($taskId -eq 'toggleConnection'){
                    if($Mode -eq 'Stop' -and $taskMatches[0].text -ne '断开'){return}
                    if($Mode -eq 'Start' -and $taskMatches[0].text -ne '连接'){throw 'Connection already active; refusing to toggle it off.'}
                }
                $taskBounds=@([regex]::Matches($taskMatches[0].bounds,'-?\d+') | ForEach-Object {[int]$_.Value})
                & $HdcPath -t $taskDevice shell uitest uiInput click ([int](($taskBounds[0]+$taskBounds[2])/2)) ([int](($taskBounds[1]+$taskBounds[3])/2)) | Out-Null
                return
            }
            $taskScroll=@($taskNodes | Where-Object {$_.type -eq 'Scroll' -and $_.visible -eq 'true'})
            if($taskScroll.Count -ne 1){throw 'Expected the connection page scroll view.'}
            $taskBounds=@([regex]::Matches($taskScroll[0].bounds,'-?\d+') | ForEach-Object {[int]$_.Value})
            $taskX=[int](($taskBounds[0]+$taskBounds[2])/2)
            $taskTop=[int]($taskBounds[1]+0.2*($taskBounds[3]-$taskBounds[1]))
            $taskBottom=[int]($taskBounds[1]+0.8*($taskBounds[3]-$taskBounds[1]))
            if($taskDirection -eq 'up'){& $HdcPath -t $taskDevice shell uitest uiInput swipe $taskX $taskTop $taskX $taskBottom | Out-Null}
            else{& $HdcPath -t $taskDevice shell uitest uiInput swipe $taskX $taskBottom $taskX $taskTop | Out-Null}
        }
    }
    throw "Cannot find current control: $taskId"
}
$taskId=switch($Mode){'StartApp'{'startConnectionAppTest'} 'StartGlobal'{'startConnectionTest'} 'Start'{'toggleConnection'} 'Check'{'checkConnection'} 'Ipv6'{'checkConnectionIpv6'} 'Resolve'{'checkPhysicalResolver'} 'Reconnect'{'reconnectConnection'} 'Stop'{'toggleConnection'} 'Browser'{'checkOtherApp'} default{''}}
if($Mode -in @('StartApp','StartGlobal','Ipv6','Resolve','Browser')) {
    $taskInitialNodes=Read-ConnectionLayout
    if(@($taskInitialNodes | Where-Object {$_.id -eq 'homePage'}).Count -gt 0 -and
       @($taskInitialNodes | Where-Object {$_.id -eq 'backFromDeveloperTools'}).Count -eq 0) {
        & 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' (Join-Path $PSScriptRoot 'test-product-ui-device.cjs') Developer
        if($LASTEXITCODE -ne 0){throw 'Cannot open developer tools safely.'}
    }
}
if($taskId){Click-ConnectionControl $taskId; Start-Sleep -Milliseconds 700}
if($Mode -eq 'Browser'){Write-Output 'Requested system browser check; inspect that app separately.';return}
$taskDeadline=(Get-Date).AddSeconds(16)
do {
    $taskNodes=Read-ConnectionLayout
    $taskState=@($taskNodes | Where-Object {$_.id -eq 'connectionState'} | Select-Object -ExpandProperty text)
    $taskCheck=@($taskNodes | Where-Object {$_.id -eq 'connectionCheckResult'} | Select-Object -ExpandProperty text)
    $taskPending=($Mode -in @('StartApp','StartGlobal','Start','Reconnect') -and (($taskState -contains '正在连接') -or ($taskState -contains '正在恢复连接'))) -or
        ($Mode -eq 'Stop' -and $taskState -contains '正在断开') -or
        ($Mode -in @('Check','Ipv6','Resolve') -and (($taskCheck -join '') -match '^正在'))
    if(!$taskPending){break}
    Start-Sleep -Milliseconds 700
}while((Get-Date) -lt $taskDeadline)
$taskNodes | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskOutput "$taskStamp-$Mode-layout.json") -Encoding utf8
$taskLines=@(& $HdcPath -t $taskDevice shell hilog -x -T HarmonyVpnLab)
$taskLines | Set-Content -LiteralPath (Join-Path $taskOutput "$taskStamp-$Mode.log") -Encoding utf8
$taskNodes | Where-Object {$_.id -in @('connectionState','connectionNetwork','toggleConnection','connectionCheckResult','connectionExitMarker','ipv6BlockedCount','dnsRequestCount') -and $_.visible -eq 'true'} | Select-Object id,text,enabled | ConvertTo-Json -Depth 3
$taskLines | Select-Object -Last 14
