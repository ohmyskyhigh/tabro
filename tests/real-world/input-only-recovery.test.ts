import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { ChromeManagementConnection } from '../../apps/broker/src/profiles/management-connection.js';
import { ChromeLauncher } from '../../apps/broker/src/profiles/chrome-launcher.js';
import { extensionDigest, profileLayout } from '../../apps/broker/src/profiles/runtime-config.js';
import { HUMAN_SIMULATION_LIMITS } from '../../apps/broker/src/core/octopus/human-simulation.js';
import type { ManagedProfile } from '../../apps/broker/src/profiles/types.js';
import { MCP_CONTRACT_VERSION } from '../../apps/shared/protocol/src/mcp/tool-catalog.js';
import { maintenanceRequest } from '../../apps/shared/protocol/src/maintenance-client.js';
import { removeBrokerRuntime } from '../../apps/shared/protocol/src/runtime-discovery.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return value as Json;
};

// The expanded scenario launches several adapters and restarts the Broker
// under real Chrome. Native Intel runners take longer across those steps.
const qualificationTimeoutMs = process.platform === 'darwin' && process.arch === 'x64' ? 480_000 : 240_000;

// Explicit environment gate: release jobs also require the resulting PASS report.
it.runIf(!!process.env.TABRO_QUALIFY_PACKAGE)('qualifies packaged domain rules and interrupted input in isolated real Chrome', async () => {
  const packageRoot = resolve(process.env.TABRO_QUALIFY_PACKAGE!);
  const manifest = object(JSON.parse(readFileSync(join(packageRoot, 'runtime-manifest.json'), 'utf8')));
  expect(manifest.contractVersion).toBe(MCP_CONTRACT_VERSION);
  if (!process.env.TABRO_QUALIFY_INSTALL_ROOT) throw new Error('TABRO_QUALIFY_INSTALL_ROOT must name the pre-provisioned machine installation.');
  const install = realpathSync(process.env.TABRO_QUALIFY_INSTALL_ROOT);
  const registrationPath = process.platform === 'win32'
    ? resolve(process.env.ProgramData ?? 'C:\\ProgramData', 'Tabro/registration.json')
    : process.platform === 'darwin' ? '/var/db/tabro/registration.json' : '/var/lib/tabro/registration.json';
  const registration = object(JSON.parse(readFileSync(registrationPath, 'utf8')));
  expect(realpathSync(String(registration.installationRoot))).toBe(install);
  expect(realpathSync(String(registration.dataRoot))).toBe(realpathSync(join(install, 'data')));
  const installation = object(JSON.parse(readFileSync(join(install, 'installation.json'), 'utf8')));
  const installedRuntime = resolve(install, String(installation.runtimeDirectory));
  const root = mkdtempSync(join(tmpdir(), 'tabro-input-qualification-'));
  const evidence = resolve(process.env.TABRO_INPUT_EVIDENCE ?? 'artifacts/qualification', `${process.platform}-${process.arch}-input-only.json`);
  const userData = join(root, 'chrome'); mkdirSync(userData);
  const runtimeFile = join(install, 'data/runtime.json');
  const rulesFile = join(install, 'data/browser-rules.json');
  if (existsSync(runtimeFile)) throw new Error('Qualification requires a stopped Broker and no published runtime.');
  const previousRules = existsSync(rulesFile) ? readFileSync(rulesFile) : null;
  const browserPath = process.env.TABRO_QUALIFY_CHROME ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/opt/google/chrome/chrome');
  expect(existsSync(browserPath), 'A native Chrome installation is required').toBe(true);
  const rules = { schemaVersion: 1, rules: [{ id: 'fixture', domain: 'fixture.test', mode: 'input_only' }] };
  const token = readFileSync(join(install, 'data/admin-token.txt'), 'utf8').trim();
  const runId = randomBytes(8).toString('hex');
  const trace: Json[] = [];
  const connections: Json[] = [];
  const events: Json[] = [];
  const effects: string[] = [];
  const report: Json = { status: 'running', os: process.platform, arch: process.arch, contract: MCP_CONTRACT_VERSION,
    startedAt: new Date().toISOString(), sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHasLocalChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    packageManifestSha256: createHash('sha256').update(readFileSync(join(packageRoot, 'runtime-manifest.json'))).digest('hex'), checks: [], connections };
  const pass = (check: string) => {
    (report.checks as string[]).push(check);
    console.info(`[Chrome qualification] ${check}`);
  };
  let broker: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  let control: ChromeManagementConnection | null = null;
  let client: Client | null = null;
  const additionalClients: Client[] = [];
  let runtime: Json = {};
  let workerSession = '';
  let workspace = '';
  let tab = '';
  let lostNextType: string | null = null;
  let holdNextControlResult = false;
  let releaseControlResult: (() => void) | null = null;
  let inventoriesReceived = 0;
  const attempts = new Map<string, Json>();
  const sockets = new Set<WebSocket>();
  let logs = '';
  let browserLog = '';
  const connectionEvent = (event: Json) => {
    connections.push({ at: new Date().toISOString(), ...event });
    if (connections.length > 200) connections.shift();
  };

  const site = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: `http://other.test:${sitePort}/` }).end(); return; }
    if (req.url === '/challenge' || req.url === '/cleared') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      // A visible slider plus a resident hidden captcha frame, like a real commerce challenge.
      res.end(`<!doctype html><title>Tabro challenge fixture</title><style>body{margin:30px;font:16px sans-serif}button{margin:10px;padding:10px}</style>
        <div id="nc_1_wrapper" style="width:300px;height:40px;background:#eee">slide</div>
        <button id="done">Done</button>
        <iframe id="resident" src="https://www.google.com/recaptcha/api2/bframe?x=1" style="width:0;height:0;border:0"></iframe>
        <script>window.fixture={doneClicks:0};document.querySelector('#done').onclick=()=>{fixture.doneClicks++};</script>`);
      return;
    }
    if (req.url === '/recaptcha-bframe') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>b</title>'); return; }
    if (req.url?.startsWith('/event') || req.url?.startsWith('/effect')) {
      let body = ''; req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => {
        if (req.url?.startsWith('/effect')) effects.push(body); else events.push(object(JSON.parse(body)));
        res.writeHead(204).end();
      }); return;
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>Tabro input fixture</title><style>
      body{margin:30px;font:16px sans-serif}button,input,select{margin:10px;padding:10px}
      #drag,#zone{position:absolute;top:180px;width:100px;height:80px;background:#ddd}#drag{left:50px}#zone{left:250px}
      #scroll{position:absolute;top:300px;left:40px;width:280px;height:120px;overflow:auto;background:#eee}
      </style><button id="button">Count</button><input id="text"><select id="select" size="2"><option>A</option><option>B</option></select>
      <div id="drag">Drag</div><div id="zone">Drop</div><div id="scroll"><div style="height:900px">Scroll</div></div>
      <iframe id="resident" src="https://www.google.com/recaptcha/api2/bframe?x=1" style="display:none"></iframe>
      <script>
      window.fixture={clicks:0,drops:0,events:[]};let dragging=false;
      const send=(path,data)=>fetch(path,{method:'POST',body:JSON.stringify(data)});
      for(const type of ['mousedown','mouseup','mousemove','keydown','keyup','input','wheel','change'])document.addEventListener(type,e=>{
        const row={type,key:e.key||null,keyCode:e.keyCode,button:e.button,buttons:e.buttons,shift:e.shiftKey,trusted:e.isTrusted,target:e.target.id};fixture.events.push(row);send('/event',row);
      });
      document.querySelector('#button').onclick=()=>{fixture.clicks++;send('/effect',{kind:'click'})};
      document.querySelector('#drag').onpointerdown=()=>{dragging=true};
      document.onpointerup=e=>{if(dragging&&e.target.id==='zone'){fixture.drops++;send('/effect',{kind:'drop'})}dragging=false};
      </script>`);
  });
  await new Promise<void>(resolveListen => site.listen(0, '127.0.0.1', resolveListen));
  const sitePort = (site.address() as { port: number }).port;
  const bridge = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(bridge, 'listening');
  // Initialize only transport settings before the packaged worker starts. This
  // prevents the fixture from connecting to the user's Native Messaging host.
  const extensionPath = join(root, 'extension');
  cpSync(join(packageRoot, 'runtime/browser-extension'), extensionPath, { recursive: true });
  const workerPath = join(extensionPath, 'service-worker.js');
  writeFileSync(workerPath, `chrome.storage.local.set(${JSON.stringify({ transportMode: 'websocket', brokerUrl: `ws://127.0.0.1:${(bridge.address() as { port: number }).port}/relay` })}).then(() => {\n${readFileSync(workerPath, 'utf8')}\n});`);
  bridge.on('connection', (socket, request) => {
    connectionEvent({ event: 'extension_connected' });
    sockets.add(socket);
    const timestamp = Date.now();
    const nonce = randomBytes(16).toString('hex');
    const proof = createHmac('sha256', Buffer.from(readFileSync(join(install, 'data/native-secret'), 'utf8').trim(), 'hex'))
      .update(`relay:${runtime.instanceRef}:${timestamp}:${nonce}`).digest('hex');
    const upstream = new WebSocket(String(runtime.relayUrl), { headers: {
      origin: request.headers.origin ?? 'chrome-extension://caekiojlchhifdomfghejkbfpmaklafe',
      'x-tabro-relay-proof': `${timestamp}.${nonce}.${proof}`
    } });
    sockets.add(upstream);
    const waiting: string[] = [];
    upstream.on('open', () => { connectionEvent({ event: 'broker_connected' }); for (const message of waiting.splice(0)) upstream.send(message); });
    socket.on('message', data => {
      const message = object(JSON.parse(data.toString()));
      connectionEvent({ direction: 'extension_to_broker', type: message.type });
      if (message.type === 'INVENTORY_SNAPSHOT') inventoriesReceived++;
      const payload = object(message.payload);
      const command = attempts.get(String(payload.attemptId));
      if (message.type === 'OPERATION_RESULT' && command && holdNextControlResult) {
        holdNextControlResult = false;
        releaseControlResult = () => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString()); };
        return;
      }
      if (message.type === 'OPERATION_RESULT' && command && lostNextType === object(command.params).type) {
        lostNextType = null;
        // The real extension has executed and persisted the result. Drop only its delivery.
        upstream.close(); socket.close(); return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString()); else waiting.push(data.toString());
    });
    upstream.on('message', data => {
      const message = object(JSON.parse(data.toString()));
      connectionEvent({ direction: 'broker_to_extension', type: message.type });
      if (message.type === 'SEND_CDP') { const payload = object(message.payload); trace.push(payload); attempts.set(String(payload.attemptId), payload); }
      if (socket.readyState === WebSocket.OPEN) socket.send(data.toString());
    });
    socket.on('close', (code, reason) => { connectionEvent({ event: 'extension_closed', code, reason: reason.toString() }); sockets.delete(socket); upstream.close(); });
    upstream.on('close', (code, reason) => { connectionEvent({ event: 'broker_closed', code, reason: reason.toString() }); sockets.delete(upstream); socket.close(); });
    upstream.on('error', error => { connectionEvent({ event: 'broker_error', message: error.message }); socket.close(); });
    socket.on('error', error => { connectionEvent({ event: 'extension_error', message: error.message }); upstream.close(); });
  });

  async function startBroker() {
    const oldPid = broker?.pid;
    broker = spawn(process.execPath, [join(installedRuntime, 'broker/main.js')], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, RELAY_DB_PATH: join(install, 'data/relay.sqlite'), RELAY_ADMIN_TOKEN: token, RELAY_LOG_LEVEL: 'silent',
      RELAY_MCP_PORT: runtime.mcpUrl ? new URL(String(runtime.mcpUrl)).port : '0',
      RELAY_WS_PORT: runtime.relayUrl ? new URL(String(runtime.relayUrl)).port : '0',
      TABRO_RUNTIME_FILE: runtimeFile, TABRO_NATIVE_RUNTIME_FILE: runtimeFile, TABRO_BROWSER_RULES_PATH: rulesFile
    } });
    broker.stdout?.on('data', data => { logs += String(data); }); broker.stderr?.on('data', data => { logs += String(data); });
    await expect.poll(() => {
      if (broker?.exitCode !== null) throw new Error(`Isolated Broker exited: ${logs}`);
      if (!existsSync(runtimeFile)) return false;
      const next = object(JSON.parse(readFileSync(runtimeFile, 'utf8')));
      if (next.processId !== broker?.pid || next.processId === oldPid) return false;
      runtime = next; return true;
    }, { timeout: 15000 }).toBe(true);
    const marker = join(install, 'data/maintenance.json');
    const operation = join(install, 'data/maintenance-operation.json');
    if (existsSync(marker)) {
      if (!existsSync(operation)) throw new Error('Unowned maintenance fence requires inspection.');
      const journal = object(JSON.parse(readFileSync(operation, 'utf8')));
      const fenced = object(JSON.parse(readFileSync(marker, 'utf8')));
      if (journal.kind !== 'stop' || typeof journal.transactionId !== 'string' || fenced.transactionId !== journal.transactionId) {
        throw new Error('The maintenance fence does not match the stopped fixture installation.');
      }
      await maintenanceRequest(install, new URL(String(runtime.mcpUrl)), 'resume', journal.transactionId, String(runtime.instanceRef));
      rmSync(operation);
    }
  }
  async function newClient(runtimeName: 'codex' | 'hermes' | 'cc' | 'dsh', session: string = runtimeName) {
    const next = new Client({ name: `input-qualification-${session}`, version: '1' });
    await next.connect(new StdioClientTransport({ command: process.execPath, args: [join(installedRuntime, 'adapter/main.js')],
      env: { ...getDefaultEnvironment(), TABRO_RUNTIME_FILE: runtimeFile, TABRO_TOKEN: token,
        TABRO_RUNTIME: runtimeName, TABRO_RUNTIME_SESSION: `input-qualification-${runId}-${session}` }, stderr: 'pipe' }));
    const tools = await next.listTools();
    const description = tools.tools.find(tool => tool.name === 'send_cdp_command')?.description;
    expect(description).toContain('guarded Runtime.evaluate');
    expect(description).toContain('HUMAN_VERIFICATION_REQUIRED');
    return next;
  }
  async function connect(runtimeName: 'codex' | 'hermes', session: string = runtimeName) {
    await client?.close(); client = await newClient(runtimeName, session);
  }
  async function callOn(target: Client, name: string, args: Json) {
    const result = await target.callTool({ name, arguments: args });
    if (!result.structuredContent) throw new Error(`MCP ${name} returned no structured content: ${JSON.stringify(result.content)}`);
    return object(result.structuredContent);
  }
  async function call(name: string, args: Json) { return callOn(client!, name, args); }
  async function executeOn(target: Client, name: string, args: Json, failCode?: string) {
    const receipt = await callOn(target, name, args);
    expect(receipt.disposition, JSON.stringify(receipt)).toBe('accepted');
    const ref = object(object(receipt.facts).ticket).request_ref;
    let ticket: Json = {};
    await expect.poll(async () => {
      ticket = object(object((await callOn(target, 'get_browser_request', { request_ref: ref })).facts).ticket);
      return ticket.state;
    }, { timeout: 45000, interval: 100 }).toMatch(/^(succeeded|failed|uncertain)$/u);
    if (failCode) expect(ticket.failure, JSON.stringify(ticket)).toMatchObject({ problem: { code: failCode } });
    else expect(ticket.state, JSON.stringify(ticket)).toBe('succeeded');
    return ticket;
  }
  async function execute(name: string, args: Json, failCode?: string) { return executeOn(client!, name, args, failCode); }
  const cdp = (method: string, params: Json, failCode?: string) => execute('send_cdp_command', { workspace_ref: workspace, target: { kind: 'tab', tab_ref: tab }, method, params }, failCode);
  async function raw(method: string, params: Json): Promise<Json> {
    const ticket = await cdp(method, params); return object(object(object(object(ticket.result).facts).command).result);
  }
  async function read(expression: string): Promise<unknown> {
    // The test harness reads actual browser state outside the Tabro action path.
    const browserTab = object(trace.at(-1)?.tab).tabId;
    expect(typeof browserTab).toBe('number');
    const result = object(await worker(`chrome.debugger.sendCommand({tabId:${Number(browserTab)}},'Runtime.evaluate',${JSON.stringify({ expression, returnByValue: true, throwOnSideEffect: true })})`));
    expect(result.exceptionDetails, JSON.stringify(result)).toBeUndefined();
    return object(result.result).value;
  }
  // Out-of-band page write used to simulate the site or the user finishing a challenge.
  async function force(expression: string): Promise<unknown> {
    const browserTab = object(trace.at(-1)?.tab).tabId;
    const result = object(await worker(`chrome.debugger.sendCommand({tabId:${Number(browserTab)}},'Runtime.evaluate',${JSON.stringify({ expression, returnByValue: true })})`));
    expect(result.exceptionDetails, JSON.stringify(result)).toBeUndefined();
    return object(result.result).value;
  }
  async function center(selector: string) {
    const document = await raw('DOM.getDocument', {});
    const node = await raw('DOM.querySelector', { nodeId: object(document.root).nodeId, selector });
    const model = object((await raw('DOM.getBoxModel', { nodeId: node.nodeId })).model);
    const points = model.content as number[];
    return { x: (points[0]! + points[4]!) / 2, y: (points[1]! + points[5]!) / 2 };
  }
  const mouse = (type: string, point: Json) => cdp('Input.dispatchMouseEvent', { type, ...point,
    ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
  async function click(selector: string) {
    const point = await center(selector); await mouse('mouseMoved', point); await mouse('mousePressed', point); await mouse('mouseReleased', point);
  }
  async function key(code: string, keyValue: string) {
    const windowsVirtualKeyCode = code === 'ArrowDown' ? 40 : code === 'Enter' ? 13 : 0;
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyValue, windowsVirtualKeyCode });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyValue, windowsVirtualKeyCode });
  }
  async function context() { return object((await call('get_browser_context', { view: { kind: 'tab', workspace_ref: workspace, tab_ref: tab } })).facts); }
  async function verification() { return object((await context()).tab).human_verification as Json | null | undefined; }
  async function worker(expression: string) {
    const value = await control!.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, workerSession);
    expect(value.exceptionDetails, JSON.stringify(value)).toBeUndefined(); return object(value.result).value;
  }
  async function bringToFront() {
    await cdp('Page.bringToFront', {});
    const { tabId, windowId } = object(trace.at(-1)?.tab);
    // A headed macOS window can remain behind another app even after Chrome activates its tab.
    if (process.env.TABRO_QUALIFY_HEADED === '1') await worker(`chrome.windows.update(${Number(windowId)}, {focused: true})`);
    await expect.poll(async () => await worker(
      `Promise.all([chrome.tabs.get(${Number(tabId)}), chrome.windows.get(${Number(windowId)})]).then(([tab, window]) => tab.active && window.focused)`),
    { timeout: 5000 }).toBe(true);
  }
  try {
    writeFileSync(rulesFile, JSON.stringify(rules));
    await startBroker(); await connect('codex');
    browser = spawn(browserPath, [`--user-data-dir=${userData}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
      ...(process.env.TABRO_QUALIFY_HEADED === '1' ? [] : ['--headless=new']),
      '--window-size=1280,900', '--no-proxy-server', '--host-resolver-rules=MAP *.test 127.0.0.1', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr?.on('data', data => { browserLog = (browserLog + String(data)).slice(-32_768); });
    const portFile = join(userData, 'DevToolsActivePort');
    await expect.poll(() => existsSync(portFile), { timeout: 15000 }).toBe(true);
    const [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/u);
    control = await ChromeManagementConnection.connect(`ws://127.0.0.1:${port}${path}`);
    report.browser = await control.send('Browser.getVersion');
    const id = (await control.send('Extensions.loadUnpacked', { path: extensionPath })).id;
    let workerId = '';
    await expect.poll(async () => {
      const targets = (await control!.send('Target.getTargets')).targetInfos as Json[];
      workerId = String(targets.find(item => item.type === 'service_worker' && String(item.url).startsWith(`chrome-extension://${id}/`))?.targetId ?? '');
      return !!workerId;
    }, { timeout: 15000 }).toBe(true);
    workerSession = String((await control.send('Target.attachToTarget', { targetId: workerId, flatten: true })).sessionId);
    let nickname = '';
    await expect.poll(async () => {
      const profiles = object((await call('list_browser_profiles', {})).facts).profiles as Json[];
      report.startupProfiles = profiles;
      nickname = String(profiles.find(profile => profile.ready)?.endpoint_nickname ?? ''); return !!nickname;
    }, { timeout: 25000 }).toBe(true);
    const workspaceArgs = { required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: nickname }] };
    const peer = await newClient('codex', 'codex'); additionalClients.push(peer);
    const receipts = await Promise.all([call('request_browser_workspace', workspaceArgs), callOn(peer, 'request_browser_workspace', workspaceArgs)]);
    const requestRef = object(object(receipts[0]!.facts).ticket).request_ref;
    expect(object(object(receipts[1]!.facts).ticket).request_ref).toBe(requestRef);
    let allocated: Json = {};
    await expect.poll(async () => {
      allocated = object(object((await call('get_browser_request', { request_ref: requestRef })).facts).ticket);
      return allocated.state;
    }, { timeout: 45000, interval: 100 }).toBe('succeeded');
    let resolved = (object(object(allocated.result).facts).resolved as Json[])[0]!;
    workspace = String(object(resolved.workspace).workspace_ref); tab = String((resolved.tabs as Json[])[0]!.tab_ref);
    await connect('codex');
    const resumed = await execute('request_browser_workspace', workspaceArgs);
    expect(object((object(object(resumed.result).facts).resolved as Json[])[0]!.workspace).workspace_ref).toBe(workspace);
    const groups = new Set([workspace]);
    for (const runtimeName of ['cc', 'dsh'] as const) {
      const other = await newClient(runtimeName, 'codex'); additionalClients.push(other);
      expect((await callOn(other, 'get_browser_request', { request_ref: requestRef })).problem).toMatchObject({ code: 'REQUEST_NOT_FOUND' });
      const ticket = await executeOn(other, 'request_browser_workspace', workspaceArgs);
      const otherWorkspace = String(object((object(object(ticket.result).facts).resolved as Json[])[0]!.workspace).workspace_ref);
      expect(groups.has(otherWorkspace)).toBe(false); groups.add(otherWorkspace);
      await executeOn(other, 'terminate_workspace', { workspace_ref: otherWorkspace });
    }
    pass('real Chrome: concurrent same-chat requests share a ticket, adapter restart resumes the group, and Codex/CC/DSH identities use separate groups');
    await cdp('Page.navigate', { url: `http://fixture.test:${sitePort}/` });
    await expect.poll(() => read('document.title'), { timeout: 15000 }).toBe('Tabro input fixture');
    const screenshot = await raw('Page.captureScreenshot', { format: 'png' });
    expect(Buffer.from(String(screenshot.data), 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    pass('real Chrome: screenshot observation works on a Human Simulation Mode domain');
    holdNextControlResult = true;
    const target = { workspace_ref: workspace, target: { kind: 'tab', tab_ref: tab } };
    const seed = await call('send_cdp_command', { ...target, method: 'DOM.getDocument', params: {} });
    expect(seed.disposition, JSON.stringify(seed)).toBe('accepted');
    await expect.poll(() => releaseControlResult !== null, { timeout: 15000 }).toBe(true);
    const sentinel = 'stop-must-fence-this-input';
    const pendingInput = await call('send_cdp_command', { ...target, method: 'Input.insertText', params: { text: sentinel } });
    expect(pendingInput.disposition, JSON.stringify(pendingInput)).toBe('accepted');
    const stopReceipt = await call('stop_workspace_automation', { workspace_ref: workspace });
    expect(stopReceipt.disposition).toBe('accepted');
    (releaseControlResult as unknown as () => void)();
    const stopRef = object(object(stopReceipt.facts).ticket).request_ref;
    await expect.poll(async () => object(object((await call('get_browser_request', { request_ref: stopRef })).facts).ticket).state,
      { timeout: 15000 }).toBe('succeeded');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
    expect(trace.some(row => object(row.params).text === sentinel)).toBe(false);
    pass('real Chrome: stopping automation fences an input queued behind an in-flight command');
    await execute('terminate_workspace', { workspace_ref: workspace });
    allocated = await execute('request_browser_workspace', workspaceArgs);
    resolved = (object(object(allocated.result).facts).resolved as Json[])[0]!;
    workspace = String(object(resolved.workspace).workspace_ref); tab = String((resolved.tabs as Json[])[0]!.tab_ref);
    await cdp('Page.navigate', { url: `http://fixture.test:${sitePort}/` });
    await expect.poll(() => read('document.title'), { timeout: 15000 }).toBe('Tabro input fixture');
    const browserTabId = Number(object(trace.at(-1)?.tab).tabId);
    const currentTab = async () => object(await worker(`chrome.tabs.get(${browserTabId})`));
    const backgroundTab = await currentTab();
    expect(backgroundTab.active).toBe(false);
    const backgroundPoint = await center('#text');
    // Contract 8 refuses browser input on a Human Simulation domain while the tab is hidden.
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...backgroundPoint }, 'FOREGROUND_REQUIRED');
    expect(await read('fixture.clicks')).toBe(0);
    pass('real Chrome: background input refused on a Human Simulation domain');
    await bringToFront();
    await mouse('mouseMoved', backgroundPoint); await mouse('mousePressed', backgroundPoint);
    const previousInventoryCount = inventoriesReceived;
    // A harmless tab update publishes inventory without changing the gesture's focus.
    await worker(`chrome.tabs.update(${Number(backgroundTab.id)},{muted:true})`);
    await expect.poll(() => inventoriesReceived).toBeGreaterThan(previousInventoryCount);
    expect(object((await context()).input_recovery)).toMatchObject({ status: 'held', pause_reason: null });
    await mouse('mouseReleased', backgroundPoint);
    expect((await context()).input_recovery).toBeNull();
    expect(await read('document.activeElement.id')).toBe('text');
    pass('foreground click survives unchanged inventory between press and release');
    for (const expression of [
      'document.querySelector("#button").click()', 'document.querySelector("#text").focus()',
      'document.querySelector("#text").value="forbidden"', 'document.querySelector("#scroll").scrollTop=50',
      'document.querySelector("#text").setAttribute("data-test","forbidden")',
      'document.querySelector("#button").dispatchEvent(new MouseEvent("click"))',
      'fetch("/effect",{method:"POST",body:"forbidden"})'
    ]) await cdp('Runtime.evaluate', { expression, returnByValue: true }, 'INPUT_ONLY_REQUIRED');
    expect(await read('fixture.clicks')).toBe(0); expect(effects).toHaveLength(0);
    expect(await read('document.querySelector("#text").value')).toBe('');
    expect(await read('document.querySelector("#scroll").scrollTop')).toBe(0);
    expect(await read('document.querySelector("#text").getAttribute("data-test")')).toBeNull();
    pass('scripted manipulation refused without effects');
    // Guarded evaluate now answers through Tabro in an isolated world with plain data only.
    const listed = await raw('Runtime.evaluate', { expression: 'JSON.stringify([...document.querySelectorAll("button,#drag,#zone")].map(item => item.id))' });
    expect(JSON.parse(String(object(listed.result).value))).toEqual(expect.arrayContaining(['button', 'drag', 'zone']));
    expect(JSON.stringify(listed)).not.toMatch(/objectId/u);
    await force('window.__mainWorldMarker = 7');
    expect(await read('window.__mainWorldMarker')).toBe(7);
    const isolated = await raw('Runtime.evaluate', { expression: 'typeof window.__mainWorldMarker' });
    expect(String(object(isolated.result).value)).toBe('undefined');
    expect(String(object((await raw('Runtime.evaluate', { expression: 'document.title' })).result).value)).toBe('Tabro input fixture');
    await cdp('Runtime.evaluate', { expression: 'window.__x = 1' }, 'INPUT_ONLY_REQUIRED');
    expect(await verification()).toBeNull();
    pass('real Chrome: isolated-world guarded read returns plain data, hides remote objects, cannot see or write page-world globals, and the resident hidden captcha frame raises no challenge');
    // The guarded reads created an activity debt: leaving the page by URL is refused until it is paid.
    await cdp('Page.navigate', { url: `http://fixture.test:${sitePort}/challenge` }, 'HUMAN_ACTIVITY_REQUIRED');
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...await center('#scroll'), deltaX: 0, deltaY: 2_000 });
    for (const selector of ['#button', '#text', '#select']) await mouse('mouseMoved', await center(selector));
    await new Promise(resolveDelay => setTimeout(resolveDelay, 4_200));
    await cdp('Page.navigate', { url: `http://fixture.test:${sitePort}/challenge` });
    await expect.poll(() => read('document.title'), { timeout: 15000 }).toBe('Tabro challenge fixture');
    pass('real Chrome: HUMAN_ACTIVITY_REQUIRED gates the URL departure and paid human activity releases it');
    // Repeated observations during the grace period must retain the first detection.
    await expect.poll(async () => {
      await raw('DOM.getDocument', {});
      return (await verification())?.status;
    }, { timeout: 15_000 }).toBe('watching');
    await raw('DOM.getDocument', {});
    expect(await verification()).toMatchObject({ status: 'watching', signature: 'taobao-slider-selector' });
    await new Promise(resolveDelay => setTimeout(resolveDelay, HUMAN_SIMULATION_LIMITS.graceMs));
    await cdp('Input.insertText', { text: 'blocked by verification' }, 'HUMAN_VERIFICATION_REQUIRED');
    const shot = await raw('Page.captureScreenshot', { format: 'png' });
    expect(Buffer.from(String(shot.data), 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(await verification()).toMatchObject({ status: 'paused', signature: 'taobao-slider-selector' });
    await execute('resume_workspace_automation', { workspace_ref: workspace,
      human_verification: { user_confirmed_completed: true } }, 'HUMAN_VERIFICATION_REQUIRED');
    await execute('resume_workspace_automation', { workspace_ref: workspace }, 'HUMAN_VERIFICATION_REQUIRED');
    await cdp('Input.insertText', { text: 'still blocked' }, 'HUMAN_VERIFICATION_REQUIRED');
    // The site clearing the challenge is what a completed user verification looks like to Tabro.
    await force('document.querySelector("#nc_1_wrapper").style.display = "none"');
    const challengeResumed = await execute('resume_workspace_automation', { workspace_ref: workspace,
      human_verification: { user_confirmed_completed: true } });
    expect(JSON.stringify(challengeResumed.result)).toMatch(/cleared_human_verification/u);
    expect(await verification()).toBeNull();
    await click('#done');
    expect(await read('fixture.doneClicks')).toBe(1);
    pass('real Chrome: a visible challenge pauses manipulation, keeps screenshots, refuses false resume claims and resumes after the user finishes');
    await cdp('Page.navigate', { url: `http://fixture.test:${sitePort}/` });
    await expect.poll(() => read('document.title'), { timeout: 15000 }).toBe('Tabro input fixture');
    await click('#button'); expect(await read('fixture.clicks')).toBe(1);
    await click('#text'); await cdp('Input.insertText', { text: 'Hello 世界' });
    expect(await read('document.querySelector("#text").value')).toBe('Hello 世界');
    await click('#select option:first-child'); await key('ArrowDown', 'ArrowDown');
    expect(await read('document.querySelector("#select").value')).toBe('B');
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...await center('#scroll'), deltaX: 0, deltaY: 150 });
    await expect.poll(() => read('document.querySelector("#scroll").scrollTop')).toBeGreaterThan(0);
    const from = await center('#drag'); const to = await center('#zone');
    await mouse('mouseMoved', from); await mouse('mousePressed', from); await mouse('mouseMoved', { ...to, buttons: 1 });
    lostNextType = 'mouseReleased';
    await mouse('mouseReleased', to);
    expect(await read('fixture.drops')).toBe(1);
    await execute('resume_workspace_automation', { workspace_ref: workspace });
    expect(trace.filter(row => row.method === 'Input.dispatchMouseEvent' && object(row.params).type === 'mouseReleased' && object(row.params).x === to.x)).toHaveLength(1);
    pass('click text selection scroll and drag; lost release confirmation produces one drop');

    await mouse('mouseMoved', from); await mouse('mousePressed', from);
    const beforeCrash = trace.length;
    const exited = once(broker!, 'exit'); broker!.kill('SIGKILL'); await exited;
    await startBroker(); await connect('codex');
    await expect.poll(async () => {
      const profiles = object((await call('list_browser_profiles', {})).facts).profiles as Json[];
      return profiles.some(profile => profile.ready);
    }, { timeout: 30000 }).toBe(true);
    const recovery = object((await context()).input_recovery);
    expect(recovery.held_inputs).toContain('mouse:left');
    expect((await call('send_cdp_command', { workspace_ref: workspace, target: { kind: 'tab', tab_ref: tab }, method: 'Input.insertText', params: { text: 'blocked' } })).disposition).toBe('rejected');
    await raw('DOM.getDocument', {});
    expect(trace.slice(beforeCrash).some(row => String(row.method).startsWith('Input.'))).toBe(false);
    const pausedWorkspace = workspace;
    const pausedTab = tab;
    const pausedBrowserTabId = object(trace[beforeCrash - 1]!.tab).tabId;
    for (const separateWorkspace of [false, true]) {
      if (separateWorkspace) {
        await connect('codex', 'independent-workspace');
        const allocation = await execute('request_browser_workspace', { required_workspace_count: 1,
          designated_endpoints: [{ endpoint_nickname: nickname, window_ref: object(resolved.workspace).window_ref }] });
        const next = (object(object(allocation.result).facts).resolved as Json[])[0]!;
        expect(object(next.workspace).window_ref).toBe(object(resolved.workspace).window_ref);
        workspace = String(object(next.workspace).workspace_ref);
        tab = String((next.tabs as Json[])[0]!.tab_ref);
      } else {
        const created = await execute('create_browser_tab', { workspace_ref: workspace });
        tab = String(object(object(object(created.result).facts).tab).tab_ref);
      }
      await cdp('Page.navigate', { url: `http://fixture.test:${sitePort}/independent-${separateWorkspace}` });
      await expect.poll(() => read('document.title'), { timeout: 15000 }).toBe('Tabro input fixture');
      expect((await context()).input_recovery).toBeNull();
      await bringToFront();
      await click('#button'); expect(await read('fixture.clicks')).toBe(1);
      await click('#text'); await cdp('Input.insertText', { text: 'new tab works' });
      expect(await read('document.querySelector("#text").value')).toBe('new tab works');
      if (separateWorkspace) {
        await execute('terminate_workspace', { workspace_ref: workspace });
        await connect('codex');
      }
      workspace = pausedWorkspace; tab = pausedTab;
      expect((await context()).input_recovery).toEqual(recovery);
      expect((await call('send_cdp_command', { workspace_ref: workspace, target: { kind: 'tab', tab_ref: tab },
        method: 'Input.insertText', params: { text: 'still blocked' } })).disposition).toBe('rejected');
    }
    expect(trace.slice(beforeCrash).filter(row => object(row.tab).tabId === pausedBrowserTabId && String(row.method).startsWith('Input.'))).toHaveLength(0);
    pass('paused tab stays locked while new tabs in its workspace and another workspace in the same window can click and type');
    // Labeled simulated user intervention, outside the action path under test.
    const tabs = await worker('chrome.tabs.query({})') as Json[];
    const testTab = tabs.find(item => item.id === pausedBrowserTabId)!;
    await worker(`chrome.debugger.sendCommand({tabId:${Number(testTab.id)}},'Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',x:700,y:500})`);
    await execute('resume_workspace_automation', { workspace_ref: workspace, input_recovery: { recovery_ref: recovery.recovery_ref, user_confirmed_released: true } });
    await bringToFront();
    await click('#button'); expect(await read('fixture.clicks')).toBe(2);
    pass('actual Broker process crash preserves held input; recovery reads and explicit acknowledgement work');

    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ShiftLeft', key: 'Shift' });
    const timeoutStart = trace.length;
    await expect.poll(async () => object((await context()).input_recovery).status, { timeout: 35000, interval: 500 }).toBe('paused');
    expect(trace.slice(timeoutStart).some(row => String(row.method).startsWith('Input.'))).toBe(false);
    const modifierRecovery = object((await context()).input_recovery);
    await worker(`chrome.debugger.sendCommand({tabId:${Number(testTab.id)}},'Input.dispatchKeyEvent',{type:'keyUp',code:'ShiftLeft',key:'Shift'})`);
    await execute('resume_workspace_automation', { workspace_ref: workspace, input_recovery: { recovery_ref: modifierRecovery.recovery_ref, user_confirmed_released: true } });
    pass('real thirty-second modifier inactivity pauses without release or replay');
    await cdp('Page.navigate', { url: `http://fixture.test:${sitePort}/redirect` });
    await expect.poll(() => read('location.hostname')).toBe('other.test');
    await cdp('Runtime.evaluate', { expression: 'document.querySelector("#text").value="standard"' });
    expect(await read('document.querySelector("#text").value')).toBe('standard');
    await cdp('Page.navigate', { url: `http://nested.fixture.test:${sitePort}/any/path` });
    await expect.poll(() => read('document.title')).toBe('Tabro input fixture');
    await cdp('Runtime.evaluate', { expression: 'document.querySelector("#text").value="blocked"' }, 'INPUT_ONLY_REQUIRED');
    pass('current-domain navigation and nested subdomain enforcement');
    writeFileSync(rulesFile, '{'); await expect.poll(async () => object(object((await context()).tab).interaction_policy).diagnostic).toBeTruthy();
    await cdp('DOM.focus', { nodeId: 1 }, 'INPUT_ONLY_REQUIRED');
    writeFileSync(rulesFile, JSON.stringify({ schemaVersion: 1, rules: [] }));
    await expect.poll(async () => object(object((await context()).tab).interaction_policy).mode).toBe('standard');
    await cdp('Runtime.evaluate', { expression: 'document.querySelector("#text").value="removed"' });
    pass('live invalid edit retains rules and explicit empty list removes them');
    await execute('terminate_workspace', { workspace_ref: workspace });
    await connect('hermes'); expect((await call('list_browser_profiles', {})).disposition).toBe('complete');
    pass('packaged stdio adapter supports Codex and Hermes session identities (client applications not exercised)');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error);
    report.browserLog = browserLog;
    if (control && workerSession) {
      try { report.extensionStatus = await worker("chrome.storage.local.get(['connectionStatus', 'lastError', 'transportKind'])"); }
      catch (statusError) { report.extensionStatusError = String(statusError); }
      try {
        const screenshot = await worker('(async()=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url?.includes(".test:"));return tab?await chrome.debugger.sendCommand({tabId:tab.id},"Page.captureScreenshot",{}):null})()');
        if (screenshot && typeof object(screenshot).data === 'string') {
          mkdirSync(resolve(evidence, '..'), { recursive: true });
          const path = evidence.replace(/\.json$/u, '-failure.png');
          writeFileSync(path, Buffer.from(String(object(screenshot).data), 'base64')); report.failureScreenshot = path;
        }
      } catch (captureError) { report.screenshotError = String(captureError); }
    }
    throw error;
  } finally {
    await (client as Client | null)?.close().catch(() => {});
    await Promise.allSettled(additionalClients.map(extra => extra.close()));
    if (control) { await control.send('Browser.close').catch(() => {}); await control.disconnect(); }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, 'exit'); browser.kill(); await exited;
    }
    const activeBroker = broker as ChildProcess | null;
    if (activeBroker && activeBroker.exitCode === null && activeBroker.signalCode === null) { const exited = once(activeBroker, 'exit'); activeBroker.kill('SIGTERM'); await exited; }
    // Windows termination does not run the process's SIGTERM handler. Remove
    // only this fixture's discovery record after its owned child has exited.
    if (activeBroker && runtime.processId === activeBroker.pid && typeof runtime.instanceRef === 'string') {
      removeBrokerRuntime(runtimeFile, runtime.instanceRef);
    }
    if (previousRules) writeFileSync(rulesFile, previousRules);
    else rmSync(rulesFile, { force: true });
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolveClose => bridge.close(() => resolveClose()));
    site.closeAllConnections(); await new Promise<void>(resolveClose => site.close(() => resolveClose()));
    mkdirSync(resolve(evidence, '..'), { recursive: true });
    writeFileSync(evidence, JSON.stringify({ ...report, trace, events, effects, brokerLog: logs }, null, 2));
    rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
}, qualificationTimeoutMs);

