# Builds dist/PhoneShare-<version>-x64.msi from dist/PhoneShare.exe with WiX 5.
# Once per machine: dotnet tool install -g wix --version 5.0.2
# -Version, -Exe and -Out build another version elsewhere (dev/update-e2e.mjs).
param([string]$Version, [string]$Exe, [string]$Out)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim() }
if (-not $Exe) { $Exe = Join-Path $root 'dist\PhoneShare.exe' }
if (-not $Out) { $Out = Join-Path $root 'dist' }
$Exe = (Resolve-Path $Exe).Path

# the MSI must carry the version the exe reports, or the updater would offer it again after installing it
$fv = (Get-Item $Exe).VersionInfo.FileVersion
if (-not $fv.StartsWith("$Version.")) { throw "$Exe is version $fv, not ${Version}: build it first (desktop/build.ps1)" }

New-Item -ItemType Directory -Force $Out | Out-Null
Get-ChildItem $Out -Filter 'PhoneShare-*-x64.msi' | Remove-Item -Force   # one installer next to the exe
$msi = Join-Path $Out "PhoneShare-$Version-x64.msi"
Push-Location $PSScriptRoot
try {
    wix build PhoneShare.wxs -arch x64 -d Version=$Version -d Exe=$Exe -pdbtype none -o $msi
    if ($LASTEXITCODE) { throw 'wix build failed' }
} finally { Pop-Location }
Write-Output "MSI: $msi"
