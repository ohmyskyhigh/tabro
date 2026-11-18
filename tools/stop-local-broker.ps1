[CmdletBinding()]
param(
  [string]$WorkspaceRoot = '',
  [string]$DataRoot = '',
  [string]$BrokerEntryPath = ''
)
$ErrorActionPreference = 'Stop'
if ($WorkspaceRoot -or $DataRoot -or $BrokerEntryPath) { throw 'Source path overrides cannot select a separate Broker; use the registered package installation.' }
& (Join-Path $PSScriptRoot '..\integrations\hermes\stop.ps1')
