[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [string]$NodePath = '',
  [Alias('ChromePath')][string]$BrowserPath = '',
  [switch]$DownloadNode,
  [switch]$SkipNativeRegistration,
  [switch]$ReplaceNativeRegistration
)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'common.ps1')
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This Tabro package supports Windows x64.' }
$install = Get-TabroRoot $InstallRoot
$package = Get-TabroPackage
$manifest = $package.manifest
$source = Join-Path $PSScriptRoot 'runtime'
$releaseRelative = 'releases\' + $manifest.version + '-' + $package.digest.Substring(0, 12)
$release = Get-TabroChild $install $releaseRelative
$data = Get-TabroChild $install 'data'
$stateFile = Get-TabroChild $install 'installation.json'
$nativeName = 'io.github.ohmyskyhigh.octopus_browser_relay'
$nativeManifest = Get-TabroChild $install ('bootstrap\' + $nativeName + '.json')
$stableNativeHost = Get-TabroChild $install 'bootstrap\relay-native-host.exe'
$registryRoots = @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts', 'HKCU:\Software\Chromium\NativeMessagingHosts', 'HKCU:\Software\AdsPower\SunBrowser\NativeMessagingHosts')
$mutex = Get-TabroMutex $install
$locked = $false
$transactionDirectory = Join-Path $install 'installation.transaction'
$transactionOwned = $false
$previousState = $null
$registryBackups = @()
$stateWritten = $false
$configurationBackups = @()
$configurationWritten = $false
$extension = Get-TabroChild $install 'browser-extension'
$extensionStage = "$extension.$([guid]::NewGuid().ToString('N')).incoming"
$extensionBackup = "$extensionStage.previous"
$extensionPublished = $false
$nativeDownload = $null
$transactionId = $null
$snapshot = $null
$resumeRequested = $false
try {
  try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another Tabro setup is running. Retry after it finishes.' }
  [void](New-Item -ItemType Directory -Path $transactionDirectory -ErrorAction Stop)
  $transactionOwned = $true
  if ($manifest.nativeHostUrl) {
    $version = [string]$manifest.version
    $expectedEntry = "native-host/relay-native-host-$version.exe"
    $expectedUrl = "https://github.com/ohmyskyhigh/tabro/releases/download/v$version/tabro-native-host-v$version-windows-x64.exe"
    $nativeFacts = @($manifest.files | Where-Object { $_.path -ceq $expectedEntry })
    if ($version -cnotmatch '^\d+\.\d+\.\d+$' -or $manifest.nativeHostEntry -cne $expectedEntry -or $manifest.nativeHostUrl -cne $expectedUrl -or
        $nativeFacts.Count -ne 1 -or $nativeFacts[0].sha256 -cnotmatch '^[a-f0-9]{64}$' -or $nativeFacts[0].bytes -le 0) {
      throw 'Invalid Native Host release metadata.'
    }
    $nativeFile = Get-TabroChild $source $expectedEntry
    if (-not (Test-Path -LiteralPath $nativeFile)) { $nativeDownload = $nativeFacts[0] }
  }
  foreach ($fact in $manifest.files) {
    if ($nativeDownload -and $fact.path -ceq $nativeDownload.path) { continue }
    $file = Get-TabroChild $source $fact.path
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fact.sha256) { throw "Package integrity check failed: $($fact.path)" }
  }
  if (Test-Path -LiteralPath $stateFile) {
    $previousState = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8
    $old = $previousState | ConvertFrom-Json
    if ($old.schemaVersion -ne 1 -or -not $old.runtimeDirectory) { throw 'The existing installation is legacy or invalid. Preserve it and follow the offline migration guidance in GETTING_STARTED.md; do not upgrade it in place.' }
    $oldRuntime = Get-TabroChild $install ([string]$old.runtimeDirectory)
    if (-not (Test-Path -LiteralPath (Join-Path $oldRuntime 'native-host\machine-lock.node') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $oldRuntime 'maintenance-client.js') -PathType Leaf)) { throw 'The existing installation predates device-wide registration. Preserve it and follow the offline migration guidance in GETTING_STARTED.md; do not upgrade it in place.' }
    $oldConfig = Join-Path $data 'managed-profiles.json'
    $oldBrowser = if (Test-Path -LiteralPath $oldConfig) { [string](Get-Content -LiteralPath $oldConfig -Raw -Encoding UTF8 | ConvertFrom-Json).executablePath } else { '' }
    if ($old.packageDigest -eq $package.digest -and (-not $NodePath -or $NodePath -eq $old.nodePath) -and (-not $BrowserPath -or [IO.Path]::GetFullPath($BrowserPath) -ieq $oldBrowser)) {
      if ([string]$old.runtimeDirectory -ine $releaseRelative) { throw 'The installed release does not match its package digest.' }
      if (-not $SkipNativeRegistration) {
        foreach ($root in $registryRoots) {
          $key = Join-Path $root $nativeName
          $exists = Test-Path -LiteralPath $key
          $prior = if ($exists) { (Get-Item -LiteralPath $key).GetValue('') } else { $null }
          if ($prior -and $prior -ine $nativeManifest -and -not $ReplaceNativeRegistration) { throw "A different Tabro Native Host is registered at $key. Finish its browser work and use -ReplaceNativeRegistration to switch explicitly." }
          $registryBackups += @{ key = $key; value = $prior; existed = $exists }
        }
        foreach ($relative in @($manifest.nativeHostEntry, 'native-host/relay-native-host.js', 'native-host/machine-lock.node')) {
          $facts = @($manifest.files | Where-Object { $_.path -ceq $relative })
          $file = Get-TabroChild $release $relative
          if ($facts.Count -ne 1 -or -not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $facts[0].sha256) { throw "Installed Native Host runtime is missing or damaged: $relative" }
        }
        if ((Get-FileHash -LiteralPath $old.nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.node.executableSha256) { throw 'Installed Node executable checksum mismatch.' }
        $bootstrapNode = Get-TabroChild $install 'bootstrap\node.exe'
        $pointer = Get-TabroChild $install 'bootstrap\current-native-release.txt'
        if ((Test-Path -LiteralPath $bootstrapNode) -and (Get-FileHash -LiteralPath $bootstrapNode -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.node.executableSha256) { throw 'The installed Native Host Node runtime differs; inspect the installation before continuing.' }
        $hostFacts = @($manifest.files | Where-Object { $_.path -ceq $manifest.nativeHostEntry })
        if ((Test-Path -LiteralPath $stableNativeHost) -and (Get-FileHash -LiteralPath $stableNativeHost -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hostFacts[0].sha256) { throw 'The installed Native Host differs; inspect the installation before continuing.' }
        if ((Test-Path -LiteralPath $pointer) -and (Get-Content -LiteralPath $pointer -Raw -Encoding UTF8).Trim() -cne $releaseRelative.Replace('\', '/')) { throw 'The Native Host release pointer conflicts with the installed release.' }
        foreach ($file in @($nativeManifest, $stableNativeHost, $pointer)) {
          $configurationBackups += @{ path = $file; bytes = $(if (Test-Path -LiteralPath $file -PathType Leaf) { [IO.File]::ReadAllBytes($file) } else { $null }) }
        }
        $configurationWritten = $true
        $stateWritten = $true
        if (-not (Test-Path -LiteralPath $bootstrapNode)) { Copy-Item -LiteralPath $old.nodePath -Destination $bootstrapNode }
        if (-not (Test-Path -LiteralPath $stableNativeHost)) { Copy-Item -LiteralPath (Get-TabroChild $release $manifest.nativeHostEntry) -Destination $stableNativeHost }
        if (-not (Test-Path -LiteralPath $pointer)) {
          $pointerTemp = "$pointer.$([guid]::NewGuid().ToString('N')).tmp"
          try { [IO.File]::WriteAllText($pointerTemp, ($releaseRelative.Replace('\', '/') + "`n"), [Text.UTF8Encoding]::new($false)); [IO.File]::Move($pointerTemp, $pointer) }
          finally { Remove-Item -LiteralPath $pointerTemp -Force -ErrorAction SilentlyContinue }
        }
        $manifestText = [ordered]@{ name = $nativeName; description = 'Tabro Native Messaging companion'; path = $stableNativeHost; type = 'stdio'; allowed_origins = @('chrome-extension://caekiojlchhifdomfghejkbfpmaklafe/') } | ConvertTo-Json
        $manifestTemp = "$nativeManifest.$([guid]::NewGuid().ToString('N')).tmp"
        try {
          [IO.File]::WriteAllText($manifestTemp, $manifestText, [Text.UTF8Encoding]::new($false))
          if (Test-Path -LiteralPath $nativeManifest) { [IO.File]::Replace($manifestTemp, $nativeManifest, $null) } else { [IO.File]::Move($manifestTemp, $nativeManifest) }
        } finally { Remove-Item -LiteralPath $manifestTemp -Force -ErrorAction SilentlyContinue }
        foreach ($backup in $registryBackups) { [void](New-Item -Path $backup.key -Force); Set-Item -Path $backup.key -Value $nativeManifest }
        $old | Add-Member -NotePropertyName nativeRegistered -NotePropertyValue $true -Force
        $stateTemp = "$stateFile.$([guid]::NewGuid().ToString('N')).tmp"
        try { [IO.File]::WriteAllText($stateTemp, ($old | ConvertTo-Json), [Text.UTF8Encoding]::new($false)); [IO.File]::Replace($stateTemp, $stateFile, $null) }
        finally { Remove-Item -LiteralPath $stateTemp -Force -ErrorAction SilentlyContinue }
      }
      $started = Start-TabroRuntime (Read-TabroState $install)
      [ordered]@{ status = 'INSTALLED'; installRoot = $install; extensionPath = $extension; broker = $started } | ConvertTo-Json -Depth 8
      return
    }
  } else {
    $conflicts = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.CommandLine -match '(?i)broker[\\/](?:main\.(?:js|mjs)|src[\\/]runtime[\\/]main\.(?:js|ts))(?:["\s]|$)'
    })
    if ($conflicts.Count) { throw ('Existing Broker processes require inspection before first installation: ' + (($conflicts | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }) -join '; ')) }
  }
  if (-not $SkipNativeRegistration) {
    foreach ($root in $registryRoots) {
      $key = Join-Path $root $nativeName
      $prior = if (Test-Path -LiteralPath $key) { (Get-Item -LiteralPath $key).GetValue('') } else { $null }
      if ($prior -and $prior -ne $nativeManifest -and -not $ReplaceNativeRegistration) { throw 'A different Tabro Native Host is registered. Keep it until its browser work ends; then use -ReplaceNativeRegistration to switch explicitly.' }
      $registryBackups += @{ key = $key; value = $prior; existed = (Test-Path -LiteralPath $key) }
    }
  }
  . (Join-Path $source 'helpers\browser-runtime.ps1')
  $configFile = Join-Path $data 'managed-profiles.json'
  $configuredPath = if (Test-Path -LiteralPath $configFile) { [string](Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json).executablePath } else { '' }
  $browser = Resolve-TabroBrowser -BrowserPath $BrowserPath -ConfiguredPath $configuredPath
  foreach ($dir in @($install, $data, (Split-Path -Parent $nativeManifest))) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $install /inheritance:r /grant:r "*${ownerSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the local installation directory.' }
  & icacls.exe (Split-Path -Parent $nativeManifest) /inheritance:r /grant:r "*${ownerSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the Native Host bootstrap directory.' }
  if (-not $NodePath -and -not $DownloadNode) { $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue; if ($nodeCommand) { $NodePath = $nodeCommand.Source } }
  if ($NodePath) {
    $NodePath = [IO.Path]::GetFullPath($NodePath)
    if ((Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.node.executableSha256) { throw "Use Node $($manifest.node.version) x64, or run setup with -DownloadNode." }
  } else {
    $nodeRoot = Get-TabroChild $install ('dependencies\node-v' + $manifest.node.version + '-win-x64')
    $NodePath = Join-Path $nodeRoot 'node.exe'
    if (-not (Test-Path -LiteralPath $NodePath)) {
      $downloadRoot = Get-TabroChild $install ('staging\' + [guid]::NewGuid().ToString('N'))
      [void](New-Item -ItemType Directory -Path $downloadRoot -Force)
      $archive = Join-Path $downloadRoot 'node.zip'
      & curl.exe --fail --location --proto '=https' --connect-timeout 20 --max-time 180 --output $archive $manifest.node.url
      if ($LASTEXITCODE -ne 0) { throw 'Node download failed; retry setup. Existing runtime data is preserved.' }
      if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.node.archiveSha256) { throw 'Node archive checksum mismatch.' }
      Expand-Archive -LiteralPath $archive -DestinationPath $downloadRoot
      [void](New-Item -ItemType Directory -Path (Split-Path -Parent $nodeRoot) -Force)
      $expanded = Get-TabroChild $downloadRoot ('node-v' + $manifest.node.version + '-win-x64')
      Move-Item -LiteralPath $expanded -Destination $nodeRoot
      Remove-Item -LiteralPath $archive
    }
    if ((Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.node.executableSha256) { throw 'Installed Node executable checksum mismatch.' }
  }
  foreach ($fact in $manifest.files) {
    $target = Get-TabroChild $release $fact.path
    if (Test-Path -LiteralPath $target) {
      if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fact.sha256) { throw 'An installed immutable runtime file was modified. Use a fresh InstallRoot or repair the installation.' }
    } elseif ($nativeDownload -and $fact.path -ceq $nativeDownload.path) {
      [void](New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force)
      $pending = "$target.$([guid]::NewGuid().ToString('N')).incoming"
      try {
        & curl.exe --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 180 --output $pending $manifest.nativeHostUrl
        if ($LASTEXITCODE -ne 0) { throw 'Native Host download failed; retry setup. Existing runtime data is preserved.' }
        if ((Get-Item -LiteralPath $pending).Length -ne $fact.bytes -or (Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash.ToLowerInvariant() -cne $fact.sha256) {
          throw 'Native Host checksum mismatch.'
        }
        Move-Item -LiteralPath $pending -Destination $target
      } finally {
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
      }
    } else {
      [void](New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force)
      Copy-Item -LiteralPath (Get-TabroChild $source $fact.path) -Destination $target
    }
  }
  if ($previousState) {
    $oldRuntime = Get-TabroChild $install ([string]$old.runtimeDirectory)
    $oldInstallation = @{ state = $old; runtime = $oldRuntime; node = [string]$old.nodePath; data = $data }
    Start-TabroRuntime $oldInstallation | Out-Null
    & (Join-Path $PSScriptRoot 'stop.ps1') -InstallRoot $install -ForUpgrade | Out-Null
    $operation = Join-Path $data 'maintenance-operation.json'
    $pending = Get-Content -LiteralPath $operation -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pending.kind -ne 'stop' -or -not (Test-Path -LiteralPath (Join-Path $data 'maintenance.json'))) { throw 'The stopped Broker has no valid maintenance fence.' }
    $transactionId = [string]$pending.transactionId
    $journal = [ordered]@{ schemaVersion = 1; kind = 'upgrade'; transactionId = $transactionId; previous = $old.runtimeDirectory; next = $releaseRelative; previousVersion = $old.version; nextVersion = $manifest.version }
    [IO.File]::WriteAllText($operation, ($journal | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    $backupDir = Join-Path $data 'backups'
    [void](New-Item -ItemType Directory -Path $backupDir -Force)
    $snapshot = Join-Path $backupDir ($old.version + '-' + $transactionId + '.sqlite')
    & $NodePath (Join-Path $release 'managed-upgrade-snapshot.mjs') (Join-Path $data 'relay.sqlite') $snapshot
    if ($LASTEXITCODE -ne 0) { throw 'Database snapshot failed; the previous Broker remains fenced for inspection.' }
  }
  $extensionMatches = Test-Path -LiteralPath $extension -PathType Container
  foreach ($fact in @($manifest.files | Where-Object { $_.path -like 'browser-extension/*' })) {
    $name = ([string]$fact.path).Substring('browser-extension/'.Length)
    $file = Get-TabroChild $extension $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fact.sha256) {
      $extensionMatches = $false
      break
    }
  }
  if (-not $extensionMatches) {
    Copy-Item -LiteralPath (Get-TabroChild $release 'browser-extension') -Destination $extensionStage -Recurse
    if (Test-Path -LiteralPath $extension) { Move-Item -LiteralPath $extension -Destination $extensionBackup }
    Move-Item -LiteralPath $extensionStage -Destination $extension
    $extensionPublished = $true
  }
  foreach ($relative in @('data\managed-profiles.json', 'data\managed-profiles.json.previous', 'bootstrap\relay-native-host.exe', 'bootstrap\node.exe', 'bootstrap\current-native-release.txt', ('bootstrap\' + $nativeName + '.json'))) {
    $file = Get-TabroChild $install $relative
    $configurationBackups += @{ path = $file; bytes = $(if (Test-Path -LiteralPath $file -PathType Leaf) { [IO.File]::ReadAllBytes($file) } else { $null }) }
  }
  $configurationWritten = $true
  & (Join-Path $release 'helpers\configure-managed-profiles.ps1') -DataRoot $data -ExtensionPath $extension -BrowserPath $browser.path -RelayUrl 'ws://127.0.0.1:0/relay' | Out-Null
  $state = [ordered]@{ schemaVersion = 1; version = $manifest.version; contractVersion = $manifest.contractVersion; packageDigest = $package.digest; runtimeDirectory = $releaseRelative; nativeHostEntry = $manifest.nativeHostEntry; nodePath = $NodePath; nativeRegistered = -not $SkipNativeRegistration; extensionPath = $extension }
  [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  $stateWritten = $true
  if (-not $SkipNativeRegistration) {
    $bootstrapNode = Join-Path $install 'bootstrap\node.exe'
    if (Test-Path -LiteralPath $bootstrapNode) {
      if ((Get-FileHash -LiteralPath $bootstrapNode -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash) { throw 'The installed Native Host Node runtime differs; keep the fenced installation for maintenance.' }
    } else { Copy-Item -LiteralPath $NodePath -Destination $bootstrapNode }
    $incomingHost = Join-Path $release $manifest.nativeHostEntry
    if (-not (Test-Path -LiteralPath $stableNativeHost) -or (Get-FileHash -LiteralPath $stableNativeHost -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $incomingHost -Algorithm SHA256).Hash) {
      $hostTemp = "$stableNativeHost.$([guid]::NewGuid().ToString('N')).tmp"
      Copy-Item -LiteralPath $incomingHost -Destination $hostTemp
      try { if (Test-Path -LiteralPath $stableNativeHost) { [IO.File]::Replace($hostTemp, $stableNativeHost, $null) } else { [IO.File]::Move($hostTemp, $stableNativeHost) } }
      finally { Remove-Item -LiteralPath $hostTemp -Force -ErrorAction SilentlyContinue }
    }
    $pointer = Join-Path $install 'bootstrap\current-native-release.txt'
    $pointerTemp = "$pointer.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($pointerTemp, ($releaseRelative.Replace('\', '/') + "`n"), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $pointer) { [IO.File]::Replace($pointerTemp, $pointer, $null) } else { [IO.File]::Move($pointerTemp, $pointer) }
    [ordered]@{ name = $nativeName; description = 'Tabro Native Messaging companion'; path = $stableNativeHost; type = 'stdio'; allowed_origins = @('chrome-extension://caekiojlchhifdomfghejkbfpmaklafe/') } | ConvertTo-Json | Set-Content -LiteralPath $nativeManifest -Encoding UTF8
    foreach ($backup in $registryBackups) { [void](New-Item -Path $backup.key -Force); Set-Item -Path $backup.key -Value $nativeManifest }
  }
  $started = Start-TabroRuntime (Read-TabroState $install) -HoldMaintenance:([bool]$transactionId)
  if ($transactionId) {
    if (-not (Test-Path -LiteralPath (Join-Path $data 'maintenance.json'))) { throw 'The upgraded Broker lost its maintenance fence.' }
    $resumeRequested = $true
    & $NodePath (Join-Path $release 'maintenance-client.js') $install $started.runtime.mcpUrl 'resume' $transactionId $started.runtime.health.instanceRef
    if ($LASTEXITCODE -ne 0) { throw 'Upgrade resume is ambiguous; inspect maintenance state without restoring the database.' }
    Remove-Item -LiteralPath (Join-Path $data 'maintenance-operation.json') -Force
  }
  if (Test-Path -LiteralPath $extensionBackup) { Remove-Item -LiteralPath $extensionBackup -Recurse -Force -ErrorAction SilentlyContinue }
  $mcp = [ordered]@{ command = 'powershell.exe'; args = @('-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'launch.ps1')); env = @{ TABRO_INSTALL_ROOT = $install; TABRO_RUNTIME = 'mcp-agent' } }
  [ordered]@{ status = 'INSTALLED'; version = $manifest.version; installRoot = $install; installationScope = 'windows-user'; hermesHome = $env:HERMES_HOME; browser = $browser; broker = $started; nativeRegistered = -not $SkipNativeRegistration; extensionPath = $extension; mcp = $mcp; nextAction = 'Register the printed stdio MCP entry or reload the enabled Hermes plugin connection. For an existing profile, load extensionPath from chrome://extensions or edge://extensions. Broker-owned Profiles load the extension on creation or open.' } | ConvertTo-Json -Depth 8
} catch {
  if ($transactionId) {
    if ($resumeRequested -or -not (Test-Path -LiteralPath (Join-Path $data 'maintenance.json'))) { throw 'Upgrade outcome is ambiguous; do not restore the database. Inspect maintenance-operation.json.' }
    $runtimeFile = Join-Path $data 'runtime.json'
    if (Test-Path -LiteralPath $runtimeFile) {
      $running = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$running.processId)
      if ($proc) {
        if ($proc.ExecutablePath -ine $NodePath -or $proc.CommandLine.IndexOf((Join-Path $release 'broker\main.js'), [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'A different Broker owns the runtime; leave the maintenance fence in place for inspection.' }
        & $NodePath (Join-Path $release 'maintenance-client.js') $install $running.mcpUrl 'stop' $transactionId $running.instanceRef
        if ($LASTEXITCODE -ne 0) { throw 'Broker shutdown is ambiguous; leave the maintenance fence in place for inspection.' }
        Wait-Process -Id $running.processId -Timeout 15 -ErrorAction Stop
      }
    }
  }
  if ($configurationWritten) {
    foreach ($backup in $configurationBackups) {
      if ($backup.path -ieq (Join-Path $install 'bootstrap\node.exe')) { continue }
      if ($null -ne $backup.bytes) {
        $restoreTemp = "$($backup.path).$([guid]::NewGuid().ToString('N')).tmp"
        [IO.File]::WriteAllBytes($restoreTemp, [byte[]]$backup.bytes)
        try { if (Test-Path -LiteralPath $backup.path) { [IO.File]::Replace($restoreTemp, $backup.path, $null) } else { [IO.File]::Move($restoreTemp, $backup.path) } }
        finally { Remove-Item -LiteralPath $restoreTemp -Force -ErrorAction SilentlyContinue }
      }
      elseif (Test-Path -LiteralPath $backup.path) { Remove-Item -LiteralPath $backup.path }
    }
  }
  if ($stateWritten) {
    if ($null -ne $previousState) { [IO.File]::WriteAllText($stateFile, $previousState, [Text.UTF8Encoding]::new($false)) }
    else { Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue }
    foreach ($backup in $registryBackups) {
      if ($null -ne $backup.value) { Set-Item -Path $backup.key -Value $backup.value }
      elseif ($backup.existed -and (Test-Path -LiteralPath $backup.key)) { (Get-Item -LiteralPath $backup.key).DeleteValue('', $false) }
      elseif (Test-Path -LiteralPath $backup.key) { Remove-Item -LiteralPath $backup.key }
    }
  }
  if ($extensionPublished) { Remove-Item -LiteralPath $extension -Recurse -Force }
  if (Test-Path -LiteralPath $extensionBackup) { Move-Item -LiteralPath $extensionBackup -Destination $extension }
  if ($transactionId -and $previousState) {
    if ($snapshot -and (Test-Path -LiteralPath $snapshot)) {
      foreach ($suffix in @('-wal', '-shm')) { Remove-Item -LiteralPath ((Join-Path $data 'relay.sqlite') + $suffix) -Force -ErrorAction SilentlyContinue }
      Copy-Item -LiteralPath $snapshot -Destination (Join-Path $data 'relay.sqlite') -Force
    }
    $oldRuntime = Get-TabroChild $install ([string]$old.runtimeDirectory)
    $restored = Start-TabroRuntime @{ state = $old; runtime = $oldRuntime; node = [string]$old.nodePath; data = $data } -HoldMaintenance
    & $old.nodePath (Join-Path $oldRuntime 'maintenance-client.js') $install $restored.runtime.mcpUrl 'resume' $transactionId $restored.runtime.health.instanceRef
    if ($LASTEXITCODE -ne 0) { throw 'Rollback remains fenced; inspect maintenance-operation.json.' }
    Remove-Item -LiteralPath (Join-Path $data 'maintenance-operation.json') -Force
  }
  throw
} finally {
  if (Test-Path -LiteralPath $extensionStage) { Remove-Item -LiteralPath $extensionStage -Recurse -Force -ErrorAction SilentlyContinue }
  if ($transactionOwned) { Remove-Item -LiteralPath $transactionDirectory -Force -ErrorAction Stop }
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
