import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RealWorldRunManifestSchema } from './run-manifest.schema.js';

type Role = 'A' | 'B' | 'C';
interface Instruction { revision: number; scenario: string; actions: Action[]; stop?: boolean }
type Action =
  | { type: 'dispatch'; sessionKey?: string; operation: string; parameters?: unknown; idempotencyClass?: string; waitMs?: number; deadlineMs?: number; idempotencyKey?: string }
  | { type: 'acquire'; sessionKey: string; ttlMs?: number; waitMs?: number }
  | { type: 'release'; sessionKey: string }
  | { type: 'sleep'; ms: number };

const arg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
};
const runId = arg('run-id');
const role = arg('role') as Role | undefined;
if (!runId || !role || !['A', 'B', 'C'].includes(role)) throw new Error('--run-id and --role=A|B|C are required.');
const root = resolve('artifacts', 'real-world', runId);
const manifest = RealWorldRunManifestSchema.parse(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')));
const agent = manifest.agents.find((candidate) => candidate.role === role)!;
const token = readFileSync(agent.tokenFile, 'utf8').trim();
const client = new Client({ name: `real-world-agent-${role}`, version: manifest.brokerVersion }, { versionNegotiation: { mode: 'auto' } });
await client.connect(new StreamableHTTPClientTransport(new URL(manifest.mcpUrl), { requestInit: { headers: { 'x-octopus-contract-version': '5', Authorization: `Bearer ${token}` } } }));
const myBinding = await callMcp('get_my_binding', {});
const bindingRef = String(myBinding.bindingRef);
const sessions = new Map<string, string>();
const readyPath = resolve(root, 'ready', `${role}.json`);
writeFileSync(readyPath, JSON.stringify({ role, readyAt: new Date().toISOString() }));
console.error(`Agent ${role} READY; waiting for coordinator instructions.`);

async function callMcp(name: string, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: argumentsValue });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
  return result.structuredContent as Record<string, unknown>;
}
const call = callMcp;
const waitCommand = async (commandId: string): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const command = await call('get_command', { bindingRef, commandId });
    if (['SUCCEEDED', 'FAILED', 'REJECTED', 'TIMED_OUT', 'UNKNOWN_OUTCOME'].includes(String(command.state))) return command;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${commandId}`);
};

let revision = 0;
let running = true;
while (running) {
  const instructionPath = resolve(root, 'instructions', `${role}.json`);
  if (!existsSync(instructionPath)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    continue;
  }
  const instruction = JSON.parse(readFileSync(instructionPath, 'utf8')) as Instruction;
  if (instruction.revision <= revision) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    continue;
  }
  revision = instruction.revision;
  const results: unknown[] = [];
  try {
    for (const action of instruction.actions) {
      if (action.type === 'acquire') {
        const result = await call('acquire_session', { bindingRef, ttlMs: action.ttlMs ?? 60_000, waitMs: action.waitMs ?? 0 });
        sessions.set(action.sessionKey, String(result.sessionHandle));
        results.push(result);
      } else if (action.type === 'release') {
        const handle = sessions.get(action.sessionKey);
        if (!handle) throw new Error(`Missing session key ${action.sessionKey}`);
        results.push(await call('release_session', { bindingRef, sessionHandle: handle }));
        sessions.delete(action.sessionKey);
      } else if (action.type === 'sleep') {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, action.ms));
        results.push({ sleptMs: action.ms });
      } else {
        const receipt = await call('dispatch', {
          runId,
          bindingRef,
          ...(action.sessionKey ? { sessionHandle: sessions.get(action.sessionKey) } : {}),
          operation: action.operation,
          parameters: action.parameters ?? {},
          idempotencyClass: action.idempotencyClass ?? 'read',
          waitMs: action.waitMs ?? 0,
          deadlineMs: action.deadlineMs ?? 30_000,
          ...(action.idempotencyKey ? { idempotencyKey: action.idempotencyKey } : {})
        });
        results.push({ receipt, command: await waitCommand(String(receipt.commandId)) });
      }
    }
    running = !instruction.stop;
    atomicWrite(resolve(root, 'results', `${role}-${revision}.json`), { role, revision, scenario: instruction.scenario, status: 'PASS', results });
  } catch (error) {
    atomicWrite(resolve(root, 'results', `${role}-${revision}.json`), { role, revision, scenario: instruction.scenario, status: 'FAIL', error: error instanceof Error ? error.message : 'unknown' });
  }
}
await client.close();

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}
