import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { CallerEvidence, OctopusBroker } from '../../apps/broker/src/core/index.js';
import { McpGateway } from '../../apps/broker/src/mcp/index.js';
import { MCP_TOOL_NAMES, type McpAsyncToolName } from '../../apps/shared/protocol/src/index.js';
import type { RelayRepositories } from '../../apps/broker/src/storage/index.js';

const TOKEN = 'canonical-mcp-gateway-test-token';
const NOW = '2026-08-31T00:00:00.000Z';
const CALLER = {
  session_ref: 'ses_gateway_test',
  lineage_ref: 'lin_gateway_test',
  parent_session_ref: null
};

const rejectedOutput = () => ({
  contract_version: '5',
  disposition: 'rejected',
  observed_at: NOW,
  caller: CALLER,
  problem: {
    code: 'BROKER_NOT_READY',
    message: 'The test broker is intentionally not connected.',
    retryable: true,
    affected_target: null
  },
  facts: null,
  available_actions: []
});

const acceptedWorkspaceOutput = (input: unknown) => {
  const requestRef = 'req_gateway_test';
  return {
    contract_version: '5',
    disposition: 'accepted',
    observed_at: NOW,
    caller: CALLER,
    problem: null,
    facts: {
      ticket: {
        request_ref: requestRef,
        state: 'queued',
        phase: 'accepted',
        checkpoint: { name: 'accepted', recorded_at: NOW, details: { ticket_before_dispatch: true } },
        pause_condition: null,
        request: { tool: 'request_browser_workspace', arguments: input },
        submitted_at: NOW,
        started_at: null,
        finished_at: null,
        updated_at: NOW,
        result: null,
        failure: null,
        uncertainty: null
      }
    },
    available_actions: [{
      tool: 'get_browser_request',
      arguments: { request_ref: requestRef },
      required_arguments: []
    }]
  };
};

class FakeCanonicalBroker {
  readonly calls: Array<{ tool: string; input: unknown; evidence: CallerEvidence }> = [];
  readonly confirmations: Array<{ requestRef: string; delivered: boolean }> = [];
  confirmationCountDuringSubmit = -1;

  getBrowserContext(input: unknown, evidence: CallerEvidence) {
    this.calls.push({ tool: 'get_browser_context', input, evidence });
    return rejectedOutput();
  }

  readCdpEvents(input: unknown, evidence: CallerEvidence) {
    this.calls.push({ tool: 'read_cdp_events', input, evidence });
    return rejectedOutput();
  }

  getBrowserRequest(input: unknown, evidence: CallerEvidence) {
    this.calls.push({ tool: 'get_browser_request', input, evidence });
    return rejectedOutput();
  }

  closeBrowserRequest(input: unknown, evidence: CallerEvidence) {
    this.calls.push({ tool: 'close_browser_request', input, evidence });
    return rejectedOutput();
  }

  submit(tool: McpAsyncToolName, input: unknown, evidence: CallerEvidence) {
    this.calls.push({ tool, input, evidence });
    this.confirmationCountDuringSubmit = this.confirmations.length;
    return tool === 'request_browser_workspace' ? acceptedWorkspaceOutput(input) : rejectedOutput();
  }

  confirmAcknowledgement(requestRef: string, delivered: boolean): void {
    this.confirmations.push({ requestRef, delivered });
  }
}

const fakeStore = (): RelayRepositories => ({
  authenticateAgent: (token: string) => token === TOKEN
    ? { principalId: 'principal-gateway-test', displayName: 'Codex', scopes: ['browser:read', 'browser:write'] }
    : null
} as unknown as RelayRepositories);

