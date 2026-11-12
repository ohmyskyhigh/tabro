import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';
import { ChromeManagementConnection } from '../../apps/broker/src/profiles/management-connection.js';
import { MANAGED_EXTENSION_ID } from '../../apps/broker/src/profiles/runtime-config.js';
import { MCP_TOOL_NAMES } from '../../apps/shared/protocol/src/index.js';
import { startManagedChromeProbeFixture } from '../helpers/managed-chrome-probe-fixture.js';
import { httpProxyFixture } from '../helpers/proxy-fixtures.js';
import { call, ticketRef } from '../helpers/simulated-v2-extension.js';
import { probeDashboard } from '../helpers/dashboard-probe.js';

interface Profile { profile_ref: string; endpoint_nickname: string; ownership: string; ready: boolean }
interface Workspace { workspace: { workspace_ref: string }; tabs: Array<{ tab_ref: string }> }
interface Setup { extensionPath: string; broker: { processId: number }; mcp: { command: string; args: string[]; env?: Record<string, string> } }

it.runIf(!!process.env.TABRO_QUALIFY_PACKAGE)('installs a packaged Broker and pairs real user and managed Chrome profiles', async () => {
  const windows = process.platform === 'win32';
  const packageRoot = resolve(process.env.TABRO_QUALIFY_PACKAGE!);
  const browser = process.env.TABRO_QUALIFY_CHROME ?? (windows ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/google/chrome/chrome');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tabro portable qualification-')));
  const liveWebsite = process.env.TABRO_QUALIFY_WEBSITE === '1';
  const liveDashboard = process.env.TABRO_QUALIFY_DASHBOARD === '1';
  const evidenceRoot = resolve('artifacts/qualification');
  const report: Record<string, unknown> = { status: 'running', startedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, transport: 'installed Native companion',
    website: liveWebsite ? 'https://www.selenium.dev/selenium/web/web-form.html' : null,
    packageManifestSha256: createHash('sha256').update(readFileSync(resolve(packageRoot, 'runtime-manifest.json'))).digest('hex'), checks: [], commands: [] };
  const passed = (check: string) => { (report.checks as string[]).push(check); };
  const install = resolve(root, 'Tabro 装');
  const userData = resolve(root, 'Existing Chrome');
  const nativeName = 'io.github.ohmyskyhigh.octopus_browser_relay';
  const run = (command: string, args: string[], env = process.env) => execFileSync(command, args, { encoding: 'utf8', timeout: 45_000, windowsHide: true, env });
  const powershell = (file: string, args: string[]) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve(packageRoot, file), ...args]);
  const node = (...args: string[]) => run(process.execPath, args);
  const setup = () => JSON.parse(windows
    ? powershell('setup.ps1', ['-InstallRoot', install, '-BrowserPath', browser, '-NodePath', process.execPath])
    : run(process.execPath, [resolve(packageRoot, 'setup.mjs'), '--root', install, '--browser-data-dir', userData], { ...process.env, TABRO_BROWSER_PATH: browser })) as Setup;
  const fixture = await startManagedChromeProbeFixture('portable');
  let client = new Client({ name: 'portable-qualification', version: '1' });
  const profiles = async () => (await call(client, 'list_browser_profiles', {})).facts as { profiles: Profile[] };
  const request = async <T>(tool: string, args: Record<string, unknown>, failureCode?: string) => {
    const receipt = await call(client, tool, args);
    expect(receipt.disposition, JSON.stringify(receipt)).toBe('accepted');
    const request_ref = ticketRef(receipt);
    let ticket: { state: string; phase?: string; failure: unknown; result: { facts: T } } | undefined;
    // A profile launch can take 30s for Chrome and another 120s for extension readiness.
    const timeout = /^(create|open|stop)_browser_profile$/u.test(tool) ? 165_000 : 45_000;
    try {
      await expect.poll(async () => {
        const status = await call(client, 'get_browser_request', { request_ref });
        ticket = (status.facts as { ticket: NonNullable<typeof ticket> }).ticket;
        return ticket.state;
      }, { timeout, interval: 250 }).toMatch(/^(succeeded|failed|cancelled|uncertain)$/u);
    } catch (error) {
      report.pendingRequest = { tool, state: ticket?.state, phase: ticket?.phase };
      throw error;
    }
    await call(client, 'close_browser_request', { request_ref });
    if (failureCode) {
      expect(ticket!.state).toBe('failed');
      expect(ticket!.failure).toMatchObject({ problem: { code: failureCode, retryable: false } });
      return ticket!.failure as T;
    }
    expect(ticket!.state, JSON.stringify(ticket!.failure)).toBe('succeeded');
    return ticket!.result.facts;
  };
  let profile: Profile | undefined;
  let workspace: Workspace | undefined;
  let userBrowser: ChildProcess | undefined;
  let browserLog = '';
  let control: ChromeManagementConnection | undefined;
  let installation: Setup | undefined;
  let proxy: Awaited<ReturnType<typeof httpProxyFixture>> | undefined;
  let credential: string | undefined;
  const stop = () => windows ? powershell('stop.ps1', ['-InstallRoot', install]) : node(resolve(install, 'tabro.mjs'), 'stop');
  async function verifyBrowser(profile: Profile, url: string, title: string): Promise<void> {
    ({ resolved: [workspace] } = await request<{ resolved: Workspace[] }>('request_browser_workspace', {
      required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: profile.endpoint_nickname }]
    }));
    const workspace_ref = workspace!.workspace.workspace_ref;
    const target = { kind: 'tab', tab_ref: workspace!.tabs[0]!.tab_ref };
    await request('send_cdp_command', { workspace_ref, target, method: 'Page.navigate', params: { url } });
    await expect.poll(async () => JSON.stringify(await request('send_cdp_command', { workspace_ref, target, method: 'Runtime.evaluate',
      params: { expression: 'document.title', returnByValue: true } })), { timeout: 15_000 }).toContain(title);
    await request('terminate_workspace', { workspace_ref });
    workspace = undefined;
  }
  async function verifyPublicWebsite(profile: Profile): Promise<void> {
    ({ resolved: [workspace] } = await request<{ resolved: Workspace[] }>('request_browser_workspace', {
      required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: profile.endpoint_nickname }]
    }));
    const workspace_ref = workspace!.workspace.workspace_ref;
    const tab_ref = workspace!.tabs[0]!.tab_ref;
    const cdp = async (method: string, params: Record<string, unknown>, failureCode?: string) => {
      const entry = { method, params, outcome: 'pending' };
      (report.commands as unknown[]).push(entry);
      try {
        const result = await request<{ command: { result: Record<string, unknown> } }>('send_cdp_command', {
          workspace_ref, target: { kind: 'tab', tab_ref }, method, params
        }, failureCode);
        entry.outcome = failureCode ?? 'succeeded';
        return failureCode ? result : result.command.result;
      } catch (error) { entry.outcome = 'failed'; throw error; }
    };
    const read = async (expression: string) => {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true }) as { exceptionDetails?: unknown; result: { value: unknown } };
      expect(result.exceptionDetails).toBeUndefined(); return result.result.value;
    };
    const mouse = async (type: string, x: number, y: number) => cdp('Input.dispatchMouseEvent', {
      type, x, y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 })
    });
    const click = async (selector: string) => {
      const document = await cdp('DOM.getDocument', {}) as { root: { nodeId: number } };
      const node = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector }) as { nodeId: number };
      const box = await cdp('DOM.getBoxModel', { nodeId: node.nodeId }) as { model: { content: number[] } };
      const points = box.model.content; const x = (points[0]! + points[4]!) / 2; const y = (points[1]! + points[5]!) / 2;
      await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y);
    };
    const key = async (code: string, windowsVirtualKeyCode: number) => {
      for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, code, key: code, windowsVirtualKeyCode });
    };
    const screenshot = async (name: string) => {
      const result = await cdp('Page.captureScreenshot', { format: 'png' }) as { data: string };
      mkdirSync(evidenceRoot, { recursive: true });
      writeFileSync(resolve(evidenceRoot, `${process.platform}-${process.arch}-${name}.png`), Buffer.from(result.data, 'base64'));
    };
    await cdp('Page.navigate', { url: report.website }); await cdp('Page.bringToFront', {});
    await expect.poll(() => read('document.title'), { timeout: 30000 }).toBe('Web form');
    await expect.poll(() => read('document.readyState'), { timeout: 30000 }).toBe('complete');
    const context = await call(client, 'get_browser_context', { view: { kind: 'tab', workspace_ref, tab_ref } });
    expect(context).toMatchObject({ facts: { tab: { interaction_policy: { mode: 'input_only', matched_domain: 'selenium.dev' } } } });
    report.policy = context.facts;
    await cdp('Runtime.evaluate', { expression: 'document.querySelector("#my-text-id").value="forbidden"' }, 'INPUT_ONLY_REQUIRED');
    await cdp('Runtime.evaluate', { expression: 'document.querySelector("#my-check-2").click()' }, 'INPUT_ONLY_REQUIRED');
    expect(await read('document.querySelector("#my-text-id").value')).toBe('');
    expect(await read('document.querySelector("#my-check-2").checked')).toBe(false);
    passed('public website: scripted value assignment and click refused with unchanged controls');
    await click('#my-text-id'); await cdp('Input.insertText', { text: 'Tabro end-to-end 世界' });
    await click('[name="my-textarea"]'); await cdp('Input.insertText', { text: 'Tested through MCP, Broker, Native companion and Chrome.' });
    await click('#my-check-2'); await click('#my-radio-2');
    expect(await read('document.querySelector("#my-text-id").value')).toBe('Tabro end-to-end 世界');
    expect(await read('document.querySelector("#my-check-2").checked')).toBe(true);
    expect(await read('document.querySelector("#my-radio-2").checked')).toBe(true);
    passed('public website: real pointer input, Unicode typing, textarea, checkbox and radio readback');
    // Keep the native popup closed: focus through normal Tab navigation and use
    // the select control's keyboard type-ahead behavior.
    await click('[name="my-textarea"]');
    const focusTrail: unknown[] = [];
    for (let index = 0; index < 8 && await read('document.activeElement?.name') !== 'my-select'; index++) {
      await key('Tab', 9); focusTrail.push(await read('document.activeElement?.name || document.activeElement?.tagName'));
    }
    report.focusTrail = focusTrail;
    expect(await read('document.activeElement?.name')).toBe('my-select');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyT', key: 't', text: 't', windowsVirtualKeyCode: 84 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyT', key: 't', windowsVirtualKeyCode: 84 });
    expect(await read('document.querySelector("[name=my-select]").value')).toBe('2');
    passed('public website: native select focused with Tab and selected Two through keyboard type-ahead');
    await screenshot('selenium-form-filled');
    await click('button[type="submit"]');
    await expect.poll(() => read('document.querySelector("#message")?.textContent'), { timeout: 30000 }).toBe('Received!');
    const frames = await cdp('Page.getFrameTree', {}) as { frameTree: { frame: { url: string } } };
    // Parse outside the website: Chrome's side-effect guard may refuse URL helpers
    // even when the caller only intends to observe.
    expect(new URL(frames.frameTree.frame.url).searchParams.get('my-text')).toBe('Tabro end-to-end 世界');
    report.submittedUrl = frames.frameTree.frame.url;
    await screenshot('selenium-form-submitted');
    passed('public website: input-only submit navigated to Received and retained the submitted Unicode value');
    await request('terminate_workspace', { workspace_ref }); workspace = undefined;
  }
  try {
    installation = setup();
    if (windows) {
      // The native resolver expands Windows 8.3 aliases before comparing the install roots.
      expect(realpathSync.native(installation.mcp.env!.TABRO_INSTALL_ROOT!).toLowerCase())
        .toBe(realpathSync.native(install).toLowerCase());
    }
    const rulesPath = resolve(install, 'data/browser-rules.json');
    let savedRules = JSON.stringify({ schemaVersion: 1, rules: [
      { id: 'preserved', domain: 'preserved.example', mode: 'input_only' },
      ...(liveWebsite ? [{ id: 'selenium-input-only', domain: 'selenium.dev', mode: 'input_only' }] : [])
    ] }, null, 2);
    expect(JSON.parse(readFileSync(rulesPath, 'utf8'))).toEqual({ schemaVersion: 1, rules: [] });
    writeFileSync(rulesPath, savedRules);
    const managedConfigPath = resolve(install, 'data/managed-profiles.json');
    const readManagedConfig = () => JSON.parse(readFileSync(managedConfigPath, 'utf8')) as { root: string; executablePath: string };
    const previousConfig = readManagedConfig();
    expect(setup().broker.processId).toBe(installation.broker.processId);
    expect(readManagedConfig()).toMatchObject({ root: previousConfig.root, executablePath: previousConfig.executablePath });
    expect(readFileSync(rulesPath, 'utf8')).toBe(savedRules);
    passed('installer initializes rules and preserves edited rules on repeated setup');
    const state = JSON.parse(readFileSync(resolve(install, 'installation.json'), 'utf8')) as { runtimeDirectory: string; nodePath: string; contractVersion: string };
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'runtime-manifest.json'), 'utf8')) as { contractVersion: string };
    expect(state.contractVersion).toBe(manifest.contractVersion);
    expect(existsSync(resolve(install, state.runtimeDirectory, 'native-host/relay-runtime.json'))).toBe(windows);
    const env = { ...getDefaultEnvironment(), ...installation.mcp.env, TABRO_RUNTIME: 'qualification' };
    const connect = () => client.connect(new StdioClientTransport({ ...installation!.mcp, env, stderr: 'inherit' }));
    await connect();
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([...MCP_TOOL_NAMES]);

    userBrowser = spawn(browser, [`--user-data-dir=${userData}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
      ...(liveDashboard ? ['--host-resolver-rules=MAP *.test 127.0.0.1', '--no-proxy-server'] : []),
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--enable-logging=stderr', fixture.url],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    userBrowser.stderr?.on('data', (chunk: Buffer) => { browserLog = (browserLog + chunk.toString('utf8')).slice(-16_384); });
    const portFile = resolve(userData, 'DevToolsActivePort');
    await expect.poll(() => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('/devtools/browser/'), { timeout: 25_000 }).toBe(true);
    const [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/u);
    control = await ChromeManagementConnection.connect(`ws://127.0.0.1:${port}${path}`);
    report.browser = await control.send('Browser.getVersion');
    expect((await control.send('Extensions.loadUnpacked', { path: installation.extensionPath })).id).toBe(MANAGED_EXTENSION_ID);
    await expect.poll(async () => (await profiles()).profiles.some(item => item.ownership === 'user' && item.ready), { timeout: 25_000 }).toBe(true);
    passed('unmodified packaged extension connected through the installed Native companion');
    if (liveDashboard) {
      const checks = await probeDashboard(control, MANAGED_EXTENSION_ID, rulesPath, evidenceRoot, async () => {
        const profile = (await profiles()).profiles.find(item => item.ownership === 'user' && item.ready)!;
        ({ resolved: [workspace] } = await request<{ resolved: Workspace[] }>('request_browser_workspace', {
          required_workspace_count: 1, designated_endpoints: [{ endpoint_nickname: profile.endpoint_nickname }]
        }));
        const scope = { workspace_ref: workspace!.workspace.workspace_ref, target: { kind: 'tab', tab_ref: workspace!.tabs[0]!.tab_ref } };
        const url = new URL(fixture.url); url.hostname = 'fixture.test';
        await request('send_cdp_command', { ...scope, method: 'Page.navigate', params: { url: url.toString() } });
        await expect.poll(async () => JSON.stringify(await request('send_cdp_command', { ...scope, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } }))).toContain('Tabro managed profile probe');
        await request('send_cdp_command', { ...scope, method: 'Runtime.evaluate', params: { expression: 'document.body.setAttribute("data-test","blocked")' } }, 'INPUT_ONLY_REQUIRED');
        await request('terminate_workspace', { workspace_ref: scope.workspace_ref }); workspace = undefined;
      });
      for (const check of checks) passed(check);
      savedRules = readFileSync(rulesPath, 'utf8');
    }
    if (liveWebsite) await verifyPublicWebsite((await profiles()).profiles.find(item => item.ownership === 'user' && item.ready)!);

    ({ profile } = await request<{ profile: Profile }>('create_browser_profile', { idempotency_key: 'portable-install-profile' }));
    expect(profile).toMatchObject({ ownership: 'broker', ready: true });
    await verifyBrowser(profile, fixture.url, 'Tabro managed profile probe');
    passed('Broker-owned profile launches with automatic extension and completes an MCP browser action');
    const profile_ref = profile.profile_ref;
    await request('stop_browser_profile', { profile_ref });
    if (windows || process.env.TABRO_QUALIFY_CREDENTIALS === '1') {
      const command = windows ? [resolve(install, state.runtimeDirectory, 'broker/provision-proxy-credential.js')] : [resolve(install, 'tabro.mjs'), 'credentials'];
      const output = execFileSync(state.nodePath, command, { encoding: 'utf8', timeout: 20_000,
        input: JSON.stringify({ username: 'fixture-user', password: 'fixture:p@ss/#' }),
        env: { ...process.env, RELAY_DB_PATH: resolve(install, 'data/relay.sqlite'), NODE_NO_WARNINGS: '1' } });
      credential = (JSON.parse(output) as { credential_ref: string }).credential_ref;
      proxy = await httpProxyFixture(false, '<!doctype html><title>Tabro authenticated proxy</title>');
      await request('set_browser_proxy', { profile_ref, expected_revision: 0, idempotency_key: 'portable-install-proxy',
        proxy: { scheme: 'http', host: '127.0.0.1', port: proxy.port, credential_ref: credential } });
    }
    const opened = await request<{ profile: Profile }>('open_browser_profile', { profile_ref });
    expect(opened.profile).toMatchObject({ endpoint_nickname: profile.endpoint_nickname, profile_ref, ready: true });
    if (proxy) {
      await verifyBrowser(opened.profile, 'http://tabro-qualification.test/', 'Tabro authenticated proxy');
      expect(proxy.count()).toBeGreaterThan(0);
    }
    await request('stop_browser_profile', { profile_ref });
    profile = undefined;
    const initialBrokerPid = installation.broker.processId;
    await client.close();
    stop();
    client = new Client({ name: 'portable-qualification-restart', version: '1' });
    await connect();
    expect((JSON.parse(readFileSync(resolve(install, 'data/runtime.json'), 'utf8')) as { processId: number }).processId).not.toBe(initialBrokerPid);
    expect(readFileSync(rulesPath, 'utf8')).toBe(savedRules);
    await expect.poll(async () => (await profiles()).profiles.some(item => item.ownership === 'user' && item.ready), { timeout: 35_000 }).toBe(true);
    ({ profile } = await request<{ profile: Profile }>('open_browser_profile', { profile_ref }));
    expect(profile).toMatchObject({ endpoint_nickname: opened.profile.endpoint_nickname, ready: true });
    await request('stop_browser_profile', { profile_ref });
    profile = undefined;
    passed('Broker restart preserves rules and reconnects both user-owned and Broker-owned profiles');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error);
    report.browserLog = browserLog;
    try {
      const data = resolve(install, 'data');
      const config = JSON.parse(readFileSync(resolve(data, 'managed-profiles.json'), 'utf8')) as { root: string };
      const profilesRoot = resolve(config.root, 'profiles');
      const diagnostics: unknown[] = [];
      report.managedExtensionDiagnostics = diagnostics;
      for (const name of existsSync(profilesRoot) ? readdirSync(profilesRoot) : []) {
        const portFile = resolve(profilesRoot, name, 'user-data', 'DevToolsActivePort');
        if (!existsSync(portFile)) continue;
        const [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/u);
        if (!/^\d+$/u.test(port ?? '') || !/^\/devtools\/browser\/[\w-]+$/u.test(path ?? '')) continue;
        let managed: ChromeManagementConnection | undefined;
        try {
          managed = await ChromeManagementConnection.connect(`ws://127.0.0.1:${port}${path}`);
          const { targetId } = await managed.send('Target.createTarget', { url: `chrome-extension://${MANAGED_EXTENSION_ID}/options.html` });
          try {
            const { sessionId } = await managed.send('Target.attachToTarget', { targetId, flatten: true });
            const status = await managed.send('Runtime.evaluate', {
              expression: "chrome.storage.local.get(['connectionStatus', 'lastError', 'transportKind'])", awaitPromise: true, returnByValue: true
            }, String(sessionId));
            diagnostics.push({ name, status });
          } finally { await managed.send('Target.closeTarget', { targetId }); }
        } catch (diagnosticError) { diagnostics.push({ name, error: String(diagnosticError) }); }
        finally { await managed?.disconnect(); }
      }
    } catch (diagnosticError) { report.managedExtensionDiagnosticError = String(diagnosticError); }
    if (control) {
      try {
        const { targetId } = await control.send('Target.createTarget', { url: `chrome-extension://${MANAGED_EXTENSION_ID}/options.html` });
        try {
          const { sessionId } = await control.send('Target.attachToTarget', { targetId, flatten: true });
          report.extensionStatus = await control.send('Runtime.evaluate', {
            expression: "chrome.storage.local.get(['connectionStatus', 'lastError', 'transportKind'])", awaitPromise: true, returnByValue: true
          }, String(sessionId));
        } finally { await control.send('Target.closeTarget', { targetId }); }
      } catch (diagnosticError) { report.extensionStatusError = String(diagnosticError); }
    }
    if (workspace) {
      try {
        const capture = await request<{ command: { result: { data: string } } }>('send_cdp_command', {
          workspace_ref: workspace.workspace.workspace_ref, target: { kind: 'tab', tab_ref: workspace.tabs[0]!.tab_ref },
          method: 'Page.captureScreenshot', params: { format: 'png' }
        });
        mkdirSync(evidenceRoot, { recursive: true });
        const path = resolve(evidenceRoot, `${process.platform}-${process.arch}-website-failure.png`);
        writeFileSync(path, Buffer.from(capture.command.result.data, 'base64')); report.failureScreenshot = path;
      } catch (captureError) { report.screenshotError = String(captureError); }
    }
    throw error;
  } finally {
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(resolve(evidenceRoot, `${process.platform}-${process.arch}-portable-installation.json`), JSON.stringify(report, null, 2));
    if (workspace) await request('terminate_workspace', { workspace_ref: workspace.workspace.workspace_ref }).catch(() => {});
    if (profile) await request('stop_browser_profile', { profile_ref: profile.profile_ref }).catch(() => {});
    await client.close();
    if (control) {
      await control.send('Browser.close').catch(() => {});
      await control.disconnect();
    }
    if (userBrowser && userBrowser.exitCode === null && userBrowser.signalCode === null) userBrowser.kill();
    await fixture.close();
    await proxy?.close();
    if (credential && !windows) {
      const account = `${createHash('sha256').update(resolve(install, 'data/proxy-credentials')).digest('hex')}:${credential}`;
      if (process.platform === 'darwin') run('/usr/bin/security', ['delete-generic-password', '-s', 'Tabro proxy credentials', '-a', account]);
      else run('secret-tool', ['clear', 'application', 'tabro', 'account', account]);
    }
    if (installation) {
      stop();
      if (windows) {
        const registered = resolve(install, 'bootstrap', `${nativeName}.json`);
        for (const vendor of ['Google\\Chrome', 'Microsoft\\Edge', 'Chromium', 'AdsPower\\SunBrowser']) {
          const key = `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${nativeName}`;
          if (run('reg.exe', ['query', key, '/ve']).includes(registered)) run('reg.exe', ['delete', key, '/f']);
        }
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}, 420_000);
