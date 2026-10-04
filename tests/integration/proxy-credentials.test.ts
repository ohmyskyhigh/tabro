import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import { ProxyCredentialStore } from '../../apps/broker/src/proxy/proxy-credential-store.js';

it('keeps credentials encrypted and rejects another principal or malformed reference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tabro-proxy-vault-')); const vault = new ProxyCredentialStore(root);
  try {
    const secret = { username: 'fixture-user', password: 'unique-proxy-fixture-secret-!:/' };
    if (process.platform !== 'win32') { await expect(vault.provision(secret, 'principal')).rejects.toThrow('PROXY_CREDENTIALS_UNAVAILABLE'); return; }
    const ref = await vault.provision(secret, 'principal');
    expect(await vault.read(ref, 'principal')).toEqual(secret);
    await expect(vault.read(ref, 'other')).rejects.toThrow('PROXY_CREDENTIALS_UNAVAILABLE');
    await expect(vault.read('../secret', 'principal')).rejects.toThrow('PROXY_CREDENTIALS_UNAVAILABLE');
    for (const file of readdirSync(root)) expect(readFileSync(join(root, file)).includes(Buffer.from(secret.password))).toBe(false);
  } finally {
    if (resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('tabro-proxy-vault-')) rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
