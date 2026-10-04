import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import process from 'node:process';

// The PowerShell caller holds the shared startup mutex. Explicit Node stdio
// handles keep the detached Broker from inheriting the caller's MCP pipes.
const root = resolve(process.argv[2]);
const data = resolve(root, 'data');
const resultFile = resolve(process.argv[3]);
if (!resultFile.startsWith(data + sep)) throw new Error('Startup result must stay in the installation data directory.');
const report = value => writeFileSync(resultFile, JSON.stringify(value) + '\n', { flag: 'wx' });
const state = JSON.parse(readFileSync(resolve(root, 'installation.json'), 'utf8'));
const runtime = resolve(root, state.runtimeDirectory);
if (!runtime.startsWith(root + sep)) throw new Error('Runtime directory escapes the installation.');
const runtimeFile = resolve(data, 'runtime.json');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

async function readHealthy() {
  if (!existsSync(runtimeFile)) return null;
  const record = JSON.parse(readFileSync(runtimeFile, 'utf8'));
  if (record.schemaVersion !== 1 || !Number.isInteger(record.processId) || record.processId <= 0) throw new Error('Invalid Broker discovery record.');
  if (!alive(record.processId)) return null;
  const url = new URL(record.mcpUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp' || record.databasePath !== resolve(data, 'relay.sqlite')) throw new Error('Broker discovery does not match this local installation.');
  const health = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(1500) }).then(response => response.json());
  if (health.status !== 'ok' || health.instanceRef !== record.instanceRef || health.serviceVersion !== state.version || health.mcpContractVersion !== '5') throw new Error('Existing Broker has incompatible health or protocol.');
  return { processId: record.processId, runtime: { runtimeFile, mcpUrl: record.mcpUrl, relayUrl: record.relayUrl, health } };
}

try {
  const current = await readHealthy();
  if (current) {
    report({ status: 'already_running', ...current });
  } else {
    const environment = {};
    const inherited = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'userprofile', 'localappdata', 'appdata', 'programfiles', 'programfiles(x86)', 'programw6432', 'psmodulepath', 'username', 'userdomain', 'homedrive', 'homepath']);
    for (const [key, value] of Object.entries(process.env)) if (inherited.has(key.toLowerCase())) environment[key] = value;
    Object.assign(environment, { RELAY_DB_PATH: resolve(data, 'relay.sqlite'), RELAY_HOST: '127.0.0.1', RELAY_MCP_PORT: '0', RELAY_WS_PORT: '0',
      RELAY_LOG_LEVEL: 'info', TABRO_RUNTIME_FILE: runtimeFile, TABRO_NATIVE_RUNTIME_FILE: resolve(runtime, dirname(state.nativeHostEntry), 'relay-runtime.json'), NODE_NO_WARNINGS: '1' });
    const config = resolve(data, 'managed-profiles.json');
    if (existsSync(config)) environment.RELAY_PROFILES_CONFIG = config;
    const out = openSync(resolve(data, 'broker.stdout.log'), 'a');
    const err = openSync(resolve(data, 'broker.stderr.log'), 'a');
    let child;
    try { child = spawn(process.execPath, [resolve(runtime, 'broker/main.js')], { cwd: root, env: environment, detached: true, windowsHide: true, stdio: ['ignore', out, err] }); }
    finally { closeSync(out); closeSync(err); }
    let failed;
    child.on('error', error => { failed = error; });
    let exited = false;
    child.on('exit', () => { exited = true; });
    child.unref();
    let ready;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await delay(250);
      if (failed) throw failed;
      if (exited) throw new Error('Broker exited during startup. See broker.stderr.log.');
      try { ready = await readHealthy(); } catch { continue; }
      if (ready && ready.processId === child.pid) break;
      ready = null;
    }
    if (!ready) { if (!exited) child.kill(); throw new Error('Broker startup timed out. See installation logs.'); }
    writeFileSync(resolve(data, 'broker.pid'), String(child.pid));
    report({ status: 'started', ...ready });
  }
} catch (error) {
  report({ status: 'error', message: error.message });
  process.exitCode = 1;
}
