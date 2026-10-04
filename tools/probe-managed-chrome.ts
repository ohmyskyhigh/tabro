import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRelayApplication, type RelayApplication } from '../apps/broker/src/runtime/bootstrap.js';
import { loadConfig } from '../apps/broker/src/runtime/config.js';
import { startManagedChromeProbeFixture, validateProbeRunId } from '../tests/helpers/managed-chrome-probe-fixture.js';
import { assertFreshProbeRoot, assertProbeConnectionStatus, ChromeProbeControl, probeIdentityHash } from './lib/chrome-probe-control.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object in probe response.');
  return value as Json;
};
const delay = (ms: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, ms));
async function until<T>(observe: () => Promise<T | null> | T | null, label: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await observe();
    if (result !== null) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function runManagedChromeProbe(runId: string, chromePath: string): Promise<void> {
  validateProbeRunId(runId);
  if (process.platform !== 'win32') throw new Error('This probe currently requires Windows.');
  if (!existsSync(chromePath)) throw new Error('Configured Chrome executable is missing.');
  const root = resolve('artifacts/real-world', runId, 'managed-chrome-probe');
  assertFreshProbeRoot(root);
  mkdirSync(root, { recursive: true });
  const userDataDir = resolve(root, 'user-data');
  const extensionDir = resolve(root, 'extension');
  mkdirSync(userDataDir);
  mkdirSync(extensionDir);
  const report: Json = { runId, startedAt: new Date().toISOString(), status: 'running', checks: [] };
  const checks = report.checks as Array<Json>;
  let stage = 'environment';
  const passed = (name: string, facts: Json = {}) => {
    checks.push({ name, status: 'passed', at: new Date().toISOString(), ...facts });
    console.error(`PASS ${name}`);
  };
  const fixture = await startManagedChromeProbeFixture(runId);
  const token = randomBytes(32).toString('base64url');
  let config = loadConfig({ RELAY_DB_PATH: resolve(root, 'broker.sqlite'), RELAY_MCP_PORT: '0', RELAY_WS_PORT: '0', RELAY_ADMIN_TOKEN: token, RELAY_LOG_LEVEL: 'silent' });
  let app: RelayApplication = createRelayApplication(config);
  let client: Client | null = null;
  let browser: ChildProcess | null = null;
  let control: ChromeProbeControl | null = null;
  let endpointNickname = '';
  let workerSession = '';
  let identityHash = '';
  let workspaceRef = '';
  let tabRef = '';
  const chromeArguments = [
    `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--enable-unsafe-extension-debugging', '--disable-background-mode', 'about:blank'
  ];

  async function connectClient(): Promise<Client> {
    const result = new Client({ name: 'managed-chrome-probe', version: '0.1' }, { versionNegotiation: { mode: 'auto' } });
    await result.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.mcpPort}/mcp`), {
      requestInit: { headers: { 'x-octopus-contract-version': '5', Authorization: `Bearer ${token}`, 'x-octopus-runtime': 'probe', 'x-octopus-runtime-session': runId } }
    }));
    return result;
  }
  async function call(name: string, args: Json): Promise<Json> {
    if (!client) throw new Error('Probe MCP client disconnected.');
    const result = await client.callTool({ name, arguments: args });
    const output = object(result.structuredContent);
    if (result.isError || output.disposition === 'rejected') throw new Error(`MCP ${name}: ${JSON.stringify(output)}`);
    return output;
  }
  async function execute(name: string, args: Json): Promise<Json> {
    const accepted = await call(name, args);
    const requestRef = object(object(accepted.facts).ticket).request_ref;
    const ticket = await until(async () => {
      const current = object(object((await call('get_browser_request', { request_ref: requestRef })).facts).ticket);
      return ['succeeded', 'failed', 'uncertain'].includes(String(current.state)) ? current : null;
    }, `${name} ticket`, 45_000);
    if (ticket.state !== 'succeeded') throw new Error(`MCP ${name} terminal: ${JSON.stringify(ticket)}`);
    return object(ticket.result);
  }
  async function cdp(method: string, params: Json): Promise<Json> {
    return execute('send_cdp_command', { workspace_ref: workspaceRef, target: { kind: 'tab', tab_ref: tabRef }, method, params });
  }
  async function evaluate(expression: string): Promise<unknown> {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const command = object(object(result.facts).command);
    const protocol = object(command.result);
    if (protocol.exceptionDetails) throw new Error('Probe page evaluation threw.');
    return object(protocol.result).value;
  }
  async function managementUrl(): Promise<string> {
    const activeFile = resolve(userDataDir, 'DevToolsActivePort');
    return until(() => {
      if (!browser || browser.exitCode !== null) throw new Error('Probe Chrome exited before ready.');
      if (!existsSync(activeFile)) return null;
      const [port, browserPath] = readFileSync(activeFile, 'utf8').trim().split(/\r?\n/u);
      return /^\d+$/u.test(port ?? '') && browserPath?.startsWith('/devtools/browser/')
        ? `ws://127.0.0.1:${port}${browserPath}` : null;
    }, 'Chrome management connection');
  }
  async function workerEvaluate(expression: string): Promise<unknown> {
    const response = await control!.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, workerSession);
    if (response.exceptionDetails) throw new Error('Probe extension evaluation threw.');
    return object(response.result).value;
  }
  async function launch(): Promise<void> {
    rmSync(resolve(userDataDir, 'DevToolsActivePort'), { force: true });
    browser = spawn(chromePath, chromeArguments, { stdio: 'ignore', windowsHide: true });
    browser.on('error', error => console.error(`Probe browser spawn failed: ${error.message}`));
    control = await ChromeProbeControl.connect(await managementUrl());
    report.browser = await control.send('Browser.getVersion');
    const extensionId = String((await control.send('Extensions.loadUnpacked', { path: extensionDir })).id);
    if (extensionId !== 'caekiojlchhifdomfghejkbfpmaklafe') throw new Error('Unexpected extension identity.');
    const worker = await until(async () => {
      const targets = (await control!.send('Target.getTargets')).targetInfos as Json[];
      return targets.find(target => target.type === 'service_worker' && String(target.url).startsWith(`chrome-extension://${extensionId}/`)) ?? null;
    }, 'extension service worker');
    workerSession = String((await control.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId);
    const identity = await until(async () => {
      const stored = object(await workerEvaluate("chrome.storage.local.get(['publicKeyJwk','endpointId'])"));
      return stored.publicKeyJwk ? stored : null;
    }, 'extension identity initialization');
    const key = object(identity.publicKeyJwk);
    identityHash = probeIdentityHash(key, identityHash);
    const endpoint = await until(async () => {
      assertProbeConnectionStatus(object(await workerEvaluate("chrome.storage.local.get(['connectionStatus','lastError'])")));
      const candidates = app.store.canonical.logical.scanLogicalRecovery().endpoints;
      return candidates.find(candidate => {
        if (!candidate.credential) return false;
        const publicKey = object(candidate.credential.publicKeyJwk);
        return publicKey.x === key.x && publicKey.y === key.y
          && app.extensionGateway.connection(candidate.endpointRef)?.connected === true
          && app.store.canonical.logical.listWindows(candidate.endpointRef).some(window => window.eligible);
      }) ?? null;
    }, 'authenticated Native Messaging endpoint');
    endpointNickname = endpoint.nickname;
    const transport = await workerEvaluate("chrome.storage.local.get(['transportKind'])");
    if (object(transport).transportKind !== 'native') throw new Error('Probe did not establish Native Messaging transport.');
    passed('native-extension-ready', { endpointNickname, identityHash });
  }
  async function workspace(): Promise<void> {
    const result = await execute('request_browser_workspace', { required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: endpointNickname }] });
    const resolved = (object(result.facts).resolved as Json[])[0]!;
    workspaceRef = String(object(resolved.workspace).workspace_ref);
    tabRef = String(object((resolved.tabs as unknown[])[0]).tab_ref);
    const groups = await workerEvaluate('chrome.tabGroups.query({})') as unknown[];
    if (!groups.length) throw new Error('No native tab group created.');
    await cdp('Page.navigate', { url: fixture.url });
    await until(async () => await evaluate(`document.querySelector('main')?.dataset.probe === ${JSON.stringify(runId)}`) === true ? true : null, 'probe page navigation');
    passed('native-tab-group-and-mcp-page-control', { workspaceRef, tabRef });
  }
  async function normalClose(): Promise<void> {
    await execute('terminate_workspace', { workspace_ref: workspaceRef });
    try { await control!.send('Browser.close'); } catch { /* Chrome may close transport before replying. */ }
    await until(() => browser!.exitCode !== null || browser!.signalCode !== null ? true : null, 'normal Chrome exit');
    await control!.disconnect();
    control = null;
    browser = null;
  }
  try {
    await app.start();
    config = { ...config, mcpPort: app.mcpGateway.address().port, wsPort: app.extensionGateway.address().port };
    report.ports = { mcp: config.mcpPort, relay: config.wsPort, fixture: new URL(fixture.url).port };
    const relayUrl = `ws://127.0.0.1:${config.wsPort}/relay`;
    stage = 'extension-build';
    await build({
      entryPoints: { 'service-worker': 'apps/browser-extension/src/service-worker.ts', options: 'apps/browser-extension/src/options.ts' },
      outdir: extensionDir, bundle: true, format: 'esm', target: 'chrome116', logLevel: 'silent',
      plugins: [{ name: 'isolated-probe-default', setup(builder) {
        builder.onLoad({ filter: /browser-extension[\\/]src[\\/]config\.ts$/ }, args => ({
          contents: readFileSync(args.path, 'utf8').replace("'ws://127.0.0.1:7332/relay'", JSON.stringify(relayUrl)), loader: 'ts'
        }));
      } }]
    });
    for (const file of ['manifest.json', 'options.html']) writeFileSync(resolve(extensionDir, file), readFileSync(resolve('apps/browser-extension', file)));
    report.extensionDigest = createHash('sha256').update(readFileSync(resolve(extensionDir, 'service-worker.js'))).digest('hex');
    client = await connectClient();
    stage = 'first-launch';
    await launch();
    await workspace();
    await evaluate(`localStorage.setItem('octopus-probe',${JSON.stringify(runId)});document.cookie='octopus_probe='+${JSON.stringify(runId)}+'; Max-Age=86400; Path=/; SameSite=Strict';true`);
    const persisted = `localStorage.getItem('octopus-probe')===${JSON.stringify(runId)} && document.cookie.split('; ').includes('octopus_probe='+${JSON.stringify(runId)})`;
    if (await evaluate(persisted) !== true) throw new Error('Initial test state missing.');
    stage = 'management-disconnect';
    await control!.disconnect();
    control = null;
    if (await evaluate(persisted) !== true) throw new Error('Extension control failed after management disconnect.');
    control = await ChromeProbeControl.connect(await managementUrl());
    if (await evaluate(persisted) !== true) throw new Error('Extension control failed after management reconnect.');
    passed('management-disconnect-and-reconnect');
    stage = 'broker-restart';
    await client.close(); client = null;
    await app.stop();
    app = createRelayApplication(config);
    await app.start();
    client = await connectClient();
    await until(() => {
      const endpoint = app.store.canonical.logical.getEndpointByNickname(endpointNickname);
      return endpoint && app.extensionGateway.connection(endpoint.endpointRef)?.connected ? true : null;
    }, 'extension reconnect after Broker restart', 60_000);
    if (await evaluate(persisted) !== true) throw new Error('State lost on Broker restart.');
    passed('broker-restart');
    stage = 'profile-reopen';
    await normalClose();
    await launch();
    await workspace();
    if (await evaluate(persisted) !== true) throw new Error('Cookie/localStorage did not survive normal reopen.');
    passed('profile-reopen-preserves-data-and-identity');
    await normalClose();
    stage = 'launcher-exit';
    rmSync(resolve(userDataDir, 'DevToolsActivePort'), { force: true });
    const launcher = spawn(process.execPath, ['-e',
      "const {spawn}=require('node:child_process');const child=spawn(process.argv[1],JSON.parse(process.argv[2]),{stdio:'ignore',windowsHide:true,detached:true});child.on('error',()=>process.exit(1));child.on('spawn',()=>{console.log(child.pid);child.unref();});",
      chromePath, JSON.stringify(chromeArguments)
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let launcherOutput = '';
    launcher.stdout.on('data', data => { launcherOutput += String(data); });
    await until(() => launcher.exitCode === 0 ? true : launcher.exitCode === null ? null : (() => { throw new Error('Probe launcher failed.'); })(), 'launcher exit');
    const detachedPid = Number(launcherOutput.trim());
    if (!Number.isSafeInteger(detachedPid) || detachedPid <= 0) throw new Error('Launcher did not return browser PID.');
    const detachedUrl = await until(() => {
      const active = resolve(userDataDir, 'DevToolsActivePort');
      if (!existsSync(active)) return null;
      const [port, browserPath] = readFileSync(active, 'utf8').trim().split(/\r?\n/u);
      return /^\d+$/u.test(port ?? '') && browserPath?.startsWith('/devtools/browser/') ? `ws://127.0.0.1:${port}${browserPath}` : null;
    }, 'browser surviving launcher exit');
    control = await ChromeProbeControl.connect(detachedUrl);
    await control.send('Browser.getVersion');
    passed('browser-survives-launcher-process-exit');
    try { await control.send('Browser.close'); } catch { /* Normal transport closure. */ }
    await until(() => {
      try { process.kill(detachedPid, 0); return null; }
      catch { return true; }
    }, 'detached browser normal exit');
    await control.disconnect(); control = null;
    passed('normal-cleanup');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = { stage, message: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    if (control) {
      try { await control.send('Browser.close'); } catch { /* Best-effort close only of this owned instance. */ }
      await control.disconnect();
    }
    const remainingBrowser = browser as ChildProcess | null;
    if (remainingBrowser && remainingBrowser.exitCode === null && remainingBrowser.signalCode === null) {
      try { await until(() => remainingBrowser.exitCode !== null ? true : null, 'cleanup', 5_000); }
      catch { remainingBrowser.kill(); report.forcedOwnedProcessCleanup = true; }
    }
    await client?.close();
    await app.stop();
    await fixture.close();
    report.finishedAt = new Date().toISOString();
    writeFileSync(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
    console.error(`Probe report: ${resolve(root, 'report.json')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice('--run-id='.length) ?? '';
  const chrome = process.argv.find(arg => arg.startsWith('--chrome='))?.slice('--chrome='.length)
    ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  await runManagedChromeProbe(runId, chrome).catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
