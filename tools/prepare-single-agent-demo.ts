import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRelayApplication } from '../apps/broker/src/runtime/bootstrap.js';
import { loadConfig } from '../apps/broker/src/runtime/config.js';
import { extensionDigest, type ProfileRuntimeConfig } from '../apps/broker/src/profiles/runtime-config.js';
import { startDemoFixture } from '../tests/demo/fixture-server.js';
import { assertFreshProbeRoot } from './lib/chrome-probe-control.js';
import { validateProbeRunId } from '../tests/helpers/managed-chrome-probe-fixture.js';

const arg = (key: string) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const runId = arg('run-id') ?? ''; validateProbeRunId(runId);
const root = resolve('artifacts/real-world', runId, 'single-agent-demo');
assertFreshProbeRoot(root); mkdirSync(root, { recursive: true });
const tokenFile = resolve(root, 'broker-token.txt');
const token = randomBytes(32).toString('base64url'); writeFileSync(tokenFile, token, { flag: 'wx', mode: 0o600 });
const runtime: ProfileRuntimeConfig = { root: resolve(root, 'managed'), executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  extensionSource: resolve('dist/browser-extension'), expectedBrowserVersion: '153.0.8010.53', expectedExtensionDigest: extensionDigest(resolve('dist/browser-extension')), relayUrl: 'ws://127.0.0.1:1/relay' };
const app = createRelayApplication({ ...loadConfig({ RELAY_DB_PATH: resolve(root, 'broker.sqlite'), RELAY_MCP_PORT: '0', RELAY_WS_PORT: '0', RELAY_ADMIN_TOKEN: token, RELAY_LOG_LEVEL: 'silent' }), profiles: runtime });
const fixture = await startDemoFixture({ runId, outputRoot: root, port: Number(arg('port') ?? 7341) });
try { await app.start(); } catch (error) { await fixture.close(); await app.stop(); throw error; }
runtime.relayUrl = `ws://127.0.0.1:${app.extensionGateway.address().port}/relay`;
const manifest = { version: 1, runId, pid: process.pid, startedAt: new Date().toISOString(), fixtureUrl: fixture.url,
  mcpUrl: `http://127.0.0.1:${app.mcpGateway.address().port}/mcp`, tokenFile, root, traceRoot: resolve(root, 'trace'), runtimeSession: `single-agent-${runId}`,
  task: 'In three independent Profiles, sign in as Alice, Bob and Carol. For each account choose its earliest due open task, write "Reviewed by <role>" and complete it. Process all three tasks before requesting the three summaries. After all summaries finish, stop and reopen Bob and verify the same login, completed task, note and summary.' };
writeFileSync(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ status: 'ready', manifest: resolve(root, 'manifest.json'), fixtureUrl: fixture.url, mcpUrl: manifest.mcpUrl, pid: process.pid }));
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.stop(); await fixture.close(); };
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
