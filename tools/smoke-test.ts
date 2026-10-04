import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRelayApplication } from '../apps/broker/src/runtime/bootstrap.js';
import { MCP_TOOL_NAMES } from '../apps/shared/protocol/src/index.js';

const token = 'smoke-admin-token-that-is-long-enough';
const application = createRelayApplication({
  host: '127.0.0.1', mcpPort: 0, wsPort: 0, dbPath: ':memory:', logLevel: 'silent',
  heartbeatTimeoutMs: 5_000, errorThreshold: 3, leaseTtlMs: 60_000, adminToken: token
});
await application.start();
const client = new Client({ name: 'smoke-test', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
try {
  const { port } = application.mcpGateway.address();
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { 'x-octopus-contract-version': '5', Authorization: `Bearer ${token}` } }
  }));
  const tools = await client.listTools();
  if (tools.tools.length !== MCP_TOOL_NAMES.length) throw new Error(`Expected ${MCP_TOOL_NAMES.length} MCP tools, received ${tools.tools.length}.`);
  const context = await client.callTool({
    name: 'get_browser_context',
    arguments: { view: { kind: 'broker' } }
  });
  if (context.isError) throw new Error('get_browser_context broker view returned an error.');
  const structured = context.structuredContent as {
    disposition?: unknown;
    facts?: { view_kind?: unknown; broker?: { condition?: unknown } };
  } | undefined;
  if (structured?.disposition !== 'complete' || structured.facts?.view_kind !== 'broker'
    || structured.facts.broker?.condition !== 'ready') {
    throw new Error(`Broker context is not ready: ${JSON.stringify(structured)}`);
  }
  console.log(JSON.stringify({ status: 'PASS', tools: tools.tools.length, brokerContext: structured }, null, 2));
} finally {
  await client.close();
  await application.stop();
}
