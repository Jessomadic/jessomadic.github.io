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
  $hostName = "127.0.0.1"
  $port = 8765
  if (Test-Path $configPath) {
    try {
      $cfg = Get-Content -Raw $configPath | ConvertFrom-Json
      if ($cfg.bridge.host) { $hostName = [string]$cfg.bridge.host }
      if ($cfg.bridge.port) { $port = [int]$cfg.bridge.port }
    } catch { }
  }
  if ($hostName -eq "0.0.0.0") { $hostName = "127.0.0.1" }
  Start-Job -ScriptBlock {
    param($SetupHost, $SetupPort)
    Start-Sleep -Seconds 2
    Start-Process "http://$($SetupHost):$SetupPort/setup"
  } -ArgumentList $hostName, $port | Out-Null
}

Set-Location $here
node server.js
