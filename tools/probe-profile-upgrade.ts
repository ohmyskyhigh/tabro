import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { assertFreshProbeRoot } from './lib/chrome-probe-control.js';
import { extensionDigest } from '../apps/broker/src/profiles/runtime-config.js';
import { validateProbeRunId } from '../tests/helpers/managed-chrome-probe-fixture.js';

// Isolated upgrade/rollback probe, not a substitute for the real single-Agent Demo.
const oldEntry = resolve(process.argv[2]!); const newRoot = resolve(process.argv[3]!);
const runId = process.argv[4] ?? 'profile-upgrade-probe-001'; validateProbeRunId(runId);
const root = resolve('artifacts/real-world', runId); assertFreshProbeRoot(root); mkdirSync(root, { recursive: true });
const database = resolve(root, 'relay.sqlite'); const backup = resolve(root, 'before-upgrade.sqlite');
const token = randomBytes(32).toString('base64url'); const checks: string[] = [];
const config = resolve(root, 'managed.json'); const managedRoot = resolve(root, 'managed');
writeFileSync(config, JSON.stringify({ root: managedRoot, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', extensionSource: resolve(newRoot, 'browser-extension'), expectedBrowserVersion: '153.0.8010.53', expectedExtensionDigest: extensionDigest(resolve(newRoot, 'browser-extension')), relayUrl: 'ws://127.0.0.1:17432/relay' }));
let child: ChildProcess | null = null; let client: Client | null = null; let profileRef: string | null = null; let failure: string | null = null;
async function stop() {
  await client?.close(); client = null;
  const owned = child; child = null;
  if (!owned || owned.exitCode !== null) return;
  await new Promise<void>(done => { owned.once('exit', () => done()); owned.kill(); });
}
async function start(entry: string, managed: boolean) {
  child = spawn(process.execPath, [entry], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
    RELAY_DB_PATH: database, RELAY_ADMIN_TOKEN: token, RELAY_MCP_PORT: '17431', RELAY_WS_PORT: '17432', RELAY_LOG_LEVEL: 'silent', RELAY_PROFILES_CONFIG: managed ? config : '' } });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Broker exited ${child.exitCode}`);
    try { const response = await fetch('http://127.0.0.1:17431/health', { signal: AbortSignal.timeout(300) }); if (response.ok) return await response.json() as Record<string, unknown>; } catch { /* Wait for this owned child to bind. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Broker startup timeout');
}
async function connect() {
  client = new Client({ name: 'isolated-upgrade-probe', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:17431/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}`, 'x-octopus-contract-version': '2', 'x-octopus-runtime': 'probe', 'x-octopus-runtime-session': 'upgrade-probe' } } }));
}
async function call(tool: string, args: Record<string, unknown>) {
  const result = await client!.callTool({ name: tool, arguments: args });
  if (result.isError) throw new Error(`MCP failed: ${tool}`);
  return result.structuredContent as Record<string, unknown>;
}
async function operation(tool: string, args: Record<string, unknown>) {
  const accepted = await call(tool, args); const ticket = (accepted.facts as { ticket: { request_ref: string } }).ticket;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const reply = await call('get_browser_request', { request_ref: ticket.request_ref });
    const current = (reply.facts as { ticket: { state: string; result: { facts: { profile: { profile_ref: string; ready: boolean } } } } }).ticket;
    if (current.state === 'succeeded') return current.result.facts.profile;
    if (['failed','uncertain'].includes(current.state)) throw new Error(`${tool}: ${current.state}`);
    await new Promise(done => setTimeout(done, 300));
  }
  throw new Error(`${tool}: timeout`);
}
try {
  // Refuse occupied ports before spawning; never infer ownership from a health response alone.
  const { createServer } = await import('node:net');
  for (const port of [17431,17432]) { const server = createServer(); await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => server.close(() => ok())); }); }
  const oldHealth = await start(oldEntry, false); await connect();
  if ((await client!.listTools()).tools.length !== 14) throw new Error('Expected 14 old tools');
  checks.push('v0.3.0-starts-with-fourteen-tools'); await stop();
  const oldDb = new DatabaseSync(database); oldDb.prepare('VACUUM INTO ?').run(backup); const principal = oldDb.prepare('SELECT principal_id FROM agents').get()?.principal_id; oldDb.close();
  await start(resolve(newRoot, 'broker/main.mjs'), true); await connect();
  if ((await client!.listTools()).tools.length !== 18) throw new Error('Expected 18 new tools');
  const profile = await operation('create_browser_profile', { display_name: 'Upgrade retained Profile', idempotency_key: 'upgrade-probe-create' }); profileRef = profile.profile_ref;
  if (!profile.ready) throw new Error('Profile not ready');
  await operation('stop_browser_profile', { profile_ref: profileRef }); profileRef = null; await stop();
  const newDb = new DatabaseSync(database);
  if (newDb.prepare('SELECT principal_id FROM agents').get()?.principal_id !== principal) throw new Error('Principal changed');
  const profiles = newDb.prepare('SELECT * FROM managed_profiles').all();
  writeFileSync(resolve(root, 'retained-profile-metadata.json'), JSON.stringify(profiles, null, 2));
  newDb.prepare('VACUUM INTO ?').run(resolve(root, 'after-upgrade.sqlite')); newDb.close();
  checks.push('v2-migration-retains-principal-and-creates-authenticated-profile');
  // All database handles and owned processes are closed before restoring the old snapshot.
  for (const suffix of ['-wal','-shm']) if (existsSync(database + suffix)) rmSync(database + suffix);
  copyFileSync(backup, database);
  await start(oldEntry, false); await connect();
  if ((await client!.listTools()).tools.length !== 14) throw new Error('Rollback tools changed');
  const layout = resolve(managedRoot, 'profiles', String(profiles[0]!.data_dir_key), 'user-data', 'Local State');
  if (!existsSync(layout)) throw new Error('Profile directory lost');
  checks.push('v0.3.0-rollback-starts-from-snapshot-and-keeps-new-profile-directory');
  writeFileSync(resolve(root, 'versions.json'), JSON.stringify({ oldHealth, oldEntry, newRoot }, null, 2));
} catch (error) { failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  if (profileRef && client) { try { await operation('stop_browser_profile', { profile_ref: profileRef }); } catch { checks.push('cleanup-requires-inspection'); } }
  await stop();
  writeFileSync(resolve(root, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, failure }, null, 2));
  console.log(readFileSync(resolve(root, 'report.json'), 'utf8'));
}
