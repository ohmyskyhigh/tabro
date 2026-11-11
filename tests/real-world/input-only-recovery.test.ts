import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
import type { ManagedProfile } from '../../apps/broker/src/profiles/types.js';
import { MCP_CONTRACT_VERSION } from '../../apps/shared/protocol/src/mcp/tool-catalog.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return value as Json;
};

// Explicit environment gate: release jobs also require the resulting PASS report.
it.runIf(!!process.env.TABRO_QUALIFY_PACKAGE)('qualifies packaged domain rules and interrupted input in isolated real Chrome', async () => {
  const packageRoot = resolve(process.env.TABRO_QUALIFY_PACKAGE!);
  const manifest = object(JSON.parse(readFileSync(join(packageRoot, 'runtime-manifest.json'), 'utf8')));
  expect(manifest.contractVersion).toBe(MCP_CONTRACT_VERSION);
  const root = mkdtempSync(join(tmpdir(), 'tabro-input-qualification-'));
  const evidence = resolve(process.env.TABRO_INPUT_EVIDENCE ?? 'artifacts/qualification', `${process.platform}-${process.arch}-input-only.json`);
  const userData = join(root, 'chrome'); mkdirSync(userData);
  const runtimeFile = join(root, 'runtime.json');
  const rulesFile = join(root, 'browser-rules.json');
  const browserPath = process.env.TABRO_QUALIFY_CHROME ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/opt/google/chrome/chrome');
  expect(existsSync(browserPath), 'A native Chrome installation is required').toBe(true);
  const rules = { schemaVersion: 1, rules: [{ id: 'fixture', domain: 'fixture.test', mode: 'input_only' }] };
  writeFileSync(rulesFile, JSON.stringify(rules));
  const token = randomBytes(32).toString('base64url');
  const trace: Json[] = [];
  const events: Json[] = [];
  const effects: string[] = [];
  const report: Json = { status: 'running', os: process.platform, arch: process.arch, contract: MCP_CONTRACT_VERSION,
    startedAt: new Date().toISOString(), sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHasLocalChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    packageManifestSha256: createHash('sha256').update(readFileSync(join(packageRoot, 'runtime-manifest.json'))).digest('hex'), checks: [] };
  const pass = (check: string) => { (report.checks as string[]).push(check); };
  let broker: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  let control: ChromeManagementConnection | null = null;
  let client: Client | null = null;
  let runtime: Json = {};
  let workerSession = '';
  let workspace = '';
  let tab = '';
  let lostNextType: string | null = null;
  let inventoriesReceived = 0;
  const attempts = new Map<string, Json>();
  const sockets = new Set<WebSocket>();
  let logs = '';

  const site = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: `http://other.test:${sitePort}/` }).end(); return; }
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
    sockets.add(socket);
    const upstream = new WebSocket(String(runtime.relayUrl), { headers: { origin: request.headers.origin ?? 'chrome-extension://caekiojlchhifdomfghejkbfpmaklafe' } });
    sockets.add(upstream);
    const waiting: string[] = [];
    upstream.on('open', () => { for (const message of waiting.splice(0)) upstream.send(message); });
    socket.on('message', data => {
      const message = object(JSON.parse(data.toString()));
      if (message.type === 'INVENTORY_SNAPSHOT') inventoriesReceived++;
      const payload = object(message.payload);
      const command = attempts.get(String(payload.attemptId));
      if (message.type === 'OPERATION_RESULT' && command && lostNextType === object(command.params).type) {
        lostNextType = null;
        // The real extension has executed and persisted the result. Drop only its delivery.
        upstream.close(); socket.close(); return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString()); else waiting.push(data.toString());
    });
    upstream.on('message', data => {
      const message = object(JSON.parse(data.toString()));
      if (message.type === 'SEND_CDP') { const payload = object(message.payload); trace.push(payload); attempts.set(String(payload.attemptId), payload); }
      if (socket.readyState === WebSocket.OPEN) socket.send(data.toString());
    });
    socket.on('close', () => { sockets.delete(socket); upstream.close(); });
    upstream.on('close', () => { sockets.delete(upstream); socket.close(); });
    upstream.on('error', () => socket.close()); socket.on('error', () => upstream.close());
  });

  async function startBroker() {
    const oldPid = broker?.pid;
    broker = spawn(process.execPath, [join(packageRoot, 'runtime/broker/main.js')], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, RELAY_DB_PATH: join(root, 'relay.sqlite'), RELAY_ADMIN_TOKEN: token, RELAY_LOG_LEVEL: 'silent',
      RELAY_MCP_PORT: runtime.mcpUrl ? new URL(String(runtime.mcpUrl)).port : '0',
      RELAY_WS_PORT: runtime.relayUrl ? new URL(String(runtime.relayUrl)).port : '0',
      TABRO_RUNTIME_FILE: runtimeFile, TABRO_NATIVE_RUNTIME_FILE: join(root, 'native-runtime.json'), TABRO_BROWSER_RULES_PATH: rulesFile
    } });
    broker.stdout?.on('data', data => { logs += String(data); }); broker.stderr?.on('data', data => { logs += String(data); });
    await expect.poll(() => {
      if (broker?.exitCode !== null) throw new Error(`Isolated Broker exited: ${logs}`);
      if (!existsSync(runtimeFile)) return false;
      const next = object(JSON.parse(readFileSync(runtimeFile, 'utf8')));
      if (next.processId !== broker?.pid || next.processId === oldPid) return false;
      runtime = next; return true;
    }, { timeout: 15000 }).toBe(true);
  }
  async function connect(runtimeName: 'codex' | 'hermes') {
    await client?.close(); client = new Client({ name: `input-qualification-${runtimeName}`, version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(packageRoot, 'runtime/adapter/main.js')],
      env: { ...getDefaultEnvironment(), TABRO_RUNTIME_FILE: runtimeFile, TABRO_TOKEN: token,
        TABRO_RUNTIME: runtimeName, TABRO_RUNTIME_SESSION: `input-qualification-${runtimeName}` }, stderr: 'pipe' }));
    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === 'send_cdp_command')?.description).toContain('INPUT_ONLY_REQUIRED');
  }
  async function call(name: string, args: Json) { return object((await client!.callTool({ name, arguments: args })).structuredContent); }
  async function execute(name: string, args: Json, failCode?: string) {
    const receipt = await call(name, args);
    expect(receipt.disposition, JSON.stringify(receipt)).toBe('accepted');
    const ref = object(object(receipt.facts).ticket).request_ref;
    let ticket: Json = {};
    await expect.poll(async () => {
      ticket = object(object((await call('get_browser_request', { request_ref: ref })).facts).ticket);
      return ticket.state;
    }, { timeout: 45000, interval: 100 }).toMatch(/^(succeeded|failed|uncertain)$/u);
    if (failCode) expect(object(object(ticket.failure).problem).code).toBe(failCode);
    else expect(ticket.state, JSON.stringify(ticket)).toBe('succeeded');
    return ticket;
  }
  const cdp = (method: string, params: Json, failCode?: string) => execute('send_cdp_command', { workspace_ref: workspace, target: { kind: 'tab', tab_ref: tab }, method, params }, failCode);
  async function raw(method: string, params: Json): Promise<Json> {
    const ticket = await cdp(method, params); return object(object(object(object(ticket.result).facts).command).result);
  }
  async function read(expression: string): Promise<unknown> {
    const result = await raw('Runtime.evaluate', { expression, returnByValue: true });
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
  async function worker(expression: string) {
    const value = await control!.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, workerSession);
    expect(value.exceptionDetails, JSON.stringify(value)).toBeUndefined(); return object(value.result).value;
  }
  try {
    await startBroker(); await connect('codex');
    browser = spawn(browserPath, [`--user-data-dir=${userData}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
      '--headless=new', '--window-size=1280,900', '--no-proxy-server', '--host-resolver-rules=MAP *.test 127.0.0.1', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', 'about:blank'], { stdio: 'ignore' });
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
      nickname = String(profiles.find(profile => profile.ready)?.endpoint_nickname ?? ''); return !!nickname;
    }, { timeout: 25000 }).toBe(true);
    const allocated = await execute('request_browser_workspace', { required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: nickname }] });
    const resolved = (object(object(allocated.result).facts).resolved as Json[])[0]!;
    workspace = String(object(resolved.workspace).workspace_ref); tab = String((resolved.tabs as Json[])[0]!.tab_ref);
    await cdp('Page.navigate', { url: `http://fixture.test:${sitePort}/` });
    await expect.poll(() => read('document.title'), { timeout: 15000 }).toBe('Tabro input fixture');
    const backgroundTab = (await worker('chrome.tabs.query({})') as Json[]).find(item => String(item.url).includes('fixture.test'))!;
    expect(backgroundTab.active).toBe(false);
    const backgroundPoint = await center('#text');
    await mouse('mouseMoved', backgroundPoint); await mouse('mousePressed', backgroundPoint);
    const previousInventoryCount = inventoriesReceived;
    // A harmless tab update publishes inventory without changing the gesture's focus.
    await worker(`chrome.tabs.update(${Number(backgroundTab.id)},{muted:true})`);
    await expect.poll(() => inventoriesReceived).toBeGreaterThan(previousInventoryCount);
    expect(object((await context()).input_recovery)).toMatchObject({ status: 'held', pause_reason: null });
    await mouse('mouseReleased', backgroundPoint);
    expect((await context()).input_recovery).toBeNull();
    expect(await read('document.activeElement.id')).toBe('text');
    pass('background click survives unchanged inventory between press and release');
    await cdp('Page.bringToFront', {});
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
      await click('#button'); expect(await read('fixture.clicks')).toBe(1);
      await click('#text'); await cdp('Input.insertText', { text: 'new tab works' });
      expect(await read('document.querySelector("#text").value')).toBe('new tab works');
      if (separateWorkspace) await execute('terminate_workspace', { workspace_ref: workspace });
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
    if (control) { await control.send('Browser.close').catch(() => {}); await control.disconnect(); }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, 'exit'); browser.kill(); await exited;
    }
    const activeBroker = broker as ChildProcess | null;
    if (activeBroker && activeBroker.exitCode === null && activeBroker.signalCode === null) { const exited = once(activeBroker, 'exit'); activeBroker.kill('SIGTERM'); await exited; }
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolveClose => bridge.close(() => resolveClose()));
    site.closeAllConnections(); await new Promise<void>(resolveClose => site.close(() => resolveClose()));
    mkdirSync(resolve(evidence, '..'), { recursive: true });
    writeFileSync(evidence, JSON.stringify({ ...report, trace, events, effects, brokerLog: logs }, null, 2));
    rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
}, 240000);

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
