import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import {
  inspectMcpHandoffs,
  inspectNativeRegistrations,
  type ReadinessCheck
} from './setup-readiness-checks.js';

type CheckResult = ReadinessCheck;

const argument = (name: string, fallback?: string): string => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback ?? '';
};

const repeatedArguments = (name: string): string[] => {
  const prefix = `--${name}=`;
  return process.argv.filter((value) => value.startsWith(prefix)).map((value) => value.slice(prefix.length));
};

const absolute = (value: string, base: string): string =>
  normalize(isAbsolute(value) ? value : resolve(base, value));

const workspace = absolute(argument('workspace', '.'), process.cwd());
const mcpHealthUrl = argument('mcp-health', 'http://127.0.0.1:7331/health');
const relayHealthUrl = argument('relay-health', 'http://127.0.0.1:7332/health');
const extensionPath = absolute(argument('extension', 'dist/browser-extension'), workspace);
const nativeHostPath = absolute(argument('native-host', 'dist/native-host/relay-native-host.exe'), workspace);
const mcpAdapterPath = absolute(
  argument('mcp-adapter', 'dist/mcp-stdio-adapter/src/main.js'),
  workspace
);
const nativeManifestPath = absolute(
  argument('native-manifest', '.relay-data/bootstrap/io.github.ohmyskyhigh.octopus_browser_relay.json'),
  workspace
);
const pairingInstructionsPath = absolute(
  argument('pairing-instructions', '.relay-data/bootstrap/PAIRING.md'),
  workspace
);
const mcpInstructionsPath = absolute(
  argument('mcp-instructions', '.relay-data/bootstrap/MCP-REGISTRATION.md'),
  workspace
);
const codexRegistrationPath = absolute(
  argument('codex-registration', '.relay-data/bootstrap/codex-mcp.toml'),
  workspace
);
const hermesRegistrationPath = absolute(
  argument('hermes-registration', '.relay-data/bootstrap/hermes-mcp.txt'),
  workspace
);
const hermesRegistrationHelperPath = absolute(
  argument('hermes-registration-helper', 'tools/register-hermes-profiles.ps1'),
  workspace
);
const adminTokenPath = absolute(argument('admin-token', '.relay-data/admin-token.txt'), workspace);
const configuredRegistryRoots = repeatedArguments('native-registry-root');
const nativeRegistryRoots = configuredRegistryRoots.length > 0 ? configuredRegistryRoots : [
  'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU:\\Software\\Chromium\\NativeMessagingHosts',
  'HKCU:\\Software\\AdsPower\\SunBrowser\\NativeMessagingHosts'
];
const expectedNativeHostName = 'io.github.ohmyskyhigh.octopus_browser_relay';
const expectedExtensionId = 'caekiojlchhifdomfghejkbfpmaklafe';
const checks: CheckResult[] = [];

const ready = (name: string, detail: string, facts?: Record<string, unknown>): void => {
  checks.push({ name, status: 'ready', detail, ...(facts === undefined ? {} : { facts }) });
};
const actionRequired = (name: string, detail: string, action: string): void => {
  checks.push({ name, status: 'action_required', detail, action });
};

if (existsSync(resolve(workspace, 'package.json'))) {
  ready('workspace', `Tabro workspace found at ${workspace}.`);
} else {
  actionRequired('workspace', `package.json is missing under ${workspace}.`, 'Pass the correct --workspace path.');
}

const extensionManifestPath = resolve(extensionPath, 'manifest.json');
const serviceWorkerPath = resolve(extensionPath, 'service-worker.js');
const optionsScriptPath = resolve(extensionPath, 'options.js');
if (!existsSync(extensionManifestPath) || !existsSync(serviceWorkerPath) || !existsSync(optionsScriptPath)) {
  actionRequired(
    'extension_build',
    `The unpacked extension is incomplete at ${extensionPath}.`,
    'Run pnpm build:extension, then rerun preflight.'
  );
} else {
  try {
    const manifest = JSON.parse(readFileSync(extensionManifestPath, 'utf8')) as {
      name?: unknown;
      version?: unknown;
      permissions?: unknown;
      background?: { service_worker?: unknown };
    };
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.filter((value): value is string => typeof value === 'string') : [];
    const missingPermissions = ['nativeMessaging', 'debugger', 'tabGroups'].filter((permission) => !permissions.includes(permission));
    if (manifest.background?.service_worker !== 'service-worker.js' || missingPermissions.length > 0) {
      actionRequired(
        'extension_build',
        `The built extension manifest is missing required runtime declarations: ${missingPermissions.join(', ') || 'service-worker.js'}.`,
        'Rebuild the current Tabro extension source before loading profiles.'
      );
    } else {
      ready('extension_build', `Built extension ${String(manifest.version)} is ready at ${extensionPath}.`, {
        extensionPath,
        extensionVersion: manifest.version,
        extensionId: expectedExtensionId
      });
    }
  } catch (error) {
    actionRequired(
      'extension_build',
      `The built extension manifest cannot be parsed: ${error instanceof Error ? error.message : 'unknown error'}.`,
      'Run pnpm build:extension.'
    );
  }
}

