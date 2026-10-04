import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')('selects compatible browsers and preserves explicit/shared selections', () => {
  const helper = resolve('tools/browser-runtime.ps1').replaceAll("'", "''");
  // Fake file metadata, but execute the production PowerShell resolver itself.
  const script = `
. '${helper}'
function Test-Path { param([string]$LiteralPath, [string]$PathType); return $LiteralPath -ne 'C:\\missing.exe' }
function Get-Item { param([string]$LiteralPath); return @{ FullName=$LiteralPath; VersionInfo=@{ FileVersion=$(if ($LiteralPath -eq 'C:\\old.exe') { '152.0.0.0' } else { '154.0.4258.53' }) } } }
function Get-TabroBrowserCandidates { 'C:\\old.exe'; 'C:\\edge.exe' }
$env:TABRO_BROWSER_PATH = ''
$auto = Resolve-TabroBrowser
$env:TABRO_BROWSER_PATH = 'C:\\env.exe'
$envChoice = Resolve-TabroBrowser
$saved = Resolve-TabroBrowser -ConfiguredPath 'C:\\saved.exe'
$explicit = Resolve-TabroBrowser -BrowserPath 'C:\\custom.exe' -ConfiguredPath 'C:\\saved.exe'
$rejected = @()
foreach ($path in @('C:\\missing.exe', 'C:\\old.exe', 'relative.exe', 'C:relative.exe', '\\relative.exe')) {
  try { Resolve-TabroBrowser -BrowserPath $path | Out-Null; throw 'Unexpected acceptance' }
  catch { if ($_.Exception.Message -eq 'Unexpected acceptance') { throw }; $rejected += $path }
}
@{ auto=$auto.path; envChoice=$envChoice.path; saved=$saved.path; explicit=$explicit.path; rejected=$rejected } | ConvertTo-Json -Compress
`;
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }));
  expect(result).toEqual({ auto: 'C:\\edge.exe', envChoice: 'C:\\env.exe', saved: 'C:\\saved.exe', explicit: 'C:\\custom.exe', rejected: ['C:\\missing.exe', 'C:\\old.exe', 'relative.exe', 'C:relative.exe', '\\relative.exe'] });
});
