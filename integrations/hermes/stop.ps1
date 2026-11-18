[CmdletBinding()]
param([string]$InstallRoot = '', [switch]$ForUpgrade)
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-TabroRoot $InstallRoot
$mutex = Get-TabroMutex $root
$locked = $false
try {
  try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another Tabro setup or startup is in progress.' }
  $recordFile = Get-TabroChild $root 'data\runtime.json'
  if (-not (Test-Path -LiteralPath $recordFile)) { '{"status":"NOT_RUNNING"}'; return }
  $record = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($record.schemaVersion -ne 2 -or $record.authMode -ne 'machine-v1' -or [int]$record.processId -le 0) { throw 'Invalid or incompatible runtime discovery record.' }
  $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$record.processId)
  if (-not $process) { '{"status":"NOT_RUNNING"}'; return }
  $state = Get-Content -LiteralPath (Get-TabroChild $root 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $runtime = Get-TabroChild $root ([string]$state.runtimeDirectory)
  $entry = Join-Path $runtime 'broker\main.js'
  if ($process.Name -ne 'node.exe' -or $process.ExecutablePath -ne $state.nodePath -or -not $process.CommandLine -or $process.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Recorded PID is not this installation''s Broker; refusing to stop it.' }
  $url = [Uri]$record.mcpUrl
  if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or $url.AbsolutePath -ne '/mcp') { throw 'Invalid local Broker address.' }
  $healthJson = & curl.exe --silent --show-error --fail --noproxy '*' --max-time 5 ($url.GetLeftPart([UriPartial]::Authority) + '/health')
  if ($LASTEXITCODE -ne 0) { throw 'Broker health is unavailable; inspect the process before stopping it manually.' }
  $health = $healthJson | ConvertFrom-Json
  if ($health.instanceRef -ne $record.instanceRef) { throw 'Broker identity changed; refusing to stop it.' }
  $transactionId = [guid]::NewGuid().ToString()
  $operation = Get-TabroChild $root 'data\maintenance-operation.json'
  $content = [ordered]@{ schemaVersion = 1; kind = 'stop'; transactionId = $transactionId; previous = $state.runtimeDirectory } | ConvertTo-Json -Compress
  $stream = [IO.File]::Open($operation, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($content); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  & $state.nodePath (Join-Path $runtime 'maintenance-client.js') $root $record.mcpUrl 'enter' $transactionId $record.instanceRef
  if ($LASTEXITCODE -ne 0) {
    if ($LASTEXITCODE -eq 3) { Remove-Item -LiteralPath $operation -Force }
    throw 'Broker maintenance could not begin; inspect the operation before retrying.'
  }
  if ($ForUpgrade) {
    $fencedJson = & curl.exe --silent --show-error --fail --noproxy '*' --max-time 5 ($url.GetLeftPart([UriPartial]::Authority) + '/health')
    $fenced = if ($LASTEXITCODE -eq 0) { $fencedJson | ConvertFrom-Json } else { $null }
    if (-not $fenced -or $fenced.instanceRef -ne $record.instanceRef -or $null -eq $fenced.managedLiveInstanceCount -or $fenced.managedLiveInstanceCount -ne 0) {
      & $state.nodePath (Join-Path $runtime 'maintenance-client.js') $root $record.mcpUrl 'resume' $transactionId $record.instanceRef
      if ($LASTEXITCODE -ne 0) { throw 'Cannot verify Profile status or resume; preserve the maintenance operation for inspection.' }
      Remove-Item -LiteralPath $operation -Force
      throw 'Close managed Profiles and verify Broker health before upgrading.'
    }
  }
  & $state.nodePath (Join-Path $runtime 'maintenance-client.js') $root $record.mcpUrl 'stop' $transactionId $record.instanceRef
  if ($LASTEXITCODE -ne 0) { throw 'Broker shutdown is ambiguous; preserve the maintenance operation for inspection.' }
  Wait-Process -Id $record.processId -Timeout 15 -ErrorAction SilentlyContinue
  if (Get-Process -Id $record.processId -ErrorAction SilentlyContinue) { throw 'Broker shutdown timed out; preserve the maintenance operation for inspection.' }
  [ordered]@{ status = 'STOPPED'; processId = $record.processId } | ConvertTo-Json -Compress
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
