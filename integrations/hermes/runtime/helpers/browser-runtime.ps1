$ErrorActionPreference = 'Stop'

function Get-TabroBrowserCandidates {
  foreach ($relative in @('Google\Chrome\Application\chrome.exe', 'Microsoft\Edge\Application\msedge.exe', 'Chromium\Application\chrome.exe')) {
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
      if ($base) { Join-Path $base $relative }
    }
  }
}

function Test-TabroBrowser([string]$Path) {
  if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/])' -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw 'Browser executable is missing. Set TABRO_BROWSER_PATH or -BrowserPath to the absolute path of Chrome, Chromium or Microsoft Edge.'
  }
  $file = Get-Item -LiteralPath $Path
  $version = $file.VersionInfo.FileVersion
  if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)\.(\d+)') { throw 'Cannot read the browser executable version.' }
  $numericVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).$($Matches[4])"
  if ([int]$Matches[1] -lt 153) { throw "Tabro requires browser version 153 or newer; found $numericVersion. Required Chromium capabilities are also checked when opening a Profile." }
  return @{ path = $file.FullName; version = $numericVersion }
}

function Resolve-TabroBrowser([string]$BrowserPath = '', [string]$ConfiguredPath = '') {
  # Preserve a shared installation's selected browser on repeat setup.
  if ($BrowserPath) { return Test-TabroBrowser $BrowserPath }
  if ($ConfiguredPath) { return Test-TabroBrowser $ConfiguredPath }
  if ($env:TABRO_BROWSER_PATH) { return Test-TabroBrowser $env:TABRO_BROWSER_PATH }
  foreach ($candidate in @(Get-TabroBrowserCandidates)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      try { return Test-TabroBrowser $candidate } catch { continue }
    }
  }
  throw 'No compatible browser found. Install Chrome, Chromium or Microsoft Edge 153+, or specify -BrowserPath.'
}
