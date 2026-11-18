[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [string]$DataRoot = '',
  [switch]$AllowNotRunning
)
$ErrorActionPreference = 'Stop'
if ($DataRoot) { throw 'DataRoot cannot select a separate Broker; use the registered package installation.' }
$registeredStop = Join-Path $PSScriptRoot '..\integrations\hermes\stop.ps1'
if (-not (Test-Path -LiteralPath $registeredStop)) { throw 'Run powershell.exe -NoProfile -File <extracted-current-package>\stop.ps1 to stop the registered Broker safely.' }
& $registeredStop -InstallRoot $InstallRoot
