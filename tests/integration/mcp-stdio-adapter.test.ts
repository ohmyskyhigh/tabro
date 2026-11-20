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
import { SimulatedV2Extension, call, ticketRef, waitFor, waitTicket } from '../helpers/simulated-v2-extension.js';

const TOKEN = 'stdio-adapter-integration-token-long-enough';

interface AdapterClient {
  client: Client;
  transport: StdioClientTransport;
}

describe('stdio MCP session adapter', () => {
  let application: RelayApplication | null = null;
  const adapterClients: AdapterClient[] = [];
  let rulesRoot: string | undefined;
  let extension: SimulatedV2Extension | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(adapterClients.splice(0).map(({ client }) => client.close()));
    application?.broker.beginShutdown();
    await extension?.close();
    extension = undefined;
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
  it('coalesces a chat across workers, isolates runtime names and resumes its group after adapter restart', async () => {
    const app = application = createRelayApplication({
      host: '127.0.0.1', mcpPort: 0, wsPort: 0, dbPath: ':memory:',
      browserRulesPath: join(rulesRoot = mkdtempSync(join(tmpdir(), 'tabro-chat-rules-')), 'browser-rules.json'),
      logLevel: 'silent', heartbeatTimeoutMs: 5_000, errorThreshold: 3, leaseTtlMs: 60_000, adminToken: TOKEN
    });
    await app.start();
    const { port } = app.mcpGateway.address();
    extension = new SimulatedV2Extension('A', 100, 200, 300);
    await extension.pair(`ws://127.0.0.1:${app.extensionGateway.address().port}/relay`, 'mintwave', 'MINT-WAVE');
    await waitFor(() => {
      const endpoint = app.store.canonical.logical.getEndpointByNickname('mintwave');
      return !!endpoint && app.store.canonical.logical.listWindows(endpoint.endpointRef).length === 1;
    });
    async function connect(runtime: string, session = 'chat-42') {
      const adapter = createAdapter(port, runtime, { TABRO_RUNTIME: runtime, TABRO_RUNTIME_SESSION: session, CODEX_THREAD_ID: 'inherited-codex' });
      adapterClients.push(adapter);
      await adapter.client.connect(adapter.transport);
      return adapter.client;
    }
    const [dsh, worker, codex, cc] = await Promise.all(['dsh', 'dsh', 'codex', 'cc'].map(runtime => connect(runtime)));
    const caller = await readBrokerContext(dsh!);
    expect(await readBrokerContext(worker!)).toEqual(caller);
    expect(new Set((await Promise.all([dsh!, codex!, cc!].map(readBrokerContext))).map(value => value.session_ref)).size).toBe(3);
    const args = { required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: 'mintwave' }] };
    const [first, duplicate] = await Promise.all([dsh!, worker!].map(client => call(client, 'request_browser_workspace', args)));
    expect(first).toMatchObject({ disposition: 'accepted' });
    expect(duplicate).toMatchObject({ disposition: 'accepted' });
    const original = await waitTicket(dsh!, ticketRef(first!));
    expect(original.state).toBe('succeeded');
    const { workspace_ref } = (original.result as { facts: { resolved: Array<{ workspace: { workspace_ref: string } }> } }).facts.resolved[0]!.workspace;
    // Across adapter processes the second submission can reach the Broker after
    // the first ticket already finished. Both paths must resolve to one workspace.
    const second = await waitTicket(worker!, ticketRef(duplicate!));
    expect(second.state).toBe('succeeded');
    expect(second.result).toMatchObject({ facts: { resolved: [{ workspace: { workspace_ref } }] } });
    expect(app.store.canonical.logical.listActiveWorkspaces()).toHaveLength(1);
    await dsh!.close();
    const resumed = await connect('dsh');
    expect(await readBrokerContext(resumed)).toEqual(caller);
    expect((await waitTicket(resumed, ticketRef(first!))).state).toBe('succeeded');
    const receipt = await call(resumed, 'request_browser_workspace', args);
    const reused = await waitTicket(resumed, ticketRef(receipt));
    expect(reused.state, JSON.stringify(reused)).toBe('succeeded');
    expect(reused.result).toMatchObject({
      facts: { resolved: [{ workspace_result: 'resumed', workspace: { workspace_ref } }] }
    });
    expect(app.store.canonical.logical.listActiveWorkspaces()).toHaveLength(1);
    for (const other of [codex!, cc!, await connect('dsh', 'chat-43')]) {
      expect(await call(other, 'get_browser_request', { request_ref: ticketRef(first!) }))
        .toMatchObject({ problem: { code: 'REQUEST_NOT_FOUND' } });
      expect(await call(other, 'create_browser_tab', { workspace_ref }))
        .toMatchObject({ problem: { code: 'WORKSPACE_NOT_OWNED' } });
    }
  }, 60_000);

});

function createAdapter(port: number, label: string, env: Record<string, string> = {}): AdapterClient {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'tests/helpers/stdio-adapter-fixture.ts'],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      OCTOPUS_BROWSER_RELAY_TOKEN: TOKEN,
      OCTOPUS_BROKER_URL: `http://127.0.0.1:${port}/mcp`,
      OCTOPUS_RUNTIME: 'codex',
      ...env
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
