import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startStdioAdapter } from '../../apps/mcp-stdio-adapter/src/server.js';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRelayApplication, type RelayApplication } from '../../apps/broker/src/runtime/bootstrap.js';
import { resolveAdapterIdentity } from '../../apps/mcp-stdio-adapter/src/index.js';
import { MCP_TOOL_NAMES } from '../../apps/shared/protocol/src/index.js';

const TOKEN = 'stdio-adapter-integration-token-long-enough';

interface AdapterClient {
  client: Client;
  transport: StdioClientTransport;
}

describe('stdio MCP session adapter', () => {
  let application: RelayApplication | null = null;
  const adapterClients: AdapterClient[] = [];
  let rulesRoot: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(adapterClients.splice(0).map(({ client }) => client.close()));
    if (application) await application.stop();
    application = null;
    if (rulesRoot) rmSync(rulesRoot, { recursive: true, force: true });
  });

  it('rejects old or unversioned Brokers before opening MCP or dispatching tools', async () => {
    for (const health of [{ mcpContractVersion: '1' }, { mcpContractVersion: '2' }, { mcpContractVersion: '3' }, {}]) {
      const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(health), { status: 200 }));
      await expect(startStdioAdapter({ brokerUrl: new URL('http://127.0.0.1:17331/mcp'), bearerToken: TOKEN,
        serviceVersion: 'test', identity: { runtimeName: 'test', runtimeSessionKey: 'version-check', source: 'explicit' } })).rejects.toThrow('MCP_CONTRACT_VERSION_MISMATCH');
      expect(request).toHaveBeenCalledTimes(1); expect(String(request.mock.calls[0]![0])).toBe('http://127.0.0.1:17331/health');
      request.mockRestore();
    }
  });

  it('prefers runtime-owned session IDs and retains a deterministic process fallback', () => {
    expect(resolveAdapterIdentity({
      CODEX_THREAD_ID: 'thread-7',
      CODEX_SESSION_ID: 'session-ignored',
      HERMES_SESSION_ID: 'hermes-ignored'
    }, () => 'unused')).toMatchObject({
      runtimeName: 'codex',
      runtimeSessionKey: 'thread-7',
      source: 'codex-thread'
    });
    expect(resolveAdapterIdentity({ OCTOPUS_RUNTIME: 'hermes' }, () => 'fixed-random')).toEqual({
      runtimeName: 'hermes',
      runtimeSessionKey: 'stdio-fixed-random',
      source: 'process'
    });
    expect(resolveAdapterIdentity({
      OCTOPUS_RUNTIME: 'hermes',
      CODEX_THREAD_ID: 'inherited-codex-thread',
      HERMES_SESSION_ID: 'hermes-9'
    }, () => 'unused')).toMatchObject({
      runtimeName: 'hermes',
      runtimeSessionKey: 'hermes-9',
      source: 'hermes-session'
    });
  });

  it('launches two adapters with one token as two independent broker sessions', async () => {
    application = createRelayApplication({
      host: '127.0.0.1',
      mcpPort: 0,
      wsPort: 0,
      dbPath: ':memory:', browserRulesPath: join(rulesRoot = mkdtempSync(join(tmpdir(), 'tabro-test-rules-')), 'browser-rules.json'),
      logLevel: 'silent',
      heartbeatTimeoutMs: 5_000,
      errorThreshold: 3,
      leaseTtlMs: 60_000,
      adminToken: TOKEN
    });
    await application.start();
    const { port } = application.mcpGateway.address();

    const first = createAdapter(port, 'first');
    const second = createAdapter(port, 'second');
    adapterClients.push(first, second);
    await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);

    const [firstTools, secondTools] = await Promise.all([
      first.client.listTools(),
      second.client.listTools()
    ]);
    expect(firstTools.tools.map(({ name }) => name)).toEqual([...MCP_TOOL_NAMES]);
    expect(secondTools.tools.map(({ name }) => name)).toEqual([...MCP_TOOL_NAMES]);

    const [firstContext, secondContext] = await Promise.all([
      readBrokerContext(first.client),
      readBrokerContext(second.client)
    ]);
    expect(firstContext.session_ref).not.toBe(secondContext.session_ref);
    expect(firstContext.lineage_ref).not.toBe(secondContext.lineage_ref);
  }, 60_000);
});

function createAdapter(port: number, label: string): AdapterClient {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'apps/mcp-stdio-adapter/src/main.ts'],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      OCTOPUS_BROWSER_RELAY_TOKEN: TOKEN,
      OCTOPUS_BROKER_URL: `http://127.0.0.1:${port}/mcp`,
      OCTOPUS_RUNTIME: 'codex'
    },
    stderr: 'pipe'
  });
  const client = new Client({
    name: `stdio-adapter-test-${label}`,
    version: '0.3.0-test'
  }, { versionNegotiation: { mode: 'auto' } });
  return { client, transport };
}

async function readBrokerContext(client: Client): Promise<{ session_ref: string; lineage_ref: string }> {
  const result = await client.callTool({
    name: 'get_browser_context',
    arguments: { view: { kind: 'broker' } }
  });
  expect(result.isError).not.toBe(true);
  const caller = (result.structuredContent as { caller: { session_ref: string; lineage_ref: string } }).caller;
  return caller;
}
