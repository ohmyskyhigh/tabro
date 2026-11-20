$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$TabroPluginRoot = $PSScriptRoot

function Get-TabroRoot([string]$Requested) {
  $directory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'Tabro'
  $file = Join-Path $directory 'registration.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Machine registration is required before Tabro setup. Ask an administrator to provision this device.' }
  foreach ($path in @($directory, $file)) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Machine registration cannot use reparse points.' }
    $acl = Get-Acl -LiteralPath $path
    $owner = ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
    if (@('S-1-5-18', 'S-1-5-32-544') -notcontains $owner) { throw 'Machine registration is not owned by an administrator.' }
    foreach ($rule in $acl.Access) {
      $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      $write = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
      if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and @('S-1-5-18', 'S-1-5-32-544') -notcontains $sid) { throw 'Machine registration is writable by a non-administrator.' }
    }
  }
  $registration = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($registration.schemaVersion -ne 1 -or $registration.owner -cne $sid -or -not [IO.Path]::IsPathRooted([string]$registration.installationRoot) -or -not [IO.Path]::IsPathRooted([string]$registration.dataRoot)) { throw 'This Windows account does not own a valid machine Tabro registration.' }
  $registered = [IO.Path]::GetFullPath([string]$registration.installationRoot)
  if ([IO.Path]::GetFullPath([string]$registration.dataRoot) -ine (Join-Path $registered 'data')) { throw 'Machine registration has an unsupported data directory.' }
  if (-not $Requested -and $env:TABRO_INSTALL_ROOT -ne '${TABRO_INSTALL_ROOT}') { $Requested = $env:TABRO_INSTALL_ROOT }
  if (-not $Requested) { $Requested = $registered }
  if ($Requested -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw 'Tabro InstallRoot must be absolute so every Hermes Profile resolves the same installation.' }
  $root = [IO.Path]::GetFullPath($Requested)
  if ($root.TrimEnd('\') -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'InstallRoot cannot be a drive root.' }
  if ($root -ine $registered) { throw 'InstallRoot conflicts with the machine Tabro registration.' }
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
  $manifest = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'windows-x64' -or @('5', '6', '7', '8') -notcontains $manifest.contractVersion) { throw 'Unsupported Tabro runtime manifest.' }
  return @{ manifest = $manifest; digest = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Read-TabroState([string]$Root) {
  $file = Get-TabroChild $Root 'installation.json'
  if (-not (Test-Path -LiteralPath $file)) { throw "Tabro setup is required. Run the plugin's setup.ps1 first. Install directory: $Root" }
  $state = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  $package = Get-TabroPackage
  if ($state.schemaVersion -ne 1 -or $state.contractVersion -ne $package.manifest.contractVersion) { throw 'Tabro plugin and installed runtime have incompatible MCP contracts.' }
  $runtime = Get-TabroChild $Root ([string]$state.runtimeDirectory)
  $node = [IO.Path]::GetFullPath([string]$state.nodePath)
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'The installed Node runtime is missing. Run setup.ps1.' }
  return @{ state = $state; runtime = $runtime; node = $node; data = (Get-TabroChild $Root 'data') }
}

function Invoke-TabroMaintenanceResume($Installation, [string]$Url, [string]$TransactionId, [string]$InstanceRef) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Installation.node
  $arguments = @((Join-Path $Installation.runtime 'maintenance-client.js'), (Split-Path -Parent $Installation.data), $Url, 'resume', $TransactionId, $InstanceRef) | ForEach-Object { '"' + $_ + '"' }
  $start.Arguments = $arguments -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $resume = [Diagnostics.Process]::Start($start)
  try {
    $stdout = $resume.StandardOutput.ReadToEndAsync()
    $stderr = $resume.StandardError.ReadToEndAsync()
    if (-not $resume.WaitForExit(70000)) { throw 'Maintenance resume timed out; inspect the operation without retrying it.' }
    $output = $stdout.GetAwaiter().GetResult()
    $errorOutput = $stderr.GetAwaiter().GetResult()
    if ($resume.ExitCode -ne 0) { throw "Maintenance could not resume (exit $($resume.ExitCode)): $output $errorOutput. Inspect the operation before retrying." }
  } finally {
    if (-not $resume.HasExited) { $resume.Kill() }
    $resume.Dispose()
  }
}

function Start-TabroRuntime($Installation, [switch]$HoldMaintenance) {
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
    $result = Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Remove-Item -LiteralPath $resultFile
    if ($result.status -eq 'error') { throw $result.message }
    $operation = Join-Path $Installation.data 'maintenance-operation.json'
    $fence = Join-Path $Installation.data 'maintenance.json'
    if ($HoldMaintenance) { return $result }
    if (Test-Path -LiteralPath $operation) {
      $pending = Get-Content -LiteralPath $operation -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($pending.schemaVersion -ne 1 -or $pending.kind -ne 'stop' -or $pending.transactionId -notmatch '^[0-9a-f-]{36}$' -or -not (Test-Path -LiteralPath $fence)) { throw 'Maintenance state is ambiguous; inspect it before recovering.' }
      Invoke-TabroMaintenanceResume $Installation $result.runtime.mcpUrl $pending.transactionId $result.runtime.health.instanceRef
      Remove-Item -LiteralPath $operation -Force
    } elseif (Test-Path -LiteralPath $fence) { throw 'An interrupted maintenance transaction needs inspection before startup.' }
    return $result
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
