# Builds dist/PhoneShare.exe (one file: web/ and the WebView2 libraries are inside) and dist/PhoneShare-Windows.zip with it.
# -Version and -Out build another version elsewhere (dev/update-e2e.mjs); then only the exe is written.
param([string]$Version, [string]$Out)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$dist = Join-Path $root 'dist'
$zip = Join-Path $dist 'PhoneShare-Windows.zip'
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim() }
$bin = if ($Out) { Join-Path $Out 'bin' } else { Join-Path $here 'bin\out' }

# packages and scratch files stay inside the project, off the system drive
$env:NUGET_PACKAGES = Join-Path $root '.tools\nuget'
$env:NUGET_HTTP_CACHE_PATH = Join-Path $root '.tools\nuget-http'
$env:TEMP = $env:TMP = (New-Item -ItemType Directory -Force (Join-Path $root 'dev\.out\tmp')).FullName

if (Test-Path $bin) { Remove-Item -Recurse -Force $bin }
& dotnet build (Join-Path $here 'PhoneShare.csproj') -c Release -o $bin --nologo -v quiet "-p:Version=$Version"
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed with exit code $LASTEXITCODE" }
if ($Out) {
    Copy-Item "$bin\PhoneShare.exe" (Join-Path $Out 'PhoneShare.exe') -Force
    Write-Output "DESKTOP: $Out\PhoneShare.exe ($Version)"
    return
}

New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item "$bin\PhoneShare.exe" "$dist\PhoneShare.exe" -Force
# the multi-file layout of earlier builds is gone; an open Explorer window may hold the folder, so empty it first
$old = Join-Path $dist 'PhoneShare-Windows'
if (Test-Path $old) { Get-ChildItem $old | Remove-Item -Recurse -Force; Remove-Item $old -ErrorAction SilentlyContinue }
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path "$dist\PhoneShare.exe" -DestinationPath $zip
Write-Output "DESKTOP: $dist\PhoneShare.exe ($Version)"
