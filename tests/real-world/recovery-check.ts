import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RealWorldRunManifestSchema } from './run-manifest.schema.js';

const arg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
};

const runId = arg('run-id');
const alias = arg('alias');
const marker = arg('marker');
const fixtureUrl = arg('fixture-url');
if (!runId || !alias || !marker || !fixtureUrl) throw new Error('--run-id, --alias, --marker, and --fixture-url are required.');

const root = resolve('artifacts', 'real-world', runId);
const manifest = RealWorldRunManifestSchema.parse(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')));
const agent = manifest.agents[0]!;
const token = readFileSync(agent.tokenFile, 'utf8').trim();
const client = new Client({ name: 'real-world-recovery-check', version: manifest.brokerVersion }, { versionNegotiation: { mode: 'auto' } });
let sessionHandle: string | undefined;
let bindingRef = '';

const call = async (name: string, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name, arguments: argumentsValue });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
  return result.structuredContent as Record<string, unknown>;
};

const dispatchAndWait = async (operation: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const receipt = await call('dispatch', {
    runId,
    bindingRef,
    ...(sessionHandle ? { sessionHandle } : {}),
    operation,
    parameters,
    idempotencyClass: operation === 'snapshot' ? 'read' : 'idempotent-write',
    idempotencyKey: `${runId}-recovery-${operation}-${randomUUID()}`,
    waitMs: 0,
    deadlineMs: 30_000
  });
  const commandId = String(receipt.commandId);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const command = await call('get_command', { bindingRef, commandId });
    if (command.state === 'SUCCEEDED') return command;
    if (['FAILED', 'REJECTED', 'TIMED_OUT', 'UNKNOWN_OUTCOME'].includes(String(command.state))) {
      throw new Error(`${operation} command ended in ${String(command.state)}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${operation} command timed out`);
};

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(manifest.mcpUrl), {
    requestInit: { headers: { 'x-octopus-contract-version': '2', Authorization: `Bearer ${token}` } }
  }));
  const binding = await call('get_my_binding', {});
  bindingRef = String(binding.bindingRef);
  if (binding.targetAlias !== alias) throw new Error(`Agent is bound to ${String(binding.targetAlias)}, not ${alias}`);

  const before = await call('list_targets', {});
  const beforeTargets = (before.targets as Array<Record<string, unknown>> | undefined) ?? [];
  const unavailableBefore = beforeTargets.filter((target) => target.status !== 'available');
  if (unavailableBefore.length > 0) {
    throw new Error(`Targets not available before recovery command: ${unavailableBefore.map((target) => String(target.alias)).join(', ')}`);
  }

  const session = await call('acquire_session', { bindingRef, ttlMs: 30_000, waitMs: 0 });
  sessionHandle = String(session.sessionHandle);
  await dispatchAndWait('open_url', { url: fixtureUrl, active: true });
  let command: Record<string, unknown> | undefined;
  let observedMarker: string | undefined;
  const markerDeadline = Date.now() + 10_000;
  while (Date.now() < markerDeadline) {
    command = await dispatchAndWait('snapshot', {});
    const candidate = command.result as { output?: { document?: { title?: string; text?: string }; tab?: { title?: string; url?: string } } } | undefined;
    observedMarker = candidate?.output?.document?.title ?? candidate?.output?.tab?.title;
    if (observedMarker === marker) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }

  if (observedMarker !== marker) throw new Error(`Wrong profile marker: expected ${marker}, received ${String(observedMarker)}`);
  if (!command) throw new Error('Snapshot command did not complete.');

  await call('release_session', { bindingRef, sessionHandle });
  sessionHandle = undefined;

  const after = await call('list_targets', {});
  const afterTargets = (after.targets as Array<Record<string, unknown>> | undefined) ?? [];
  const unavailableAfter = afterTargets.filter((target) => target.status !== 'available');
  if (unavailableAfter.length > 0) {
    throw new Error(`Targets not available after recovery command: ${unavailableAfter.map((target) => String(target.alias)).join(', ')}`);
  }

  console.log(JSON.stringify({
    status: 'PASS',
    runId,
    targetAlias: alias,
    marker: observedMarker,
    commandState: command.state,
    targets: afterTargets.map((target) => ({ alias: target.alias, status: target.status }))
  }, null, 2));
} finally {
  if (sessionHandle) {
    try {
      await call('release_session', { bindingRef, sessionHandle });
    } catch {
      // The lease may already have expired or been released by the broker.
    }
  }
  await client.close();
}
