import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { MINIMUM_BROWSER_MAJOR } from '../apps/broker/src/profiles/browser-compatibility.js';
import { containedPath, extensionDigest, MANAGED_EXTENSION_ID, privateDirectory, type ProfileRuntimeConfig } from '../apps/broker/src/profiles/runtime-config.js';
import { MCP_CONTRACT_VERSION } from '../apps/shared/protocol/src/mcp/tool-catalog.js';
import { readBrokerRuntime } from '../apps/shared/protocol/src/runtime-discovery.js';
import { assertMachineInstallation, readMachineRegistration } from '../apps/shared/protocol/src/machine-registration.js';
import { maintenanceRequest } from '../apps/shared/protocol/src/maintenance-client.js';

const mac = process.platform === 'darwin';
const platform = `${mac ? 'macos' : process.platform}-${process.arch}`;
const nativeName = 'io.github.ohmyskyhigh.octopus_browser_relay';
const hostEntry = 'native-host/relay-native-host.js';
const helperEntry = 'native-host/tabro-macos';
const args = process.argv.slice(2);
const script = realpathSync(process.argv[1]!);
const stateName = 'installation.json';

interface Installation {
  schemaVersion: 1;
  version: string;
  packageDigest: string;
  runtimeDirectory: string;
  nativeHostEntry: string;
  nodePath: string;
  contractVersion?: string;
  desktopEnvironment?: Record<string, string>;
}

