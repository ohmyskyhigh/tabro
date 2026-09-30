[CmdletBinding()]
param(
  [string]$Repository = 'ohmyskyhigh/tabro',
  [string]$Version = 'latest',
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Octopus Browser Relay'),
  [string]$DataRoot = '',
  [string]$PackagePath = '',
  [string]$ChecksumPath = '',
  [string]$NodePath = '',
  [int]$McpPort = 7331,
  [int]$RelayPort = 7332,
  [string[]]$NativeRegistryRoots = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Chromium\NativeMessagingHosts',
    'HKCU:\Software\AdsPower\SunBrowser\NativeMessagingHosts'
  ),
  [switch]$SkipNativeRegistration,
  [switch]$EnableManagedProfiles,
  [switch]$NoStartBroker,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$hostName = 'io.github.ohmyskyhigh.octopus_browser_relay'
$extensionId = 'caekiojlchhifdomfghejkbfpmaklafe'
$install = [IO.Path]::GetFullPath($InstallRoot)
$data = if ($DataRoot) { [IO.Path]::GetFullPath($DataRoot) } else { Join-Path $install 'data' }
$releases = Join-Path $install 'releases'
$bootstrap = Join-Path $install 'bootstrap'
$stableExtension = Join-Path $install 'browser-extension'
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("octopus-update-" + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $temporaryRoot 'release.zip'
$checksum = Join-Path $temporaryRoot 'release.zip.sha256'
$expanded = Join-Path $temporaryRoot 'expanded'
$previousStatePath = Join-Path $bootstrap 'current-release.json'
$previousStateText = if (Test-Path -LiteralPath $previousStatePath) { Get-Content -LiteralPath $previousStatePath -Raw } else { $null }
$previousState = if ($previousStateText) { $previousStateText | ConvertFrom-Json } else { $null }
$extensionBackup = Join-Path $temporaryRoot 'extension-backup'
$installedHermesRegistrationHelper = Join-Path $install 'register-hermes-profiles.ps1'
$brokerStopped = $false
$previousBrokerWasRunning = $false
$upgradeBackup = Join-Path $data ('upgrade-backups\' + [guid]::NewGuid().ToString('N'))
$databaseBackup = Join-Path $upgradeBackup 'relay.sqlite'
$managedConfigBackup = Join-Path $upgradeBackup 'managed-profiles.json'
$releaseBackup = Join-Path $temporaryRoot 'previous-release'
$bootstrapBackup = Join-Path $temporaryRoot 'previous-bootstrap'
$replacedReleaseRoot = $null

function Assert-ChildPath([string]$Parent, [string]$Child) {
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childFull = [IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escapes its expected root: $childFull"
  }
}

function ConvertTo-PowerShellLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Invoke-Mirror([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & robocopy $Source $Destination /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE while copying $Source." }
}

function Write-NativeManifest([pscustomobject]$State) {
  if ($SkipNativeRegistration) { return $null }
  $manifestPath = Join-Path $bootstrap "$hostName.json"
  [ordered]@{
    name = $hostName
    description = 'Tabro Native Messaging companion'
    path = [string]$State.nativeHostEntry
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  foreach ($root in $NativeRegistryRoots) {
    if ($root -like 'HKCU:*' -or $root -like 'HKLM:*') {
      New-Item -Path $root -Force | Out-Null
      $key = Join-Path $root $hostName
      New-Item -Path $key -Force | Out-Null
      Set-Item -Path $key -Value $manifestPath
    }
  }
  return $manifestPath
}

function Start-InstalledBroker([pscustomobject]$State) {
  $node = if ($NodePath) { [IO.Path]::GetFullPath($NodePath) } else { (Get-Command node -ErrorAction Stop).Source }
  $launcher = Join-Path $bootstrap 'broker-launcher.mjs'
  $environment = @{
    RELAY_DB_PATH = (Join-Path $data 'relay.sqlite')
    RELAY_HOST = '127.0.0.1'
    RELAY_MCP_PORT = [string]$McpPort
    RELAY_WS_PORT = [string]$RelayPort
    RELAY_LOG_LEVEL = 'info'
  }
  $process = Start-Process -FilePath $node -ArgumentList @('"' + $launcher + '"') -WorkingDirectory $install -WindowStyle Hidden -PassThru -Environment $environment
  Set-Content -LiteralPath (Join-Path $data 'broker.pid') -Value $process.Id -Encoding ascii
  $healthUrl = "http://127.0.0.1:$McpPort/health"
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    Start-Sleep -Milliseconds 125
    if ($process.HasExited) { throw "Updated broker exited with code $($process.ExitCode)." }
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
      if ($health.status -eq 'ok' -and $health.serviceVersion -eq $State.version -and $health.mcpContractVersion -eq '2') {
        return [ordered]@{ processId = $process.Id; healthUrl = $healthUrl; health = $health }
      }
    } catch { }
  }
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  throw "Updated broker did not report version $($State.version) at $healthUrl."
}

function Stop-CurrentBroker {
  $stopScript = Join-Path $install 'stop-installed-broker.ps1'
  if (Test-Path -LiteralPath $stopScript) {
    $result = & $stopScript -InstallRoot $install -DataRoot $data -AllowNotRunning | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Installed broker stop failed with exit code $LASTEXITCODE." }
    return $result.stopped -eq $true
  } elseif (Test-Path -LiteralPath (Join-Path $data 'broker.pid')) {
    throw "A broker PID exists, but the fenced installed stop command is missing at $stopScript."
  }
  return $false
}

try {
  New-Item -ItemType Directory -Force -Path $temporaryRoot, $expanded, $releases, $bootstrap, $data | Out-Null
  if ($PackagePath) {
    $resolvedPackage = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $PackagePath).Path)
    Copy-Item -LiteralPath $resolvedPackage -Destination $archive
    $resolvedChecksum = if ($ChecksumPath) {
      [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ChecksumPath).Path)
    } elseif (Test-Path -LiteralPath "$resolvedPackage.sha256") {
      "$resolvedPackage.sha256"
    } else {
      throw 'A local package requires its sibling .sha256 file or -ChecksumPath.'
    }
    Copy-Item -LiteralPath $resolvedChecksum -Destination $checksum
  } else {
    $releaseUri = if ($Version -eq 'latest') {
      "https://api.github.com/repos/$Repository/releases/latest"
    } else {
      $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
      "https://api.github.com/repos/$Repository/releases/tags/$tag"
    }
    $release = Invoke-RestMethod -Uri $releaseUri -Headers @{ 'User-Agent' = 'tabro-updater' }
    $zipAsset = @($release.assets | Where-Object { $_.name -match '^tabro-v.+-windows-x64\.zip$' })
    if ($zipAsset.Count -eq 0) {
      $zipAsset = @($release.assets | Where-Object { $_.name -match '^octopus-browser-relay-v.+-windows-x64\.zip$' })
    }
    if ($zipAsset.Count -ne 1) { throw "Release $($release.tag_name) must contain exactly one Windows x64 ZIP." }
    $checksumAsset = @($release.assets | Where-Object { $_.name -eq "$($zipAsset[0].name).sha256" })
    if ($checksumAsset.Count -ne 1) { throw "Release $($release.tag_name) has no matching checksum asset." }
    Invoke-WebRequest -Uri $zipAsset[0].browser_download_url -OutFile $archive -Headers @{ 'User-Agent' = 'tabro-updater' }
    Invoke-WebRequest -Uri $checksumAsset[0].browser_download_url -OutFile $checksum -Headers @{ 'User-Agent' = 'tabro-updater' }
  }

  $expectedHash = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  if ($expectedHash -notmatch '^[a-f0-9]{64}$') { throw 'The release checksum file is invalid.' }
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw "Release checksum mismatch: expected $expectedHash, received $actualHash." }

  Expand-Archive -LiteralPath $archive -DestinationPath $expanded
  $manifestPath = Join-Path $expanded 'release-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'The release archive has no root release-manifest.json.' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'windows-x64' -or [string]::IsNullOrWhiteSpace($manifest.version)) {
    throw 'The release manifest identity is invalid.'
  }
  foreach ($file in $manifest.files) {
    $path = Join-Path $expanded ([string]$file.path)
    Assert-ChildPath $expanded $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Release file is missing: $($file.path)" }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$file.sha256).ToLowerInvariant()) { throw "Release file hash mismatch: $($file.path)" }
    if ((Get-Item -LiteralPath $path).Length -ne [long]$file.bytes) { throw "Release file size mismatch: $($file.path)" }
  }

  $releaseRoot = Join-Path $releases ([string]$manifest.version)
  Assert-ChildPath $releases $releaseRoot
  if ((Test-Path -LiteralPath $releaseRoot) -and -not $Force) {
    throw "Release $($manifest.version) is already installed. Pass -Force to repair it."
  }
  $releaseStage = Join-Path $releases (".staging-" + [guid]::NewGuid().ToString('N'))
  Assert-ChildPath $releases $releaseStage
  Copy-Item -LiteralPath $expanded -Destination $releaseStage -Recurse

  if (Test-Path -LiteralPath $stableExtension) {
    Copy-Item -LiteralPath $stableExtension -Destination $extensionBackup -Recurse
  }
  $snapshotNode = if ($NodePath) { [IO.Path]::GetFullPath($NodePath) } else { (Get-Command node -ErrorAction Stop).Source }
  & $snapshotNode (Join-Path $expanded 'tools\managed-upgrade-snapshot.mjs') (Join-Path $data 'relay.sqlite') $databaseBackup --check-only
  if ($LASTEXITCODE -ne 0) { throw 'Finish browser work and stop managed Profiles before upgrading.' }
  $previousBrokerWasRunning = Stop-CurrentBroker
  $brokerStopped = $true
  & $snapshotNode (Join-Path $expanded 'tools\managed-upgrade-snapshot.mjs') (Join-Path $data 'relay.sqlite') $databaseBackup
  if ($LASTEXITCODE -ne 0) { throw 'Upgrade requires inactive workspaces, completed requests and stopped managed Profiles; the previous broker will be restored.' }
  [void](New-Item -ItemType Directory -Path $upgradeBackup -Force)
  if (Test-Path -LiteralPath (Join-Path $data 'managed-profiles.json')) { Copy-Item -LiteralPath (Join-Path $data 'managed-profiles.json') -Destination $managedConfigBackup }
  if (Test-Path -LiteralPath $bootstrap) { Copy-Item -LiteralPath $bootstrap -Destination $bootstrapBackup -Recurse }
  if (Test-Path -LiteralPath $releaseRoot) {
    Assert-ChildPath $releases $releaseRoot
    Assert-ChildPath $temporaryRoot $releaseBackup
    Move-Item -LiteralPath $releaseRoot -Destination $releaseBackup
    $replacedReleaseRoot = $releaseRoot
  }
  Move-Item -LiteralPath $releaseStage -Destination $releaseRoot
  Invoke-Mirror (Join-Path $releaseRoot ([string]$manifest.extensionDirectory)) $stableExtension
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'tools\installed-broker-launcher.mjs') -Destination (Join-Path $bootstrap 'broker-launcher.mjs') -Force
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'tools\installed-mcp-adapter-launcher.mjs') -Destination (Join-Path $bootstrap 'mcp-stdio-adapter.mjs') -Force
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'tools\update-local.ps1') -Destination (Join-Path $install 'update-local.ps1') -Force
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'tools\stop-installed-broker.ps1') -Destination (Join-Path $install 'stop-installed-broker.ps1') -Force
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'tools\register-hermes-profiles.ps1') -Destination $installedHermesRegistrationHelper -Force

  $state = [ordered]@{
    version = [string]$manifest.version
    releaseRoot = $releaseRoot
    brokerEntry = (Join-Path $releaseRoot ([string]$manifest.brokerEntry))
    mcpAdapterEntry = (Join-Path $releaseRoot ([string]$manifest.mcpAdapterEntry))
    nativeHostEntry = (Join-Path $releaseRoot ([string]$manifest.nativeHostEntry))
    extensionDirectory = $stableExtension
    installedAt = [DateTime]::UtcNow.ToString('o')
  }
  $state | ConvertTo-Json | Set-Content -LiteralPath $previousStatePath -Encoding utf8
  $nativeManifest = Write-NativeManifest ([pscustomobject]$state)
  $managedConfig = Join-Path $data 'managed-profiles.json'
  if ($EnableManagedProfiles -or (Test-Path -LiteralPath $managedConfig)) {
    & (Join-Path $releaseRoot 'tools\configure-managed-profiles.ps1') -DataRoot $data -ExtensionPath $stableExtension -RelayUrl "ws://127.0.0.1:$RelayPort/relay" | Out-Null
  }

  $adapter = Join-Path $bootstrap 'mcp-stdio-adapter.mjs'
  $tokenFile = Join-Path $data 'admin-token.txt'
  $nodeExecutable = if ($NodePath) { [IO.Path]::GetFullPath($NodePath) } else { (Get-Command node -ErrorAction Stop).Source }
  @"
