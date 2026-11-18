[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OwnerSid,
  [Parameter(Mandatory = $true)][string]$InstallationRoot,
  [Parameter(Mandatory = $true)][string]$DataRoot
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run provisioning in an elevated PowerShell.' }
$sid = [Security.Principal.SecurityIdentifier]::new($OwnerSid)
if ($sid.Value -cne $OwnerSid -or $OwnerSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'OwnerSid must identify the desktop user.' }
function Get-PrivateRoot([string]$Path) {
  if (-not [IO.Path]::IsPathRooted($Path)) { throw "Path must be absolute: $Path" }
  $inputPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $root = [IO.Path]::GetPathRoot($inputPath)
  if ($root.StartsWith('\\')) { throw 'Machine registration requires a local drive path.' }
  $full = $root.ToUpperInvariant()
  foreach ($component in $inputPath.Substring($root.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
    $entries = @(Get-ChildItem -LiteralPath $full -Force | Where-Object { $_.Name -ieq $component })
    if ($entries.Count -ne 1) { throw "Directory path is missing or has ambiguous casing: $Path" }
    $full = Join-Path $full $entries[0].Name
  }
  $current = $full
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are not allowed: $current" }
    $parent = Split-Path -Parent $current
    if ($parent -eq $current) { break }
    $current = $parent
  }
  $item = Get-Item -LiteralPath $full -Force
  if (-not $item.PSIsContainer) { throw "Create a private directory as the desktop user first: $full" }
  $acl = Get-Acl -LiteralPath $full
  $actualOwner = ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($actualOwner -cne $OwnerSid) { throw "Directory must be owned by the designated desktop user: $full" }
  foreach ($rule in $acl.Access) {
    $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow' -and @($OwnerSid, 'S-1-5-18', 'S-1-5-32-544') -notcontains $ruleSid) { throw "Directory must be private to the desktop user: $full" }
  }
  return $full
}
$install = Get-PrivateRoot $InstallationRoot
$data = Get-PrivateRoot $DataRoot
if ($data -ine (Join-Path $install 'data')) { throw 'DataRoot must be the installation root data directory.' }
$directory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'Tabro'
$file = Join-Path $directory 'registration.json'
function Assert-Protected([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point in machine registration: $Path" }
  $acl = Get-Acl -LiteralPath $Path
  $aclOwner = ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  if (@('S-1-5-18', 'S-1-5-32-544') -notcontains $aclOwner) { throw "Machine registration owner is not trusted: $Path" }
  $write = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $acl.Access) {
    $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and @('S-1-5-18', 'S-1-5-32-544') -notcontains $ruleSid) { throw "Machine registration is writable by an untrusted principal: $Path" }
  }
}
if (Test-Path -LiteralPath $directory) {
  $item = Get-Item -LiteralPath $directory -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Machine registration directory is invalid.' }
  Assert-Protected $directory
  if (Test-Path -LiteralPath $file) {
    Assert-Protected $file
    $existing = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($existing.PSObject.Properties).Count -ne 4 -or $existing.schemaVersion -ne 1 -or $existing.owner -cne $OwnerSid -or $existing.installationRoot -ine $install -or $existing.dataRoot -ine $data) { throw 'This device is registered to a different owner or installation.' }
    [ordered]@{ status = 'already_registered'; owner = $OwnerSid; installationRoot = $install; dataRoot = $data } | ConvertTo-Json -Compress
    return
  }
} else {
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $security.SetOwner($administrators)
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($trusted in @([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), $administrators)) {
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($trusted, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  [void][IO.Directory]::CreateDirectory($directory, $security)
  Assert-Protected $directory
  if (Test-Path -LiteralPath $file) { throw 'Machine registration appeared during provisioning; retry to validate it.' }
}
$temporary = Join-Path $directory ('.registration-' + [guid]::NewGuid().ToString('N'))
try {
  $contents = [ordered]@{ schemaVersion = 1; owner = $OwnerSid; installationRoot = $install; dataRoot = $data } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($temporary, $contents, [Text.UTF8Encoding]::new($false))
  & icacls.exe $temporary /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*${OwnerSid}:R" /setowner '*S-1-5-32-544' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not secure the machine registration file.' }
  Move-Item -LiteralPath $temporary -Destination $file -ErrorAction Stop
} finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
[ordered]@{ status = 'registered'; owner = $OwnerSid; installationRoot = $install; dataRoot = $data } | ConvertTo-Json -Compress
