import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import { ProxyCredentialStore } from '../../apps/broker/src/proxy/proxy-credential-store.js';

it.runIf(process.platform === 'win32' || process.env.TABRO_QUALIFY_CREDENTIALS === '1')('keeps credentials in the OS vault and rejects another principal or malformed reference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tabro-proxy-vault-')); const vault = new ProxyCredentialStore(root);
  let ref: string | undefined;
  try {
    const secret = { username: 'fixture-user', password: 'unique-proxy-fixture-secret-!:/' };
    ref = await vault.provision(secret, 'principal');
    expect(await vault.read(ref, 'principal')).toEqual(secret);
    await expect(vault.read(ref, 'other')).rejects.toThrow('PROXY_CREDENTIALS_UNAVAILABLE');
    await expect(vault.read('../secret', 'principal')).rejects.toThrow('PROXY_CREDENTIALS_UNAVAILABLE');
    for (const file of readdirSync(root)) expect(readFileSync(join(root, file)).includes(Buffer.from(secret.password))).toBe(false);
  } finally {
    if (ref && process.platform !== 'win32') {
      const account = `${createHash('sha256').update(resolve(root)).digest('hex')}:${ref}`;
      if (process.platform === 'darwin') execFileSync('/usr/bin/security', ['delete-generic-password', '-s', 'Tabro proxy credentials', '-a', account], { stdio: 'ignore' });
      if (process.platform === 'linux') execFileSync('secret-tool', ['clear', 'application', 'tabro', 'account', account], { stdio: 'ignore' });
    }
    if (resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('tabro-proxy-vault-')) rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
