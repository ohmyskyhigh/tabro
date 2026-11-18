import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'win32')('reads maintenance exit codes directly and keeps helper output off MCP stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'tabro maintenance exit '));
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  try {
    mkdirSync(join(root, 'data'));
    const helper = join(root, 'maintenance-client.js');
    const script = join(root, 'test.ps1');
    writeFileSync(script, `$ErrorActionPreference='Stop'\n. ${quote(resolve('integrations/hermes/common.ps1'))}\n` +
      `$installation=@{node=${quote(process.execPath)};runtime=${quote(root)};data=${quote(join(root, 'data'))}}\n` +
      `$LASTEXITCODE=$null\nInvoke-TabroMaintenanceResume $installation 'http://127.0.0.1:1/mcp' 'transaction' 'instance'\n'RESUMED'\n`);
    writeFileSync(helper, 'console.log("private helper output"); process.exit(0);');
    expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8' }).trim()).toBe('RESUMED');
    writeFileSync(helper, 'console.error("fixture resume failed"); process.exit(9);');
    expect(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/exit 9.*fixture resume failed/su);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
