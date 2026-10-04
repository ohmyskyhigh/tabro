[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$DataRoot,
  [Parameter(Mandatory)][string]$ExtensionPath,
  [Alias('ChromePath')][string]$BrowserPath = '',
  [string]$RelayUrl = 'ws://127.0.0.1:7332/relay'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'browser-runtime.ps1')
$data = [IO.Path]::GetFullPath($DataRoot)
$configPath = Join-Path $data 'managed-profiles.json'
$existingConfig = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } else { $null }
$configuredPath = if ($existingConfig) { [string]$existingConfig.executablePath } else { '' }
$browser = Resolve-TabroBrowser -BrowserPath $BrowserPath -ConfiguredPath $configuredPath
$extension = [IO.Path]::GetFullPath($ExtensionPath)
$chrome = $browser.path
$version = $browser.version
$uri = [Uri]$RelayUrl
if ($uri.Scheme -ne 'ws' -or $uri.Host -ne '127.0.0.1' -or $uri.AbsolutePath -ne '/relay') { throw 'Managed relay must use loopback.' }
$hash = [Security.Cryptography.SHA256]::Create()
try {
  foreach ($name in @('manifest.json', 'service-worker.js', 'options.js', 'options.html')) {
    $label = [Text.Encoding]::UTF8.GetBytes($name)
    $bytes = [IO.File]::ReadAllBytes((Join-Path $extension $name))
    [void]$hash.TransformBlock($label, 0, $label.Length, $label, 0)
    [void]$hash.TransformBlock($bytes, 0, $bytes.Length, $bytes, 0)
  }
  [void]$hash.TransformFinalBlock([byte[]]@(), 0, 0)
  $digest = ([BitConverter]::ToString($hash.Hash)).Replace('-', '').ToLowerInvariant()
} finally { $hash.Dispose() }
$root = if ($existingConfig) { [IO.Path]::GetFullPath([string]$existingConfig.root) } else { Join-Path $data 'managed-profiles' }
[void](New-Item -ItemType Directory -Path $root -Force)
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Managed root cannot be a reparse point.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $root /inheritance:r /grant:r "*${identity}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict managed Profile directory permissions.' }
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination ($configPath + '.previous') -Force }
$config = [ordered]@{ root = $root; executablePath = $chrome; extensionSource = $extension; expectedBrowserVersion = $version; expectedExtensionDigest = $digest; relayUrl = $RelayUrl }
if ($existingConfig -and $existingConfig.PSObject.Properties.Name -contains 'launchesEnabled') { $config.launchesEnabled = [bool]$existingConfig.launchesEnabled }
$temporary = $configPath + '.tmp'
[IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $configPath -Force
Write-Output $configPath
