import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CredentialReader, ProxyCredentials } from './types.js';
import { ProfileError } from '../profiles/types.js';

// Fixed code; secrets travel over stdin, never through shell interpolation or arguments.
const dpapi = (decrypt: boolean) => `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
function vaultCommand(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const output: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > 65536) child.kill(); else output.push(data); });
    child.on('error', () => { clearTimeout(timer); fail(new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE')); });
    child.on('close', code => { clearTimeout(timer); if (code === 0 && size <= 65536) ok(Buffer.concat(output)); else fail(new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE')); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

async function protect(value: Buffer, decrypt: boolean): Promise<Buffer> {
  const result = await vaultCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', dpapi(decrypt)], Buffer.from(value.toString('base64')));
  return Buffer.from(result.toString().trim(), 'base64');
}

async function unixCredential(root: string, ref: string, secret?: Buffer): Promise<Buffer> {
  const account = `${createHash('sha256').update(resolve(root)).digest('hex')}:${ref}`;
  if (process.platform === 'darwin') {
    return vaultCommand(process.env.TABRO_MACOS_HELPER ?? resolve('dist/native-host/tabro-macos'), [secret ? 'store' : 'lookup', account], secret);
  }
  if (process.platform === 'linux') {
    const attributes = ['application', 'tabro', 'account', account];
    if (secret) return vaultCommand('secret-tool', ['store', '--label=Tabro proxy credentials', ...attributes], Buffer.from(secret.toString('base64')));
    const result = await vaultCommand('secret-tool', ['lookup', ...attributes]);
    return Buffer.from(result.toString().trim(), 'base64');
  }
  throw new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE');
}

export class ProxyCredentialStore implements CredentialReader {
  constructor(private readonly root: string) {}
  async provision(secret: ProxyCredentials, principalId: string): Promise<string> {
    if (!principalId || typeof secret.username !== 'string' || !secret.username || typeof secret.password !== 'string' || !secret.password || secret.username.length > 1024 || secret.password.length > 4096) throw new ProfileError('INVALID_ARGUMENT');
    const ref = `pcr_${randomUUID()}`;
    const bytes = Buffer.from(JSON.stringify({ principalId, ...secret }));
    try {
      if (process.platform !== 'win32') {
        await unixCredential(this.root, ref, bytes);
        return ref;
      }
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
      bytes = process.platform === 'win32'
        ? await protect(await readFile(resolve(this.root, `${ref}.bin`)), true)
        : await unixCredential(this.root, ref);
      const value = JSON.parse(bytes.toString()) as ProxyCredentials & { principalId: string };
      if (value.principalId !== principalId) throw new Error('unauthorized');
      return { username: value.username, password: value.password };
    } catch { throw new ProfileError('PROXY_CREDENTIALS_UNAVAILABLE'); }
    finally { bytes?.fill(0); }
  }
}
