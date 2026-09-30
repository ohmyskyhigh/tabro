[CmdletBinding()]
param(
  [string]$NodePath = 'C:\Program Files\nodejs\node.exe'
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = Join-Path $workspace 'dist\broker\src\runtime\main.js'
$data = Join-Path $workspace '.relay-data'
$pidFile = Join-Path $data 'broker.pid'
$healthUrl = 'http://127.0.0.1:7331/health'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node is missing: $NodePath" }
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "Build the broker first: $entry" }
New-Item -ItemType Directory -Force -Path $data | Out-Null

# Serialize startup-folder and manual launches to avoid duplicate brokers.
$mutex = New-Object System.Threading.Mutex($false, 'Local\OctopusLocalBrokerStartup')
$locked = $false
try {
  try { $locked = $mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another broker startup is still running.' }
  $entryPattern = '(?i)(?:^|[\s"])' + [Regex]::Escape($entry) + '(?=$|[\s"])'
  $existing = @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Replace('/', '\') -match $entryPattern
  })
  if ($existing.Count -gt 1) { throw 'Multiple matching brokers exist; inspect them before starting.' }
  if ($existing.Count -eq 1) {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($health.status -ne 'ok') { throw 'The existing broker is not healthy.' }
    Set-Content -LiteralPath $pidFile -Value $existing[0].ProcessId -Encoding ascii
    [ordered]@{ status = 'already_running'; processId = $existing[0].ProcessId; health = $health } | ConvertTo-Json -Depth 4
    return
  }

  $environment = @{
    RELAY_DB_PATH = (Join-Path $data 'relay.sqlite')
    RELAY_HOST = '127.0.0.1'
    RELAY_MCP_PORT = '7331'
    RELAY_WS_PORT = '7332'
  }
  $previous = @{}
  $managedConfig = Join-Path $data 'managed-profiles.json'
  if (Test-Path -LiteralPath $managedConfig) { $environment.RELAY_PROFILES_CONFIG = $managedConfig }
  try {
    foreach ($name in $environment.Keys) {
      $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
      [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
    }
    $broker = Start-Process -FilePath $NodePath -ArgumentList @('"' + $entry + '"') -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $data 'broker.stdout.log') -RedirectStandardError (Join-Path $data 'broker.stderr.log')
  } finally {
    foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  }
  Set-Content -LiteralPath $pidFile -Value $broker.Id -Encoding ascii
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($broker.HasExited) { throw "Broker exited. Check $data\broker.stderr.log" }
    try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 } catch { continue }
    if ($health.status -eq 'ok') {
      [ordered]@{ status = 'started'; processId = $broker.Id; health = $health } | ConvertTo-Json -Depth 4
      return
    }
  }
  throw "Broker did not become healthy. Check logs in $data."
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
