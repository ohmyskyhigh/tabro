import { existsSync, readFileSync, statSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ReadinessCheck {
  name: string;
  status: 'ready' | 'action_required';
  detail: string;
  action?: string;
  facts?: Record<string, unknown>;
}

export interface McpHandoffPaths {
  adapterPath: string;
  instructionsPath: string;
  codexRegistrationPath: string;
  hermesRegistrationPath: string;
  hermesRegistrationHelperPath: string;
  adminTokenPath: string;
  brokerUrl: string;
}

export type NativeRegistryReader = (keyPath: string) => string | null;

const ready = (name: string, detail: string, facts?: Record<string, unknown>): ReadinessCheck => ({
  name,
  status: 'ready',
  detail,
  ...(facts === undefined ? {} : { facts })
});

const actionRequired = (name: string, detail: string, action: string): ReadinessCheck => ({
  name,
  status: 'action_required',
  detail,
  action
});

const isNonemptyFile = (path: string): boolean =>
  existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;

const containsPath = (body: string, path: string): boolean => {
  const absolutePath = normalize(resolve(path));
  return [
    absolutePath,
    absolutePath.replaceAll('\\', '\\\\'),
    absolutePath.replaceAll('\\', '/')
  ].some((candidate) => body.includes(candidate));
};

export function inspectMcpHandoffs(paths: McpHandoffPaths): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  if (!isNonemptyFile(paths.adapterPath)) {
    checks.push(actionRequired(
      'mcp_stdio_adapter',
      `The compiled stdio MCP adapter is missing or empty at ${paths.adapterPath}.`,
      'Run pnpm build, then rerun preflight.'
    ));
  } else {
    checks.push(ready('mcp_stdio_adapter', `The compiled stdio MCP adapter is ready at ${paths.adapterPath}.`, {
      bytes: statSync(paths.adapterPath).size
    }));
  }

  const registrationFiles = [
    paths.instructionsPath,
    paths.codexRegistrationPath,
    paths.hermesRegistrationPath,
    paths.hermesRegistrationHelperPath
  ];
  const missing = registrationFiles.filter((path) => !isNonemptyFile(path));
  if (missing.length > 0) {
    checks.push(actionRequired(
      'mcp_registration_handoffs',
      `Generated MCP registration handoff files are missing or empty: ${missing.join(', ')}.`,
      'Run tools/install-local.ps1 -Install to regenerate the Codex and Hermes handoffs.'
    ));
    return checks;
  }

  const instructions = readFileSync(paths.instructionsPath, 'utf8');
  const codex = readFileSync(paths.codexRegistrationPath, 'utf8');
  const hermes = readFileSync(paths.hermesRegistrationPath, 'utf8');
  const hermesHelper = readFileSync(paths.hermesRegistrationHelperPath, 'utf8');
  const codexValid = codex.includes('[mcp_servers.tabro]')
    && codex.includes('TABRO_RUNTIME = "codex"')
    && codex.includes(paths.brokerUrl)
    && containsPath(codex, paths.adapterPath)
    && containsPath(codex, paths.adminTokenPath);
  const hermesValid = hermes.includes('register-hermes-profiles.ps1')
    && containsPath(hermes, paths.hermesRegistrationHelperPath)
    && hermes.includes(paths.brokerUrl)
    && containsPath(hermes, paths.adapterPath)
    && containsPath(hermes, paths.adminTokenPath)
    && hermesHelper.includes("@('default') + $namedProfiles")
    && hermesHelper.includes("'mcp', 'add', 'tabro'")
    && hermesHelper.includes("'TABRO_RUNTIME=hermes'");
  const instructionsValid = /Codex/i.test(instructions)
    && /Hermes/i.test(instructions)
    && containsPath(instructions, paths.codexRegistrationPath)
    && containsPath(instructions, paths.hermesRegistrationPath)
    && containsPath(instructions, paths.adapterPath);
  if (!codexValid || !hermesValid || !instructionsValid) {
    checks.push(actionRequired(
      'mcp_registration_handoffs',
      'Generated MCP registration handoffs do not match the selected adapter, broker URL, token file, or agent runtimes.',
      'Rerun tools/install-local.ps1 -Install with the intended parameterized paths.'
    ));
  } else {
    checks.push(ready(
      'mcp_registration_handoffs',
      'Generated Codex and Hermes MCP registration handoffs match the selected local runtime.',
      {
        instructionsPath: paths.instructionsPath,
        codexRegistrationPath: paths.codexRegistrationPath,
        hermesRegistrationPath: paths.hermesRegistrationPath,
        hermesRegistrationHelperPath: paths.hermesRegistrationHelperPath
      }
    ));
  }
  return checks;
}

export function nativeRegistryKey(root: string, hostName: string): string {
  return `${root.replace(/[\\/]+$/u, '')}\\${hostName}`;
}

export function readWindowsRegistryDefault(keyPath: string): string | null {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$item = Get-Item -LiteralPath $env:OCTOPUS_NATIVE_REGISTRY_KEY',
    "$value = $item.GetValue('')",
    'if ($null -eq $value) { exit 3 }',
    '[Console]::Out.Write([string]$value)'
  ].join('; ');
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, OCTOPUS_NATIVE_REGISTRY_KEY: keyPath }
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function inspectNativeRegistrations(
  roots: readonly string[],
  hostName: string,
  manifestPath: string,
  readValue: NativeRegistryReader = readWindowsRegistryDefault
): ReadinessCheck {
  const expected = normalize(resolve(manifestPath));
  const observations = roots.map((root) => {
    const keyPath = nativeRegistryKey(root, hostName);
    const registeredManifest = readValue(keyPath);
    const matches = registeredManifest !== null
      && normalize(resolve(registeredManifest)).toLowerCase() === expected.toLowerCase();
    return { root, keyPath, registeredManifest, matches };
  });
  const mismatches = observations.filter(({ matches }) => !matches);
  if (mismatches.length > 0) {
    return actionRequired(
      'native_host_registry',
      `Native Messaging registration is missing or stale under: ${mismatches.map(({ root }) => root).join(', ')}.`,
      'Rerun tools/install-local.ps1 -Install with the same -NativeRegistryRoots values.'
    );
  }
  return ready(
    'native_host_registry',
    `Every configured Native Messaging registry root points to ${expected}.`,
    { registryRoots: [...roots], nativeManifestPath: expected }
  );
}
