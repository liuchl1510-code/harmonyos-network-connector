# Exercise only the metadata exporter with local synthetic files. No native
# compilation, source downloads, phone access or real build-cache mutations.
$ErrorActionPreference='Stop'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskTokens=$null;$taskErrors=$null
$taskAst=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'build-xray26.ps1'),[ref]$taskTokens,[ref]$taskErrors)
if($taskErrors.Count){throw 'Build entry PowerShell syntax check failed.'}
$taskFunction=$taskAst.Find({param($node)$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Sync-XrayLicenseMetadata'},$true)
if(!$taskFunction){throw 'Metadata exporter was not found.'}
. ([scriptblock]::Create($taskFunction.Extent.Text))
$taskTestRoot=Join-Path $taskProject ('build\license-metadata-tests\'+[Guid]::NewGuid().ToString('N'))
$taskArtifacts=Join-Path $taskTestRoot 'candidate'
$taskDependencies=Join-Path $taskArtifacts 'licenses\dependencies'
$taskDestination=Join-Path $taskTestRoot 'exported'
New-Item -ItemType Directory -Force -Path $taskDependencies | Out-Null
$taskNoticePath=Join-Path $taskDependencies 'example.test_module__LICENSE'
'Synthetic notice with a retained copyright line.' | Set-Content -Encoding utf8NoBOM -LiteralPath $taskNoticePath
foreach($taskName in @('libXray-MIT.txt','Go-BSD.txt')){
    'Synthetic component notice.' | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskArtifacts ('licenses\'+$taskName))
}
$taskExpectedHash='a'*64
$taskOriginalInventory=@{
    artifactSha256=$taskExpectedHash
    dependencies=@(@{
        module='example.test/module';version='v1.0.0';goSum='h1:synthetic'
        localReplacement='C:\synthetic\stage-xray-core'
        licenses=@(@{file='example.test_module__LICENSE';sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $taskNoticePath).Hash.ToLowerInvariant()})
    })
}
$taskInventoryPath=Join-Path $taskDependencies 'dependency-inventory.json'
function Write-SyntheticInventory { $taskOriginalInventory | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8NoBOM -LiteralPath $taskInventoryPath }
function Assert-Condition([bool]$Condition,[string]$Message){if(!$Condition){throw $Message}}
function Expect-ExportFailure([string]$Name,[string]$Hash=$taskExpectedHash){
    $taskRejected=$false
    try {Sync-XrayLicenseMetadata -ArtifactRoot $taskArtifacts -Destination (Join-Path $taskTestRoot $Name) -ArtifactHash $Hash}
    catch {$taskRejected=$true}
    Assert-Condition $taskRejected ($Name+' should be rejected')
    Assert-Condition (!(Test-Path -LiteralPath (Join-Path $taskTestRoot $Name))) ($Name+' wrote metadata before validation')
}
Write-SyntheticInventory
$taskModuleInfo="C:\synthetic\libxray.so: go1.26.7`n`tpath`texample.test/wrapper`n`tdep`texample.test/module`tv1.0.0`th1:synthetic`n`t=>`tC:\synthetic\stage-xray-core`t(devel)`n"
$taskModuleInfo | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskArtifacts 'module-info.txt')

Expect-ExportFailure 'wrong-artifact' ('b'*64)
'Changed notice.' | Set-Content -Encoding utf8NoBOM -LiteralPath $taskNoticePath
Expect-ExportFailure 'changed-notice'
'Synthetic notice with a retained copyright line.' | Set-Content -Encoding utf8NoBOM -LiteralPath $taskNoticePath
$taskOriginalInventory.dependencies[0].licenses[0].file='../outside.txt';Write-SyntheticInventory
Expect-ExportFailure 'unsafe-notice-path'
$taskOriginalInventory.dependencies[0].licenses[0].file='example.test_module__LICENSE';Write-SyntheticInventory
$taskModuleInfo.Replace('v1.0.0','v2.0.0') | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskArtifacts 'module-info.txt')
Expect-ExportFailure 'different-module-table'
$taskModuleInfo | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskArtifacts 'module-info.txt')

