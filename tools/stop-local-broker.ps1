[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [string]$WorkspaceRoot = '',
  [string]$DataRoot = '',
  [string]$BrokerEntryPath = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-TaskPath([string]$Value, [string]$Fallback, [string]$Base) {
  $candidate = if ([string]::IsNullOrWhiteSpace($Value)) { $Fallback } else { $Value }
  if ($candidate -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2})') {
    $candidate = Join-Path $Base $candidate
  }
  return [System.IO.Path]::GetFullPath($candidate)
}

function Test-CommandLineArgument([string]$CommandLine, [string]$ExpectedPath) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $normalizedCommandLine = $CommandLine.Replace('/', '\')
  $normalizedExpectedPath = $ExpectedPath.Replace('/', '\')
  $pattern = '(?i)(?:^|[\s"])' + [Regex]::Escape($normalizedExpectedPath) + '(?=$|[\s"])'
  return [Regex]::IsMatch($normalizedCommandLine, $pattern)
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'The current local broker stop command requires Windows process inspection.'
}

$defaultWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspace = Resolve-TaskPath $WorkspaceRoot $defaultWorkspace $defaultWorkspace
$data = Resolve-TaskPath $DataRoot '.relay-data' $workspace
$brokerEntry = Resolve-TaskPath $BrokerEntryPath 'dist\broker\src\runtime\main.js' $workspace
$brokerPidFile = Join-Path $data 'broker.pid'

if (-not (Test-Path -LiteralPath $brokerPidFile -PathType Leaf)) {
  Write-Output ([ordered]@{
    status = 'not_running'
    stopped = $false
    brokerPidFile = $brokerPidFile
    detail = 'No installer-managed broker PID file exists.'
  } | ConvertTo-Json -Depth 3)
  return
}

$pidText = (Get-Content -LiteralPath $brokerPidFile -Raw).Trim()
$brokerProcessId = 0
if (-not [int]::TryParse($pidText, [ref]$brokerProcessId) -or $brokerProcessId -le 0) {
  throw "Refusing to stop a process because $brokerPidFile does not contain one positive process ID."
}

$brokerProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $brokerProcessId" -ErrorAction Stop
if ($null -eq $brokerProcess) {
  Write-Output ([ordered]@{
    status = 'stale_pid'
    stopped = $false
    processId = $brokerProcessId
    brokerPidFile = $brokerPidFile
    pidFileRetained = $true
    detail = 'The recorded process no longer exists; the PID file was retained for inspection.'
  } | ConvertTo-Json -Depth 3)
  exit 3
}

$executableName = if ([string]::IsNullOrWhiteSpace([string]$brokerProcess.ExecutablePath)) {
  ''
} else {
  [System.IO.Path]::GetFileName([string]$brokerProcess.ExecutablePath)
}
$isExpectedNode = $executableName.Equals('node.exe', [StringComparison]::OrdinalIgnoreCase)
$hasExpectedEntry = Test-CommandLineArgument ([string]$brokerProcess.CommandLine) $brokerEntry
if (-not $isExpectedNode -or -not $hasExpectedEntry) {
  throw "Refusing to stop process $brokerProcessId because it is not Node running the expected broker entry point $brokerEntry."
}

if (-not $PSCmdlet.ShouldProcess(
  "process $brokerProcessId ($($brokerProcess.ExecutablePath))",
  "Stop the installer-managed Tabro broker running $brokerEntry"
)) {
  Write-Output ([ordered]@{
    status = 'would_stop'
    stopped = $false
    processId = $brokerProcessId
    brokerEntryPath = $brokerEntry
    brokerPidFile = $brokerPidFile
  } | ConvertTo-Json -Depth 3)
  return
}

Stop-Process -Id $brokerProcessId -ErrorAction Stop
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $stillRunning = Get-Process -Id $brokerProcessId -ErrorAction SilentlyContinue
  if ($null -eq $stillRunning) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

if ($null -ne (Get-Process -Id $brokerProcessId -ErrorAction SilentlyContinue)) {
  throw "Process $brokerProcessId did not stop within 10 seconds; the PID file was retained."
}

Remove-Item -LiteralPath $brokerPidFile
Write-Output ([ordered]@{
  status = 'stopped'
  stopped = $true
  processId = $brokerProcessId
  brokerEntryPath = $brokerEntry
  brokerPidFile = $brokerPidFile
  pidFileRemoved = $true
} | ConvertTo-Json -Depth 3)