describe('canonical MCP gateway', () => {
  let gateway: McpGateway | null = null;
  let client: Client | null = null;

  afterEach(async () => {
    if (client) await client.close();
    if (gateway) await gateway.stop();
    client = null;
    gateway = null;
  });

  async function connect(broker: FakeCanonicalBroker, headers: Record<string, string> = {}): Promise<Client> {
    gateway = new McpGateway(broker as unknown as OctopusBroker, fakeStore(), {
      host: '127.0.0.1',
      port: 0,
      serviceVersion: '0.3.0-test',
      health: () => ({ canonicalContractVersion: '1' }),
      onError: vi.fn()
    });
    await gateway.start();
    const { port } = gateway.address();
    client = new Client({ name: 'mcp-gateway-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          'x-octopus-contract-version': '5', Authorization: `Bearer ${TOKEN}`,
          ...headers
        }
      }
    }));
    return client;
  }

  it('publishes exactly the canonical fourteen tools with full JSON schemas', async () => {
    const connected = await connect(new FakeCanonicalBroker());
    const listed = await connected.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description?.length).toBeGreaterThan(20);
    }
  });

  it('rejects missing or old contract versions after authentication and before admission', async () => {
    const broker = new FakeCanonicalBroker(); await connect(broker);
    const url = `http://127.0.0.1:${gateway!.address().port}/mcp`;
    for (const version of [undefined, '1', '2', '3']) {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, ...(version ? { 'x-octopus-contract-version': version } : {}) } });
      expect(response.status).toBe(409);
    }
    expect((await fetch(url, { method: 'POST', headers: { 'x-octopus-contract-version': '1' } })).status).toBe(401);
    expect(broker.calls).toHaveLength(0);
  });

  it('derives caller evidence from auth and safe runtime headers, never tool arguments', async () => {
    const broker = new FakeCanonicalBroker();
    const connected = await connect(broker, {
      'x-octopus-runtime': 'codex',
      'x-octopus-runtime-session': 'task-42',
      'x-octopus-parent-runtime-session': 'task-parent'
    });
    const result = await connected.callTool({
      name: 'get_browser_context',
      arguments: { view: { kind: 'broker' } }
    });
    expect(result.isError).not.toBe(true);
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]?.evidence).toEqual({
      managementAuthority: { principalId: 'principal-gateway-test', scopes: ['browser:read', 'browser:write'] },
      runtimeName: 'codex',
      runtimeSessionKey: 'principal:principal-gateway-test:session:task-42',
      parentRuntimeSessionKey: 'principal:principal-gateway-test:session:task-parent'
    });
  });

  it('does not mistake two same-token stateless clients for distinct sessions without runtime evidence', async () => {
    const broker = new FakeCanonicalBroker();
    gateway = new McpGateway(broker as unknown as OctopusBroker, fakeStore(), {
      host: '127.0.0.1',
      port: 0,
      serviceVersion: '0.3.0-test',
      health: () => ({ canonicalContractVersion: '1' }),
      onError: vi.fn()
    });
    await gateway.start();
    const { port } = gateway.address();
    const firstTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { 'x-octopus-contract-version': '5', Authorization: `Bearer ${TOKEN}` } }
    });
    const secondTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { 'x-octopus-contract-version': '5', Authorization: `Bearer ${TOKEN}` } }
    });
    const first = new Client({ name: 'same-token-first', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const second = new Client({ name: 'same-token-second', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
      await Promise.all([first.connect(firstTransport), second.connect(secondTransport)]);
      await Promise.all([
        first.callTool({ name: 'get_browser_context', arguments: { view: { kind: 'broker' } } }),
        second.callTool({ name: 'get_browser_context', arguments: { view: { kind: 'broker' } } })
      ]);
      expect(firstTransport.sessionId).toBeUndefined();
      expect(secondTransport.sessionId).toBeUndefined();
      expect(broker.calls.map((entry) => entry.evidence.runtimeSessionKey)).toEqual([
        'principal:principal-gateway-test:session:principal-gateway-test',
        'principal:principal-gateway-test:session:principal-gateway-test'
      ]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('exposes neither ServerContext.sessionId nor mcp-session-id in the SDK modern stateless path', async () => {
    const observations: Array<{
      factorySessionHeader: string | null;
      handlerSessionHeader: string | null;
      handlerSessionId: string | null;
    }> = [];
    const handler = createMcpHandler((factoryContext) => {
      const factorySessionHeader = factoryContext.requestInfo?.headers.get('mcp-session-id') ?? null;
      const server = new McpServer({ name: 'automatic-session-evidence-probe', version: '1.0.0' });
      server.registerTool('probe', {
        description: 'Observe only automatic MCP transport session evidence.',
        inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false })
      }, async (_input, context) => {
        observations.push({
          factorySessionHeader,
          handlerSessionHeader: context.http?.req?.headers.get('mcp-session-id') ?? null,
          handlerSessionId: context.sessionId ?? null
        });
        return { content: [{ type: 'text', text: 'ok' }] };
      });
      return server;
    }, { legacy: 'stateless', responseMode: 'json' });
    const nodeHandler = toNodeHandler(handler);
    const probeServer = createServer((request, response) => {
      void nodeHandler(
        request as unknown as Parameters<typeof nodeHandler>[0],
        response as unknown as Parameters<typeof nodeHandler>[1]
      );
    });
    await new Promise<void>((resolve, reject) => {
      probeServer.once('error', reject);
      probeServer.listen(0, '127.0.0.1', () => {
        probeServer.off('error', reject);
        resolve();
      });
    });
    const address = probeServer.address();
    if (!address || typeof address === 'string') throw new Error('Probe server did not bind a TCP port.');
    const firstTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    const secondTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    const first = new Client({ name: 'probe-first', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const second = new Client({ name: 'probe-second', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
      await Promise.all([first.connect(firstTransport), second.connect(secondTransport)]);
      await Promise.all([
        first.callTool({ name: 'probe', arguments: {} }),
        second.callTool({ name: 'probe', arguments: {} })
      ]);
      expect(firstTransport.sessionId).toBeUndefined();
      expect(secondTransport.sessionId).toBeUndefined();
      expect(observations).toEqual([
        { factorySessionHeader: null, handlerSessionHeader: null, handlerSessionId: null },
        { factorySessionHeader: null, handlerSessionHeader: null, handlerSessionId: null }
      ]);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await handler.close();
      await new Promise<void>((resolve, reject) => probeServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('confirms an accepted ticket only after constructing and handing off the MCP response', async () => {
    const broker = new FakeCanonicalBroker();
    const connected = await connect(broker);
    const result = await connected.callTool({
      name: 'request_browser_workspace',
      arguments: { required_workspace_count: 1, designated_endpoints: [] }
    });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as Record<string, unknown>).disposition).toBe('accepted');
    expect(broker.confirmationCountDuringSubmit).toBe(0);
    await vi.waitFor(() => expect(broker.confirmations).toEqual([
      { requestRef: 'req_gateway_test', delivered: true }
    ]));
  });

  it('lets the advertised input schema reject malformed calls before broker admission', async () => {
    const broker = new FakeCanonicalBroker();
    const connected = await connect(broker);
    const result = await connected.callTool({
      name: 'request_browser_workspace',
      arguments: { required_workspace_count: 0, designated_endpoints: [] }
    });
    expect(result.isError).toBe(true);
    expect(broker.calls).toHaveLength(0);
    expect(broker.confirmations).toHaveLength(0);
  });

  it('fails acknowledgement when an accepted broker result violates its tool output schema', async () => {
    const broker = new FakeCanonicalBroker();
    vi.spyOn(broker, 'submit').mockImplementation((_tool, input) => {
      const output = acceptedWorkspaceOutput(input);
      delete (output.facts.ticket as Record<string, unknown>).updated_at;
      return output;
    });
    const connected = await connect(broker);
    const result = await connected.callTool({
      name: 'request_browser_workspace',
      arguments: { required_workspace_count: 1, designated_endpoints: [] }
    });
    expect(result.isError).toBe(true);
    expect(broker.confirmations).toEqual([{ requestRef: 'req_gateway_test', delivered: false }]);
  });

  it('rejects missing credentials before MCP parsing and retains the local health endpoint', async () => {
    const broker = new FakeCanonicalBroker();
    gateway = new McpGateway(broker as unknown as OctopusBroker, fakeStore(), {
      host: '127.0.0.1', port: 0, serviceVersion: '0.3.0-test',
      health: () => ({ canonicalContractVersion: '1' })
    });
    await gateway.start();
    const { port } = gateway.address();
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    expect(unauthorized.status).toBe(401);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', canonicalContractVersion: '1' });
  });
});
