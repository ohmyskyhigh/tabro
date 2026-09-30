import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('Hermes all-profile registration helper', () => {
  it('registers the default profile and every installed named profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'octopus-hermes-profiles-'));
    temporaryRoots.push(root);
    const hermesRoot = join(root, 'hermes');
    const logPath = join(root, 'hermes-arguments.log');
    const fakeHermes = join(root, 'hermes.cmd');
    const nodePath = join(root, 'node.exe');
    const adapterPath = join(root, 'adapter.js');
    const tokenPath = join(root, 'admin-token.txt');

    mkdirSync(join(hermesRoot, 'profiles', 'alpha'), { recursive: true });
    mkdirSync(join(hermesRoot, 'profiles', 'beta'), { recursive: true });
    writeFileSync(nodePath, 'fixture');
    writeFileSync(adapterPath, 'fixture');
    writeFileSync(tokenPath, 'fixture');
    writeFileSync(fakeHermes, [
      '@echo off',
      'echo %*>>"%FAKE_HERMES_LOG%"',
      "echo Saved 'tabro'",
      'exit /b 0'
    ].join('\r\n'));

    const result = spawnSync('pwsh', [
      '-NoProfile',
      '-File', resolve('tools/register-hermes-profiles.ps1'),
      '-NodeExecutable', nodePath,
      '-AdapterPath', adapterPath,
      '-BrokerUrl', 'http://127.0.0.1:7331/mcp',
      '-TokenFile', tokenPath,
      '-HermesExecutable', fakeHermes,
      '-HermesRoot', hermesRoot
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, FAKE_HERMES_LOG: logPath }
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'REGISTERED',
      profiles: ['default', 'alpha', 'beta'],
      profileCount: 3
    });
    const calls = readFileSync(logPath, 'utf8').trim().split(/\r?\n/u);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('-p default mcp add tabro');
    expect(calls[1]).toContain('-p alpha mcp add tabro');
    expect(calls[2]).toContain('-p beta mcp add tabro');
  });
});
