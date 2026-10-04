[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$StartBroker,
  [switch]$SkipDependencyInstall,
  [switch]$SkipBuild,
  [switch]$SkipNativeRegistration,
  [switch]$EnableManagedProfiles,
  [string]$WorkspaceRoot = '',
  [string]$DataRoot = '',
  [string]$ExtensionPath = '',
  [string]$NativeHostPath = '',
  [string]$BootstrapRoot = '',
  [string]$McpUrl = 'http://127.0.0.1:0/mcp',
  [string]$RelayUrl = 'ws://127.0.0.1:0/relay',
  [string[]]$NativeRegistryRoots = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
    'HKCU:\Software\Chromium\NativeMessagingHosts',
    'HKCU:\Software\AdsPower\SunBrowser\NativeMessagingHosts'
  )
)

$ErrorActionPreference = 'Stop'
$hostName = 'io.github.ohmyskyhigh.octopus_browser_relay'
$legacyHostNames = @('com.openai.profile_aware_browser_relay')
$extensionId = 'caekiojlchhifdomfghejkbfpmaklafe'

function Resolve-TaskPath([string]$Value, [string]$Fallback, [string]$Base) {
  $candidate = if ([string]::IsNullOrWhiteSpace($Value)) { $Fallback } else { $Value }
  if (-not [System.IO.Path]::IsPathFullyQualified($candidate)) {
    $candidate = Join-Path $Base $candidate
  }
  return [System.IO.Path]::GetFullPath($candidate)
}

function Invoke-Checked([string]$FilePath, [string[]]$ArgumentList) {
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE."
  }
}

function ConvertTo-PowerShellLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Test-Health([string]$Url) {
  try {
    $response = Invoke-RestMethod -Method Get -Uri $Url -TimeoutSec 2
    return $null -ne $response -and $response.status -eq 'ok'
  }
  catch {
    return $false
  }
}

function Assert-LoopbackUri([string]$Value, [string[]]$Schemes, [string]$Label) {
  try { $uri = [Uri]$Value }
  catch { throw "$Label is not a valid URI: $Value" }
  if (-not $uri.IsAbsoluteUri -or $Schemes -notcontains $uri.Scheme) {
    throw "$Label must use one of these schemes: $($Schemes -join ', ')."
  }
  if (@('127.0.0.1', 'localhost', '::1') -notcontains $uri.Host.ToLowerInvariant()) {
    throw "$Label must use a loopback host."
  }
  return $uri
}

$defaultWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspace = Resolve-TaskPath $WorkspaceRoot $defaultWorkspace $defaultWorkspace
$data = Resolve-TaskPath $DataRoot '.relay-data' $workspace
$extension = Resolve-TaskPath $ExtensionPath 'dist\browser-extension' $workspace
$nativeHost = Resolve-TaskPath $NativeHostPath 'dist\native-host\relay-native-host.exe' $workspace
$mcpAdapter = Resolve-TaskPath '' 'dist\mcp-stdio-adapter\src\main.js' $workspace
$hermesRegistrationHelper = Resolve-TaskPath '' 'tools\register-hermes-profiles.ps1' $workspace
$brokerEntry = Resolve-TaskPath '' 'dist\broker\src\runtime\main.js' $workspace
$bootstrap = Resolve-TaskPath $BootstrapRoot (Join-Path $data 'bootstrap') $workspace
$nativeManifest = Join-Path $bootstrap "$hostName.json"
$pairingInstructions = Join-Path $bootstrap 'PAIRING.md'
$mcpInstructions = Join-Path $bootstrap 'MCP-REGISTRATION.md'
$codexTemplate = Join-Path $bootstrap 'codex-mcp.toml'
$hermesTemplate = Join-Path $bootstrap 'hermes-mcp.txt'
$adminTokenFile = Join-Path $data 'admin-token.txt'
$brokerPidFile = Join-Path $data 'broker.pid'
$runtimeFile = Join-Path $data 'runtime.json'
$mcpUri = Assert-LoopbackUri $McpUrl @('http', 'https') 'MCP URL'
$relayUri = Assert-LoopbackUri $RelayUrl @('ws', 'wss') 'Relay URL'
$mcpHealthUrl = $McpUrl -replace '/mcp$', '/health'
$relayHealthScheme = $relayUri.Scheme -replace '^ws$', 'http' -replace '^wss$', 'https'
$relayHealthUrl = '{0}://{1}/health' -f $relayHealthScheme, $relayUri.Authority
if (Test-Path -LiteralPath $runtimeFile) {
  try {
    $running = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    $mcpHealthUrl = $running.mcpUrl -replace '/mcp$', '/health'
    $relayHealthUrl = ($running.relayUrl -replace '^ws:', 'http:') -replace '/relay$', '/health'
  } catch { }
}

