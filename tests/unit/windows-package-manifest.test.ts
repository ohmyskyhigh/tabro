import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MCP_CONTRACT_VERSION } from '../../apps/shared/protocol/src/mcp/tool-catalog.js';

it.runIf(process.platform === 'win32')('accepts the current MCP contract in the Windows installer manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'tabro-windows-manifest-'));
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  try {
    writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
      schemaVersion: 1, platform: 'windows-x64', contractVersion: MCP_CONTRACT_VERSION
    }));
    const script = join(root, 'test.ps1');
    writeFileSync(script, `. ${quote(resolve('integrations/hermes/common.ps1'))}\n$TabroPluginRoot = $PSScriptRoot\n(Get-TabroPackage).manifest.contractVersion\n`);
    const actual = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8' });
    expect(actual.trim()).toBe(MCP_CONTRACT_VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
