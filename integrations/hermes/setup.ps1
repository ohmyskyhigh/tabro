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
$registryRoots = @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts', 'HKCU:\Software\Chromium\NativeMessagingHosts', 'HKCU:\Software\AdsPower\SunBrowser\NativeMessagingHosts')
$mutex = Get-TabroMutex $install
$locked = $false
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
try {
  try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another Tabro setup is running. Retry after it finishes.' }
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
    $runtimeFile = Join-Path $data 'runtime.json'
    if ($old.packageDigest -ne $package.digest -and (Test-Path -LiteralPath $runtimeFile)) {
      $record = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if (Get-Process -Id $record.processId -ErrorAction SilentlyContinue) { throw 'A different Tabro release is running. Finish browser work and stop it before setup.' }
    }
  }
  if (-not $SkipNativeRegistration) {
    foreach ($root in $registryRoots) {
      $key = Join-Path $root $nativeName
      $prior = if (Test-Path -LiteralPath $key) { (Get-Item -LiteralPath $key).GetValue('') } else { $null }
      if ($prior -and $prior -ne $nativeManifest -and -not $ReplaceNativeRegistration) { throw 'A different Tabro Native Host is registered. Keep it until its browser work ends; then use -ReplaceNativeRegistration to switch explicitly.' }
      $registryBackups += @{ key = $key; value = $prior }
    }
  }
  . (Join-Path $source 'helpers\browser-runtime.ps1')
  $configFile = Join-Path $data 'managed-profiles.json'
  $configuredPath = if (Test-Path -LiteralPath $configFile) { [string](Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json).executablePath } else { '' }
  $browser = Resolve-TabroBrowser -BrowserPath $BrowserPath -ConfiguredPath $configuredPath
  if ($configuredPath -and $browser.path -ne $configuredPath -and (Test-Path -LiteralPath (Join-Path $data 'runtime.json'))) {
    $record = Get-Content -LiteralPath (Join-Path $data 'runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (Get-Process -Id $record.processId -ErrorAction SilentlyContinue) { throw 'Stop the shared Broker before changing its browser executable.' }
  }
  foreach ($dir in @($install, $data, (Split-Path -Parent $nativeManifest))) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $install /inheritance:r /grant:r "*${ownerSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the local installation directory.' }
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
  foreach ($relative in @('data\managed-profiles.json', 'data\managed-profiles.json.previous', ('bootstrap\' + $nativeName + '.json'))) {
    $file = Get-TabroChild $install $relative
    $configurationBackups += @{ path = $file; bytes = $(if (Test-Path -LiteralPath $file -PathType Leaf) { [IO.File]::ReadAllBytes($file) } else { $null }) }
  }
  $configurationWritten = $true
  & (Join-Path $release 'helpers\configure-managed-profiles.ps1') -DataRoot $data -ExtensionPath $extension -BrowserPath $browser.path -RelayUrl 'ws://127.0.0.1:0/relay' | Out-Null
  $state = [ordered]@{ schemaVersion = 1; version = $manifest.version; contractVersion = $manifest.contractVersion; packageDigest = $package.digest; runtimeDirectory = $releaseRelative; nativeHostEntry = $manifest.nativeHostEntry; nodePath = $NodePath; nativeRegistered = -not $SkipNativeRegistration; extensionPath = $extension }
  [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  $stateWritten = $true
  if (-not $SkipNativeRegistration) {
    [ordered]@{ name = $nativeName; description = 'Tabro Native Messaging companion'; path = (Join-Path $release $manifest.nativeHostEntry); type = 'stdio'; allowed_origins = @('chrome-extension://caekiojlchhifdomfghejkbfpmaklafe/') } | ConvertTo-Json | Set-Content -LiteralPath $nativeManifest -Encoding UTF8
    foreach ($backup in $registryBackups) { [void](New-Item -Path $backup.key -Force); Set-Item -Path $backup.key -Value $nativeManifest }
  }
  $started = Start-TabroRuntime (Read-TabroState $install)
  if (Test-Path -LiteralPath $extensionBackup) { Remove-Item -LiteralPath $extensionBackup -Recurse -Force -ErrorAction SilentlyContinue }
  $mcp = [ordered]@{ command = 'powershell.exe'; args = @('-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'launch.ps1')); env = @{ TABRO_INSTALL_ROOT = $install; TABRO_RUNTIME = 'mcp-agent' } }
  [ordered]@{ status = 'INSTALLED'; version = $manifest.version; installRoot = $install; installationScope = 'windows-user'; hermesHome = $env:HERMES_HOME; browser = $browser; broker = $started; nativeRegistered = -not $SkipNativeRegistration; extensionPath = $extension; mcp = $mcp; nextAction = 'Register the printed stdio MCP entry or reload the enabled Hermes plugin connection. For an existing profile, load extensionPath from chrome://extensions or edge://extensions. Broker-owned Profiles load the extension on creation or open.' } | ConvertTo-Json -Depth 8
} catch {
  if ($configurationWritten) {
    foreach ($backup in $configurationBackups) {
      if ($null -ne $backup.bytes) { [IO.File]::WriteAllBytes($backup.path, [byte[]]$backup.bytes) }
      elseif (Test-Path -LiteralPath $backup.path) { Remove-Item -LiteralPath $backup.path }
    }
  }
  if ($stateWritten) {
    if ($null -ne $previousState) { [IO.File]::WriteAllText($stateFile, $previousState, [Text.UTF8Encoding]::new($false)) }
    else { Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue }
    foreach ($backup in $registryBackups) {
      if ($null -ne $backup.value) { Set-Item -Path $backup.key -Value $backup.value }
      elseif (Test-Path -LiteralPath $backup.key) { Remove-Item -LiteralPath $backup.key }
    }
  }
  if ($extensionPublished) { Remove-Item -LiteralPath $extension -Recurse -Force }
  if (Test-Path -LiteralPath $extensionBackup) { Move-Item -LiteralPath $extensionBackup -Destination $extension }
  throw
} finally {
  if (Test-Path -LiteralPath $extensionStage) { Remove-Item -LiteralPath $extensionStage -Recurse -Force -ErrorAction SilentlyContinue }
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
