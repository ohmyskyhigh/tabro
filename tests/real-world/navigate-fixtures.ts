import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RealWorldRunManifestSchema } from './run-manifest.schema.js';

const runId = process.argv.find((value) => value.startsWith('--run-id='))?.slice('--run-id='.length);
if (!runId) throw new Error('--run-id is required.');
const root = resolve('artifacts', 'real-world', runId);
const manifest = RealWorldRunManifestSchema.parse(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')));
const token = readFileSync(manifest.adminTokenFile, 'utf8').trim();
const client = new Client({ name: 'real-world-fixture-navigator', version: manifest.brokerVersion }, { versionNegotiation: { mode: 'auto' } });
await client.connect(new StreamableHTTPClientTransport(new URL(manifest.mcpUrl), {
  requestInit: { headers: { 'x-octopus-contract-version': '2', Authorization: `Bearer ${token}` } }
}));

async function call(name: string, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: argumentsValue });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
  return result.structuredContent as Record<string, unknown>;
}

async function dispatch(alias: string, bindingRef: string, operation: string, parameters: unknown, idempotencyClass: 'read' | 'idempotent-write', sessionHandle?: unknown): Promise<Record<string, unknown>> {
  const receipt = await call('dispatch', {
    bindingRef, ...(sessionHandle ? { sessionHandle } : {}), operation, parameters, idempotencyClass, waitMs: 0, deadlineMs: 30_000
  });
  const commandId = String(receipt.commandId);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const command = await call('get_command', { bindingRef, commandId });
    if (command.state === 'SUCCEEDED') return command;
    if (['FAILED', 'REJECTED', 'TIMED_OUT', 'UNKNOWN_OUTCOME'].includes(String(command.state))) {
      throw new Error(`${alias} ${operation} ended in ${String(command.state)}: ${JSON.stringify({ decision: command.decision, result: command.result })}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${alias} ${operation} timed out`);
}

try {
  const listed = await call('list_bindings', {});
  const bindings = (listed.bindings as Array<Record<string, unknown>> | undefined) ?? [];
  const verified: Array<{ alias: string; marker: string }> = [];
  for (const target of manifest.targets) {
    const binding = bindings.find((candidate) => candidate.targetAlias === target.alias);
    if (!binding) throw new Error(`No active binding exists for ${target.alias}`);
    const bindingRef = String(binding.bindingRef);
    const session = await call('acquire_session', { bindingRef, ttlMs: 30_000, waitMs: 5_000 });
    try {
      await dispatch(target.alias, bindingRef, 'navigate', { url: target.fixtureUrl }, 'idempotent-write', session.sessionHandle);
    } finally {
      await call('release_session', { bindingRef, sessionHandle: session.sessionHandle });
    }
    const deadline = Date.now() + 10_000;
    let observedMarker: string | undefined;
    while (Date.now() < deadline && observedMarker !== target.marker) {
      const command = await dispatch(target.alias, bindingRef, 'snapshot', {}, 'read');
      observedMarker = findMarker((command.result as { output?: unknown } | undefined)?.output);
      if (observedMarker !== target.marker) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (observedMarker !== target.marker) throw new Error(`${target.alias} did not load its expected fixture marker.`);
    verified.push({ alias: target.alias, marker: target.marker });
  }
  console.log(JSON.stringify({ status: 'READY', verified }, null, 2));
} finally {
  await client.close();
}

function findMarker(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.title === 'string' && /^fixture-[A-C]$/.test(object.title)) return object.title;
  for (const nested of [object.document, object.tab]) {
    const marker = findMarker(nested);
    if (marker) return marker;
  }
  return undefined;
}
