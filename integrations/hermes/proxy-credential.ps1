[CmdletBinding()]
param([string]$InstallRoot = '')
. (Join-Path $PSScriptRoot 'common.ps1')
$installation = Read-TabroState (Get-TabroRoot $InstallRoot)
$username = Read-Host 'Proxy username'
$password = Read-Host 'Proxy password' -AsSecureString
$credential = New-Object System.Management.Automation.PSCredential($username, $password)
$inputJson = @{ username = $username; password = $credential.GetNetworkCredential().Password } | ConvertTo-Json -Compress
try {
  $inputJson | & $installation.node (Join-Path $installation.runtime 'broker\provision-proxy-credential.js') --db (Join-Path $installation.data 'relay.sqlite')
  if ($LASTEXITCODE -ne 0) { throw 'Credential provisioning failed.' }
} finally { $inputJson = $null; $credential = $null; $password.Dispose() }
