import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCP_TOOL_NAMES } from '../../apps/shared/protocol/src/index.js';

const run = promisify(execFile);
const enabled = process.platform === 'win32' && process.env.TABRO_TEST_HERMES_INSTALL === '1';
const plugin = resolve('integrations/hermes');
const base = resolve('artifacts/hermes-plugin-tests');
const hermesSource = process.env.TABRO_TEST_HERMES_SOURCE;
const hermesPython = process.env.TABRO_TEST_HERMES_PYTHON;
const customRoot = process.env.TABRO_TEST_HERMES_CUSTOM_ROOT === '1';
let install = '';
let fixture = '';
let record: { processId: number; instanceRef: string; mcpUrl: string };
const clients: Client[] = [];
interface McpLaunch { command: string; args: string[]; env: Record<string, string>; cwd: string }
interface HermesProfile { home: string; plugin: string; env: Record<string, string>; configHash: string; server?: McpLaunch }
const hermesProfiles: HermesProfile[] = [];
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const setup = (profile = hermesProfiles[0]!, directory = profile.plugin, target?: string) => run('powershell.exe', [
  '-NoProfile', '-File', resolve(directory, 'setup.ps1'), ...(target ? ['-InstallRoot', target] : []),
  '-NodePath', process.execPath, '-SkipNativeRegistration'
], { timeout: 60000, windowsHide: true, cwd: profile.home, env: { ...process.env, ...profile.env } });

