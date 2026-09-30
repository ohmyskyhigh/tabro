import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { validateProbeRunId } from '../tests/helpers/managed-chrome-probe-fixture.js';

// Transport harness only: the Agent supplies each tool and its arguments. It never chooses tasks or browser actions.
const runId = process.argv[2] ?? ''; validateProbeRunId(runId);
const root = resolve('artifacts/real-world', runId, 'single-agent-demo');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as { mcpUrl: string; tokenFile: string; traceRoot: string; runtimeSession: string; adapterEntry?: string };
const commands = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as Array<{ tool: string; arguments: Record<string, unknown>; wait?: boolean }>;
const transport = new StdioClientTransport({ command: process.execPath, args: manifest.adapterEntry ? [manifest.adapterEntry] : ['--import', 'tsx', 'apps/mcp-stdio-adapter/src/main.ts'], cwd: process.cwd(), stderr: 'pipe',
  env: { ...getDefaultEnvironment(), OCTOPUS_BROKER_URL: manifest.mcpUrl, OCTOPUS_BROWSER_RELAY_TOKEN_FILE: manifest.tokenFile,
    OCTOPUS_RUNTIME: 'mcp-agent', OCTOPUS_RUNTIME_SESSION: manifest.runtimeSession, OCTOPUS_DEMO_TRACE_ROOT: manifest.traceRoot, OCTOPUS_DEMO_RUN_ID: runId } });
const client = new Client({ name: 'single-agent-demo-tool-transport', version: '1' }, { versionNegotiation: { mode: 'auto' } });
try {
  await client.connect(transport);
  const results = await Promise.all(commands.map(async command => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError) throw new Error(JSON.stringify(response.structuredContent ?? response.content));
      return response.structuredContent as Record<string, unknown>;
    };
    const reply = await call(command.tool, command.arguments);
    if (!command.wait || reply.disposition !== 'accepted') return reply;
    const requestRef = (reply.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const current = await call('get_browser_request', { request_ref: requestRef });
      const ticket = (current.facts as { ticket: { state: string } }).ticket;
      if (['succeeded','failed','uncertain'].includes(ticket.state)) return current;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
    }
    throw new Error(`Ticket still pending: ${requestRef}`);
  }));
  writeFileSync(resolve(root, 'last-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(reply => {
    const ticket = (reply.facts as { ticket?: Record<string, unknown> } | null)?.ticket;
    return ticket ? { request_ref: ticket.request_ref, state: ticket.state, result: ticket.result, failure: ticket.failure, uncertainty: ticket.uncertainty } : reply;
  })));
} finally { await client.close(); await transport.close(); }
