param(
    [string]$DevEcoPath = 'C:\Program Files\Huawei\DevEco Studio',
    [string]$BuildRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray26'),
    [string]$PythonPath = 'C:\Python314\python.exe',
    [string]$OutputPath = '',
    [string]$EvidencePath = '',
    [string]$PortRoot = '',
    [string]$CacheRoot = (Join-Path $env:TEMP 'HarmonyVpnLab-xray'),
    [switch]$ValidateCacheOnly,
    [switch]$ForceCompilerRebuild
)
# Current core entrypoint. The historical 25.8.3 recipe remains unchanged in
# build-xray-legacy.ps1 for reproducing the earlier experiment.
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'build-xray26.ps1') @PSBoundParameters
