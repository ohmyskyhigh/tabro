param([string]$OutputPath = '')
$ErrorActionPreference = 'Stop'

$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $workspace 'apps\native-host\src\relay-native-host.cpp'
$outputDirectory = Join-Path $workspace 'dist\native-host'
$output = Join-Path $outputDirectory 'relay-native-host.exe'
if ($OutputPath) { $output = [IO.Path]::GetFullPath($OutputPath) }
$buildRef = [Guid]::NewGuid().ToString('N')
$temporaryOutput = Join-Path $outputDirectory "relay-native-host.$buildRef.exe"
$temporaryObject = Join-Path $outputDirectory "relay-native-host.$buildRef.obj"

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$vsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installationPath = if (Test-Path -LiteralPath $vsWhere) {
  & $vsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
else {
  $null
}

if (-not $installationPath) {
  $knownBuildTools = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2017\BuildTools'
  if (Test-Path -LiteralPath $knownBuildTools) { $installationPath = $knownBuildTools }
}
if (-not $installationPath) {
  throw 'Visual Studio C++ Build Tools were not found.'
}

$developerCommand = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
try {
  $compileCommand = 'call "{0}" -arch=x64 && cl /nologo /EHsc /O2 /W4 /DUNICODE /D_UNICODE "{1}" /Fo:"{2}" /Fe:"{3}" /link winhttp.lib' -f $developerCommand, $source, $temporaryObject, $temporaryOutput
  & cmd.exe /d /s /c $compileCommand
  if ($LASTEXITCODE -ne 0) { throw "Native companion build failed with exit code $LASTEXITCODE." }

  try {
    Copy-Item -LiteralPath $temporaryOutput -Destination $output -Force
  }
  catch [System.IO.IOException] {
    if (-not (Test-Path -LiteralPath $output)) { throw }
    $sourceTimestamp = (Get-Item -LiteralPath $source).LastWriteTimeUtc
    $installedTimestamp = (Get-Item -LiteralPath $output).LastWriteTimeUtc
    if ($sourceTimestamp -gt $installedTimestamp) {
      throw 'The running native companion locks an older binary. Close the connected browser profiles or stop their native companion processes before rebuilding.'
    }
    Write-Warning 'The running native companion locked the destination. The source is not newer than the installed binary, and a fresh temporary compilation succeeded.'
  }
}
finally {
  Remove-Item -LiteralPath $temporaryOutput -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $temporaryObject -Force -ErrorAction SilentlyContinue
}

Write-Output $output
