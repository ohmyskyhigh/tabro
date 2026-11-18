[CmdletBinding()]
param(
  [string]$NodePath = '',
  [string]$DataRoot = '',
  [string]$BrokerEntryPath = '',
  [string]$NativeHostPath = ''
)
$ErrorActionPreference = 'Stop'
if ($NodePath -or $DataRoot -or $BrokerEntryPath -or $NativeHostPath) { throw 'Source path overrides cannot select a separate Broker; use the registered package installation.' }
. (Join-Path $PSScriptRoot '..\integrations\hermes\common.ps1')
$registeredRoot = Get-TabroRoot ''
Start-TabroRuntime (Read-TabroState $registeredRoot) | ConvertTo-Json -Depth 8
