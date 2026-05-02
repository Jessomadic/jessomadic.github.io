param(
  [switch]$OpenSetup
)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = Split-Path -Parent $here
$configPath = Join-Path $base "config.json"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required to run PickFlick Bridge."
}

$env:PICKFLICK_BRIDGE_CONFIG = $configPath
$env:PICKFLICK_BRIDGE_DATA = $base

if ($OpenSetup) {
  $port = 8765
  if (Test-Path $configPath) {
    try {
      $cfg = Get-Content -Raw $configPath | ConvertFrom-Json
      if ($cfg.bridge.port) { $port = [int]$cfg.bridge.port }
    } catch { }
  }
  Start-Job -ScriptBlock {
    param($SetupPort)
    Start-Sleep -Seconds 2
    Start-Process "http://127.0.0.1:$SetupPort/setup"
  } -ArgumentList $port | Out-Null
}

Set-Location $here
node server.js