describe.skipIf(!enabled)('Hermes plugin Windows installation', () => {
  beforeAll(async () => {
    mkdirSync(base, { recursive: true });
    fixture = mkdtempSync(resolve(base, 'multi profile-'));
    const localAppData = resolve(fixture, 'Local AppData');
    install = customRoot ? resolve(fixture, 'Custom runtime 测试') : resolve(localAppData, 'Tabro');
    for (const label of ['tabro-one', 'research-two']) {
      const home = resolve(fixture, 'Hermes homes 测试', label);
      const directory = resolve(home, 'plugins/tabro');
      const data = resolve(home, 'plugin-data/tabro-fixture');
      cpSync(plugin, directory, { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(resolve(home, 'config.yaml'), `# ${label}: existing profile configuration\nplugins:\n  enabled: [tabro]\n`);
      hermesProfiles.push({ home, plugin: directory, configHash: digest(resolve(home, 'config.yaml')),
        env: { LOCALAPPDATA: localAppData, TABRO_INSTALL_ROOT: customRoot ? install : '', TABRO_TEST_PRIVATE_SENTINEL: 'must-not-reach-mcp', TABRO_BROWSER_PATH: process.env.TABRO_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', HERMES_HOME: home, HERMES_PROFILE: label,
          HERMES_SESSION_ID: `plugin-test-${label}`, PLUGIN_ROOT: directory, PLUGIN_DATA: data } });
    }
    // No default Hermes home and no explicit InstallRoot: both setups must
    // resolve the same user-level daemon even from separate working directories.
    const results = await Promise.all(hermesProfiles.map(async profile => JSON.parse((await setup(profile)).stdout)));
    for (const result of results) {
      expect(result.status).toBe('INSTALLED');
      expect(result.nativeRegistered).toBe(false);
      expect(result.installRoot).toBe(install);
    }
    expect(results.map(result => result.broker.status).sort()).toEqual(['already_running', 'started']);
    record = JSON.parse(readFileSync(resolve(install, 'data/runtime.json'), 'utf8'));
    expect(results.every(result => result.broker.processId === record.processId)).toBe(true);
  }, 60000);

  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()));
    if (record) {
      const health = await fetch(new URL('/health', record.mcpUrl)).then(response => response.json()) as { instanceRef: string };
      if (health.instanceRef !== record.instanceRef || !install.startsWith(resolve(fixture) + '\\')) throw new Error('Fixture ownership changed; refusing shutdown.');
      const stopped = await run('powershell.exe', ['-NoProfile', '-File', resolve(plugin, 'stop.ps1'), '-InstallRoot', install], {
        timeout: 15000, windowsHide: true
      });
      expect(JSON.parse(stopped.stdout).status).toBe('STOPPED');
    }
  });

  it.skipIf(!hermesSource || !hermesPython)('loads each profile through the installed Hermes plugin manager', async () => {
    for (const profile of hermesProfiles) {
      const result = await run(hermesPython!, ['-I', resolve('tests/real-world/hermes-profile-plugin-probe.py'), hermesSource!], {
        cwd: profile.home, windowsHide: true, timeout: 30000, env: { ...process.env, ...profile.env }
      });
      profile.server = JSON.parse(result.stdout) as McpLaunch;
      expect(profile.server.env.PLUGIN_ROOT).toBe(profile.plugin);
      expect(profile.server.env.TABRO_INSTALL_ROOT).toBe(customRoot ? install : '${TABRO_INSTALL_ROOT}');
      expect(profile.server.env.TABRO_TEST_PRIVATE_SENTINEL).toBeUndefined();
      expect(profile.server.env.PLUGIN_DATA?.startsWith(resolve(profile.home, 'plugin-data') + '\\')).toBe(true);
    }
    expect(hermesProfiles[0]!.server!.env.PLUGIN_DATA).not.toBe(hermesProfiles[1]!.server!.env.PLUGIN_DATA);
  }, 60000);

  it('connects two named Hermes profile installations concurrently to one Broker with distinct sessions', async () => {
    const callers = await Promise.all(hermesProfiles.map(async (profile, index) => {
      const server = profile.server ?? { command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve(profile.plugin, 'launch.ps1')], cwd: profile.plugin, env: {} };
      const transport = new StdioClientTransport({ ...server,
        env: profile.server ? server.env : { ...getDefaultEnvironment(), ...profile.env }, stderr: 'pipe' });
      let errors = '';
      transport.stderr?.on('data', chunk => { errors += String(chunk); });
      const client = new Client({ name: `plugin-${index}`, version: 'test' }, { versionNegotiation: { mode: 'auto' } });
      clients[index] = client;
      try { await client.connect(transport); } catch (error) { throw new Error(`${String(error)}\n${errors}`); }
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([...MCP_TOOL_NAMES]);
      const context = await client.callTool({ name: 'get_browser_context', arguments: { view: { kind: 'broker' } } });
      expect(context.isError).not.toBe(true);
      const profiles = await client.callTool({ name: 'list_browser_profiles', arguments: {} });
      expect(profiles.isError).not.toBe(true);
      return (context.structuredContent as { caller: { session_ref: string } }).caller.session_ref;
    }));
    expect(callers[0]).not.toBe(callers[1]);
    expect(JSON.parse(readFileSync(resolve(install, 'data/runtime.json'), 'utf8')).processId).toBe(record.processId);
  }, 60000);

  it('setup from either profile preserves the daemon, credentials and both Hermes configurations', async () => {
    const token = digest(resolve(install, 'data/admin-token.txt'));
    const results = await Promise.all(hermesProfiles.map(async profile => JSON.parse((await setup(profile)).stdout)));
    for (const result of results) {
      expect(result.broker.status).toBe('already_running');
      expect(result.broker.processId).toBe(record.processId);
    }
    expect(digest(resolve(install, 'data/admin-token.txt'))).toBe(token);
    for (const profile of hermesProfiles) {
      expect(digest(resolve(profile.home, 'config.yaml'))).toBe(profile.configHash);
      expect(existsSync(resolve(profile.env.PLUGIN_DATA!, 'installation.json'))).toBe(false);
    }
  }, 60000);

  it('disconnecting one Hermes profile leaves the other profile and shared daemon usable', async () => {
    await clients[0]!.close();
    const profiles = await clients[1]!.callTool({ name: 'list_browser_profiles', arguments: {} });
    expect(profiles.isError).not.toBe(true);
    expect(JSON.parse(readFileSync(resolve(install, 'data/runtime.json'), 'utf8')).processId).toBe(record.processId);
  });

  it('rejects altered payloads before creating an installation or touching the running Broker', async () => {
    const copied = mkdtempSync(resolve(base, 'altered-plugin-'));
    cpSync(plugin, copied, { recursive: true });
    writeFileSync(resolve(copied, 'runtime/broker/main.js'), '// altered payload\n');
    const target = resolve(copied, 'install-target');
    await expect(setup(hermesProfiles[1], copied, target)).rejects.toThrow('Package integrity check failed');
    expect(existsSync(resolve(target, 'installation.json'))).toBe(false);
    expect(JSON.parse(readFileSync(resolve(install, 'data/runtime.json'), 'utf8')).processId).toBe(record.processId);
  });

  it('rejects a different plugin release without restarting the other profile\'s daemon', async () => {
    const copied = mkdtempSync(resolve(base, 'different-release-'));
    cpSync(plugin, copied, { recursive: true });
    const manifestFile = resolve(copied, 'runtime-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.version = '99.0.0-test';
    writeFileSync(manifestFile, JSON.stringify(manifest));
    await expect(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve(copied, 'launch.ps1')], {
      windowsHide: true, timeout: 15000, env: { ...process.env, ...hermesProfiles[1]!.env }
    })).rejects.toThrow('plugin and installed runtime differ');
    expect((await clients[1]!.callTool({ name: 'list_browser_profiles', arguments: {} })).isError).not.toBe(true);
    expect(JSON.parse(readFileSync(resolve(install, 'data/runtime.json'), 'utf8')).processId).toBe(record.processId);
  });

  it('provisions an encrypted local proxy credential without exposing it in the result', () => {
    const state = JSON.parse(readFileSync(resolve(install, 'installation.json'), 'utf8')) as { runtimeDirectory: string };
    const secret = { username: 'fixture-user', password: 'fixture-private-password' };
    const output = execFileSync(process.execPath, [resolve(install, state.runtimeDirectory, 'broker/provision-proxy-credential.js'), '--db', resolve(install, 'data/relay.sqlite')], {
      input: JSON.stringify(secret), encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    const credential = JSON.parse(output) as { credential_ref: string };
    expect(credential.credential_ref).toMatch(/^pcr_/u);
    expect(output).not.toContain(secret.password);
    const stored = readFileSync(resolve(install, 'data/proxy-credentials', `${credential.credential_ref}.bin`));
    expect(stored.includes(Buffer.from(secret.password))).toBe(false);
  });

  it('restores existing installation configuration when daemon startup fails during setup', async () => {
    const copied = mkdtempSync(resolve(base, 'startup-failure-'));
    cpSync(plugin, copied, { recursive: true });
    writeFileSync(resolve(copied, 'broker-service.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[3], JSON.stringify({status:'error',message:'Injected fixture startup failure'}));\n");
    const config = resolve(install, 'data/managed-profiles.json');
    const original = readFileSync(config);
    writeFileSync(config, original.toString() + '\n  ');
    const preserved = ['installation.json', 'data/managed-profiles.json', 'data/managed-profiles.json.previous'];
    const before = preserved.map(file => digest(resolve(install, file)));
    try {
      await expect(setup(hermesProfiles[1], copied)).rejects.toThrow('Injected fixture startup failure');
      expect(preserved.map(file => digest(resolve(install, file)))).toEqual(before);
      expect((await clients[1]!.callTool({ name: 'list_browser_profiles', arguments: {} })).isError).not.toBe(true);
      expect(JSON.parse(readFileSync(resolve(install, 'data/runtime.json'), 'utf8')).processId).toBe(record.processId);
    } finally { writeFileSync(config, original); }
  }, 30000);

  it('refuses to stop an unrelated process referenced by stale discovery metadata', async () => {
    const runtimeFile = resolve(install, 'data/runtime.json');
    const original = readFileSync(runtimeFile);
    writeFileSync(runtimeFile, JSON.stringify({ ...JSON.parse(original.toString()), processId: process.pid }));
    try {
      await expect(run('powershell.exe', ['-NoProfile', '-File', resolve(plugin, 'stop.ps1'), '-InstallRoot', install], {
        timeout: 15000, windowsHide: true
      })).rejects.toThrow('refusing to stop it');
    } finally { writeFileSync(runtimeFile, original); }
    expect((await clients[1]!.callTool({ name: 'list_browser_profiles', arguments: {} })).isError).not.toBe(true);
  }, 20000);
});