New-Item -ItemType Directory -Force -Path (Join-Path $taskDestination 'dependencies') | Out-Null
'Obsolete generated notice.' | Set-Content -LiteralPath (Join-Path $taskDestination 'dependencies\obsolete.txt')
'User-authored dependency notes.' | Set-Content -LiteralPath (Join-Path $taskDestination 'dependencies\notes.md')
'An old notice that the user later edited.' | Set-Content -LiteralPath (Join-Path $taskDestination 'dependencies\edited.txt')
'Preserve supplemental material.' | Set-Content -LiteralPath (Join-Path $taskDestination 'supplemental.txt')
$taskOldInventory=@{dependencies=@(@{licenses=@(
    @{file='obsolete.txt';sha256=(Get-FileHash -LiteralPath (Join-Path $taskDestination 'dependencies\obsolete.txt')).Hash.ToLowerInvariant()},
    @{file='edited.txt';sha256=('0'*64)},
    @{file='../supplemental.txt';sha256=(Get-FileHash -LiteralPath (Join-Path $taskDestination 'supplemental.txt')).Hash.ToLowerInvariant()}
)})}
$taskOldInventory | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskDestination 'dependencies\dependency-inventory.json')
Sync-XrayLicenseMetadata -ArtifactRoot $taskArtifacts -Destination $taskDestination -ArtifactHash $taskExpectedHash -SupplementalLicenseRoot (Join-Path $taskProject 'native\xray26\licenses')
$taskExport=Get-Content -Raw -LiteralPath (Join-Path $taskDestination 'dependencies\dependency-inventory.json') | ConvertFrom-Json
Assert-Condition ($taskExport.artifactSha256 -eq $taskExpectedHash) 'Export artifact identity changed'
Assert-Condition ($taskExport.dependencies[0].localReplacement -eq '${BuildRoot}/stage-xray-core') 'Portable replacement was not preserved'
Assert-Condition ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskDestination 'dependencies\example.test_module__LICENSE')).Hash.ToLowerInvariant() -eq $taskOriginalInventory.dependencies[0].licenses[0].sha256) 'Original notice bytes changed'
Assert-Condition (!(Test-Path -LiteralPath (Join-Path $taskDestination 'dependencies\obsolete.txt'))) 'Stale generated notice remained'
Assert-Condition (Test-Path -LiteralPath (Join-Path $taskDestination 'dependencies\notes.md')) 'An unknown user file was removed'
Assert-Condition (Test-Path -LiteralPath (Join-Path $taskDestination 'dependencies\edited.txt')) 'A locally edited old notice was removed'
Assert-Condition (Test-Path -LiteralPath (Join-Path $taskDestination 'supplemental.txt')) 'Supplemental file was removed'
Assert-Condition ((Get-Content -Raw -LiteralPath (Join-Path $taskDestination 'module-info.txt')) -notmatch 'C:\\synthetic') 'Machine-specific module paths remained'
foreach($taskName in @('GPL-3.0.txt','LGPL-3.0.txt','license-texts-provenance.json')){
    Assert-Condition ((Get-FileHash -LiteralPath (Join-Path $taskDestination $taskName)).Hash -eq (Get-FileHash -LiteralPath (Join-Path $taskProject ('native\xray26\licenses\'+$taskName))).Hash) ($taskName+' did not accompany custom metadata')
}
foreach($taskOldState in @('missing','malformed')){
    $taskPreservedDestination=Join-Path $taskTestRoot ('preserve-'+$taskOldState)
    $taskPreservedDependencies=Join-Path $taskPreservedDestination 'dependencies'
    New-Item -ItemType Directory -Force -Path $taskPreservedDependencies | Out-Null
    'Unknown handwritten file.' | Set-Content -LiteralPath (Join-Path $taskPreservedDependencies 'handwritten.txt')
    if($taskOldState -eq 'malformed'){'{' | Set-Content -LiteralPath (Join-Path $taskPreservedDependencies 'dependency-inventory.json')}
    Sync-XrayLicenseMetadata -ArtifactRoot $taskArtifacts -Destination $taskPreservedDestination -ArtifactHash $taskExpectedHash
    Assert-Condition (Test-Path -LiteralPath (Join-Path $taskPreservedDependencies 'handwritten.txt')) ($taskOldState+' old inventory caused an unknown file to be removed')
    $taskPreservedExport=Get-Content -Raw -LiteralPath (Join-Path $taskPreservedDependencies 'dependency-inventory.json') | ConvertFrom-Json
    Assert-Condition ($taskPreservedExport.artifactSha256 -eq $taskExpectedHash) ($taskOldState+' old inventory prevented a valid new snapshot')
    Assert-Condition ((Get-FileHash -LiteralPath (Join-Path $taskPreservedDependencies 'example.test_module__LICENSE')).Hash.ToLowerInvariant() -eq $taskOriginalInventory.dependencies[0].licenses[0].sha256) ($taskOldState+' old inventory changed the new notice bytes')
}
[pscustomobject]@{suite='xray-license-metadata';passed=7;failed=0;scope='Synthetic export, four rejection cases, and missing/malformed old inventory preservation; no compilation, downloads or phone access'} | ConvertTo-Json -Compress
