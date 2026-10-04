[CmdletBinding()]
param(
  [string]$NodePath = '',
  [string]$DataRoot = '',
  [string]$BrokerEntryPath = '',
  [string]$NativeHostPath = ''
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$entry = if ($BrokerEntryPath) { [IO.Path]::GetFullPath($BrokerEntryPath) } else { Join-Path $workspace 'dist\broker\src\runtime\main.js' }
$data = if ($DataRoot) { [IO.Path]::GetFullPath($DataRoot) } else { Join-Path $workspace '.relay-data' }
$native = if ($NativeHostPath) { [IO.Path]::GetFullPath($NativeHostPath) } else { Join-Path $workspace 'dist\native-host\relay-native-host.exe' }
$runtimeFile = Join-Path $data 'runtime.json'
$pidFile = Join-Path $data 'broker.pid'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node is missing: $NodePath" }
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "Build the broker first: $entry" }
New-Item -ItemType Directory -Force -Path $data | Out-Null

function Read-HealthyRuntime([int]$ExpectedProcessId) {
  if (-not (Test-Path -LiteralPath $runtimeFile)) { return $null }
  try {
    $record = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    if ($record.schemaVersion -ne 1 -or $record.processId -ne $ExpectedProcessId -or
        [IO.Path]::GetFullPath($record.databasePath) -ne (Join-Path $data 'relay.sqlite')) { return $null }
    $url = [Uri]$record.mcpUrl
    if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or $url.AbsolutePath -ne '/mcp' -or $url.Port -le 0) { return $null }
    $health = Invoke-RestMethod -Uri ([Uri]::new($url, '/health')) -TimeoutSec 2
    if ($health.status -ne 'ok' -or $health.instanceRef -ne $record.instanceRef -or $health.mcpContractVersion -ne '5') { return $null }
    return [ordered]@{ runtimeFile = $runtimeFile; mcpUrl = $record.mcpUrl; relayUrl = $record.relayUrl; health = $health }
  } catch { return $null }
}

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
    $ready = Read-HealthyRuntime $existing[0].ProcessId
    if (-not $ready) { throw 'The existing Broker has no matching healthy discovery record; migrate or repair it before starting another.' }
    Set-Content -LiteralPath $pidFile -Value $existing[0].ProcessId -Encoding ascii
    [ordered]@{ status = 'already_running'; processId = $existing[0].ProcessId; runtime = $ready } | ConvertTo-Json -Depth 5
    return
  }
  $environment = @{
    RELAY_DB_PATH = (Join-Path $data 'relay.sqlite')
    RELAY_HOST = '127.0.0.1'
    RELAY_MCP_PORT = '0'
    RELAY_WS_PORT = '0'
    RELAY_ADMIN_TOKEN = $null
    RELAY_PROFILES_CONFIG = $null
    TABRO_RUNTIME_FILE = $runtimeFile
    TABRO_NATIVE_RUNTIME_FILE = (Join-Path (Split-Path -Parent $native) 'relay-runtime.json')
  }
  $previous = @{}
  $managedConfig = Join-Path $data 'managed-profiles.json'
  if (Test-Path -LiteralPath $managedConfig) { $environment.RELAY_PROFILES_CONFIG = $managedConfig }
  try {
    foreach ($name in $environment.Keys) {
      $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
      if ($null -eq $environment[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process') }
    }
    $broker = Start-Process -FilePath $NodePath -ArgumentList @('"' + $entry + '"') -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $data 'broker.stdout.log') -RedirectStandardError (Join-Path $data 'broker.stderr.log')
  } finally {
    foreach ($name in $previous.Keys) {
      if ($null -eq $previous[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
  }
  Set-Content -LiteralPath $pidFile -Value $broker.Id -Encoding ascii
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($broker.HasExited) { throw "Broker exited. Check $data\broker.stderr.log" }
    $ready = Read-HealthyRuntime $broker.Id
    if ($ready) {
      [ordered]@{ status = 'started'; processId = $broker.Id; runtime = $ready } | ConvertTo-Json -Depth 5
      return
    }
  }
  throw "Broker did not become healthy. Check logs in $data."
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
