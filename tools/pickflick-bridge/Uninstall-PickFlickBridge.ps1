param(
  [switch]$KeepConfig
)

$ErrorActionPreference = "Stop"

$base = Join-Path $env:LOCALAPPDATA "PickFlickBridge"
$startup = [Environment]::GetFolderPath("Startup")
$startupShortcut = Join-Path $startup "PickFlick Bridge.lnk"
$startupBatch = Join-Path $startup "PickFlick Bridge.bat"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "PickFlick Bridge Setup.lnk"

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*PickFlickBridge*server.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (Test-Path $startupShortcut) { Remove-Item -LiteralPath $startupShortcut -Force }
if (Test-Path $startupBatch) { Remove-Item -LiteralPath $startupBatch -Force }
if (Test-Path $desktopShortcut) { Remove-Item -LiteralPath $desktopShortcut -Force }

if (Test-Path $base) {
  if ($KeepConfig) {
    $app = Join-Path $base "app"
    if (Test-Path $app) { Remove-Item -LiteralPath $app -Recurse -Force }
  } else {
    Remove-Item -LiteralPath $base -Recurse -Force
  }
}

Write-Host "PickFlick Bridge uninstalled."
