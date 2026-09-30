import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RealWorldRunManifestSchema } from './run-manifest.schema.js';

const arg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
};
const runId = arg('run-id');
if (!runId) throw new Error('--run-id is required.');
const root = resolve('artifacts', 'real-world', runId);
const manifest = RealWorldRunManifestSchema.parse(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')));
const findings: string[] = [];

for (const url of [`${manifest.fixtureBaseUrl}/health`, manifest.mcpUrl.replace('/mcp', '/health')]) {
  try {
    const response = await fetch(url);
    if (!response.ok) findings.push(`${url} returned HTTP ${response.status}`);
  } catch {
    findings.push(`${url} is not reachable`);
  }
}

let targets: Array<Record<string, unknown>> = [];
let bindings: Array<Record<string, unknown>> = [];
if (!existsSync(manifest.adminTokenFile)) findings.push('Admin token file is missing');
else {
  const adminToken = readFileSync(manifest.adminTokenFile, 'utf8').trim();
  const client = new Client({ name: 'real-world-preflight', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(manifest.mcpUrl), { requestInit: { headers: { 'x-octopus-contract-version': '2', Authorization: `Bearer ${adminToken}` } } }));
    const result = await client.callTool({ name: 'list_targets', arguments: {} });
    targets = ((result.structuredContent as { targets?: Array<Record<string, unknown>> } | undefined)?.targets ?? []);
    const listedBindings = await client.callTool({ name: 'list_bindings', arguments: {} });
    if (listedBindings.isError) throw new Error(JSON.stringify(listedBindings.structuredContent ?? listedBindings.content));
    bindings = ((listedBindings.structuredContent as { bindings?: Array<Record<string, unknown>> } | undefined)?.bindings ?? []);
    if (manifest.targets.every((expected) => targets.some((target) => target.alias === expected.alias))) {
      for (const [index, agent] of manifest.agents.entries()) {
        const expectedTarget = manifest.targets[index]!;
        const existing = bindings.find((binding) => binding.principalId === agent.principalId);
        if (existing && existing.targetAlias !== expectedTarget.alias) {
          findings.push(`${agent.role} is bound to ${String(existing.targetAlias)}, expected ${expectedTarget.alias}`);
          continue;
        }
        if (!existing) {
          findings.push(`${agent.role} has no binding to ${expectedTarget.alias}; preflight is read-only and did not create one`);
        }
      }
    }
  } catch (error) {
    findings.push(`MCP preflight failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    await client.close();
  }
}

for (const expected of manifest.targets) {
  const target = targets.find((candidate) => candidate.alias === expected.alias);
  if (!target) findings.push(`${expected.alias} is not paired`);
  else if (target.status !== 'available') findings.push(`${expected.alias} status is ${String(target.status)}, expected available`);
}

const readyRoles = manifest.agents.filter((agent) => existsSync(resolve(root, 'ready', `${agent.role}.json`))).map((agent) => agent.role);
const checkpoint = arg('checkpoint') ?? 'U1';
if (checkpoint === 'U2' && readyRoles.length !== manifest.agents.length) findings.push(`Only ${readyRoles.length}/${manifest.agents.length} Codex task roles are ready`);

if (findings.length > 0) {
  console.log(JSON.stringify({ status: 'ENVIRONMENT_NOT_READY', checkpoint, findings, readyRoles }, null, 2));
  process.exitCode = 10;
} else {
  console.log(JSON.stringify({ status: 'READY', checkpoint, targets: targets.map((target) => ({ alias: target.alias, status: target.status })), bindingCount: bindings.length, readyRoles }, null, 2));
}
