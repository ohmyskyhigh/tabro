import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readBrokerRuntime } from '../apps/shared/protocol/src/runtime-discovery.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startDemoFixture } from '../tests/demo/fixture-server.js';
import { assertFreshProbeRoot } from './lib/chrome-probe-control.js';
import { validateProbeRunId } from '../tests/helpers/managed-chrome-probe-fixture.js';

const arg = (key: string) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const runId = arg('run-id') ?? ''; validateProbeRunId(runId);
const root = resolve('artifacts/real-world', runId, 'single-agent-demo');
assertFreshProbeRoot(root); mkdirSync(root, { recursive: true });
const runtimeFile = resolve(arg('runtime-file') ?? '.relay-data/runtime.json');
if (!arg('runtime-file')) execFileSync('powershell.exe', ['-NoProfile', '-File', resolve('tools/start-local-broker.ps1')], { stdio: ['ignore', 'pipe', 'inherit'] });
const runtime = readBrokerRuntime(runtimeFile);
const tokenFile = resolve(arg('token-file') ?? '.relay-data/admin-token.txt');
// Validate access to the credential without copying its contents into Demo artifacts.
if (readFileSync(tokenFile, 'utf8').trim().length < 16) throw new Error('Invalid Broker token file.');
const fixture = await startDemoFixture({ runId, outputRoot: root, port: Number(arg('port') ?? 0) });
const manifest = { version: 1, runId, pid: process.pid, startedAt: new Date().toISOString(), fixtureUrl: fixture.url,
  runtimeFile, brokerPid: runtime.processId, mcpUrl: runtime.mcpUrl, tokenFile, root, traceRoot: resolve(root, 'trace'), runtimeSession: `single-agent-${runId}`,
  task: 'In three independent Profiles, sign in as Alice, Bob and Carol. For each account choose its earliest due open task, write "Reviewed by <role>" and complete it. Process all three tasks before requesting the three summaries. After all summaries finish, stop and reopen Bob and verify the same login, completed task, note and summary.' };
writeFileSync(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ status: 'ready', manifest: resolve(root, 'manifest.json'), fixtureUrl: fixture.url, mcpUrl: manifest.mcpUrl, pid: process.pid }));
let closing = false;
const close = async () => { if (closing) return; closing = true; await fixture.close(); };
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
