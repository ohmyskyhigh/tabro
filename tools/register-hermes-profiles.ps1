[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$NodeExecutable,
  [Parameter(Mandatory)]
  [string]$AdapterPath,
  [Parameter(Mandatory)]
  [string]$BrokerUrl,
  [Parameter(Mandatory)]
  [string]$TokenFile,
  [string]$HermesExecutable = 'hermes',
  [string]$HermesRoot = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-ExistingFile([string]$Value, [string]$Label) {
  $resolved = [IO.Path]::GetFullPath($Value)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "$Label is missing: $resolved"
  }
  return $resolved
}

function Resolve-HermesRoot([string]$Value) {
  $candidate = if (-not [string]::IsNullOrWhiteSpace($Value)) {
    $Value
  } elseif (-not [string]::IsNullOrWhiteSpace($env:HERMES_HOME)) {
    $env:HERMES_HOME
  } elseif ($IsWindows -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Join-Path $env:LOCALAPPDATA 'hermes'
  } else {
    Join-Path $HOME '.hermes'
  }

  $resolved = [IO.Path]::GetFullPath($candidate)
  $parent = Split-Path -Parent $resolved
  if ((Split-Path -Leaf $parent) -eq 'profiles') {
    return Split-Path -Parent $parent
  }
  return $resolved
}

function Resolve-TargetProfiles([string]$Root) {
  $namedProfilesRoot = Join-Path $Root 'profiles'
  $namedProfiles = if (Test-Path -LiteralPath $namedProfilesRoot -PathType Container) {
    @(Get-ChildItem -LiteralPath $namedProfilesRoot -Directory | Select-Object -ExpandProperty Name | Sort-Object -Unique)
  } else {
    @()
  }
  return @('default') + $namedProfiles
}

try {
  $node = Resolve-ExistingFile $NodeExecutable 'Node executable'
  $adapter = Resolve-ExistingFile $AdapterPath 'MCP stdio adapter'
  $token = Resolve-ExistingFile $TokenFile 'Broker token file'
  $brokerUri = [Uri]$BrokerUrl
  if (-not $brokerUri.IsAbsoluteUri -or @('http', 'https') -notcontains $brokerUri.Scheme) {
    throw 'BrokerUrl must be an absolute HTTP or HTTPS URL.'
  }
  if (@('127.0.0.1', 'localhost', '::1') -notcontains $brokerUri.Host.ToLowerInvariant()) {
    throw 'BrokerUrl must use a loopback host.'
  }

  $hermes = (Get-Command $HermesExecutable -ErrorAction Stop).Source
  $root = Resolve-HermesRoot $HermesRoot
  $targets = Resolve-TargetProfiles $root
  $registered = @()

  foreach ($profile in $targets) {
    $arguments = @(
      '-p', $profile,
      'mcp', 'add', 'tabro',
      '--command', $node,
      '--env',
      "TABRO_BROKER_URL=$BrokerUrl",
      "TABRO_TOKEN_FILE=$token",
      'TABRO_RUNTIME=hermes',
      '--args', $adapter
    )
    $output = @(@('y', 'y') | & $hermes @arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($exitCode -ne 0 -or $text -notmatch "Saved 'tabro'") {
      throw "Hermes MCP registration did not complete for profile '$profile'.`n$text"
    }
    $registered += $profile
  }

  [ordered]@{
    status = 'REGISTERED'
    server = 'tabro'
    profiles = $registered
    profileCount = $registered.Count
    nextAction = 'Start a new session in each registered Hermes profile.'
  } | ConvertTo-Json -Depth 4
}
catch {
  Write-Error $_
  exit 1
}
