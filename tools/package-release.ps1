[CmdletBinding()]
param(
  [string]$OutputDirectory = 'artifacts\release',
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$outputRoot = [IO.Path]::GetFullPath((Join-Path $workspace $OutputDirectory))
$stage = Join-Path $outputRoot "tabro-v$version-windows-x64"
$archive = "$stage.zip"
$checksum = "$archive.sha256"
$updater = Join-Path $outputRoot 'tabro-update.ps1'

if (-not $SkipVerify) {
  & pnpm verify
  if ($LASTEXITCODE -ne 0) { throw "pnpm verify failed with exit code $LASTEXITCODE." }
} else {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed with exit code $LASTEXITCODE." }
}

& pnpm exec tsx tools/stage-release.ts "--output=$stage"
if ($LASTEXITCODE -ne 0) { throw "Release staging failed with exit code $LASTEXITCODE." }

if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksum -Value "$hash  $([IO.Path]::GetFileName($archive))" -Encoding ascii
Copy-Item -LiteralPath (Join-Path $workspace 'tools\update-local.ps1') -Destination $updater -Force

[ordered]@{
  status = 'PACKAGED'
  version = $version
  archive = $archive
  checksum = $checksum
  updater = $updater
  sha256 = $hash
} | ConvertTo-Json
