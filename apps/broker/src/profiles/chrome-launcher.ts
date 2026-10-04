import { execFile, execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromeManagementConnection } from './management-connection.js';
import { MANAGED_EXTENSION_ID, profileLayout, validateRuntime, type ProfileRuntimeConfig } from './runtime-config.js';
import { ProfileError, type ManagedBrowserInstance, type ManagedProfile } from './types.js';

const runFile = promisify(execFile);
export interface ChromeProcessIdentity { pid: number; createdAt: string; executablePath: string; commandLine: string }
export async function chromeProcesses(): Promise<ChromeProcessIdentity[]> {
  const script = "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { @{pid=$_.ProcessId;createdAt=$_.CreationDate.ToUniversalTime().ToString('o');executablePath=$_.ExecutablePath;commandLine=$_.CommandLine} }) | ConvertTo-Json -Compress";
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  const value: unknown = JSON.parse(stdout.trim() || '[]');
  const rows = Array.isArray(value) ? value : [value];
  return rows.map(row => {
    const p = row as Record<string, unknown>;
    return { pid: Number(p.pid), createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
      executablePath: typeof p.executablePath === 'string' ? p.executablePath : '', commandLine: typeof p.commandLine === 'string' ? p.commandLine : '' };
  }).filter(p => Number.isSafeInteger(p.pid) && p.pid > 0);
}

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();
export function processUsesDataDir(process: ChromeProcessIdentity, dataDir: string): boolean {
  const match = /(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))/u.exec(process.commandLine);
  return !!match && samePath(match[1] ?? match[2] ?? match[3]!, dataDir);
}
export function matchesInstance(process: ChromeProcessIdentity, value: ManagedBrowserInstance): boolean {
  return process.pid === value.pid && process.createdAt === value.processCreatedAt && !!value.executablePath && !!value.dataDir
    && samePath(process.executablePath, value.executablePath) && processUsesDataDir(process, value.dataDir);
}

/** Only lifecycle actions are exposed; it never evaluates website scripts. */
export class ChromeLauncher {
  proxyPort: ((profileRef: string) => Promise<number | null>) | null = null;
  constructor(readonly config: ProfileRuntimeConfig, private readonly processes = chromeProcesses) {}

