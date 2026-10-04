import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RealWorldRunManifestSchema } from './run-manifest.schema.js';

const argument = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
};
const runId = argument('run-id');
const alias = argument('alias');
const output = argument('output');
if (!runId || !alias || !output) throw new Error('--run-id, --alias, and --output are required.');

const root = resolve('artifacts', 'real-world', runId);
const manifest = RealWorldRunManifestSchema.parse(JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')));
if (!manifest.targets.some((target) => target.alias === alias)) throw new Error('Alias is not part of this run.');
const token = readFileSync(manifest.adminTokenFile, 'utf8').trim();
const client = new Client({ name: 'real-world-pairing-rotation', version: manifest.brokerVersion }, { versionNegotiation: { mode: 'auto' } });
await client.connect(new StreamableHTTPClientTransport(new URL(manifest.mcpUrl), {
  requestInit: { headers: { 'x-octopus-contract-version': '5', Authorization: `Bearer ${token}` } }
}));

async function call(name: string, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: argumentsValue });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
  return result.structuredContent as Record<string, unknown>;
}

try {
  const listed = await call('list_targets', {});
  const targets = Array.isArray(listed.targets) ? listed.targets as Array<{ alias?: unknown }> : [];
  if (targets.some((target) => target.alias === alias)) await call('revoke_target', { alias });
  const pairing = await call('pair_target', { alias, expiresInMs: 10 * 60_000 });
  const outputPath = resolve(output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, [
    `# Replacement Pairing Code for ${alias}`,
    '',
    `Pairing code: ${String(pairing.pairingCode)}`,
    '',
    `Expires at: ${String(pairing.expiresAt)}`,
    '',
    'Use this only in the intended profile. Do not paste it into chat.'
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  chmodSync(outputPath, 0o600);
  console.log(JSON.stringify({ status: 'PAIRING_ROTATED', alias, outputPath, expiresAt: pairing.expiresAt }, null, 2));
} finally {
  await client.close();
}
