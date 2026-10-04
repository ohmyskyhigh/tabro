$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$TabroPluginRoot = $PSScriptRoot

function Get-TabroRoot([string]$Requested) {
  if (-not $Requested) { $Requested = $env:TABRO_INSTALL_ROOT }
  if (-not $Requested) { $Requested = Join-Path $env:LOCALAPPDATA 'Tabro' }
  if ($Requested -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw 'Tabro InstallRoot must be absolute so every Hermes Profile resolves the same installation.' }
  $root = [IO.Path]::GetFullPath($Requested)
  if ($root.TrimEnd('\') -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'InstallRoot cannot be a drive root.' }
  return $root
}

function Get-TabroMutex([string]$Root) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $name = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.TrimEnd('\').ToLowerInvariant())))).Replace('-', '') }
  finally { $hash.Dispose() }
  return New-Object Threading.Mutex($false, ('Local\TabroInstallation-' + $name))
}

function Get-TabroChild([string]$Root, [string]$Relative) {
  if ([IO.Path]::IsPathRooted($Relative)) { throw 'Expected a relative package path.' }
  $parent = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $child = [IO.Path]::GetFullPath((Join-Path $parent $Relative))
  if (-not $child.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package path escapes its root.' }
  $current = $child
  while ($current -and $current.StartsWith($parent.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation paths cannot contain reparse points.' }
    $current = Split-Path -Parent $current
  }
  return $child
}

function Get-TabroPackage {
  $file = Join-Path $TabroPluginRoot 'runtime-manifest.json'
  $manifest = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'windows-x64' -or $manifest.contractVersion -ne '5') { throw 'Unsupported Tabro runtime manifest.' }
  return @{ manifest = $manifest; digest = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Read-TabroState([string]$Root) {
  $file = Get-TabroChild $Root 'installation.json'
  if (-not (Test-Path -LiteralPath $file)) { throw "Tabro setup is required. Run the plugin's setup.ps1 first. Install directory: $Root" }
  $state = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  $package = Get-TabroPackage
  if ($state.schemaVersion -ne 1 -or $state.packageDigest -ne $package.digest) { throw 'Tabro plugin and installed runtime differ. Finish active browser work, stop the installed Broker and run setup.ps1 for this plugin version.' }
  $runtime = Get-TabroChild $Root ([string]$state.runtimeDirectory)
  $node = [IO.Path]::GetFullPath([string]$state.nodePath)
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'The installed Node runtime is missing. Run setup.ps1.' }
  return @{ state = $state; runtime = $runtime; node = $node; data = (Get-TabroChild $Root 'data') }
}

function Start-TabroRuntime($Installation) {
  $mutex = Get-TabroMutex (Split-Path -Parent $Installation.data)
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(20000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another Tabro startup is in progress.' }
    $resultFile = Join-Path $Installation.data ('startup-' + [guid]::NewGuid().ToString('N') + '.json')
    # ShellExecute isolates this short bootstrap process from inherited MCP pipes.
    # Its Node child owns explicit log handles; no console is shown.
    $arguments = @('"' + (Join-Path $TabroPluginRoot 'broker-service.mjs') + '"', '"' + (Split-Path -Parent $Installation.data) + '"', '"' + $resultFile + '"')
    $bootstrap = Start-Process -FilePath $Installation.node -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $bootstrap.WaitForExit(30000)) { throw 'Tabro startup did not finish; inspect the installation logs before retrying.' }
    if (-not (Test-Path -LiteralPath $resultFile)) { throw 'Tabro startup produced no result; check the Node installation.' }
    $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
    Remove-Item -LiteralPath $resultFile
    if ($result.status -eq 'error') { throw $result.message }
    return $result
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
