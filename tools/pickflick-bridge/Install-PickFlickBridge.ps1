param(
  [int]$Port = 8765,
  [string]$BridgeHost = "",
  [string]$ListenHost = "0.0.0.0",
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

function Stop-ExistingBridge {
  param(
    [int]$Port
  )

  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    $processId = [int]$connection.OwningProcess
    if (-not $processId -or $processId -eq $PID) { continue }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    $commandLine = if ($process) { [string]$process.CommandLine } else { "" }
    $name = if ($process) { [string]$process.Name } else { "" }
    $looksLikeBridge = $name -ieq "node.exe" -and (
      $commandLine -match "PickFlickBridge" -or
      $commandLine -match "server\.js"
    )

    if (-not $looksLikeBridge) {
      throw "Port $Port is already in use by process $processId ($name). Stop that process or choose another port."
    }

    Write-Host "Stopping existing PickFlick Bridge process: $processId"
    Stop-Process -Id $processId -Force
    Start-Sleep -Milliseconds 500
  }
}

function Get-DefaultBridgeHost {
  $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "169.254*" -and
      $_.IPAddress -ne "127.0.0.1" -and
      $_.PrefixOrigin -ne "WellKnown"
    } |
    Sort-Object @{Expression = { if ($_.IPAddress -like "192.168.*") { 0 } else { 1 } }}, InterfaceMetric, IPAddress |
    Select-Object -ExpandProperty IPAddress)

  if ($addresses) { return [string]$addresses[0] }
  return "127.0.0.1"
}

function Normalize-HostValue {
  param(
    [string]$Value,
    [string]$Fallback,
    [switch]$AllowWildcard
  )
  $raw = ([string]$Value).Trim()
  if (-not $raw) { return $Fallback }
  if ($AllowWildcard -and ($raw -eq "0.0.0.0" -or $raw -eq "::" -or $raw -eq "*")) { return "0.0.0.0" }
  try {
    $candidate = if ($raw -match "^https?://") { [Uri]$raw } else { [Uri]"http://$raw" }
    if ($candidate.Host) { return $candidate.Host }
  } catch { }
  return $Fallback
}

function Write-Utf8NoBom {
  param(
    [string]$Path,
    [string]$Value
  )
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Read-SettingsData {
  param(
    [string]$DbPath,
    [string]$ConfigPath
  )

  if (Test-Path $DbPath) {
    $doc = Get-Content -Raw -LiteralPath $DbPath | ConvertFrom-Json
    if ($doc.schema -eq "pickflick-bridge-settings" -and $doc.data) { return $doc.data }
    if ($doc.data -and ($doc.data.bridge -or $doc.data.lmStudio -or $doc.data.radarr)) { return $doc.data }
    return $doc
  }

  if (Test-Path $ConfigPath) {
    return Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
  }

  return $null
}

function Write-SettingsDb {
  param(
    [string]$DbPath,
    [object]$Data
  )

  if (Test-Path $DbPath) {
    $backupPath = "$DbPath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
    Copy-Item -LiteralPath $DbPath -Destination $backupPath -Force
  }
  $doc = [ordered]@{
    schema = "pickflick-bridge-settings"
    version = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    data = $Data
  } | ConvertTo-Json -Depth 10
  Write-Utf8NoBom -Path $DbPath -Value $doc
}

function Write-StartupBatch {
  param(
    [string]$Path
  )

  $content = @"
@echo off
cd /d "%LOCALAPPDATA%\PickFlickBridge\app"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LOCALAPPDATA%\PickFlickBridge\app\Start-PickFlickBridge.ps1"
"@
  Write-Utf8NoBom -Path $Path -Value $content
}

Require-Node

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = Join-Path $env:LOCALAPPDATA "PickFlickBridge"
$app = Join-Path $base "app"
$startup = [Environment]::GetFolderPath("Startup")
$startupShortcut = Join-Path $startup "PickFlick Bridge.lnk"
$startupBatch = Join-Path $startup "PickFlick Bridge.bat"
$startScript = Join-Path $app "Start-PickFlickBridge.ps1"
$publicHost = Normalize-HostValue -Value $BridgeHost -Fallback (Get-DefaultBridgeHost)
$bindHost = Normalize-HostValue -Value $ListenHost -Fallback "0.0.0.0" -AllowWildcard

New-Item -ItemType Directory -Force -Path $app | Out-Null
Stop-ExistingBridge -Port $Port

$items = @("server.js", "package.json", "public", "Start-PickFlickBridge.ps1", "Uninstall-PickFlickBridge.ps1")
foreach ($item in $items) {
  $src = Join-Path $source $item
  $dst = Join-Path $app $item
  if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
  Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
}

$configPath = Join-Path $base "config.json"
$dbPath = Join-Path $base "settings.db.json"
try {
  $cfg = Read-SettingsData -DbPath $dbPath -ConfigPath $configPath
  if (-not $cfg) {
    $cfg = [pscustomobject]@{
      bridge = [pscustomobject]@{ host = $publicHost; listenHost = $bindHost; port = $Port }
      lmStudio = [pscustomobject]@{ baseUrl = ""; modelId = ""; apiKey = "" }
      radarr = [pscustomobject]@{ baseUrl = ""; apiKey = ""; rootFolderPath = ""; qualityProfileId = $null }
    }
  }
  if (-not $cfg.bridge) {
    $cfg | Add-Member -NotePropertyName bridge -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if (-not $cfg.lmStudio) {
    $cfg | Add-Member -NotePropertyName lmStudio -NotePropertyValue ([pscustomobject]@{ baseUrl = ""; modelId = ""; apiKey = "" }) -Force
  }
  if (-not $cfg.radarr) {
    $cfg | Add-Member -NotePropertyName radarr -NotePropertyValue ([pscustomobject]@{ baseUrl = ""; apiKey = ""; rootFolderPath = ""; qualityProfileId = $null }) -Force
  }
  if (-not $cfg.bridge.host) {
    $cfg.bridge | Add-Member -NotePropertyName host -NotePropertyValue $publicHost -Force
  }
  if (-not $cfg.bridge.listenHost) {
    $cfg.bridge | Add-Member -NotePropertyName listenHost -NotePropertyValue $bindHost -Force
  }
  if (-not $cfg.bridge.port) {
    $cfg.bridge | Add-Member -NotePropertyName port -NotePropertyValue $Port -Force
  }
  Write-SettingsDb -DbPath $dbPath -Data $cfg
  $publicHost = [string]$cfg.bridge.host
} catch {
  throw "Could not initialize bridge settings database at $dbPath`: $($_.Exception.Message)"
}

$shell = New-Object -ComObject WScript.Shell
if (-not $NoStartupShortcut) {
  if (Test-Path $startupShortcut) { Remove-Item -LiteralPath $startupShortcut -Force }
  Write-StartupBatch -Path $startupBatch
}

$setupShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "PickFlick Bridge Setup.lnk"
$shortcut = $shell.CreateShortcut($setupShortcut)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -OpenSetup"
$shortcut.WorkingDirectory = $app
$shortcut.Description = "Open PickFlick Bridge setup"
$shortcut.Save()

Write-Host "PickFlick Bridge installed to: $app"
Write-Host "Settings database: $dbPath"
if (-not $NoStartupShortcut) { Write-Host "Startup batch: $startupBatch" }
if (Test-Path $configPath) { Write-Host "Legacy config migration source: $configPath" }
Write-Host "Setup URL: http://127.0.0.1:$Port/setup"
Write-Host "PickFlick Bridge URL: http://$publicHost`:$Port"

if (-not $NoStart) {
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -OpenSetup"
}
