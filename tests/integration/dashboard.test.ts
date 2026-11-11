import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { OctopusBroker } from '../../apps/broker/src/core/index.js';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { BrowserRulesFile } from '../../apps/broker/src/runtime/browser-rules.js';
import { DashboardService } from '../../apps/broker/src/runtime/dashboard.js';
import { DashboardCommandSchema, type DashboardSnapshot } from '../../apps/shared/protocol/src/dashboard.js';
import { profileStatus } from '../../apps/browser-extension/src/profile-status.js';

it.each([
  { browser_state: 'running', extension_state: 'connected', ready: true, automation_paused: true, problem_code: null, connection: 'Connected', automation: 'Paused' },
  { browser_state: 'running', extension_state: 'disconnected', ready: false, automation_paused: false, problem_code: 'PROFILE_EXTENSION_TIMEOUT', connection: 'Connection failed', automation: 'Not ready' },
  { browser_state: 'running', extension_state: 'disconnected', ready: false, automation_paused: false, problem_code: null, connection: 'Disconnected', automation: 'Not ready' },
  { browser_state: 'starting', extension_state: 'disconnected', ready: false, automation_paused: false, problem_code: null, connection: 'Connecting', automation: 'Not ready' },
  { browser_state: 'stopped', extension_state: 'disconnected', ready: false, automation_paused: false, problem_code: null, connection: 'Offline', automation: 'Not ready' },
  { browser_state: 'running', extension_state: 'connected', ready: false, automation_paused: false, problem_code: 'PROFILE_PROXY_UNAVAILABLE', connection: 'Connected', automation: 'Not ready' }
])('separates connection health from automation: $connection / $automation', (scenario) => {
  const profile: DashboardSnapshot['profiles'][number] = { profile_ref: 'profile-test', endpoint_nickname: 'fixture', ownership: 'broker', observed_at: new Date().toISOString(), ...scenario };
  const status = profileStatus(profile);
  expect(status.connection.label).toBe(scenario.connection);
  expect(status.automation.label).toBe(scenario.automation);
  if (scenario.problem_code === 'PROFILE_EXTENSION_TIMEOUT') {
    expect(status.connection.tone).toBe('error');
    expect(status.connection.detail).toMatch(/timeout.*retry/u);
  }
});

it('lists registered profiles, saves shared rules and exposes no profile lifecycle or arbitrary command surface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tabro-dashboard-'));
  const store = new SqliteRelayStore(':memory:'); const broker = new OctopusBroker(store.canonical);
  try {
    const rules = new BrowserRulesFile(join(root, 'browser-rules.json'), false, () => {});
    const service = new DashboardService(broker, store, rules);
    const endpoint = broker.ensureEndpoint({ nickname: 'mintwave' });
    broker.openEndpointConnection({ endpointRef: endpoint.endpointRef, connectionRef: 'test', transport: 'test',
      protocolVersion: '2', extensionVersion: '0.5.0', browserProduct: 'Chrome', browserVersion: '157' });
    const state = service.handle(endpoint.endpointRef, { action: 'snapshot' });
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]).toMatchObject({ endpoint_nickname: 'mintwave', ownership: 'user' });
    expect(state.currentProfileRef).toBe(endpoint.endpointRef);
    expect(JSON.stringify(state)).not.toMatch(/adminToken|publicKey|privateKey|credential|relay\.sqlite/u);
    const configuration = { schemaVersion: 1 as const, rules: [{ id: 'test', domain: 'example.com', mode: 'input_only' as const }] };
    const saved = service.handle(endpoint.endpointRef, { action: 'rules.save', expectedRevision: state.rules.revision!, configuration });
    expect(saved.rules.configuration).toEqual(configuration);
    expect(JSON.parse(readFileSync(rules.path, 'utf8'))).toEqual(configuration);
    expect(() => service.handle(endpoint.endpointRef, { action: 'rules.save', expectedRevision: state.rules.revision!, configuration: { schemaVersion: 1, rules: [] } })).toThrow('RULES_CONFLICT');
    expect(() => service.handle('unknown', { action: 'snapshot' })).toThrow('PROFILE_NOT_FOUND');
    for (const command of [{ action: 'profile.open', profileRef: 'foo' }, { action: 'profile.stop', profileRef: 'foo' },
      { action: 'execute', tool: 'send_cdp_command' }, { action: 'rules.save', path: '/tmp/other', configuration },
      { action: 'snapshot', adminToken: 'injected' }]) expect(DashboardCommandSchema.safeParse(command).success).toBe(false);
  } finally { broker.beginShutdown(); await broker.waitForIdle(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
