import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globalAgent } from 'node:https';
import { build } from 'esbuild';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRelayApplication } from '../apps/broker/src/runtime/bootstrap.js';
import { loadConfig } from '../apps/broker/src/runtime/config.js';
import { extensionDigest } from '../apps/broker/src/profiles/runtime-config.js';
import { ProxyCredentialStore } from '../apps/broker/src/proxy/proxy-credential-store.js';
import { chromeProcesses } from '../apps/broker/src/profiles/chrome-launcher.js';
import { ChromeProbeControl } from './lib/chrome-probe-control.js';
import { echoFixture, httpProxyFixture, socksProxyFixture, fixtureCert } from '../tests/helpers/proxy-fixtures.js';
import type { ProfileRuntimeConfig } from '../apps/broker/src/profiles/runtime-config.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object'); return value as Json; };
async function until<T>(check: () => T | null | Promise<T | null>, label: string, timeout = 60_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value !== null) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${label}`);
}
if (process.platform !== 'win32') throw new Error('This qualification requires Windows Chrome and the installed Native Messaging host.');
const base = JSON.parse(readFileSync('.relay-data/managed-profiles.json', 'utf8')) as ProfileRuntimeConfig;
if (!existsSync(base.executablePath)) throw new Error('Configured Chrome is missing.');
const root = resolve('artifacts/real-world', `profile-proxy-${Date.now()}`);
const extensionDir = resolve(root, 'extension'); const userData = resolve(root, 'user-data');
mkdirSync(extensionDir, { recursive: true }); mkdirSync(userData);
const checks: Json[] = []; const report: Json = { root, started_at: new Date().toISOString(), checks, status: 'running' };
const pass = (name: string, details: Json = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`); };
const echo = await echoFixture('{"ip":"203.0.113.61"}');
const http = await httpProxyFixture(false, '{"ip":"203.0.113.61"}');
const https = await httpProxyFixture(true, '{"ip":"203.0.113.62"}');
const socks = await socksProxyFixture(echo.port);
const ca = globalAgent.options.ca; globalAgent.options.ca = fixtureCert;
const config = loadConfig({ RELAY_DB_PATH: resolve(root, 'broker.sqlite'), RELAY_ADMIN_TOKEN: randomBytes(32).toString('base64url'), RELAY_LOG_LEVEL: 'silent' });
config.profiles = { ...base, root: resolve(root, 'managed'), extensionSource: extensionDir, expectedExtensionDigest: '0'.repeat(64), relayUrl: 'ws://127.0.0.1:0/relay' };
const nativeName = `io.github.ohmyskyhigh.tabro_proxy_probe_${process.pid}`;
const nativeRegistry = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${nativeName}`;
const nativeExecutable = resolve(root, 'relay-native-host.exe');
copyFileSync('dist/native-host/relay-native-host-dynamic.exe', nativeExecutable);
const nativeManifest = resolve(root, 'native.json');
writeFileSync(nativeManifest, JSON.stringify({ name: nativeName, description: 'Isolated Tabro proxy qualification', path: nativeExecutable, type: 'stdio', allowed_origins: ['chrome-extension://caekiojlchhifdomfghejkbfpmaklafe/'] }));
execFileSync('reg.exe', ['add', nativeRegistry, '/ve', '/t', 'REG_SZ', '/d', nativeManifest, '/f'], { windowsHide: true, stdio: 'ignore' });
let app = createRelayApplication(config); let client: Client | null = null;
let control: ChromeProbeControl | null = null; let browser: ChildProcess | null = null; let brokerProfile = '';

async function connectClient(session: string) {
  const next = new Client({ name: 'profile-proxy-qualification', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await next.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.mcpPort}/mcp`), { requestInit: { headers: {
    'x-octopus-contract-version': '5', Authorization: `Bearer ${config.adminToken}`, 'x-octopus-runtime': 'proxy-probe', 'x-octopus-runtime-session': session
  } } })); return next;
}
async function call(tool: string, args: Json, using = client!): Promise<Json> {
  const reply = await using.callTool({ name: tool, arguments: args });
  const structured = object(reply.structuredContent);
  const value = structured.result && typeof structured.result === 'object' ? object(structured.result) : structured;
  if (reply.isError || value.disposition === 'rejected') throw new Error(`${tool}: ${JSON.stringify(value)}`);
  return value;
}
async function execute(tool: string, args: Json, using = client!): Promise<Json> {
  const accepted = await call(tool, args, using); const ref = object(object(accepted.facts).ticket).request_ref;
  const ticket = await until(async () => {
    const ticket = object(object((await call('get_browser_request', { request_ref: ref }, using)).facts).ticket);
    return ['succeeded', 'failed', 'uncertain'].includes(String(ticket.state)) ? ticket : null;
  }, `${tool} ticket`, 150_000);
  if (ticket.state !== 'succeeded') throw new Error(`${tool}: ${JSON.stringify(ticket)}`);
  await call('close_browser_request', { request_ref: ref }, using);
  return object(object(ticket.result).facts);
}
async function configure(ref: string, scheme: string, upstreamPort: number, credentialRef: string, key: string) {
  await execute('stop_browser_profile', { profile_ref: ref });
  const revision = app.store.proxies.get(ref).revision;
  const result = await execute('set_browser_proxy', { profile_ref: ref, expected_revision: revision, idempotency_key: key, proxy: { scheme, host: '127.0.0.1', port: upstreamPort, credential_ref: credentialRef } });
  if (app.store.profiles.currentInstance(ref) || object(object(result.proxy).application).state !== 'pending_connection') throw new Error('Saving proxy unexpectedly opened or applied a browser');
  await execute('open_browser_profile', { profile_ref: ref });
  return result;
}
try {
  await app.start(); config.mcpPort = app.mcpGateway.address().port; config.wsPort = app.extensionGateway.address().port;
  const relayUrl = `ws://127.0.0.1:${config.wsPort}/relay`;
  writeFileSync(resolve(root, 'relay-runtime.json'), JSON.stringify({ schemaVersion: 1, instanceRef: app.instanceRef, processId: process.pid, startedAt: new Date().toISOString(), mcpUrl: `http://127.0.0.1:${config.mcpPort}/mcp`, relayUrl, databasePath: config.dbPath }));
  const probeUrl = `http://echo.proxy.test:${echo.port}/ip`;
  await build({ entryPoints: { 'service-worker': 'apps/browser-extension/src/service-worker.ts', options: 'apps/browser-extension/src/options.ts' }, outdir: extensionDir,
    bundle: true, format: 'esm', target: 'chrome116', logLevel: 'silent', plugins: [{ name: 'isolated-proxy-fixture', setup(builder) {
      builder.onLoad({ filter: /browser-extension[\\/]src[\\/]config\.ts$/ }, args => ({ contents: readFileSync(args.path, 'utf8').replace("'ws://127.0.0.1:7332/relay'", JSON.stringify(relayUrl)), loader: 'ts' }));
      builder.onLoad({ filter: /relay-transport\.ts$/ }, args => ({ contents: readFileSync(args.path, 'utf8').replace("'io.github.ohmyskyhigh.octopus_browser_relay'", JSON.stringify(nativeName)), loader: 'ts' }));
      builder.onLoad({ filter: /proxy-controller\.ts$/ }, args => ({ contents: readFileSync(args.path, 'utf8').replace("'https://api.ipify.org?format=json'", JSON.stringify(probeUrl)), loader: 'ts' }));
    } }] });
  const manifest = JSON.parse(readFileSync('apps/browser-extension/manifest.json', 'utf8')) as { host_permissions: string[] };
  manifest.host_permissions.push('http://echo.proxy.test/*');
  writeFileSync(resolve(extensionDir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(resolve(extensionDir, 'options.html'), readFileSync('apps/browser-extension/options.html'));
  config.profiles.expectedExtensionDigest = extensionDigest(extensionDir);
  client = await connectClient('agent-one');
  const principal = app.store.authenticateAgent(config.adminToken)!;
  const credential = await new ProxyCredentialStore(resolve(root, 'proxy-credentials')).provision({ username: 'fixture-user', password: 'fixture:p@ss/#' }, principal.principalId);
  const created = await execute('create_browser_profile', { idempotency_key: 'proxy-probe-create-1' });
  brokerProfile = String(object(created.profile).profile_ref);
  pass('broker-owned-profile-native-ready', { profile_ref: brokerProfile });

  browser = spawn(base.executablePath, [`--user-data-dir=${userData}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--disable-background-mode', '--headless=new', '--host-resolver-rules=MAP echo.proxy.test 127.0.0.1', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const url = await until(() => {
    const file = resolve(userData, 'DevToolsActivePort'); if (!existsSync(file)) return null;
    const [port, path] = readFileSync(file, 'utf8').trim().split(/\r?\n/u); return port && path ? `ws://127.0.0.1:${port}${path}` : null;
  }, 'user Chrome management port');
  control = await ChromeProbeControl.connect(url);
  await control.send('Extensions.loadUnpacked', { path: extensionDir });
  const userProfile = await until(() => {
    const endpoint = app.store.canonical.logical.scanLogicalRecovery().endpoints.find(e => !app.store.profiles.forEndpoint(e.endpointRef) && app.extensionGateway.connection(e.endpointRef)?.profileProxy);
    return endpoint?.endpointRef ?? null;
  }, 'user-owned Native Messaging endpoint');
  pass('user-owned-profile-native-ready', { profile_ref: userProfile });

  for (const online of [true, false]) {
    for (const tool of ['set_browser_proxy', 'clear_browser_proxy']) {
      const args = { profile_ref: userProfile, expected_revision: 0, idempotency_key: `reject-user-${online}-${tool}`,
        ...(tool === 'set_browser_proxy' ? { proxy: { scheme: 'http', host: '127.0.0.1', port: http.port, credential_ref: credential } } : {}) };
      const reply = await client.callTool({ name: tool, arguments: args });
      if (object(object(reply.structuredContent).problem).code !== 'PROFILE_USER_OWNED') throw new Error('User-owned proxy mutation was accepted');
    }
    pass(`user-owned-proxy-rejected-${online ? 'connected' : 'disconnected'}`);
    if (online) {
      if (app.store.proxies.get(userProfile).revision !== 0 || browser.exitCode !== null) throw new Error('Rejected user mutation changed Chrome');
      await control!.send('Browser.close'); await control!.disconnect(); control = null;
      await until(() => browser!.exitCode !== null && !app.extensionGateway.connection(userProfile)?.connected ? true : null, 'manual browser exit');
    }
  }
  const idleRejected = await client.callTool({ name: 'set_browser_proxy', arguments: { profile_ref: brokerProfile, expected_revision: 0, idempotency_key: 'reject-open-managed', proxy: { scheme: 'http', host: '127.0.0.1', port: http.port } } });
  if (object(object(idleRejected.structuredContent).problem).code !== 'PROFILE_IN_USE') throw new Error('Idle but open managed Profile accepted proxy change');
  pass('open-managed-profile-rejected-without-workspaces');

  for (const [scheme, upstream, ip] of [['http', http, '203.0.113.61'], ['https', https, '203.0.113.62'], ['socks5', socks, '203.0.113.61']] as const) {
    await configure(brokerProfile, scheme, upstream.port, credential, `managed-${scheme}-proxy`);
    const checked = await execute('check_browser_proxy', { profile_ref: brokerProfile, expected_revision: app.store.proxies.get(brokerProfile).revision });
    if (object(object(checked.proxy).exit).ip !== ip || upstream.count() < 1) throw new Error('Browser probe did not reach the authenticated upstream fixture');
    pass(`closed-configure-open-${scheme}-authenticated`, { observed_fixture_ip: ip });
  }
  if (!socks.hosts.includes('echo.proxy.test')) throw new Error('SOCKS destination DNS was not forwarded');
  const wrong = await new ProxyCredentialStore(resolve(root, 'proxy-credentials')).provision({ username: 'fixture-user', password: 'wrong-fixture-password' }, principal.principalId);
  await configure(brokerProfile, 'http', http.port, wrong, 'managed-invalid-auth');
  let authenticationFailed = false;
  try { await execute('check_browser_proxy', { profile_ref: brokerProfile, expected_revision: app.store.proxies.get(brokerProfile).revision }); }
  catch (error) { authenticationFailed = error instanceof Error && error.message.includes('PROXY_CHECK_FAILED'); }
  if (!authenticationFailed) throw new Error('Invalid credentials passed the browser check');
  pass('browser-auth-failure-reported');
  await configure(brokerProfile, 'socks5', socks.port, credential, 'restore-managed-socks');
  const second = await connectClient('agent-two');
  try {
    const alias = app.store.canonical.logical.getEndpoint(app.store.profiles.get(brokerProfile)!.endpointRef!)!.nickname;
    const acquired = await execute('request_browser_workspace', { required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: alias }] });
    const workspace = object((acquired.resolved as Json[])[0]!.workspace).workspace_ref;
    const rejected = await second.callTool({ name: 'clear_browser_proxy', arguments: { profile_ref: brokerProfile, expected_revision: app.store.proxies.get(brokerProfile).revision, idempotency_key: 'concurrent-clear-1' } });
    if (object(object(rejected.structuredContent).problem).code !== 'PROFILE_HAS_ACTIVE_WORK') throw new Error('Concurrent agent changed an active Profile');
    await execute('terminate_workspace', { workspace_ref: workspace });
    pass('second-agent-cannot-change-active-profile');
  } finally { await second.close(); }
  await execute('stop_browser_profile', { profile_ref: brokerProfile });
  await execute('open_browser_profile', { profile_ref: brokerProfile });
  await execute('check_browser_proxy', { profile_ref: brokerProfile, expected_revision: app.store.proxies.get(brokerProfile).revision });
  pass('broker-owned-reopen-preserves-proxy');
  const listenerPort = app.store.proxies.get(brokerProfile).port;
  control = await ChromeProbeControl.connect(app.store.profiles.currentInstance(brokerProfile)!.managementUrl!);
  await client.close(); client = null; await app.stop();
  const workers = (await control.send('Target.getTargets')).targetInfos as Json[];
  const worker = workers.find(t => t.type === 'service_worker')!;
  const workerSession = String((await control.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId);
  const outageProbe = await control.send('Runtime.evaluate', { expression: `fetch('http://echo.proxy.test:${echo.port}/outage', {signal:AbortSignal.timeout(4000)}).then(()=>false,()=>true)`, awaitPromise: true, returnByValue: true }, workerSession);
  if (object(outageProbe.result).value !== true) throw new Error('Browser request unexpectedly succeeded during Broker outage');
  pass('broker-outage-blocks-browser-request');
  await control.disconnect(); control = null;
  app = createRelayApplication(config); await app.start(); client = await connectClient('agent-one');
  await until(() => app.network.ready(brokerProfile) ? true : null, 'proxy reconciliation after Broker restart');
  if (app.store.proxies.get(brokerProfile).port !== listenerPort) throw new Error('Listener changed after restart');
  await execute('check_browser_proxy', { profile_ref: brokerProfile, expected_revision: app.store.proxies.get(brokerProfile).revision });
  pass('broker-restart-reclaims-listener-and-reconciles-extension');
  const before = app.store.profiles.currentInstance(brokerProfile)!.instanceRef;
  await execute('stop_browser_profile', { profile_ref: brokerProfile });
  const cleared = await execute('clear_browser_proxy', { profile_ref: brokerProfile, expected_revision: app.store.proxies.get(brokerProfile).revision, idempotency_key: 'clear-closed-managed' });
  if (app.store.profiles.currentInstance(brokerProfile) || object(object(cleared.proxy).application).state !== 'pending_connection') throw new Error('Clearing proxy unexpectedly opened or applied Chrome');
  await execute('open_browser_profile', { profile_ref: brokerProfile });
  const opened = app.store.profiles.currentInstance(brokerProfile)!;
  const browserProcess = (await chromeProcesses()).find(row => row.pid === opened.pid);
  if (opened.instanceRef === before || !browserProcess || browserProcess.commandLine.includes('--proxy-server=') || app.store.proxies.get(brokerProfile).state !== 'unmanaged') throw new Error('Explicit reopen did not release the proxy');
  pass('closed-clear-stays-closed-and-next-open-removes-proxy');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.stack : 'Unknown error'; process.exitCode = 1;
  console.error(report.error);
  report.fixture_counts = { http: http.count(), https: https.count(), socks: socks.count(), echo: echo.requests };
  if (control) {
    const targets: Json = await control.send('Target.getTargets').catch(() => ({}));
    for (const target of (targets.targetInfos as Json[] ?? []).filter(t => t.type === 'service_worker')) {
      const session = await control.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const expression = `Promise.all([chrome.proxy.settings.get({incognito:false}), fetch('http://echo.proxy.test:${echo.port}/ip').then(async r=>({status:r.status,body:await r.text()})).catch(e=>({error:e.message}))])`;
      report.browser_diagnostic = await control.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, String(session.sessionId));
    }
    console.error(JSON.stringify({ fixture_counts: report.fixture_counts, diagnostic: report.browser_diagnostic }));
  }
} finally {
  if (client && brokerProfile) await execute('stop_browser_profile', { profile_ref: brokerProfile }).catch(() => {});
  for (const profile of app.store.profiles.all()) {
    if (app.store.profiles.currentInstance(profile.profileRef)) await app.profileManager?.run('stop_browser_profile', profile).catch(() => {});
  }
  if (control) { await control.send('Browser.close').catch(() => {}); await control.disconnect(); }
  await client?.close(); await app.stop().catch(() => {});
  await http.close(); await https.close(); await socks.close(); await echo.close(); globalAgent.options.ca = ca;
  execFileSync('reg.exe', ['delete', nativeRegistry, '/f'], { windowsHide: true, stdio: 'ignore' });
  report.finished_at = new Date().toISOString(); writeFileSync(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${resolve(root, 'report.json')}`);
}
