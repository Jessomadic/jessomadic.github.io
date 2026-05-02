param(
  [int]$Port = 8765,
  [switch]$NoStart,
  [switch]$NoStartupShortcut
)

$ErrorActionPreference = "Stop"

function Require-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Node.js 18 or newer is required. Install Node.js from https://nodejs.org/ and rerun this installer."
  }
  $versionText = (& node --version).TrimStart("v")
  $major = [int]($versionText.Split(".")[0])
  if ($major -lt 18) {
    throw "Node.js 18 or newer is required. Found v$versionText."
  }
}

Require-Node

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = Join-Path $env:LOCALAPPDATA "PickFlickBridge"
$app = Join-Path $base "app"
$startup = [Environment]::GetFolderPath("Startup")
$startupShortcut = Join-Path $startup "PickFlick Bridge.lnk"
$startScript = Join-Path $app "Start-PickFlickBridge.ps1"

New-Item -ItemType Directory -Force -Path $app | Out-Null

$items = @("server.js", "package.json", "public", "Start-PickFlickBridge.ps1", "Uninstall-PickFlickBridge.ps1")
foreach ($item in $items) {
  $src = Join-Path $source $item
  $dst = Join-Path $app $item
  if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
  Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
}

$configPath = Join-Path $base "config.json"
if (-not (Test-Path $configPath)) {
  $config = @{
    bridge = @{ host = "127.0.0.1"; port = $Port }
    lmStudio = @{ baseUrl = ""; modelId = ""; apiKey = "" }
    radarr = @{ baseUrl = ""; apiKey = ""; rootFolderPath = ""; qualityProfileId = $null }
  } | ConvertTo-Json -Depth 5
  Set-Content -LiteralPath $configPath -Value $config -Encoding UTF8
}

$shell = New-Object -ComObject WScript.Shell
if (-not $NoStartupShortcut) {
  $shortcut = $shell.CreateShortcut($startupShortcut)
  $shortcut.TargetPath = "powershell.exe"
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
  $shortcut.WorkingDirectory = $app
  $shortcut.Description = "Start PickFlick Bridge at sign-in"
  $shortcut.Save()
}

$setupShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "PickFlick Bridge Setup.lnk"
$shortcut = $shell.CreateShortcut($setupShortcut)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -OpenSetup"
$shortcut.WorkingDirectory = $app
$shortcut.Description = "Open PickFlick Bridge setup"
$shortcut.Save()

Write-Host "PickFlick Bridge installed to: $app"
Write-Host "Config stored at: $configPath"
Write-Host "Setup URL: http://127.0.0.1:$Port/setup"

if (-not $NoStart) {
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -OpenSetup"
}