it.runIf(!!process.env.TABRO_QUALIFY_PACKAGE)('loads changed managed extension bytes after a same-version upgrade without losing identity', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tabro-worker-upgrade-')));
  const source = join(root, 'source'); mkdirSync(source);
  const nativeManifest = join(root, 'native.json'); writeFileSync(nativeManifest, '{}');
  const browserPath = process.env.TABRO_QUALIFY_CHROME ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/opt/google/chrome/chrome');
  const packageRoot = resolve(process.env.TABRO_QUALIFY_PACKAGE!);
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'runtime/browser-extension/manifest.json'), 'utf8')) as Json;
  const profile = { dataDirKey: crypto.randomUUID() } as ManagedProfile;
  const { dataDir, extensionDir } = profileLayout(root, profile.dataDirKey);
  const config = { root, executablePath: browserPath, extensionSource: source, expectedBrowserVersion: '',
    expectedExtensionDigest: '', relayUrl: 'ws://127.0.0.1:1/relay', nativeHostManifest: nativeManifest };
  let browser: ChildProcess | null = null;
  let control: ChromeManagementConnection | null = null;
  try {
    for (const build of ['first', 'second']) {
      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Tabro upgrade fixture',
        version: '0.5.0', key: manifest.key, permissions: ['storage'], background: { service_worker: 'service-worker.js', type: 'module' } }));
      writeFileSync(join(source, 'service-worker.js'), `globalThis.fixtureBuild=${JSON.stringify(build)};chrome.runtime.onInstalled.addListener(()=>{});`);
      writeFileSync(join(source, 'options.js'), ''); writeFileSync(join(source, 'options.html'), '<title>Fixture</title>');
      config.expectedExtensionDigest = extensionDigest(source);
      new ChromeLauncher(config).prepare(profile, {});
      if (build === 'first') {
        // Seed the unchanged script URL used by installations predating this fix.
        const installed = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8')) as Json;
        object(installed.background).service_worker = 'service-worker.js';
        writeFileSync(join(extensionDir, 'manifest.json'), JSON.stringify(installed));
      }
      const portFile = join(dataDir, 'DevToolsActivePort'); rmSync(portFile, { force: true });
      browser = spawn(browserPath, [`--user-data-dir=${dataDir}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', 'about:blank'], { stdio: 'ignore' });
      await expect.poll(() => existsSync(portFile), { timeout: 15000 }).toBe(true);
      const [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/u);
      control = await ChromeManagementConnection.connect(`ws://127.0.0.1:${port}${path}`);
      const { id } = await control.send('Extensions.loadUnpacked', { path: extensionDir });
      let session = '';
      await expect.poll(async () => {
        const targets = (await control!.send('Target.getTargets')).targetInfos as Json[];
        const worker = targets.find(item => item.type === 'service_worker' && String(item.url).startsWith(`chrome-extension://${id}/`));
        if (!worker) return false;
        session = String((await control!.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId);
        return true;
      }, { timeout: 15000 }).toBe(true);
      await expect.poll(async () => object((await control!.send('Runtime.evaluate', {
        expression: 'globalThis.fixtureBuild', returnByValue: true
      }, session)).result).value, { timeout: 5000 }).toBe(build);
      const storage = await control.send('Runtime.evaluate', { expression: build === 'first'
        ? 'chrome.storage.local.set({identity:"preserved"})' : 'chrome.storage.local.get("identity")', awaitPromise: true, returnByValue: true }, session);
      if (build === 'second') expect(object(storage.result).value).toEqual({ identity: 'preserved' });
      const exited = once(browser, 'exit'); await control.send('Browser.close'); await exited;
      await control.disconnect(); control = null; browser = null;
    }
  } finally {
    if (control) { await control.send('Browser.close').catch(() => {}); await control.disconnect(); }
    if (browser && browser.exitCode === null && browser.signalCode === null) { const exited = once(browser, 'exit'); browser.kill(); await exited; }
    rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
}, 60000);
