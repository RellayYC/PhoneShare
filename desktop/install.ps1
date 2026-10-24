# Installs dist/PhoneShare.exe for the current user: %LOCALAPPDATA%\Programs\PhoneShare plus Start menu and desktop shortcuts.
# No admin rights, nothing outside the user profile. Remove with: powershell -File desktop/install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'Programs\PhoneShare'
$exe = Join-Path $dir 'PhoneShare.exe'
$links = @(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'PhoneShare.lnk'),
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'PhoneShare.lnk')
)

$running = Get-Process PhoneShare -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
if ($running) { throw "PhoneShare is running from $dir. Close it and run this again." }

if ($Uninstall) {
    Remove-Item $links -ErrorAction SilentlyContinue
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    Write-Output 'PhoneShare removed (settings in %LOCALAPPDATA%\PhoneShare are kept)'
    return
}

$src = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\PhoneShare.exe'
if (-not (Test-Path $src)) { throw "build first: powershell -File desktop/build.ps1" }
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item $src $exe -Force

$shell = New-Object -ComObject WScript.Shell
foreach ($l in $links) {
    $s = $shell.CreateShortcut($l)
    $s.TargetPath = $exe
    $s.WorkingDirectory = $dir
    $s.IconLocation = "$exe,0"
    $s.Description = 'Экран и звук телефона на ПК'
    $s.Save()
}
Write-Output "PhoneShare installed: $exe"
