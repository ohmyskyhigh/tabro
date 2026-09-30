import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OCTOPUS_VERSION } from '../../shared/protocol/src/version.js';
import type { DemoTraceConfig } from './demo-trace.js';

const SAFE_RUNTIME_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;
const SAFE_SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u;

export interface StdioAdapterIdentity {
  runtimeName: string;
  runtimeSessionKey: string;
  parentRuntimeSessionKey?: string;
  source: 'codex-thread' | 'codex-session' | 'hermes-session' | 'hermes-agent-session' | 'explicit' | 'process';
}

export interface StdioAdapterConfig {
  demoTrace?: DemoTraceConfig;
  brokerUrl: URL;
  bearerToken: string;
  identity: StdioAdapterIdentity;
  serviceVersion: string;
}

export type AdapterEnvironment = Readonly<Record<string, string | undefined>>;

interface IdentityCandidate {
  key: string;
  source: StdioAdapterIdentity['source'];
  runtime: string;
}

const SESSION_CANDIDATES: readonly IdentityCandidate[] = [
  { key: 'CODEX_THREAD_ID', source: 'codex-thread', runtime: 'codex' },
  { key: 'CODEX_SESSION_ID', source: 'codex-session', runtime: 'codex' },
  { key: 'HERMES_SESSION_ID', source: 'hermes-session', runtime: 'hermes' },
  { key: 'HERMES_AGENT_SESSION_ID', source: 'hermes-agent-session', runtime: 'hermes' },
  { key: 'OCTOPUS_RUNTIME_SESSION', source: 'explicit', runtime: 'mcp-agent' }
];

const CODEX_PARENT_SESSION_KEYS = ['CODEX_PARENT_THREAD_ID', 'CODEX_PARENT_SESSION_ID'] as const;
const HERMES_PARENT_SESSION_KEYS = ['HERMES_PARENT_SESSION_ID', 'HERMES_PARENT_AGENT_SESSION_ID'] as const;

const valueOf = (environment: AdapterEnvironment, key: string): string | undefined => {
  const tabroKey = key.replace(/^OCTOPUS_BROWSER_RELAY_/u, 'TABRO_').replace(/^OCTOPUS_/u, 'TABRO_');
  const value = environment[tabroKey]?.trim() || environment[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

const assertHeaderValue = (name: string, value: string, pattern: RegExp): string => {
  if (!pattern.test(value)) {
    throw new Error(`${name} contains unsupported characters or exceeds its size limit.`);
  }
  return value;
};

/**
 * Resolves session evidence once, at adapter process startup. The value never
 * appears in a tool schema or model-authored tool arguments.
 */
export function resolveAdapterIdentity(
  environment: AdapterEnvironment,
  createRandomId: () => string = randomUUID
): StdioAdapterIdentity {
  const explicitRuntime = valueOf(environment, 'OCTOPUS_RUNTIME');
  const runtimeCandidates = explicitRuntime === 'codex'
    ? SESSION_CANDIDATES.filter(({ runtime }) => runtime === 'codex' || runtime === 'mcp-agent')
    : explicitRuntime === 'hermes'
      ? SESSION_CANDIDATES.filter(({ runtime }) => runtime === 'hermes' || runtime === 'mcp-agent')
      : SESSION_CANDIDATES;
  const candidate = runtimeCandidates.find(({ key }) => valueOf(environment, key) !== undefined);
  const runtimeSessionKey = candidate
    ? valueOf(environment, candidate.key)!
    : `stdio-${createRandomId()}`;
  const detectedRuntime = candidate?.runtime ?? 'mcp-agent';
  const runtimeName = explicitRuntime ?? detectedRuntime;
  const runtimeParentKeys = explicitRuntime === 'codex'
    ? CODEX_PARENT_SESSION_KEYS
    : explicitRuntime === 'hermes'
      ? HERMES_PARENT_SESSION_KEYS
      : [...CODEX_PARENT_SESSION_KEYS, ...HERMES_PARENT_SESSION_KEYS];
  const parentRuntimeSessionKey = [...runtimeParentKeys, 'OCTOPUS_PARENT_RUNTIME_SESSION']
    .map((key) => valueOf(environment, key))
    .find((value) => value !== undefined);

  return {
    runtimeName: assertHeaderValue('runtime name', runtimeName, SAFE_RUNTIME_NAME),
    runtimeSessionKey: assertHeaderValue('runtime session key', runtimeSessionKey, SAFE_SESSION_KEY),
    ...(parentRuntimeSessionKey === undefined
      ? {}
      : { parentRuntimeSessionKey: assertHeaderValue('parent runtime session key', parentRuntimeSessionKey, SAFE_SESSION_KEY) }),
    source: candidate?.source ?? 'process'
  };
}

const readBearerToken = (environment: AdapterEnvironment): string => {
  const direct = valueOf(environment, 'OCTOPUS_BROWSER_RELAY_TOKEN')
    ?? valueOf(environment, 'OCTOPUS_AGENT_TOKEN');
  const tokenFile = valueOf(environment, 'OCTOPUS_BROWSER_RELAY_TOKEN_FILE');
  // Installer-generated token-file configuration wins over an inherited
  // direct token so an old shell variable cannot silently select another
  // broker principal.
  const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : direct;
  if (!token || token.length < 16 || token.length > 4096) {
    throw new Error('A valid broker token is required through TABRO_TOKEN or TABRO_TOKEN_FILE (legacy OCTOPUS_BROWSER_RELAY_* names are also accepted).');
  }
  return token;
};

const readBrokerUrl = (environment: AdapterEnvironment): URL => {
  const url = new URL(valueOf(environment, 'OCTOPUS_BROKER_URL') ?? 'http://127.0.0.1:7331/mcp');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase())) {
    throw new Error('TABRO_BROKER_URL must use a loopback host.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/mcp') {
    throw new Error('TABRO_BROKER_URL must be an HTTP(S) URL whose path is /mcp.');
  }
  return url;
};

export function loadStdioAdapterConfig(
  environment: AdapterEnvironment = process.env,
  createRandomId: () => string = randomUUID
): StdioAdapterConfig {
  const traceRoot = valueOf(environment, 'OCTOPUS_DEMO_TRACE_ROOT');
  const runId = valueOf(environment, 'OCTOPUS_DEMO_RUN_ID');
  if (!!traceRoot !== !!runId) throw new Error('Demo trace requires both root and run ID.');
  return {
    ...(traceRoot && runId ? { demoTrace: { root: traceRoot, runId } } : {}),
    brokerUrl: readBrokerUrl(environment),
    bearerToken: readBearerToken(environment),
    identity: resolveAdapterIdentity(environment, createRandomId),
    serviceVersion: valueOf(environment, 'OCTOPUS_ADAPTER_VERSION') ?? OCTOPUS_VERSION
  };
}