[mcp_servers.tabro]
command = "$($nodeExecutable.Replace('\','\\'))"
args = ["$($adapter.Replace('\','\\'))"]
env = { TABRO_BROKER_URL = "http://127.0.0.1:$McpPort/mcp", TABRO_TOKEN_FILE = "$($tokenFile.Replace('\','\\'))", TABRO_RUNTIME = "codex" }
"@ | Set-Content -LiteralPath (Join-Path $bootstrap 'codex-mcp.toml') -Encoding utf8
  $hermesCommand = @(
    'pwsh -NoProfile -File',
    (ConvertTo-PowerShellLiteral $installedHermesRegistrationHelper),
    '-NodeExecutable',
    (ConvertTo-PowerShellLiteral $nodeExecutable),
    '-AdapterPath',
    (ConvertTo-PowerShellLiteral $adapter),
    '-BrokerUrl',
    (ConvertTo-PowerShellLiteral "http://127.0.0.1:$McpPort/mcp"),
    '-TokenFile',
    (ConvertTo-PowerShellLiteral $tokenFile)
  ) -join ' '
  $hermesCommand | Set-Content -LiteralPath (Join-Path $bootstrap 'hermes-mcp.txt') -Encoding utf8
  @"
Load this extension directory once with Chrome developer mode and Load unpacked:
$stableExtension

