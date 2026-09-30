import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectMcpHandoffs,
  inspectNativeRegistrations,
  nativeRegistryKey
} from './setup-readiness-checks.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('real-world setup readiness checks', () => {
  it('requires a built adapter and matching Codex and Hermes handoffs', () => {
    const root = mkdtempSync(join(tmpdir(), 'octopus-readiness-'));
    temporaryRoots.push(root);
    const adapterPath = join(root, 'dist', 'adapter.js');
    const instructionsPath = join(root, 'bootstrap', 'MCP-REGISTRATION.md');
    const codexRegistrationPath = join(root, 'bootstrap', 'codex-mcp.toml');
    const hermesRegistrationPath = join(root, 'bootstrap', 'hermes-mcp.txt');
    const hermesRegistrationHelperPath = join(root, 'tools', 'register-hermes-profiles.ps1');
    const adminTokenPath = join(root, 'data', 'admin-token.txt');
    const brokerUrl = 'http://127.0.0.1:7331/mcp';
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'bootstrap'), { recursive: true });
    mkdirSync(join(root, 'tools'), { recursive: true });
    writeFileSync(adapterPath, 'adapter');
    writeFileSync(instructionsPath, `Codex ${codexRegistrationPath}\nHermes ${hermesRegistrationPath}\nadapter ${adapterPath}`);
    writeFileSync(codexRegistrationPath, [
      '[mcp_servers.tabro]',
      `args = [${JSON.stringify(adapterPath)}]`,
      `env = { TABRO_BROKER_URL = "${brokerUrl}", TABRO_TOKEN_FILE = ${JSON.stringify(adminTokenPath)}, TABRO_RUNTIME = "codex" }`
    ].join('\n'));
    writeFileSync(hermesRegistrationPath, [
      `pwsh -NoProfile -File '${hermesRegistrationHelperPath}'`,
      `-NodeExecutable 'node' -AdapterPath '${adapterPath}'`,
      `-BrokerUrl '${brokerUrl}' -TokenFile '${adminTokenPath}'`
    ].join(' '));
    writeFileSync(hermesRegistrationHelperPath, [
      "$namedProfiles = @('alpha')",
      "return @('default') + $namedProfiles",
      "$arguments = @('mcp', 'add', 'tabro')",
      "$environment = @('TABRO_RUNTIME=hermes')"
    ].join('\n'));

    expect(inspectMcpHandoffs({
      adapterPath,
      instructionsPath,
      codexRegistrationPath,
      hermesRegistrationPath,
      hermesRegistrationHelperPath,
      adminTokenPath,
      brokerUrl
    }).map(({ status }) => status)).toEqual(['ready', 'ready']);

    writeFileSync(hermesRegistrationPath, 'stale command');
    expect(inspectMcpHandoffs({
      adapterPath,
      instructionsPath,
      codexRegistrationPath,
      hermesRegistrationPath,
      hermesRegistrationHelperPath,
      adminTokenPath,
      brokerUrl
    })[1]).toMatchObject({ name: 'mcp_registration_handoffs', status: 'action_required' });
  });

  it('requires every configured registry root to point at the selected manifest', () => {
    const roots = [
      'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts',
      'HKCU:\\Software\\Chromium\\NativeMessagingHosts',
      'HKCU:\\Software\\AdsPower\\SunBrowser\\NativeMessagingHosts'
    ];
    const hostName = 'io.github.ohmyskyhigh.octopus_browser_relay';
    const manifestPath = 'G:\\octopus\\bootstrap\\host.json';
    const registrations = new Map(roots.map((root) => [nativeRegistryKey(root, hostName), manifestPath]));

    expect(inspectNativeRegistrations(
      roots,
      hostName,
      manifestPath,
      (key) => registrations.get(key) ?? null
    )).toMatchObject({ name: 'native_host_registry', status: 'ready' });

    registrations.set(nativeRegistryKey(roots[2]!, hostName), 'G:\\old\\host.json');
    expect(inspectNativeRegistrations(
      roots,
      hostName,
      manifestPath,
      (key) => registrations.get(key) ?? null
    )).toMatchObject({ name: 'native_host_registry', status: 'action_required' });
  });
});