interface PackageManifest {
  schemaVersion: 1;
  version: string;
  platform: string;
  contractVersion: string;
  nativeHostEntry: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function json<T>(file: string): T { return JSON.parse(readFileSync(file, 'utf8')) as T; }
function readMaybe(file: string): Buffer | undefined { return existsSync(file) ? readFileSync(file) : undefined; }
function serialize(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }

function replace(file: string, contents: string | Buffer, mode = 0o600): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

function readInstallation(root: string): Installation {
  const state = json<Installation>(resolve(root, stateName));
  if (state.schemaVersion !== 1 || state.nativeHostEntry !== hostEntry || !/^releases\/\d+\.\d+\.\d+-[a-f0-9]{12}$/u.test(state.runtimeDirectory)
    || !isAbsolute(state.nodePath)) throw new Error('Tabro installation is invalid. Rerun setup.');
  return state;
}

function validatePackage(source: string): { manifest: PackageManifest; hash: string } {
  const bytes = readFileSync(resolve(dirname(source), 'runtime-manifest.json'));
  const manifest = JSON.parse(bytes.toString('utf8')) as PackageManifest;
  if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.nativeHostEntry !== hostEntry
    || !/^\d+\.\d+\.\d+$/u.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error(`This package cannot run on ${platform}.`);
  if (manifest.contractVersion !== MCP_CONTRACT_VERSION) throw new Error('The Tabro package uses a different MCP contract version.');
  const required = new Set([hostEntry, 'native-host/machine-lock.node', 'broker/main.js', 'adapter/main.js', 'maintenance-client.js', 'broker-service.mjs', 'managed-upgrade-snapshot.mjs', ...(mac ? [helperEntry] : [])]);
  for (const fact of manifest.files) {
    if (!fact.path || isAbsolute(fact.path) || fact.path.split('/').some(part => part === '..' || !part)) throw new Error('Invalid package file path.');
    const path = containedPath(source, fact.path);
    if (!lstatSync(path).isFile()) throw new Error(`Invalid package file: ${fact.path}`);
    const contents = readFileSync(path);
    if (contents.length !== fact.bytes || digest(contents) !== fact.sha256) throw new Error(`Package integrity check failed: ${fact.path}`);
    required.delete(fact.path);
  }
  if (required.size) throw new Error('The Tabro package is incomplete.');
  return { manifest, hash: digest(bytes) };
}

function browserPath(requested?: string, prior?: string): { executable: string; version: string; userData: string } {
  const selected = requested || prior || process.env.TABRO_BROWSER_PATH;
  if (selected && !isAbsolute(selected)) throw new Error('Select the browser with an absolute executable path.');
  const candidates = selected ? [selected] : mac ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ] : ['/opt/google/chrome/chrome', '/opt/microsoft/msedge/msedge', '/usr/lib/chromium/chromium', '/usr/lib64/chromium-browser/chromium-browser'];
  const executable = candidates.find(path => existsSync(path));
  if (!executable) throw new Error(`Install Chrome ${MINIMUM_BROWSER_MAJOR}+ or provide --browser with its executable path.`);
  const path = realpathSync(executable);
  const output = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  const match = /\b(Google Chrome for Testing|Google Chrome|Chromium|Microsoft Edge)\s+(\d+(?:\.\d+){2,3})/u.exec(output);
  if (!match || Number(match[2]!.split('.')[0]) < MINIMUM_BROWSER_MAJOR) throw new Error(`Select Chrome, Chromium or Edge ${MINIMUM_BROWSER_MAJOR} or newer.`);
  const product = match[1];
  const directory = mac
    ? product === 'Google Chrome' ? 'Google/Chrome' : product === 'Google Chrome for Testing' ? 'Google/ChromeForTesting' : product
    : product === 'Google Chrome' ? 'google-chrome' : product === 'Google Chrome for Testing' ? 'google-chrome-for-testing' : product === 'Microsoft Edge' ? 'microsoft-edge' : 'chromium';
  return { executable: path, version: match[2]!, userData: resolve(mac ? resolve(homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'), directory!) };
}

function brokerRuntimeFile(root: string): string { return resolve(root, 'data/runtime.json'); }

function assertNoLegacyBrokers(): void {
  const processes = execFileSync('/bin/ps', ['-u', String(process.getuid!()), '-o', 'pid=', '-o', 'command='], { encoding: 'utf8' });
  const conflicts = processes.split('\n').map(line => line.trim()).filter(line => /(?:^|\s)\S*node(?:\s|$)/u.test(line) && /(?:broker\/main\.(?:js|mjs)|broker\/src\/runtime\/main\.(?:js|ts))(?:\s|$)/u.test(line));
  if (conflicts.length) throw new Error(`Existing Broker processes require inspection before first installation:\n${conflicts.join('\n')}`);
}

async function brokerHealth(root: string) {
  const runtimeFile = brokerRuntimeFile(root);
  if (!existsSync(runtimeFile)) return null;
  let record;
  try { record = readBrokerRuntime(runtimeFile); }
  catch (error) {
    if (error instanceof Error && error.message === 'The discovered Tabro Broker is not running. Start the local Broker first.') return null;
    throw error;
  }
  if (record.databasePath !== resolve(root, 'data/relay.sqlite')) throw new Error('Broker discovery points to another installation.');
  const response = await fetch(new URL('/health', record.mcpUrl), { signal: AbortSignal.timeout(1500) });
  const health = await response.json() as { status: string; instanceRef: string; activeWorkspaceCount: number; openRequestCount: number; managedLiveInstanceCount: number };
  if (!response.ok || health.status !== 'ok' || health.instanceRef !== record.instanceRef) throw new Error('Could not verify the installed Broker.');
  return { record, health };
}

function start(root: string, state = readInstallation(root)): unknown {
  if (!existsSync(state.nodePath)) throw new Error('The configured Node.js executable is missing. Rerun setup from a supported Node.js installation.');
  const result = resolve(root, 'data', `startup-${randomUUID()}.json`);
  try {
    spawnSync(state.nodePath, [containedPath(root, state.runtimeDirectory, 'broker-service.mjs'), root, result], { timeout: 20_000, stdio: 'ignore' });
    if (!existsSync(result)) throw new Error('The Broker startup did not report a result. Check the installation logs.');
    const ready = json<{ status: string; message?: string }>(result);
    if (ready.status === 'error') throw new Error(ready.message ?? 'Broker startup failed.');
    return ready;
  } finally { rmSync(result, { force: true }); }
}

async function stop(root: string): Promise<void> {
  const state = readInstallation(root);
  const current = await brokerHealth(root);
  if (!current) return;
  const { record } = current;
  const transactionId = randomUUID();
  const operation = resolve(root, 'data/maintenance-operation.json');
  writeFileSync(operation, serialize({ schemaVersion: 1, kind: 'stop', transactionId, previous: state.runtimeDirectory }), { flag: 'wx', mode: 0o600 });
  try { await maintenanceRequest(root, new URL(record.mcpUrl), 'enter', transactionId, record.instanceRef); }
  catch (error) { if ((error as Error & { status?: number }).status === 409) rmSync(operation, { force: true }); throw error; }
  await terminateVerified(root, state, record, transactionId);
}

function assertBrokerProcess(root: string, state: Installation, record: { processId: number }): void {
  const pid = String(record.processId);
  const entry = containedPath(root, state.runtimeDirectory, 'broker/main.js');
  const matches = mac
    ? execFileSync('/bin/ps', ['-ww', '-p', pid, '-o', 'command='], { encoding: 'utf8' }).trimEnd() === `${state.nodePath} ${entry}`
    : readFileSync(`/proc/${pid}/cmdline`, 'utf8') === `${state.nodePath}\0${entry}\0`;
  if (!matches) throw new Error('The process does not match this installation’s Broker; maintenance remains fenced.');
}

async function terminateVerified(root: string, state: Installation, record: { processId: number; instanceRef: string; mcpUrl: string }, transactionId: string): Promise<void> {
  assertBrokerProcess(root, state, record);
  await maintenanceRequest(root, new URL(record.mcpUrl), 'stop', transactionId, record.instanceRef);
  for (let i = 0; i < 120; i++) {
    if (!existsSync(brokerRuntimeFile(root))) {
      try { process.kill(record.processId, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
    }
    await delay(250);
  }
  throw new Error('Broker shutdown timed out. Check the installation logs.');
}

async function startWithRecovery(root: string): Promise<unknown> {
  const operation = resolve(root, 'data/maintenance-operation.json');
  const pending = existsSync(operation) ? json<{ schemaVersion: number; kind: string; transactionId: string }>(operation) : undefined;
  if (pending && (pending.schemaVersion !== 1 || pending.kind !== 'stop' || !/^[0-9a-f-]{36}$/u.test(pending.transactionId))) throw new Error('An interrupted maintenance transaction needs inspection before startup.');
  if (!pending && existsSync(resolve(root, 'data/maintenance.json'))) throw new Error('An interrupted maintenance transaction needs inspection before startup.');
  const ready = start(root);
  if (pending) {
    const current = await brokerHealth(root);
    if (!current) throw new Error('Broker did not report health during maintenance recovery.');
    if (!existsSync(resolve(root, 'data/maintenance.json'))) throw new Error('Maintenance state is ambiguous. Inspect the running Broker and transaction before recovering.');
    await maintenanceRequest(root, new URL(current.record.mcpUrl), 'resume', pending.transactionId, current.record.instanceRef);
    rmSync(operation, { force: true });
  }
  return ready;
}

async function recover(root: string): Promise<unknown> {
  const operation = resolve(root, 'data/maintenance-operation.json');
  const pending = json<{ schemaVersion: number; kind: string; phase: string; transactionId: string; next: string }>(operation);
  if (pending.schemaVersion !== 1 || pending.kind !== 'upgrade' || pending.phase !== 'ready' || !/^[0-9a-f-]{36}$/u.test(pending.transactionId)) {
    throw new Error(`The interrupted upgrade cannot be safely resumed automatically. Preserve ${operation} and the backups for inspection.`);
  }
  const fence = json<{ transactionId: string }>(resolve(root, 'data/maintenance.json'));
  const state = readInstallation(root);
  if (fence.transactionId !== pending.transactionId || state.runtimeDirectory !== pending.next) throw new Error('Maintenance journal does not match the installed runtime and fence.');
  const ready = start(root, state);
  const current = await brokerHealth(root);
  if (!current) throw new Error('The fenced Broker did not become healthy.');
  assertBrokerProcess(root, state, current.record);
  await maintenanceRequest(root, new URL(current.record.mcpUrl), 'resume', pending.transactionId, current.record.instanceRef);
  rmSync(operation);
  return ready;
}

async function install(root: string, source: string, browser?: string, customUserData?: string): Promise<void> {
  const { manifest, hash } = validatePackage(source);
  if (customUserData && !isAbsolute(customUserData)) throw new Error('--browser-data-dir must be absolute.');
  const data = containedPath(root, 'data');
  const stateFile = containedPath(root, stateName);
  let previous: Installation | undefined;
  if (existsSync(stateFile)) {
    try { previous = readInstallation(root); }
    catch { throw new Error('The existing installation is legacy or invalid. Preserve it and follow the offline migration guidance in GETTING_STARTED.md; do not upgrade it in place.'); }
    const oldRuntime = containedPath(root, previous.runtimeDirectory);
    if (!existsSync(resolve(oldRuntime, 'native-host/machine-lock.node')) || !existsSync(resolve(oldRuntime, 'maintenance-client.js'))) {
      throw new Error('The existing installation predates device-wide registration. Preserve it and follow the offline migration guidance in GETTING_STARTED.md; do not upgrade it in place.');
    }
  }
  privateDirectory(data);
  const configFile = containedPath(data, 'managed-profiles.json');
  const prior = existsSync(configFile) ? json<ProfileRuntimeConfig>(configFile) : undefined;
  const selected = browserPath(browser, prior?.executablePath);
  if (!previous) assertNoLegacyBrokers();
  const desktopEnvironment = { ...previous?.desktopEnvironment };
  // MCP clients omit locale variables; Chrome needs the desktop locale to resolve Unicode paths on Linux.
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (process.env[key]) desktopEnvironment[key] = process.env[key];
  }
  const state: Installation = { schemaVersion: 1, version: manifest.version, contractVersion: manifest.contractVersion, packageDigest: hash,
    runtimeDirectory: `releases/${manifest.version}-${hash.slice(0, 12)}`, nativeHostEntry: hostEntry, nodePath: realpathSync(process.execPath), desktopEnvironment };
  const launcher = containedPath(root, 'tabro.mjs');
  const launcherBytes = readMaybe(launcher);
  const changing = !!previous && (previous.packageDigest !== hash || previous.runtimeDirectory !== state.runtimeDirectory || previous.nodePath !== state.nodePath ||
    prior?.executablePath !== selected.executable || !launcherBytes?.equals(readFileSync(script)));

  const wrapper = containedPath(root, 'native-host');
  const manifestFile = containedPath(root, `${nativeName}.json`);
  const browserBase = mac ? resolve(homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  const browserDirectories = mac ? ['Google/Chrome', 'Google/ChromeForTesting', 'Microsoft Edge', 'Chromium'] : ['google-chrome', 'google-chrome-for-testing', 'microsoft-edge', 'chromium'];
  const targets = customUserData ? [customUserData] : [selected.userData, ...browserDirectories.map(dir => resolve(browserBase, dir))];
  const browserRegistrations = [...new Set(targets.map(path => resolve(path, 'NativeMessagingHosts', `${nativeName}.json`)))];
  for (const browserRegistration of browserRegistrations) {
    if (existsSync(browserRegistration) && (lstatSync(browserRegistration).isSymbolicLink() || json<{ path: string }>(browserRegistration).path !== wrapper)) {
      throw new Error(`Another Tabro installation owns ${browserRegistration}. Select the original install root or remove that registration after its browser work ends.`);
    }
  }
  const hostManifest = serialize({ name: nativeName, description: 'Tabro Native Messaging companion', path: wrapper, type: 'stdio',
    allowed_origins: [`chrome-extension://${MANAGED_EXTENSION_ID}/`] });
  const installed = containedPath(root, state.runtimeDirectory);
  let createdRelease = false;
  if (!existsSync(installed)) {
    privateDirectory(dirname(installed));
    const temporary = `${installed}.${randomUUID()}.tmp`;
    try {
      privateDirectory(temporary);
      for (const fact of manifest.files) {
        const target = containedPath(temporary, fact.path);
        privateDirectory(dirname(target));
        const bytes = readFileSync(containedPath(source, fact.path));
        if (digest(bytes) !== fact.sha256) throw new Error(`Package file changed during setup: ${fact.path}`);
        writeFileSync(target, bytes, { flag: 'wx', mode: fact.path === helperEntry ? 0o700 : 0o600 });
      }
      renameSync(temporary, installed);
      createdRelease = true;
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  } else {
    for (const fact of manifest.files) {
      if (digest(readFileSync(containedPath(installed, fact.path))) !== fact.sha256) throw new Error(`Installed release is damaged: ${fact.path}`);
    }
  }
  if (previous && !changing) {
    for (const browserRegistration of browserRegistrations) {
      privateDirectory(dirname(browserRegistration));
      replace(browserRegistration, hostManifest);
    }
    const broker = await startWithRecovery(root);
    console.log(serialize({ status: 'INSTALLED', installRoot: root, extensionPath: resolve(root, 'browser-extension'), broker,
      mcp: { command: previous.nodePath, args: [launcher, 'mcp'] } }));
    return;
  }
  if (mac) chmodSync(resolve(installed, helperEntry), 0o700);
  const extension = containedPath(root, 'browser-extension');
  const incoming = `${extension}.${randomUUID()}.tmp`;
  const backupExtension = `${incoming}.previous`;
  const newExtension = resolve(installed, 'browser-extension');
  const extensionHash = extensionDigest(newExtension);
  let refreshExtension: boolean;
  try { refreshExtension = extensionDigest(extension) !== extensionHash; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    refreshExtension = true;
  }
  const stableAddon = containedPath(root, 'runtime/native-host/machine-lock.node');
  const config: ProfileRuntimeConfig = { ...prior, root: prior?.root ?? resolve(data, 'managed-profiles'), executablePath: selected.executable,
    extensionSource: extension, expectedBrowserVersion: selected.version, expectedExtensionDigest: extensionHash,
    relayUrl: 'ws://127.0.0.1:0/relay', nativeHostManifest: manifestFile };
  const backups = new Map([wrapper, manifestFile, ...browserRegistrations, launcher, stableAddon, configFile, stateFile].map(file => [file, readMaybe(file)]));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const operation = resolve(data, 'maintenance-operation.json');
  const fence = resolve(data, 'maintenance.json');
  let transactionId: string | undefined;
  let snapshot: string | undefined;
  let entered = false;
  let publishedExtension = false;
  let resumeRequested = false;
  try {
  if (previous && changing) {
    await startWithRecovery(root);
    const running = await brokerHealth(root);
    if (!running) throw new Error('The current Broker did not become healthy for maintenance.');
    transactionId = randomUUID();
    writeFileSync(operation, serialize({ schemaVersion: 1, kind: 'upgrade', phase: 'preparing', transactionId, previous: previous.runtimeDirectory,
      next: state.runtimeDirectory, previousVersion: previous.version, nextVersion: state.version }), { flag: 'wx', mode: 0o600 });
    try { await maintenanceRequest(root, new URL(running.record.mcpUrl), 'enter', transactionId, running.record.instanceRef); }
    catch (error) { if ((error as Error & { status?: number }).status === 409) rmSync(operation, { force: true }); throw error; }
    entered = true;
    try {
      const fenced = await brokerHealth(root);
      if (!fenced || fenced.record.instanceRef !== running.record.instanceRef || !Number.isInteger(fenced.health.managedLiveInstanceCount) || fenced.health.managedLiveInstanceCount !== 0) throw new Error('Close managed Profiles and verify Broker health before upgrading.');
    } catch (failure) {
      resumeRequested = true;
      await maintenanceRequest(root, new URL(running.record.mcpUrl), 'resume', transactionId, running.record.instanceRef);
      rmSync(operation, { force: true });
      entered = false;
      throw failure;
    }
    await terminateVerified(root, previous, running.record, transactionId);
    const backupsDirectory = resolve(data, 'backups');
    privateDirectory(backupsDirectory);
    snapshot = resolve(backupsDirectory, `${previous.version}-${transactionId}.sqlite`);
    execFileSync(state.nodePath, [resolve(installed, 'managed-upgrade-snapshot.mjs'), resolve(data, 'relay.sqlite'), snapshot], { timeout: 45_000, stdio: ['ignore', 'ignore', 'inherit'] });
  }
    privateDirectory(containedPath(root, 'data', 'managed-profiles'));
    if (refreshExtension) {
      cpSync(newExtension, incoming, { recursive: true });
      if (existsSync(extension)) renameSync(extension, backupExtension);
      renameSync(incoming, extension);
      publishedExtension = true;
    }
    replace(wrapper, `#!/bin/sh\nexec ${quote(state.nodePath)} ${quote(resolve(installed, hostEntry))} ${quote(brokerRuntimeFile(root))} "$@"\n`, 0o700);
    replace(manifestFile, hostManifest);
    for (const browserRegistration of browserRegistrations) {
      privateDirectory(dirname(browserRegistration));
      replace(browserRegistration, hostManifest);
    }
    replace(launcher, readFileSync(script));
    privateDirectory(dirname(stableAddon));
    replace(stableAddon, readFileSync(resolve(installed, 'native-host/machine-lock.node')));
    replace(configFile, serialize(config));
    replace(stateFile, serialize(state));
    if (transactionId && previous) replace(operation, serialize({ schemaVersion: 1, kind: 'upgrade', phase: 'ready', transactionId,
      previous: previous.runtimeDirectory, next: state.runtimeDirectory, previousVersion: previous.version, nextVersion: state.version }));
    const broker = start(root, state);
    if (transactionId && entered) {
      const ready = await brokerHealth(root);
      if (!ready || !existsSync(fence)) throw new Error('The upgraded Broker did not retain its maintenance fence.');
      assertBrokerProcess(root, state, ready.record);
      resumeRequested = true;
      await maintenanceRequest(root, new URL(ready.record.mcpUrl), 'resume', transactionId, ready.record.instanceRef);
      rmSync(operation, { force: true });
    }
    console.log(serialize({ status: 'INSTALLED', installRoot: root, extensionPath: extension, broker,
      mcp: { command: state.nodePath, args: [launcher, 'mcp'] },
      nextAction: 'Register the printed stdio MCP entry. Load extensionPath from chrome://extensions or edge://extensions in an existing profile, or create a managed profile from MCP.' }));
  } catch (error) {
    if (previous && changing && !entered) {
      if (createdRelease) rmSync(installed, { recursive: true, force: true });
      throw error;
    }
    if (transactionId && entered) {
      if (resumeRequested || !existsSync(fence)) throw new Error(`Upgrade outcome is ambiguous; do not restore the database. Inspect ${operation}.`, { cause: error });
      const running = await brokerHealth(root);
      if (running) {
        const selectedState = readInstallation(root);
        await terminateVerified(root, selectedState, running.record, transactionId);
      }
    }
    for (const [file, bytes] of backups) {
      if (bytes) replace(file, bytes, file === wrapper ? 0o700 : 0o600);
      else rmSync(file, { force: true });
    }
    if (publishedExtension) rmSync(extension, { recursive: true, force: true });
    if (existsSync(backupExtension)) renameSync(backupExtension, extension);
    if (transactionId && entered && previous) {
      if (snapshot && existsSync(snapshot)) {
        const database = resolve(data, 'relay.sqlite');
        const rollback = `${database}.${randomUUID()}.tmp`;
        copyFileSync(snapshot, rollback);
        chmodSync(rollback, 0o600);
        rmSync(`${database}-wal`, { force: true });
        rmSync(`${database}-shm`, { force: true });
        renameSync(rollback, database);
      }
      start(root, previous);
      const restored = await brokerHealth(root);
      if (!restored || !existsSync(fence)) throw new Error(`Rollback requires inspection: ${operation}`, { cause: error });
      await maintenanceRequest(root, new URL(restored.record.mcpUrl), 'resume', transactionId, restored.record.instanceRef);
      rmSync(operation, { force: true });
      if (createdRelease) rmSync(installed, { recursive: true, force: true });
    }
    throw error;
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
  rmSync(backupExtension, { recursive: true, force: true });
}

async function runClient(root: string, command: 'mcp' | 'credentials'): Promise<void> {
  if (command === 'mcp') execFileSync(process.execPath, [script, 'start'], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 });
  const state = readInstallation(root);
  const env = { ...process.env, TABRO_RUNTIME_FILE: brokerRuntimeFile(root), TABRO_TOKEN_FILE: resolve(root, 'data/admin-token.txt'),
    TABRO_TOKEN: '', TABRO_AGENT_TOKEN: '', OCTOPUS_BROWSER_RELAY_TOKEN: '', OCTOPUS_AGENT_TOKEN: '',
    RELAY_DB_PATH: resolve(root, 'data/relay.sqlite'), NODE_NO_WARNINGS: '1',
    ...(mac ? { TABRO_MACOS_HELPER: containedPath(root, state.runtimeDirectory, helperEntry) } : {}) };
  const entry = command === 'mcp' ? 'adapter/main.js' : 'broker/provision-proxy-credential.js';
  const child = spawn(state.nodePath, [containedPath(root, state.runtimeDirectory, entry)], { env, stdio: 'inherit' });
  process.once('SIGTERM', () => child.kill('SIGTERM'));
  process.once('SIGINT', () => child.kill('SIGINT'));
  process.exitCode = await new Promise<number>((ok, fail) => {
    child.on('error', fail);
    child.on('exit', code => ok(code ?? 1));
  });
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!major || major < 22 || (major === 22 && (minor ?? 0) < 12)) throw new Error('Tabro requires Node.js 22.12 or newer.');
  if (!['macos-arm64', 'macos-x64', 'linux-x64'].includes(platform) || process.getuid?.() === 0) throw new Error('Run this package as the desktop browser user on a supported macOS or Linux host.');
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    root: { type: 'string' }, browser: { type: 'string' }, 'browser-data-dir': { type: 'string' }
  } });
  const command = positionals[0] ?? 'install';
  if (positionals.length > 1 || !['install', 'start', 'stop', 'recover', 'mcp', 'credentials'].includes(command)) throw new Error('Use install, start, stop, recover, mcp, or credentials.');
  if (command !== 'install' && Object.keys(values).length) throw new Error('Browser and root options apply to setup only. Use the installed tabro.mjs for runtime commands.');
  const registration = readMachineRegistration();
  const requestedRoot = values.root ?? process.env.TABRO_INSTALL_ROOT ?? registration.installationRoot;
  if (command === 'install' && (!isAbsolute(requestedRoot) || resolve(requestedRoot) === '/' || resolve(requestedRoot) === resolve(homedir()))) throw new Error('Select an absolute, dedicated Tabro install directory.');
  const root = realpathSync(command === 'install' ? requestedRoot : dirname(script));
  assertMachineInstallation(registration, root, resolve(root, 'data'));
  if (command === 'mcp' || command === 'credentials') await runClient(root, command);
  else {
    const source = resolve(dirname(script), 'runtime');
    const transaction = containedPath(root, 'installation.transaction');
    try { mkdirSync(transaction, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another setup is in progress or was interrupted. Inspect ${transaction} and the installation before removing the empty transaction directory.`);
      throw error;
    }
    try {
      if (command === 'install') await install(root, source, values.browser, values['browser-data-dir']);
      else if (command === 'start') console.log(serialize(await startWithRecovery(root)));
      else if (command === 'recover') console.log(serialize(await recover(root)));
      else await stop(root);
    } finally { rmdirSync(transaction); }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