  prepare(profile: ManagedProfile, bootstrap: Record<string, unknown>): void {
    validateRuntime(this.config);
    const paths = profileLayout(this.config.root, profile.dataDirKey);
    mkdirSync(paths.dataDir, { recursive: true }); mkdirSync(paths.extensionDir, { recursive: true });
    const owner = /S-1-5-[\d-]+/u.exec(execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))?.[0];
    if (!owner) throw new ProfileError('PROFILE_PATH_INVALID');
    execFileSync('icacls.exe', [paths.directory, '/inheritance:r', '/grant:r', `*${owner}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    for (const file of ['manifest.json', 'service-worker.js', 'options.js', 'options.html']) {
      copyFileSync(resolve(this.config.extensionSource, file), resolve(paths.extensionDir, file));
    }
    // A manifest marker survives a missing bootstrap file and prevents unmanaged fallback.
    const manifest = JSON.parse(readFileSync(resolve(paths.extensionDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    manifest.description = `${String(manifest.description ?? '')} [octopus-managed]`;
    writeFileSync(resolve(paths.extensionDir, 'manifest.json'), JSON.stringify(manifest));
    this.writeBootstrap(profile, bootstrap);
  }

  private writeBootstrap(profile: ManagedProfile, bootstrap: Record<string, unknown>): void {
    const paths = profileLayout(this.config.root, profile.dataDirKey);
    const temporary = resolve(paths.extensionDir, 'managed-bootstrap.json.tmp');
    writeFileSync(temporary, JSON.stringify({ ...bootstrap, relayUrl: this.config.relayUrl }), { mode: 0o600 });
    renameSync(temporary, resolve(paths.extensionDir, 'managed-bootstrap.json'));
  }

  async repair(profile: ManagedProfile, instance: ManagedBrowserInstance, bootstrap: Record<string, unknown>, guard: () => void): Promise<void> {
    await this.withControl(instance, async control => {
      guard(); this.writeBootstrap(profile, bootstrap);
      const extension = await control.send('Extensions.loadUnpacked', { path: profileLayout(this.config.root, profile.dataDirKey).extensionDir });
      if (extension.id !== MANAGED_EXTENSION_ID) throw new ProfileError('PROFILE_EXTENSION_MISMATCH');
    });
  }

  clearBootstrapSecret(profile: ManagedProfile, instance: ManagedBrowserInstance): void {
    const path = resolve(profileLayout(this.config.root, profile.dataDirKey).extensionDir, 'managed-bootstrap.json');
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (config.instanceRef !== instance.instanceRef || config.generation !== instance.generation) throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
    delete config.secret; delete config.grantRef;
    writeFileSync(`${path}.tmp`, JSON.stringify(config), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  async launch(profile: ManagedProfile, instance: ManagedBrowserInstance, checkpoint: (value: ManagedBrowserInstance) => void): Promise<ManagedBrowserInstance> {
    const paths = profileLayout(this.config.root, profile.dataDirKey);
    if ((await this.processes()).some(p => processUsesDataDir(p, paths.dataDir))) throw new ProfileError('PROFILE_IN_USE');
    const proxyPort = await this.proxyPort?.(profile.profileRef);
    const marker = resolve(paths.directory, 'launch-intent.json');
    // A prior unresolved spawn must be reconciled before another launch.
    if (existsSync(marker)) throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
    writeFileSync(marker, JSON.stringify({ instanceRef: instance.instanceRef, generation: instance.generation }), { flag: 'wx', mode: 0o600 });
    const active = resolve(paths.dataDir, 'DevToolsActivePort');
    if (existsSync(active)) unlinkSync(active);
    let value = { ...instance, dataDir: paths.dataDir, executablePath: this.config.executablePath };
    checkpoint(value);
    const child = spawn(this.config.executablePath, [...(proxyPort ? [`--proxy-server=http://127.0.0.1:${proxyPort}`] : []), `--user-data-dir=${paths.dataDir}`, `--octopus-instance-ref=${instance.instanceRef}`, '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--disable-background-mode', 'about:blank'],
    { detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise<void>((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
    child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const process = (await this.processes()).find(p => p.pid === child.pid);
      if (process && processUsesDataDir(process, paths.dataDir) && samePath(process.executablePath, this.config.executablePath)) {
        value = { ...value, pid: process.pid, processCreatedAt: process.createdAt, observedAt: new Date().toISOString() };
        checkpoint(value);
        if (existsSync(active)) {
          const [port, path] = readFileSync(active, 'utf8').trim().split(/\r?\n/u);
          if (/^\d+$/u.test(port ?? '') && Number(port) > 0 && Number(port) < 65536 && /^\/devtools\/browser\/[\w-]+$/u.test(path ?? '')) {
            value = { ...value, managementUrl: `ws://127.0.0.1:${port}${path}`, browserState: 'running' };
            checkpoint(value);
            await this.withControl(value, async control => {
              const version = await control.send('Browser.getVersion');
              if (version.product !== `Chrome/${this.config.expectedBrowserVersion}`) throw new ProfileError('PROFILE_RUNTIME_UNSUPPORTED');
              checkpoint(value);
              const extension = await control.send('Extensions.loadUnpacked', { path: paths.extensionDir });
              if (extension.id !== MANAGED_EXTENSION_ID) throw new ProfileError('PROFILE_EXTENSION_MISMATCH');
            });
            return value;
          }
        }
      } else if (child.exitCode !== null) throw new ProfileError('PROFILE_START_FAILED');
      await delay(250);
    }
    throw new ProfileError('PROFILE_START_TIMEOUT');
  }

  async inspect(value: ManagedBrowserInstance): Promise<'running' | 'stopped' | 'unknown'> {
    if (!value.pid || !value.dataDir || !value.processCreatedAt) return 'unknown';
    const processes = await this.processes();
    const process = processes.find(p => p.pid === value.pid);
    if (process && matchesInstance(process, value)) return 'running';
    if (process || processes.some(p => processUsesDataDir(p, value.dataDir!))) return 'unknown';
    return 'stopped';
  }

  async isClosed(profile: ManagedProfile): Promise<boolean> {
    const { dataDir } = profileLayout(this.config.root, profile.dataDirKey);
    return !(await this.processes()).some(process => processUsesDataDir(process, dataDir));
  }

  async ensureWindow(value: ManagedBrowserInstance, guard: () => void = () => {}): Promise<void> {
    await this.withControl(value, async control => {
      const targets = await control.send('Target.getTargets');
      const pages = targets.targetInfos as Array<{ type: string }>;
      guard();
      if (!pages.some(p => p.type === 'page')) await control.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    });
  }

  async close(profile: ManagedProfile, value: ManagedBrowserInstance, guard: () => void = () => {}): Promise<void> {
    const state = await this.inspect(value);
    if (state === 'unknown') throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
    if (state === 'running') {
      await this.withControl(value, async control => {
        guard();
        try { await control.send('Browser.close'); } catch { /* Exit is verified independently below. */ }
      });
      const deadline = Date.now() + 30_000;
      while (await this.inspect(value) !== 'stopped') {
        if (Date.now() >= deadline) throw new ProfileError('PROFILE_STOP_TIMEOUT');
        await delay(250);
      }
    }
    const marker = resolve(profileLayout(this.config.root, profile.dataDirKey).directory, 'launch-intent.json');
    guard();
    if (existsSync(marker)) {
      const intent = JSON.parse(readFileSync(marker, 'utf8')) as { instanceRef: string };
      if (intent.instanceRef !== value.instanceRef) throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
      unlinkSync(marker);
    }
  }

  private async withControl<T>(value: ManagedBrowserInstance, work: (control: ChromeManagementConnection) => Promise<T>): Promise<T> {
    if (await this.inspect(value) !== 'running' || !value.managementUrl) throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
    const control = await ChromeManagementConnection.connect(value.managementUrl);
    try { return await work(control); } finally { await control.disconnect(); }
  }
}
