[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
  $root = Get-TabroRoot ''
  # Setup and every profile's launcher share the installation lock. A profile
  # cannot read partially written state while another profile is setting up.
  $mutex = Get-TabroMutex $root
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another Tabro setup or startup is in progress.' }
    $installation = Read-TabroState $root
    $ready = Start-TabroRuntime $installation
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
  if ($ready.runtime.health.serviceVersion -ne $installation.state.version) { throw 'Broker and plugin runtime versions do not match.' }
  $env:TABRO_RUNTIME = 'hermes'
  $env:TABRO_RUNTIME_FILE = Join-Path $installation.data 'runtime.json'
  $env:TABRO_TOKEN_FILE = Join-Path $installation.data 'admin-token.txt'
  $env:TABRO_TOKEN = $null
  $env:TABRO_AGENT_TOKEN = $null
  $env:OCTOPUS_BROWSER_RELAY_TOKEN = $null
  $env:OCTOPUS_AGENT_TOKEN = $null
  $env:NODE_NO_WARNINGS = '1'
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $installation.node
  $start.Arguments = '"' + (Join-Path $installation.runtime 'adapter\main.js') + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  # MCP stdio uses UTF-8 JSON lines. Console.In preserves any input buffered by
  # PowerShell; reopening the raw handle can lose the first initialize message.
  Add-Type -TypeDefinition @'
using System.IO;
using System.Threading.Tasks;
public static class TabroMcpInput {
  public static Task Pump(TextReader source, TextWriter target) {
    return Task.Run(() => {
      try {
        string line;
        while ((line = source.ReadLine()) != null) {
          target.WriteLine(line);
          target.Flush();
        }
      } finally { target.Close(); }
    });
  }
}
'@
  $adapter = [Diagnostics.Process]::Start($start)
  try {
    $inputPump = [TabroMcpInput]::Pump([Console]::In, $adapter.StandardInput)
    $outputPump = $adapter.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
    $errorPump = $adapter.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
    $adapter.WaitForExit()
    [void]$outputPump.GetAwaiter().GetResult()
    [void]$errorPump.GetAwaiter().GetResult()
    if ($inputPump.IsFaulted) { [void]$inputPump.GetAwaiter().GetResult() }
    $exitCode = $adapter.ExitCode
  } finally {
    if (-not $adapter.HasExited) { $adapter.Kill() }
    $adapter.Dispose()
  }
  exit $exitCode
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
