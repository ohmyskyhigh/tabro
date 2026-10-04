import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRelayApplication } from '../apps/broker/src/runtime/bootstrap.js';
import { loadConfig } from '../apps/broker/src/runtime/config.js';
import { extensionDigest, type ProfileRuntimeConfig } from '../apps/broker/src/profiles/runtime-config.js';
import { assertFreshProbeRoot } from './lib/chrome-probe-control.js';
import { validateProbeRunId } from '../tests/helpers/managed-chrome-probe-fixture.js';

const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9) ?? '';
validateProbeRunId(runId);
const root = resolve('artifacts/real-world', runId, 'profile-manager');
assertFreshProbeRoot(root); mkdirSync(root, { recursive: true });
const runtime: ProfileRuntimeConfig = {
  root, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  extensionSource: resolve('dist/browser-extension'), expectedBrowserVersion: '153.0.8010.53',
  expectedExtensionDigest: extensionDigest(resolve('dist/browser-extension')), relayUrl: 'ws://127.0.0.1:1/relay'
};
let config = { ...loadConfig({ RELAY_DB_PATH: resolve(root, 'relay.sqlite'), RELAY_MCP_PORT: '0', RELAY_WS_PORT: '0',
  RELAY_ADMIN_TOKEN: randomBytes(32).toString('base64url'), RELAY_LOG_LEVEL: 'silent' }), profiles: runtime };
let app = createRelayApplication(config);
const checks: string[] = [];
let failure: string | null = null;
try {
  await app.start();
  runtime.relayUrl = `ws://127.0.0.1:${app.extensionGateway.address().port}/relay`;
  config = { ...config, mcpPort: app.mcpGateway.address().port, wsPort: app.extensionGateway.address().port };
  const principal = app.store.createAgent('Manager probe', ['profiles:read', 'profiles:manage']).principal;
  const profile = app.store.profiles.create(principal.principalId, 'chrome-153');
  const result = await app.profileManager!.run('create_browser_profile', profile);
  if (result.ready !== true) throw new Error('Profile was not ready');
  checks.push('formal-launcher-managed-auth-ready'); console.error('PASS formal launcher + managed authentication');
  const identity = app.store.profiles.get(profile.profileRef)!.identityHash;
  await app.profileManager!.run('stop_browser_profile', app.store.profiles.get(profile.profileRef)!);
  if (app.store.profiles.currentInstance(profile.profileRef)) throw new Error('Instance did not end');
  checks.push('normal-stop-retains-profile');
  await app.profileManager!.run('open_browser_profile', app.store.profiles.get(profile.profileRef)!);
  if (app.store.profiles.get(profile.profileRef)!.identityHash !== identity) throw new Error('Profile identity changed');
  checks.push('reopen-retains-identity'); console.error('PASS stop + reopen');
  await app.stop(); app = createRelayApplication(config); await app.start();
  await app.profileManager!.run('open_browser_profile', app.store.profiles.get(profile.profileRef)!);
  if (app.store.profiles.currentInstance(profile.profileRef)!.generation !== 2) throw new Error('Broker restart launched another instance');
  checks.push('broker-restart-reuses-current-instance'); console.error('PASS Broker restart');
  await app.profileManager!.run('stop_browser_profile', app.store.profiles.get(profile.profileRef)!);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(error instanceof Error ? error.stack : `FAIL ${failure}`); process.exitCode = 1;
} finally {
  for (const profile of app.store.profiles.all()) {
    if (app.store.profiles.currentInstance(profile.profileRef)) {
      try { await app.profileManager!.run('stop_browser_profile', profile); }
      catch (error) { console.error(`Cleanup requires inspection: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  writeFileSync(resolve(root, 'report.json'), JSON.stringify({ runId, checks, failure, status: failure ? 'failed' : 'passed', finishedAt: new Date().toISOString() }, null, 2));
  await app.stop();
}
