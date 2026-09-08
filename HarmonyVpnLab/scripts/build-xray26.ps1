param(
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray26'),
    [string]$PythonPath = 'C:\Python314\python.exe',
    [string]$OutputPath = '',
    [string]$EvidencePath = '',
    [string]$LicenseOutputPath = '',
    [string]$PortRoot = '',
    [string]$CacheRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray'),
    [switch]$ValidateCacheOnly,
    [switch]$ForceCompilerRebuild
)
$ErrorActionPreference='Stop'

# Keep publication metadata bound to the candidate's exact SHA. The collector
# runs inside the build cache; this step verifies and exports its complete
# snapshot so a standard rebuild cannot silently leave old repository notices.
function Sync-XrayLicenseMetadata {
    param(
        [Parameter(Mandatory=$true)][string]$ArtifactRoot,
        [Parameter(Mandatory=$true)][string]$Destination,
        [Parameter(Mandatory=$true)][string]$ArtifactHash,
        [string]$SupplementalLicenseRoot = ''
    )
    $taskLicenseRoot=Join-Path $ArtifactRoot 'licenses'
    $taskDependencyRoot=Join-Path $taskLicenseRoot 'dependencies'
    $taskInventoryPath=Join-Path $taskDependencyRoot 'dependency-inventory.json'
    $taskInventory=Get-Content -Raw -LiteralPath $taskInventoryPath | ConvertFrom-Json -AsHashtable
    if($taskInventory.artifactSha256 -ne $ArtifactHash -or !$taskInventory.dependencies -or
        @($taskInventory.dependencies).Count -eq 0){throw 'License inventory does not identify the verified candidate.'}
    $taskFiles=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $taskDependencyIds=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach($taskDependency in $taskInventory.dependencies){
        if(!$taskDependency.module -or !$taskDependency.version -or
            !$taskDependencyIds.Add($taskDependency.module+'@'+$taskDependency.version) -or
            @($taskDependency.licenses).Count -eq 0){throw 'Invalid or incomplete dependency license entry.'}
        foreach($taskNotice in $taskDependency.licenses){
            $taskName=[string]$taskNotice.file
            if(!$taskName -or $taskName -in @('.','..','dependency-inventory.json') -or $taskName -match '[/\\:]' -or
                $taskName -ne [IO.Path]::GetFileName($taskName) -or
                $taskNotice.sha256 -notmatch '^[0-9a-f]{64}$'){
                throw 'Invalid dependency notice filename or hash.'
            }
            $taskNoticePath=Join-Path $taskDependencyRoot $taskName
            if(!(Test-Path -LiteralPath $taskNoticePath -PathType Leaf) -or
                (Get-FileHash -Algorithm SHA256 -LiteralPath $taskNoticePath).Hash.ToLowerInvariant() -ne $taskNotice.sha256){
                throw 'Dependency notice differs from its verified SHA256.'
            }
            $null=$taskFiles.Add($taskName)
        }
        if($taskDependency.ContainsKey('localReplacement')){
            $taskDependency.localReplacement='${BuildRoot}/stage-xray-core'
            $taskDependency.sourceRecipe='native/xray26/prepare.py'
        }
    }
    foreach($taskName in @('libXray-MIT.txt','Go-BSD.txt')){
        if(!(Test-Path -LiteralPath (Join-Path $taskLicenseRoot $taskName) -PathType Leaf)){
            throw 'Wrapper or compiler license text is missing.'
        }
    }
    $taskModuleLines=Get-Content -LiteralPath (Join-Path $ArtifactRoot 'module-info.txt')
    $taskModuleIds=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $taskPortableLines=@(foreach($taskLine in $taskModuleLines){
        $taskFields=$taskLine.Trim().Split("`t")
        if($taskFields.Count -ge 3 -and $taskFields[0] -eq 'dep'){
            $null=$taskModuleIds.Add($taskFields[1]+'@'+$taskFields[2])
        }
        if($taskLine -match '^.*[\\/]libxray\.so:\s*(go\S+)\s*$'){
            'libxray.so: '+$Matches[1]
        }elseif($taskFields.Count -ge 3 -and $taskFields[0] -eq '=>'){
            $taskFields[1]='${BuildRoot}/stage-xray-core'
            "`t"+($taskFields -join "`t")
        }else{$taskLine}
    })
    if(!$taskModuleIds.SetEquals($taskDependencyIds)){throw 'Module table and license inventory describe different dependencies.'}
    $taskInventory.normalization='Machine-local replacement paths use a portable BuildRoot placeholder; upstream versions, module sums and license bytes are unchanged.'
    $taskDestination=[IO.Path]::GetFullPath($Destination)
    if($taskDestination -eq [IO.Path]::GetFullPath($taskLicenseRoot)){
        throw 'LicenseOutputPath must be separate from the candidate build cache.'
    }
    if($SupplementalLicenseRoot){
        $taskSupplementalRoot=[IO.Path]::GetFullPath($SupplementalLicenseRoot)
        $taskProvenance=Get-Content -Raw -LiteralPath (Join-Path $taskSupplementalRoot 'license-texts-provenance.json') | ConvertFrom-Json
        foreach($taskSupplement in $taskProvenance.files){
            if($taskSupplement.file -notin @('GPL-3.0.txt','LGPL-3.0.txt') -or
                (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskSupplementalRoot $taskSupplement.file)).Hash.ToLowerInvariant() -ne $taskSupplement.sha256){
                throw 'Supplemental GNU license text differs from its provenance.'
            }
        }
        if(@($taskProvenance.files).Count -ne 2){throw 'Supplemental GNU license provenance is incomplete.'}
    }
    $taskTargetDependencies=Join-Path $taskDestination 'dependencies'
    # An output directory may also contain the user's own files. Only a notice
    # explicitly owned by the previous inventory is eligible for removal; an
    # absent or unreadable previous inventory grants no cleanup authority.
    $taskPreviousNotices=@{}
    $taskPreviousInventoryPath=Join-Path $taskTargetDependencies 'dependency-inventory.json'
    if(Test-Path -LiteralPath $taskPreviousInventoryPath -PathType Leaf){
        try {
            $taskPreviousInventory=Get-Content -Raw -LiteralPath $taskPreviousInventoryPath | ConvertFrom-Json
            foreach($taskPreviousDependency in $taskPreviousInventory.dependencies){
                foreach($taskPreviousNotice in $taskPreviousDependency.licenses){
                    $taskPreviousName=[string]$taskPreviousNotice.file
                    if(!$taskPreviousName -or $taskPreviousName -in @('.','..','dependency-inventory.json') -or
                        $taskPreviousName -match '[/\\:]' -or
                        $taskPreviousName -ne [IO.Path]::GetFileName($taskPreviousName) -or
                        $taskPreviousNotice.sha256 -notmatch '^[0-9a-f]{64}$'){continue}
                    $taskPreviousPath=[IO.Path]::GetFullPath((Join-Path $taskTargetDependencies $taskPreviousName))
                    if([IO.Path]::GetDirectoryName($taskPreviousPath) -ne [IO.Path]::GetFullPath($taskTargetDependencies)){continue}
                    $taskPreviousNotices[$taskPreviousName]=[string]$taskPreviousNotice.sha256
                }
            }
        } catch { $taskPreviousNotices=@{} }
    }
    New-Item -ItemType Directory -Force -Path $taskTargetDependencies | Out-Null
    foreach($taskName in $taskFiles){
        Copy-Item -LiteralPath (Join-Path $taskDependencyRoot $taskName) -Destination (Join-Path $taskTargetDependencies $taskName)
    }
    foreach($taskName in @('libXray-MIT.txt','Go-BSD.txt')){
        Copy-Item -LiteralPath (Join-Path $taskLicenseRoot $taskName) -Destination (Join-Path $taskDestination $taskName)
    }
    if($SupplementalLicenseRoot -and $taskSupplementalRoot -ne $taskDestination){
        foreach($taskName in @('GPL-3.0.txt','LGPL-3.0.txt','license-texts-provenance.json')){
            Copy-Item -LiteralPath (Join-Path $taskSupplementalRoot $taskName) -Destination (Join-Path $taskDestination $taskName)
        }
    }
    $taskPortableLines | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskDestination 'module-info.txt')
    $taskInventory | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM -LiteralPath (Join-Path $taskTargetDependencies 'dependency-inventory.json')
    # Retain unknown files and even previously generated notices that somebody
    # has edited. Cleanup is nonrecursive and remains inside this exact directory.
    foreach($taskPreviousName in $taskPreviousNotices.Keys){
        if($taskFiles.Contains($taskPreviousName)){continue}
        $taskPreviousPath=[IO.Path]::GetFullPath((Join-Path $taskTargetDependencies $taskPreviousName))
        if([IO.Path]::GetDirectoryName($taskPreviousPath) -ne [IO.Path]::GetFullPath($taskTargetDependencies)){continue}
        try {
            if((Test-Path -LiteralPath $taskPreviousPath -PathType Leaf) -and
                !((Get-Item -LiteralPath $taskPreviousPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                (Get-FileHash -Algorithm SHA256 -LiteralPath $taskPreviousPath).Hash.ToLowerInvariant() -eq $taskPreviousNotices[$taskPreviousName]){
                Remove-Item -LiteralPath $taskPreviousPath
            }
        } catch { Write-Warning 'An obsolete generated notice was retained because it could not be safely removed.' }
    }
}

$taskProject=Split-Path -Parent $PSScriptRoot
$taskNative=Join-Path $taskProject 'native\xray26'
$taskLock=Get-Content -Raw -LiteralPath (Join-Path $taskNative 'sources.lock.json') | ConvertFrom-Json
if($BuildRoot -match '[^\x00-\x7F]'){throw 'BuildRoot must use an ASCII path for native cross-build tools.'}
$BuildRoot=[IO.Path]::GetFullPath($BuildRoot)
$taskCompilerRoot=Join-Path $BuildRoot 'go-toolchain'
if(!$PortRoot){$PortRoot=Join-Path $taskCompilerRoot 'src-go'}
$PortRoot=[IO.Path]::GetFullPath($PortRoot)
if(!$OutputPath){$OutputPath=Join-Path $taskProject 'entry\libs\arm64-v8a\libxray.so'}
if(!$EvidencePath){$EvidencePath=Join-Path $taskProject 'build\native\xray26-verification.json'}
$OutputPath=[IO.Path]::GetFullPath($OutputPath);$EvidencePath=[IO.Path]::GetFullPath($EvidencePath)
if(!$LicenseOutputPath){
    $taskCanonicalOutput=[IO.Path]::GetFullPath((Join-Path $taskProject 'entry\libs\arm64-v8a\libxray.so'))
    $LicenseOutputPath=if($OutputPath -eq $taskCanonicalOutput){Join-Path $taskNative 'licenses'}else{$OutputPath+'.licenses'}
}
$LicenseOutputPath=[IO.Path]::GetFullPath($LicenseOutputPath)
$taskPortScript=Join-Path $taskNative 'go-port\rebuild-port.ps1'
if($ValidateCacheOnly){
    $taskCompilerJson=(& $taskPortScript -WorkingRoot $taskCompilerRoot -SourceRoot $PortRoot -PythonPath $PythonPath -ValidateCacheOnly) -join "`n"
    $taskArchive=Join-Path $BuildRoot $taskLock.libXray.archiveName
    $taskArchivePresent=Test-Path -LiteralPath $taskArchive
    $taskArchiveMatches=$false
    if($taskArchivePresent){$taskArchiveMatches=(Get-FileHash -Algorithm SHA256 $taskArchive).Hash.ToLowerInvariant() -eq $taskLock.libXray.archiveSHA256}
    $taskInspection=@{mode='read-only cache validation';compiler=($taskCompilerJson | ConvertFrom-Json);wrapperArchivePresent=$taskArchivePresent;wrapperArchiveMatches=$taskArchiveMatches;buildRoot=$BuildRoot;requestedOutput=$OutputPath;outputWritten=$false;downloadsStarted=$false;buildsStarted=$false}
    $taskInspection | ConvertTo-Json -Depth 6
    if($taskArchivePresent -and !$taskArchiveMatches){throw 'Existing wrapper archive differs from the fixed source.'}
    return
}
& $taskPortScript -WorkingRoot $taskCompilerRoot -SourceRoot $PortRoot -PythonPath $PythonPath -DevEcoPath $DevEcoPath -ForceRebuild:$ForceCompilerRebuild
$taskArtifacts=Join-Path $BuildRoot 'artifacts'
& (Join-Path $taskNative 'build-candidate.ps1') -PortRoot $PortRoot -BuildRoot $BuildRoot -CacheRoot $CacheRoot -DevEcoPath $DevEcoPath -PythonPath $PythonPath -ArtifactDir $taskArtifacts
# Publish requested local outputs only after all isolated build checks passed.
$taskCandidate=Join-Path $taskArtifacts 'libxray.so'
$taskRecord=Get-Content -Raw -LiteralPath (Join-Path $taskArtifacts 'build-verification.json') | ConvertFrom-Json -AsHashtable
if($taskRecord.xrayVersion -ne $taskLock.xrayCore.reportedVersion){throw 'Unexpected built core version.'}
if((Get-FileHash -Algorithm SHA256 $taskCandidate).Hash.ToLowerInvariant() -ne $taskRecord.output.sha256){throw 'Candidate artifact hash changed after verification.'}
Sync-XrayLicenseMetadata -ArtifactRoot $taskArtifacts -Destination $LicenseOutputPath -ArtifactHash $taskRecord.output.sha256 -SupplementalLicenseRoot (Join-Path $taskNative 'licenses')
New-Item -ItemType Directory -Force -Path (Split-Path $OutputPath),(Split-Path $EvidencePath) | Out-Null
Copy-Item -LiteralPath $taskCandidate -Destination $OutputPath
$taskRecord.output.path=$OutputPath
$taskRecord.Remove('canonicalArtifactsModified')
$taskRecord.compilerPatchSHA256=$taskLock.goPort.patchSHA256
$taskRecord.compilerPatch='native/xray26/go-port/go1.26.7-openharmony-arm64.patch'
$taskRecord.sourcesLock='native/xray26/sources.lock.json'
$taskRecord.bootstrapArchiveSHA256=$taskLock.bootstrap.sha256
$taskRecord.licenseInventory=Join-Path $LicenseOutputPath 'dependencies\dependency-inventory.json'
$taskRecord.moduleInfoPath=Join-Path $LicenseOutputPath 'module-info.txt'
$taskRecord | ConvertTo-Json -Depth 9 | Set-Content -Encoding utf8NoBOM -LiteralPath $EvidencePath
Write-Output "Verified Xray 26.6.1 library: $OutputPath"
Write-Output "Build evidence: $EvidencePath"
Write-Output "Matching dependency notices and module table: $LicenseOutputPath"
