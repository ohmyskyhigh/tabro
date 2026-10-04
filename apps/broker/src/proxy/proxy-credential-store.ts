import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CredentialReader, ProxyCredentials } from './types.js';
import { ProfileError } from '../profiles/types.js';

// Fixed code; secrets travel over stdin, never through shell interpolation or arguments.
const dpapi = (decrypt: boolean) => `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
async function protect(value: Buffer, decrypt: boolean): Promise<Buffer> {
  if (process.platform !== 'win32') throw new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE');
  return new Promise((ok, fail) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', dpapi(decrypt)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', data => { output += String(data); if (output.length > 65536) child.kill(); });
    child.on('error', () => { clearTimeout(timer); fail(new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE')); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) ok(Buffer.from(output.trim(), 'base64')); else fail(new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE')); });
    child.stdin.on('error', () => {}); child.stdin.end(value.toString('base64'));
  });
}
export class ProxyCredentialStore implements CredentialReader {
  constructor(private readonly root: string) {}
  async provision(secret: ProxyCredentials, principalId: string): Promise<string> {
    if (!principalId || typeof secret.username !== 'string' || !secret.username || typeof secret.password !== 'string' || !secret.password || secret.username.length > 1024 || secret.password.length > 4096) throw new ProfileError('INVALID_ARGUMENT');
    const ref = `pcr_${randomUUID()}`;
    const bytes = Buffer.from(JSON.stringify({ principalId, ...secret }));
    try {
      const encrypted = await protect(bytes, false);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const owner = /S-1-5-[\d-]+/u.exec(execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))?.[0];
      if (!owner) throw new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE');
      execFileSync('icacls.exe', [this.root, '/inheritance:r', '/grant:r', `*${owner}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
      await writeFile(resolve(this.root, `${ref}.bin`), encrypted, { flag: 'wx', mode: 0o600 });
      return ref;
    } finally { bytes.fill(0); }
  }
  async read(ref: string, principalId: string): Promise<ProxyCredentials> {
    if (!/^pcr_[0-9a-f-]{36}$/u.test(ref)) throw new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE');
    let bytes: Buffer | undefined;
    try {
      bytes = await protect(await readFile(resolve(this.root, `${ref}.bin`)), true);
      const value = JSON.parse(bytes.toString()) as ProxyCredentials & { principalId: string };
      if (value.principalId !== principalId) throw new Error('unauthorized');
      return { username: value.username, password: value.password };
    } catch { throw new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE'); }
    finally { bytes?.fill(0); }
  }
}
