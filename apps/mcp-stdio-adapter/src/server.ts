import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  McpServer,
  fromJsonSchema,
  type CallToolResult
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  MCP_TOOL_CATALOG,
  MCP_CONTRACT_VERSION,
  mcpToolInputJsonSchemas,
  mcpToolOutputJsonSchemas,
  parseMcpToolInput,
  parseMcpToolOutput,
  type McpToolName
} from '../../shared/protocol/src/index.js';
import type { StdioAdapterConfig } from './config.js';
import { createDemoTrace } from './demo-trace.js';
import { randomUUID } from 'node:crypto';
import { readBrokerRuntime } from '../../shared/protocol/src/runtime-discovery.js';

export interface RunningStdioAdapter {
  close(): Promise<void>;
}

const title = (tool: McpToolName): string => tool
  .split('_')
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  .join(' ');

// Hand-wired stdio currently negotiates the 2025 MCP era. Its wire codec
// wraps structured output as `{result: ...}` when the advertised schema has a
// typeless `$ref` root. Every canonical Tabro result is an object, so stamp
// that known root type and keep the broker's structured result shape intact.
const objectRootOutputSchema = (tool: McpToolName): Record<string, unknown> => ({
  ...mcpToolOutputJsonSchemas[tool],
  type: 'object'
});

/**
 * Bridges one agent-owned stdio MCP process to the local HTTP broker. The
 * remote HTTP acknowledgement proves delivery to this adapter process; MCP
 * has no transaction spanning that handoff and the subsequent stdout write.
 * Consequently, a process crash in that narrow interval can dispatch a ticket
 * whose acknowledgement the agent runtime did not receive. The broker-issued
 * request_ref remains the only request identity and is never synthesized here.
 */
export async function startStdioAdapter(config: StdioAdapterConfig): Promise<RunningStdioAdapter> {
  const trace = createDemoTrace(config.demoTrace, config.identity.runtimeSessionKey, config.bearerToken);
  const requestHeaders: Record<string, string> = {
    'x-octopus-contract-version': MCP_CONTRACT_VERSION,
    Authorization: `Bearer ${config.bearerToken}`,
    'x-octopus-runtime': config.identity.runtimeName,
    'x-octopus-runtime-session': config.identity.runtimeSessionKey,
    ...(config.identity.parentRuntimeSessionKey === undefined
      ? {}
      : { 'x-octopus-parent-runtime-session': config.identity.parentRuntimeSessionKey })
  };
  let remoteClient: Client | undefined;
  let connectedInstance: string | undefined;
  let connecting: Promise<void> | undefined;
  const ensureConnection = async (): Promise<void> => {
    if (connecting) return connecting;
    const runtime = config.runtimeFile ? readBrokerRuntime(config.runtimeFile) : undefined;
    if (remoteClient && (!runtime || connectedInstance === runtime.instanceRef)) return;
    const url = runtime ? new URL(runtime.mcpUrl) : config.brokerUrl;
    connecting = (async () => {
      const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(5_000) });
      const health = await response.json() as { mcpContractVersion?: string; instanceRef?: string };
      if (!response.ok || health.mcpContractVersion !== MCP_CONTRACT_VERSION) {
        throw new Error('MCP_CONTRACT_VERSION_MISMATCH: update the Broker and stdio adapter together.');
      }
      if (runtime && health.instanceRef !== runtime.instanceRef) {
        throw new Error('The discovered Tabro runtime does not match the responding Broker.');
      }
      const next = new Client({ name: 'tabro-stdio-adapter', version: config.serviceVersion }, { versionNegotiation: { mode: 'auto' } });
      try { await next.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: requestHeaders } })); }
      catch (error) { await next.close(); throw error; }
      const previous = remoteClient;
      remoteClient = next;
      connectedInstance = runtime?.instanceRef;
      if (previous) await previous.close();
    })();
    try { await connecting; } finally { connecting = undefined; }
  };
  await ensureConnection();

  const server = new McpServer({
    name: 'tabro',
    version: config.serviceVersion
  });
  for (const definition of MCP_TOOL_CATALOG) {
    server.registerTool(definition.name, {
      title: title(definition.name),
      description: definition.description,
      inputSchema: fromJsonSchema(mcpToolInputJsonSchemas[definition.name]),
      outputSchema: fromJsonSchema(objectRootOutputSchema(definition.name))
    }, async (rawInput): Promise<CallToolResult> => {
      const input = parseMcpToolInput(definition.name, rawInput);
      const callId = randomUUID();
      trace?.({ kind: 'call', callId, tool: definition.name, input });
      // Reconnect before dispatch when discovery changes. Never retry a dispatched mutation.
      await ensureConnection();
      const result = await remoteClient!.callTool({
        name: definition.name,
        arguments: input as Record<string, unknown>
      });
      try { trace?.({ kind: 'result', callId, tool: definition.name, result: result.structuredContent ?? null, isError: result.isError ?? false }); }
      catch (error) { console.error('Demo trace write failed after MCP execution:', error instanceof Error ? error.message : String(error)); }
      if (!result.isError && result.structuredContent !== undefined) {
        parseMcpToolOutput(definition.name, result.structuredContent);
      }
      // Rebuild the result instead of forwarding the remote server's `_meta`.
      // The stdio server adds its own server metadata and otherwise preserves
      // the broker's content and structured output byte-for-byte.
      return {
        content: result.content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        ...(result.isError === undefined ? {} : { isError: result.isError })
      };
    });
  }

  const stdioTransport = new StdioServerTransport();
  try {
    await server.connect(stdioTransport);
  } catch (error) {
    await remoteClient!.close();
    throw error;
  }

  let closing: Promise<void> | null = null;
  return {
    close: () => {
      closing ??= Promise.allSettled([server.close(), remoteClient!.close()]).then((results) => {
        const rejection = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (rejection) throw rejection.reason;
      });
      return closing;
    }
  };
}
