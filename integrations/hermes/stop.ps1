[CmdletBinding()]
param([string]$InstallRoot = '')
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-TabroRoot $InstallRoot
$mutex = Get-TabroMutex $root
$locked = $false
try {
  try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another Tabro setup or startup is in progress.' }
  $recordFile = Get-TabroChild $root 'data\runtime.json'
  if (-not (Test-Path -LiteralPath $recordFile)) { '{"status":"NOT_RUNNING"}'; return }
  $record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
  if ($record.schemaVersion -ne 1 -or [int]$record.processId -le 0) { throw 'Invalid runtime discovery record.' }
  $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$record.processId)
  if (-not $process) { '{"status":"NOT_RUNNING"}'; return }
  $state = Get-Content -LiteralPath (Get-TabroChild $root 'installation.json') -Raw | ConvertFrom-Json
  $runtime = Get-TabroChild $root ([string]$state.runtimeDirectory)
  $entry = Join-Path $runtime 'broker\main.js'
  if ($process.Name -ne 'node.exe' -or $process.ExecutablePath -ne $state.nodePath -or -not $process.CommandLine -or $process.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Recorded PID is not this installation''s Broker; refusing to stop it.' }
  $url = [Uri]$record.mcpUrl
  if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or $url.AbsolutePath -ne '/mcp') { throw 'Invalid local Broker address.' }
  $healthJson = & curl.exe --silent --show-error --fail --noproxy '*' --max-time 5 ($url.GetLeftPart([UriPartial]::Authority) + '/health')
  if ($LASTEXITCODE -ne 0) { throw 'Broker health is unavailable; inspect the process before stopping it manually.' }
  $health = $healthJson | ConvertFrom-Json
  if ($health.instanceRef -ne $record.instanceRef) { throw 'Broker identity changed; refusing to stop it.' }
  if ($health.activeWorkspaceCount -gt 0 -or $health.openRequestCount -gt 0) { throw 'Finish active browser work in all Hermes profiles before stopping the shared Broker.' }
  Stop-Process -Id $record.processId -ErrorAction Stop
  [ordered]@{ status = 'STOPPED'; processId = $record.processId } | ConvertTo-Json -Compress
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