if (-not (Test-Path -LiteralPath (Join-Path $workspace 'package.json'))) {
  throw "Workspace does not contain package.json: $workspace"
}

if (-not $Install) {
  $preflight = Join-Path $workspace 'tests\real-world\setup-readiness.ts'
  if (-not (Test-Path -LiteralPath $preflight)) {
    throw "Setup preflight is missing: $preflight"
  }
  Push-Location $workspace
  try {
    $registryArguments = @($NativeRegistryRoots | ForEach-Object { "--native-registry-root=$_" })
    & pnpm exec tsx $preflight `
      "--workspace=$workspace" `
      "--mcp-health=$mcpHealthUrl" `
      "--mcp-url=$McpUrl" `
      "--relay-health=$relayHealthUrl" `
      "--extension=$extension" `
      "--native-host=$nativeHost" `
      "--mcp-adapter=$mcpAdapter" `
      "--native-manifest=$nativeManifest" `
      "--pairing-instructions=$pairingInstructions" `
      "--mcp-instructions=$mcpInstructions" `
      "--codex-registration=$codexTemplate" `
      "--hermes-registration=$hermesTemplate" `
      "--hermes-registration-helper=$hermesRegistrationHelper" `
      "--admin-token=$adminTokenFile" `
      @registryArguments
    exit $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
}

New-Item -ItemType Directory -Force -Path $data, $bootstrap | Out-Null

Push-Location $workspace
try {
  if (-not $SkipDependencyInstall) {
    Invoke-Checked 'pnpm' @('install', '--frozen-lockfile')
  }
  if (-not $SkipBuild) {
    Invoke-Checked 'pnpm' @('build')
  }
}
finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath (Join-Path $extension 'manifest.json'))) {
  throw "Built extension is missing: $extension"
}
if (-not (Test-Path -LiteralPath $nativeHost)) {
  throw "Built native host is missing: $nativeHost"
}
if (-not (Test-Path -LiteralPath $mcpAdapter)) {
  throw "Built stdio MCP adapter is missing: $mcpAdapter"
}
if (-not (Test-Path -LiteralPath $hermesRegistrationHelper)) {
  throw "Hermes all-profile registration helper is missing: $hermesRegistrationHelper"
}
if (-not (Test-Path -LiteralPath $brokerEntry)) {
  throw "Built broker entry point is missing: $brokerEntry"
}

$nativeManifestBody = [ordered]@{
  name = $hostName
  description = 'Tabro native companion'
  path = $nativeHost
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
}
$nativeManifestBody | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $nativeManifest -Encoding utf8

if (-not $SkipNativeRegistration) {
  foreach ($registryRoot in $NativeRegistryRoots) {
    $registrationPath = Join-Path $registryRoot $hostName
    New-Item -Path $registrationPath -Force | Out-Null
    Set-Item -LiteralPath $registrationPath -Value $nativeManifest
    foreach ($legacyHostName in $legacyHostNames) {
      $legacyPath = Join-Path $registryRoot $legacyHostName
      if (-not (Test-Path -LiteralPath $legacyPath)) { continue }
      $legacyManifest = [string](Get-Item -LiteralPath $legacyPath).GetValue('')
      if ([string]::IsNullOrWhiteSpace($legacyManifest) -or -not (Test-Path -LiteralPath $legacyManifest -PathType Leaf)) {
        continue
      }
      try {
        $legacyBody = Get-Content -LiteralPath $legacyManifest -Raw | ConvertFrom-Json
        $legacyOrigins = @($legacyBody.allowed_origins)
        if ($legacyBody.name -eq $legacyHostName -and $legacyOrigins -contains "chrome-extension://$extensionId/") {
          Remove-Item -LiteralPath $legacyPath
        }
      }
      catch {
        # Preserve unknown or malformed registrations rather than deleting a key we cannot attribute.
      }
    }
  }
}

$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$codexNodeJson = ConvertTo-Json $nodeExecutable -Compress
$codexAdapterJson = ConvertTo-Json $mcpAdapter -Compress
$codexRuntimeFileJson = ConvertTo-Json $runtimeFile -Compress
$codexTokenFileJson = ConvertTo-Json $adminTokenFile -Compress
$codexConfig = @"
[mcp_servers.tabro]
command = $codexNodeJson
args = [$codexAdapterJson]
env = { TABRO_RUNTIME_FILE = $codexRuntimeFileJson, TABRO_TOKEN_FILE = $codexTokenFileJson, TABRO_RUNTIME = "codex" }
"@
$codexConfig | Set-Content -LiteralPath $codexTemplate -Encoding utf8

$hermesCommand = @(
  'pwsh -NoProfile -File',
  (ConvertTo-PowerShellLiteral $hermesRegistrationHelper),
  '-NodeExecutable',
  (ConvertTo-PowerShellLiteral $nodeExecutable),
  '-AdapterPath',
  (ConvertTo-PowerShellLiteral $mcpAdapter),
  '-RuntimeFile',
  (ConvertTo-PowerShellLiteral $runtimeFile),
  '-TokenFile',
  (ConvertTo-PowerShellLiteral $adminTokenFile)
) -join ' '
$hermesCommand | Set-Content -LiteralPath $hermesTemplate -Encoding utf8

$mcpGuide = @"
# MCP registration

The installer generated instructions but did not overwrite Codex or Hermes configuration.

1. Start the shared Broker, read mcpUrl from $runtimeFile, replace /mcp with /health, and require status: ok.
2. Codex: merge the contents of $codexTemplate into the applicable Codex config.toml, then start a new Codex session.
3. Hermes: run the command stored in $hermesTemplate. It registers Tabro in the default profile and every named profile installed when the command runs. Start a new session in each profile, then run: hermes -p <profile> mcp test tabro
4. Both registrations launch $mcpAdapter as a stdio MCP server. Each adapter process injects its Codex or Hermes session evidence outside tool arguments and discovers the shared Broker through $runtimeFile and forwards the canonical eighteen tools. Broker and adapter must both use MCP contract v2.
5. The adapter prefers CODEX_THREAD_ID, CODEX_SESSION_ID, HERMES_SESSION_ID, or HERMES_AGENT_SESSION_ID. When the runtime supplies none of them, it creates one random session key for that adapter process. A runtime must launch a separate adapter process for each independent agent session when it supplies no session ID.
6. The generated registrations point to $adminTokenFile; they do not embed the bearer token. Do not paste the token into chat, documentation, source control, or retained shell history.
7. Rerun the Hermes command after creating another Hermes profile so the new isolated profile receives the MCP registration.

The Broker publishes actual MCP and relay addresses to $runtimeFile. Port 0 requests free ports from the operating system. Demo and ordinary sessions share this runtime.
"@
$mcpGuide | Set-Content -LiteralPath $mcpInstructions -Encoding utf8

$pairingGuide = @"
# Browser profile pairing

1. Open chrome://extensions in each intended Chrome or AdsPower profile.
2. Enable developer mode, choose **Load unpacked**, and select $extension.
3. Confirm extension ID $extensionId and accept the debugger, tabGroups, and Native Messaging permissions.
4. Open Tabro settings. Keep **Native companion** selected. It discovers the actual relay address from relay-runtime.json beside the native executable; a saved legacy URL is only used when no discovery record exists.
5. The extension generates and displays a two-word profile-local pairing code and compact combined endpoint nickname, such as MINT-WAVE and mintwave. It registers automatically with the running local broker; do not request or enter a broker-generated code. A nickname collision selects another two-word label and retries automatically.
6. Choose **Save connection settings** only if you changed the transport or relay URL.
7. Wait for Status: connected, then confirm the broker context lists the final nickname and at least one browser window.
8. Repeat for every profile. Each profile has a separate identity and readable code.

The readable pairing code is an installation label, not a password. Reconnect authentication uses the persisted profile key. Reset pairing only when intentionally replacing that profile endpoint; reset generates a new key, code, and nickname candidate and does not delete browser history, tabs, or the browser profile.
"@
$pairingGuide | Set-Content -LiteralPath $pairingInstructions -Encoding utf8

if ($EnableManagedProfiles) {
  & (Join-Path $workspace 'tools\configure-managed-profiles.ps1') -DataRoot $data -ExtensionPath $extension -RelayUrl $RelayUrl | Out-Null
}

if ($StartBroker -and -not (Test-Health $mcpHealthUrl)) {
  $node = (Get-Command node -ErrorAction Stop).Source
  $environment = @{
    RELAY_DB_PATH = (Join-Path $data 'relay.sqlite')
    RELAY_MCP_PORT = $mcpUri.Port.ToString()
    RELAY_WS_PORT = $relayUri.Port.ToString()
    TABRO_RUNTIME_FILE = $runtimeFile
    TABRO_NATIVE_RUNTIME_FILE = (Join-Path (Split-Path -Parent $nativeHost) 'relay-runtime.json')
  }
  $managedConfig = Join-Path $data 'managed-profiles.json'
  if (Test-Path -LiteralPath $managedConfig) { $environment.RELAY_PROFILES_CONFIG = $managedConfig }
  $process = Start-Process -FilePath $node -ArgumentList @("`"$brokerEntry`"") -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -Environment $environment
  Set-Content -LiteralPath $brokerPidFile -Value $process.Id -Encoding ascii
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { throw 'Broker exited during installation.' }
    try {
      $running = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
      if ($running.processId -ne $process.Id) { continue }
      $mcpHealthUrl = $running.mcpUrl -replace '/mcp$', '/health'
      $relayHealthUrl = ($running.relayUrl -replace '^ws:', 'http:') -replace '/relay$', '/health'
      if (Test-Health $mcpHealthUrl) { break }
    } catch { }
  }
  if (-not (Test-Health $mcpHealthUrl)) {
    throw "Broker process $($process.Id) started but did not become healthy at $mcpHealthUrl."
  }
}

Write-Output ([ordered]@{
  status = if ($SkipNativeRegistration) { 'PREPARED' } else { 'INSTALLED' }
  workspace = $workspace
  dataRoot = $data
  extensionPath = $extension
  nativeHostPath = $nativeHost
  mcpAdapterPath = $mcpAdapter
  nativeManifestPath = $nativeManifest
  nativeRegistryRoots = $NativeRegistryRoots
  nativeRegistration = if ($SkipNativeRegistration) { 'skipped' } else { 'current-user' }
  brokerPidFile = $brokerPidFile
  mcpHealth = if (Test-Health $mcpHealthUrl) { 'ready' } else { 'not-running' }
  relayHealth = if (Test-Health $relayHealthUrl) { 'ready' } else { 'not-running' }
  mcpInstructions = $mcpInstructions
  pairingInstructions = $pairingInstructions
} | ConvertTo-Json -Depth 4)
