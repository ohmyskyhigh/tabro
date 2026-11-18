[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [string]$InstallRoot = '',
  [string]$NodePath = '',
  [switch]$DownloadNode
)
$ErrorActionPreference = 'Stop'
$setup = Join-Path ([IO.Path]::GetFullPath($PackagePath)) 'setup.ps1'
if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
  throw 'PackagePath must be an extracted, checksum-verified current Windows Tabro package containing setup.ps1.'
}
$parameters = @{}
if ($InstallRoot) { $parameters.InstallRoot = $InstallRoot }
if ($NodePath) { $parameters.NodePath = $NodePath }
if ($DownloadNode) { $parameters.DownloadNode = $true }
& $setup @parameters
