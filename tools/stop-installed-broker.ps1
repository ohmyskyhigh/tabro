[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Octopus Browser Relay'),
  [string]$DataRoot = '',
  [switch]$AllowNotRunning
)

$ErrorActionPreference = 'Stop'
$install = [IO.Path]::GetFullPath($InstallRoot)
$data = if ($DataRoot) { [IO.Path]::GetFullPath($DataRoot) } else { Join-Path $install 'data' }
$pidFile = Join-Path $data 'broker.pid'
$launcher = [IO.Path]::GetFullPath((Join-Path $install 'bootstrap\broker-launcher.mjs'))

if (-not (Test-Path -LiteralPath $pidFile)) {
  if ($AllowNotRunning) {
    [ordered]@{ status = 'not_running'; stopped = $false; pidFile = $pidFile } | ConvertTo-Json
    exit 0
  }
  throw "No installed broker PID file exists at $pidFile."
}

$processId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidFile -Force
  [ordered]@{ status = 'stale_pid_removed'; stopped = $false; processId = $processId } | ConvertTo-Json
  exit 0
}

$commandLine = [string]$process.CommandLine
if (-not $commandLine.Contains($launcher, [StringComparison]::OrdinalIgnoreCase)) {
  throw "PID $processId does not belong to the installed Tabro broker launcher $launcher."
}

Stop-Process -Id $processId
Wait-Process -Id $processId -Timeout 15 -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force
[ordered]@{ status = 'stopped'; stopped = $true; processId = $processId; launcher = $launcher } | ConvertTo-Json
