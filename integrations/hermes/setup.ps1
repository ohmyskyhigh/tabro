[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [string]$NodePath = '',
  [string]$ChromePath = '',
  [switch]$DownloadNode,
  [switch]$SkipNativeRegistration,
  [switch]$ReplaceNativeRegistration
)
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
$registryRoots = @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Chromium\NativeMessagingHosts', 'HKCU:\Software\AdsPower\SunBrowser\NativeMessagingHosts')
$mutex = Get-TabroMutex $install
$locked = $false
$previousState = $null
$registryBackups = @()
$stateWritten = $false
$configurationBackups = @()
$configurationWritten = $false
try {
  try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another Tabro setup is running. Retry after it finishes.' }
  foreach ($fact in $manifest.files) {
    $file = Get-TabroChild $source $fact.path
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fact.sha256) { throw "Package integrity check failed: $($fact.path)" }
  }
  if (Test-Path -LiteralPath $stateFile) {
    $previousState = Get-Content -LiteralPath $stateFile -Raw
    $old = $previousState | ConvertFrom-Json
    $runtimeFile = Join-Path $data 'runtime.json'
    if ($old.packageDigest -ne $package.digest -and (Test-Path -LiteralPath $runtimeFile)) {
      $record = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
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
  if (-not $ChromePath) {
    foreach ($candidate in @((Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'), (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'))) {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $ChromePath = $candidate; break }
    }
  }
  if (-not $ChromePath -or -not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) { throw 'Install Google Chrome before setting up Tabro.' }
  $ChromePath = [IO.Path]::GetFullPath($ChromePath)
  if ((Get-Item -LiteralPath $ChromePath).VersionInfo.ProductVersion -ne $manifest.verifiedChromeVersion) { throw "This release qualifies managed Profiles on Chrome $($manifest.verifiedChromeVersion). Found a different Chrome build; no managed configuration was changed." }
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
    } else {
      [void](New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force)
      Copy-Item -LiteralPath (Get-TabroChild $source $fact.path) -Destination $target
    }
  }
  $extension = Join-Path $release 'browser-extension'
  foreach ($relative in @('data\managed-profiles.json', 'data\managed-profiles.json.previous', ('bootstrap\' + $nativeName + '.json'))) {
    $file = Get-TabroChild $install $relative
    $configurationBackups += @{ path = $file; bytes = $(if (Test-Path -LiteralPath $file -PathType Leaf) { [IO.File]::ReadAllBytes($file) } else { $null }) }
  }
  $configurationWritten = $true
  & (Join-Path $release 'helpers\configure-managed-profiles.ps1') -DataRoot $data -ExtensionPath $extension -ChromePath $ChromePath -RelayUrl 'ws://127.0.0.1:0/relay' | Out-Null
  $state = [ordered]@{ schemaVersion = 1; version = $manifest.version; packageDigest = $package.digest; runtimeDirectory = $releaseRelative; nativeHostEntry = $manifest.nativeHostEntry; nodePath = $NodePath; nativeRegistered = -not $SkipNativeRegistration }
  [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  $stateWritten = $true
  if (-not $SkipNativeRegistration) {
    [ordered]@{ name = $nativeName; description = 'Tabro Native Messaging companion'; path = (Join-Path $release $manifest.nativeHostEntry); type = 'stdio'; allowed_origins = @('chrome-extension://caekiojlchhifdomfghejkbfpmaklafe/') } | ConvertTo-Json | Set-Content -LiteralPath $nativeManifest -Encoding UTF8
    foreach ($backup in $registryBackups) { [void](New-Item -Path $backup.key -Force); Set-Item -Path $backup.key -Value $nativeManifest }
  }
  $started = Start-TabroRuntime (Read-TabroState $install)
  [ordered]@{ status = 'INSTALLED'; version = $manifest.version; installRoot = $install; installationScope = 'windows-user'; hermesHome = $env:HERMES_HOME; broker = $started; nativeRegistered = -not $SkipNativeRegistration; extensionPath = $extension; nextAction = 'Reload MCP in this Hermes profile. Enable the plugin separately in each other Hermes profile; all share this Broker installation. Broker-owned Chrome Profiles load the extension automatically. For an existing Chrome Profile, load the extension directory in chrome://extensions.' } | ConvertTo-Json -Depth 8
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
  throw
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
