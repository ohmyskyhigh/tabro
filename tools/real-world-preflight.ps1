param(
  [string]$RunId = '',
  [ValidateSet('U1','U2')][string]$Checkpoint = 'U1',
  [string]$WorkspaceRoot = '',
  [string]$McpHealthUrl = 'http://127.0.0.1:7331/health',
  [string]$RelayHealthUrl = 'http://127.0.0.1:7332/health',
  [string]$McpUrl = 'http://127.0.0.1:7331/mcp',
  [string]$ExtensionPath = 'dist\browser-extension',
  [string]$NativeHostPath = 'dist\native-host\relay-native-host.exe',
  [string]$McpAdapterPath = 'dist\mcp-stdio-adapter\src\main.js',
  [string]$NativeManifestPath = '.relay-data\bootstrap\io.github.ohmyskyhigh.octopus_browser_relay.json',
  [string]$PairingInstructionsPath = '.relay-data\bootstrap\PAIRING.md',
  [string]$McpInstructionsPath = '.relay-data\bootstrap\MCP-REGISTRATION.md',
  [string]$CodexRegistrationPath = '.relay-data\bootstrap\codex-mcp.toml',
  [string]$HermesRegistrationPath = '.relay-data\bootstrap\hermes-mcp.txt',
  [string]$AdminTokenPath = '.relay-data\admin-token.txt',
  [string[]]$NativeRegistryRoots = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Chromium\NativeMessagingHosts',
    'HKCU:\Software\AdsPower\SunBrowser\NativeMessagingHosts'
  )
)

if (-not [string]::IsNullOrWhiteSpace($RunId)) {
  Write-Error "The -RunId/-Checkpoint preflight uses the retired relay-v1 MCP contract and cannot qualify Tabro 0.3.0. Run this script without -RunId, then follow doc\06-Files\Real-World-Runbook.md for the canonical fourteen-tool physical test."
  exit 2
}

$workspace = if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
else {
  [System.IO.Path]::GetFullPath($WorkspaceRoot)
}

Push-Location $workspace
try {
  $registryArguments = @($NativeRegistryRoots | ForEach-Object { "--native-registry-root=$_" })
  pnpm exec tsx tests/real-world/setup-readiness.ts `
    --workspace=$workspace `
    --mcp-health=$McpHealthUrl `
    --mcp-url=$McpUrl `
    --relay-health=$RelayHealthUrl `
    --extension=$ExtensionPath `
    --native-host=$NativeHostPath `
    --mcp-adapter=$McpAdapterPath `
    --native-manifest=$NativeManifestPath `
    --pairing-instructions=$PairingInstructionsPath `
    --mcp-instructions=$McpInstructionsPath `
    --codex-registration=$CodexRegistrationPath `
    --hermes-registration=$HermesRegistrationPath `
    --admin-token=$AdminTokenPath `
    @registryArguments
  $setupExit = $LASTEXITCODE
  if ($setupExit -ne 0) { exit $setupExit }
}
finally {
  Pop-Location
}