Future updates keep this path and the updated broker requests one safe extension reload.

Codex: merge the generated codex-mcp.toml fragment into the applicable Codex config.toml and start a new session.

Hermes: run the command in hermes-mcp.txt. It registers Tabro in the default profile and every named profile currently installed. Start a new session in each profile, then run: hermes -p <profile> mcp test tabro

Rerun hermes-mcp.txt after creating another Hermes profile so the new isolated profile receives the MCP registration.

Both handoffs point to the local token file instead of embedding its contents. Do not paste the token into chat, documentation, source control, or shell history.
"@ | Set-Content -LiteralPath (Join-Path $bootstrap 'INSTALLATION.md') -Encoding utf8

  $started = if ($NoStartBroker) { $null } else { Start-InstalledBroker ([pscustomobject]$state) }
  [ordered]@{
    status = 'UPDATED'
    version = $state.version
    installRoot = $install
    releaseRoot = $releaseRoot
    extensionPath = $stableExtension
    extensionAction = if (-not $previousStateText) {
      'load_unpacked_once'
    } elseif ([string]$previousState.version -ne [string]$state.version) {
      'automatic_reload_requested'
    } else {
      'same_version_repaired_reload_manually_if_needed'
    }
    nativeManifest = $nativeManifest
    broker = $started
    archiveSha256 = $actualHash
  } | ConvertTo-Json -Depth 10
} catch {
  if ($brokerStopped -and $previousStateText) {
    if ($replacedReleaseRoot -and (Test-Path -LiteralPath $releaseBackup)) {
      Assert-ChildPath $releases $replacedReleaseRoot
      if (Test-Path -LiteralPath $replacedReleaseRoot) { Remove-Item -LiteralPath $replacedReleaseRoot -Recurse -Force }
      Move-Item -LiteralPath $releaseBackup -Destination $replacedReleaseRoot
    }
    if (Test-Path -LiteralPath $bootstrapBackup) { Invoke-Mirror $bootstrapBackup $bootstrap }
    if (Test-Path -LiteralPath $databaseBackup) {
      foreach ($suffix in @('-wal', '-shm')) {
        $sidecar = Join-Path $data ('relay.sqlite' + $suffix)
        if (Test-Path -LiteralPath $sidecar) { Remove-Item -LiteralPath $sidecar -Force }
      }
      Copy-Item -LiteralPath $databaseBackup -Destination (Join-Path $data 'relay.sqlite') -Force
    }
    Set-Content -LiteralPath $previousStatePath -Value $previousStateText -Encoding utf8
    if (Test-Path -LiteralPath $extensionBackup) { Invoke-Mirror $extensionBackup $stableExtension }
    if (Test-Path -LiteralPath $managedConfigBackup) { Copy-Item -LiteralPath $managedConfigBackup -Destination (Join-Path $data 'managed-profiles.json') -Force }
    Write-NativeManifest $previousState | Out-Null
    if ($previousBrokerWasRunning -and -not $NoStartBroker) {
      Start-InstalledBroker $previousState | Out-Null
    }
  }
  throw
} finally {
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $tempFull = [IO.Path]::GetFullPath($temporaryRoot)
  if ($tempFull.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $tempFull)) {
    Remove-Item -LiteralPath $tempFull -Recurse -Force
  }
}