if (!existsSync(nativeHostPath) || statSync(nativeHostPath).size === 0) {
  actionRequired(
    'native_host_executable',
    `Native companion executable is missing at ${nativeHostPath}.`,
    'Install Visual Studio C++ Build Tools, then run pnpm build:native.'
  );
} else {
  ready('native_host_executable', `Native companion executable exists at ${nativeHostPath}.`, {
    bytes: statSync(nativeHostPath).size
  });
}

if (!existsSync(nativeManifestPath)) {
  actionRequired(
    'native_host_manifest',
    `Native Messaging manifest is missing at ${nativeManifestPath}.`,
    'Run tools/install-local.ps1 -Install to generate and register it for the current user.'
  );
} else {
  try {
    const manifest = JSON.parse(readFileSync(nativeManifestPath, 'utf8')) as {
      name?: unknown;
      path?: unknown;
      type?: unknown;
      allowed_origins?: unknown;
    };
    const allowedOrigins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
    const configuredHost = typeof manifest.path === 'string' ? absolute(manifest.path, workspace) : '';
    const sameHost = process.platform === 'win32'
      ? configuredHost.toLowerCase() === nativeHostPath.toLowerCase()
      : configuredHost === nativeHostPath;
    if (manifest.name !== expectedNativeHostName || manifest.type !== 'stdio' || !sameHost
      || !allowedOrigins.includes(`chrome-extension://${expectedExtensionId}/`)) {
      actionRequired(
        'native_host_manifest',
        'Native Messaging manifest does not match the built host or fixed extension identity.',
        'Rerun tools/install-local.ps1 -Install with the intended parameterized paths.'
      );
    } else {
      ready('native_host_manifest', `Native Messaging manifest is valid at ${nativeManifestPath}.`, {
        name: manifest.name,
        path: configuredHost
      });
    }
  } catch (error) {
    actionRequired(
      'native_host_manifest',
      `Native Messaging manifest cannot be parsed: ${error instanceof Error ? error.message : 'unknown error'}.`,
      'Rerun tools/install-local.ps1 -Install.'
    );
  }
}

if (process.platform === 'win32') {
  checks.push(inspectNativeRegistrations(
    nativeRegistryRoots,
    expectedNativeHostName,
    nativeManifestPath
  ));
}

checks.push(...inspectMcpHandoffs({
  adapterPath: mcpAdapterPath,
  instructionsPath: mcpInstructionsPath,
  codexRegistrationPath,
  hermesRegistrationPath,
  hermesRegistrationHelperPath,
  adminTokenPath,
  brokerUrl: argument('mcp-url', 'http://127.0.0.1:7331/mcp')
}));

if (!existsSync(pairingInstructionsPath)) {
  actionRequired(
    'pairing_instructions',
    `Pairing instructions are missing at ${pairingInstructionsPath}.`,
    'Run tools/install-local.ps1 -Install to generate path-specific instructions.'
  );
} else {
  const instructions = readFileSync(pairingInstructionsPath, 'utf8');
  if (!instructions.includes(extensionPath)
    || !/pairing code/i.test(instructions)
    || !/registers automatically/i.test(instructions)
    || /pnpm pair --nickname|enter the returned pairing_code/i.test(instructions)
    || !/Native companion/i.test(instructions)) {
    actionRequired(
      'pairing_instructions',
      'Pairing instructions do not match the selected extension path or required Native Messaging flow.',
      'Regenerate instructions with tools/install-local.ps1 -Install and the same bootstrap parameters.'
    );
  } else {
    ready('pairing_instructions', `Pairing steps are ready at ${pairingInstructionsPath}.`);
  }
}

await checkHealth('mcp_health', mcpHealthUrl, 'Start the broker with tools/install-local.ps1 -Install -StartBroker.');
await checkHealth('relay_health', relayHealthUrl, 'Start the broker and verify the extension relay port is available.');

const pending = checks.filter((check) => check.status === 'action_required');
const connectedEndpoints = checks.find((check) => check.name === 'mcp_health')?.facts?.connectedEndpoints;
const readyNextAction = typeof connectedEndpoints === 'number' && connectedEndpoints > 0
  ? `Confirm the intended profile count (${connectedEndpoints} currently connected), then begin physical MCP qualification.`
  : 'Load the extension in each intended browser profile and wait for automatic pairing.';
console.log(JSON.stringify({
  status: pending.length === 0 ? 'READY' : 'ACTION_REQUIRED',
  observedAt: new Date().toISOString(),
  paths: {
    workspace,
    extensionPath,
    nativeHostPath,
    mcpAdapterPath,
    nativeManifestPath,
    pairingInstructionsPath,
    mcpInstructionsPath,
    codexRegistrationPath,
    hermesRegistrationPath,
    hermesRegistrationHelperPath,
    adminTokenPath
  },
  nativeRegistryRoots,
  endpoints: { mcpHealthUrl, relayHealthUrl },
  checks,
  nextAction: pending[0]?.action ?? readyNextAction
}, null, 2));
if (pending.length > 0) process.exitCode = 10;

async function checkHealth(name: string, url: string, action: string): Promise<void> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok || body.status !== 'ok') {
      actionRequired(name, `${url} returned HTTP ${response.status} without status ok.`, action);
      return;
    }
    ready(name, `${url} is healthy.`, body);
  } catch (error) {
    actionRequired(
      name,
      `${url} is not reachable: ${error instanceof Error ? error.message : 'unknown error'}.`,
      action
    );
  }
}
