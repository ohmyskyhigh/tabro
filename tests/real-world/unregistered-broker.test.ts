import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.runIf(process.env.TABRO_QUALIFY_UNREGISTERED === '1')('fails before creating state when the machine has no registration', () => {
  if (!process.env.TABRO_QUALIFY_PACKAGE) throw new Error('TABRO_QUALIFY_PACKAGE is required.');
  const registration = process.platform === 'win32'
    ? resolve(process.env.ProgramData ?? 'C:\\ProgramData', 'Tabro/registration.json')
    : process.platform === 'darwin' ? '/var/db/tabro/registration.json' : '/var/lib/tabro/registration.json';
  if (existsSync(registration)) throw new Error('This test requires an isolated host with no machine registration.');
  const entry = resolve(process.env.TABRO_QUALIFY_PACKAGE, 'runtime/broker/main.js');
  if (!existsSync(entry)) throw new Error(`Packaged Broker is missing: ${entry}`);
  const root = mkdtempSync(join(tmpdir(), 'tabro-unregistered-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_') && !key.startsWith('TABRO_')));
    env.RELAY_DB_PATH = join(root, 'relay.sqlite');
    const child = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (child.error) throw child.error;
    expect(child.status).not.toBe(0);
    expect(child.stderr).toMatch(/registr/i);
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
