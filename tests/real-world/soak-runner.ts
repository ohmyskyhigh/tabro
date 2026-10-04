import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { RealWorldRunManifestSchema, type RealWorldRunManifest } from './run-manifest.schema.js';
import { verifyRealWorldRun } from './trace-verifier.js';

const arg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
};

const baseRunId = arg('run-id');
if (!baseRunId) throw new Error('--run-id is required.');
const durationMinutes = Number(arg('duration-minutes') ?? '30');
const batchDelayMs = Number(arg('batch-delay-ms') ?? '1000');
if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error('--duration-minutes must be positive.');
if (!Number.isFinite(batchDelayMs) || batchDelayMs < 100) throw new Error('--batch-delay-ms must be at least 100.');

const root = resolve('artifacts', 'real-world', baseRunId);
const manifest = RealWorldRunManifestSchema.parse(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')));
const soakRunId = `${baseRunId}-soak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const clients: Client[] = [];
const bindings: Array<{ bindingRef: string; target: RealWorldRunManifest['targets'][number] }> = [];
const terminalStates = new Set(['SUCCEEDED', 'FAILED', 'REJECTED', 'TIMED_OUT', 'UNKNOWN_OUTCOME']);
const durations: number[] = [];
const failures: string[] = [];
let commandCount = 0;
let batchCount = 0;

const call = async (client: Client, name: string, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name, arguments: argumentsValue });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
  return result.structuredContent as Record<string, unknown>;
};

const waitCommand = async (client: Client, bindingRef: string, commandId: string): Promise<Record<string, unknown>> => {
  const startedAt = Date.now();
  const deadline = startedAt + 30_000;
  while (Date.now() < deadline) {
    const command = await call(client, 'get_command', { bindingRef, commandId });
    if (terminalStates.has(String(command.state))) {
      durations.push(Date.now() - startedAt);
      return command;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${commandId}`);
};

const findMarker = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.title === 'string' && /^fixture-[A-C]$/.test(object.title)) return object.title;
  for (const candidate of [object.document, object.tab]) {
    const marker = findMarker(candidate);
    if (marker) return marker;
  }
  if (Array.isArray(object.tabs)) {
    for (const tab of object.tabs) {
      const marker = findMarker(tab);
      if (marker) return marker;
    }
  }
  return undefined;
};

const percentile = (values: number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
};

try {
  for (const agent of manifest.agents) {
    const token = readFileSync(agent.tokenFile, 'utf8').trim();
    const client = new Client({ name: `soak-agent-${agent.role}`, version: manifest.brokerVersion }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(manifest.mcpUrl), {
      requestInit: { headers: { 'x-octopus-contract-version': '5', Authorization: `Bearer ${token}` } }
    }));
    clients.push(client);
    const binding = await call(client, 'get_my_binding', {});
    const target = manifest.targets.find((candidate) => candidate.alias === binding.targetAlias);
    if (!target) throw new Error(`Agent ${agent.role} has unexpected binding target ${String(binding.targetAlias)}`);
    bindings.push({ bindingRef: String(binding.bindingRef), target });
  }

  const startedAt = Date.now();
  const endAt = startedAt + durationMinutes * 60_000;
  let nextProgressAt = startedAt + 60_000;
  while (Date.now() < endAt && failures.length === 0) {
    const currentBatch = batchCount++;
    await Promise.all(clients.map(async (client, agentIndex) => {
      const owned = bindings[agentIndex]!;
      const target = owned.target;
      const operation = (currentBatch + agentIndex) % 2 === 0 ? 'snapshot' : 'list_tabs';
      const receipt = await call(client, 'dispatch', {
        runId: soakRunId,
        bindingRef: owned.bindingRef,
        operation,
        parameters: {},
        idempotencyClass: 'read',
        idempotencyKey: `${soakRunId}-${agentIndex}-${currentBatch}`,
        waitMs: 5_000,
        deadlineMs: 30_000
      });
      const command = await waitCommand(client, owned.bindingRef, String(receipt.commandId));
      commandCount += 1;
      if (command.state !== 'SUCCEEDED') {
        failures.push(`${target.alias} ${operation} ended in ${String(command.state)}`);
        return;
      }
      const result = command.result as { output?: unknown } | undefined;
      const observedMarker = findMarker(result?.output);
      if (observedMarker !== target.marker) failures.push(`${target.alias} returned ${String(observedMarker)} instead of ${target.marker}`);
    }));

    if (Date.now() >= nextProgressAt) {
      const targets = await call(clients[0]!, 'list_targets', {});
      console.log(JSON.stringify({
        event: 'progress',
        soakRunId,
        elapsedMinutes: Number(((Date.now() - startedAt) / 60_000).toFixed(1)),
        commands: commandCount,
        failures: failures.length,
        commandLatencyP95Ms: percentile(durations, 0.95),
        targets: targets.targets
      }));
      nextProgressAt += 60_000;
    }

    const remainingDelay = Math.min(batchDelayMs, Math.max(0, endAt - Date.now()));
    if (remainingDelay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, remainingDelay));
  }

  const store = new SqliteRelayStore(manifest.dbPath);
  const commands = store.listCommandsByRunId(soakRunId);
  const events = store.listTrace(soakRunId);
  const traceReport = verifyRealWorldRun({ ...manifest, runId: soakRunId }, commands, events);
  store.close();

  const finishedAt = Date.now();
  const report = {
    status: failures.length === 0 && traceReport.status === 'PASS' ? 'PASS' : 'FAIL',
    soakRunId,
    durationMinutes: Number(((finishedAt - startedAt) / 60_000).toFixed(2)),
    batchCount,
    commandCount,
    successfulCommands: traceReport.successfulCommands,
    commandLatencyP95Ms: percentile(durations, 0.95),
    ackLatencyP95Ms: traceReport.ackLatencyP95Ms,
    failures,
    traceFindings: traceReport.findings
  };
  const reportDir = resolve(root, 'soak');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(resolve(reportDir, `${soakRunId}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: 'complete', ...report }, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
}
