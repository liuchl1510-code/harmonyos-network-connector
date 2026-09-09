$ErrorActionPreference='Stop'
$taskSource=Join-Path $PSScriptRoot 'test-connection.ps1'
$taskTokens=$null; $taskErrors=$null
$taskAst=[Management.Automation.Language.Parser]::ParseFile($taskSource,[ref]$taskTokens,[ref]$taskErrors)
if($taskErrors.Count){throw 'Connection driver syntax failed'}
# Define only these pure functions from the authored driver; never run its body.
$taskNames=@('Select-ConnectionTarget','Flatten-ConnectionNodes')
$taskFunctions=@($taskAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true) |
    Where-Object {$_.Name -in $taskNames})
if($taskFunctions.Count -ne 2){throw 'Pure driver helper functions not found'}
foreach($taskFunction in $taskFunctions){. ([scriptblock]::Create($taskFunction.Extent.Text))}
function Assert-Test($value, [string]$label){if(!$value){throw $label}}
function Assert-Reject([scriptblock]$operation){$taskRejected=$false;try{& $operation | Out-Null}catch{$taskRejected=$true};Assert-Test $taskRejected 'Expected rejection'}
$taskPhone='SYNTHETIC_PHONE USB Connected phone'
$taskTablet='SYNTHETIC_TABLET USB Connected tablet'
$taskLines=@($taskPhone,$taskTablet,'127.0.0.1:15555 TCP Connected emulator','OFFLINE_USB USB Offline unavailable')
Assert-Test ((Select-ConnectionTarget -Lines @($taskTablet)) -ceq 'SYNTHETIC_TABLET') 'Unique USB fallback failed'
Assert-Test ((Select-ConnectionTarget -Lines $taskLines -Requested 'SYNTHETIC_TABLET') -ceq 'SYNTHETIC_TABLET') 'Explicit target failed'
Assert-Reject {Select-ConnectionTarget -Lines $taskLines}
Assert-Reject {Select-ConnectionTarget -Lines @()}
foreach($taskTarget in @('OFFLINE_USB','127.0.0.1:15555','MISSING','synthetic_tablet','TABLET','bad id','--target')){
    Assert-Reject {Select-ConnectionTarget -Lines $taskLines -Requested $taskTarget}
}
Assert-Reject {Select-ConnectionTarget -Lines @($taskPhone) -Requested 'SYNTHETIC_TABLET' -Current 'SYNTHETIC_TABLET'}
Assert-Reject {Select-ConnectionTarget -Lines @($taskPhone) -Current 'SYNTHETIC_TABLET'}
Assert-Reject {Select-ConnectionTarget -Lines @($taskTablet,$taskTablet) -Requested 'SYNTHETIC_TABLET'}
$taskTree=@'
{"children":[{"attributes":{"id":"appSideNavigation","type":"Scroll","visible":"true","bounds":"[0,0][176,900]"},"children":[{"attributes":{"id":"nestedSide","type":"Scroll","visible":"true"}},{"attributes":{"id":"nodeInput","type":"TextInput","visible":"true"}},{"attributes":{"id":"permissiondialog","type":"Dialog","visible":"true"}},{"attributes":{"id":"navHome","visible":"true"}}]},{"attributes":{"id":"body","type":"Scroll","visible":"true","bounds":"[176,0][1280,900]"}}]}
'@ | ConvertFrom-Json
$taskFlattened=@(Flatten-ConnectionNodes $taskTree)
$taskBody=@($taskFlattened | Where-Object {$_.type -eq 'Scroll' -and $_.visible -eq 'true' -and !$_.connectionSidebar})
Assert-Test ($taskBody.Count -eq 1 -and $taskBody[0].bounds -eq '[176,0][1280,900]') 'Wrong body scroll'
foreach($taskPreserved in @('nodeInput','permissiondialog','navHome')){
    Assert-Test (@($taskFlattened | Where-Object {$_.id -eq $taskPreserved}).Count -eq 1) 'Sidebar descendant was discarded'
}
$taskParameters=@($taskAst.ParamBlock.Parameters | ForEach-Object {$_.Name.VariablePath.UserPath})
Assert-Test ($taskParameters -contains 'TargetDevice') 'Missing TargetDevice parameter'
$taskChildCalls=@($taskAst.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.Extent.Text -match 'test-product-ui-device\.cjs' -and $node.Extent.Text -match '\bDeveloper\b'},$true))
Assert-Test ($taskChildCalls.Count -eq 1 -and $taskChildCalls[0].Extent.Text -match 'Developer --target \$taskDevice') 'Developer target was not forwarded'
Write-Output 'PASS PowerShell target validation, sidebar traversal, parameter and child-target forwarding fixtures; deviceContacted=false'
