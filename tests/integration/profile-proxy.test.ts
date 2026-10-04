import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { OctopusBroker, type CallerEvidence, type OctopusExtensionPort } from '../../apps/broker/src/core/index.js';
import { ProfileNetworkService } from '../../apps/broker/src/proxy/profile-network-service.js';
import { parseMcpToolInput, parseMcpToolOutput } from '../../apps/shared/protocol/src/index.js';
import { waitFor } from '../helpers/simulated-v2-extension.js';
import { ProfileManager } from '../../apps/broker/src/profiles/profile-manager.js';

describe('Profile proxy coordination', () => {
  let store: SqliteRelayStore; let broker: OctopusBroker; let network: ProfileNetworkService;
  let evidence: CallerEvidence; let connected = true; let generation = 1; let capable = true; let commands: string[]; let processClosed = true;
  let applied: { revision: number; state: string }; let profileRef: string;
  const endpoint = 'ext_proxy';
  const input = (ref = profileRef, key = 'proxy-key-0001', revision = 0) => ({ profile_ref: ref, expected_revision: revision, idempotency_key: key, proxy: { scheme: 'socks5', host: '127.0.0.1', port: 54321 } });
  beforeEach(() => {
    store = new SqliteRelayStore(':memory:'); broker = new OctopusBroker(store.canonical);
    const principal = store.createAgent('network agent', ['profiles:read', 'profiles:network:manage']).principal;
    evidence = { runtimeName: 'test', runtimeSessionKey: 'agent-one', managementAuthority: principal };
    store.canonical.logical.createEndpoint({ endpointRef: endpoint, nickname: 'proxypanda' });
    const profile = store.profiles.create(principal.principalId, 'chrome'); profileRef = profile.profileRef; store.profiles.bind(profileRef, endpoint, 'identity');
    broker.openEndpointConnection({ endpointRef: endpoint, connectionRef: 'connection', transport: 'test', protocolVersion: '2' });
    connected = false; generation = 1; capable = true; commands = []; processClosed = true; applied = { revision: 0, state: 'unmanaged' };
    const port = {
      connection: () => ({ endpointRef: endpoint, connectionGeneration: generation, inventoryGeneration: 1, connected, profileProxy: capable }),
      execute: async (_ref: string, _type: string, payload: { action: string; revision: number }) => {
        commands.push(payload.action);
        if (payload.action === 'apply') applied = { revision: payload.revision, state: 'applied' };
        if (payload.action === 'clear') applied = { revision: payload.revision, state: 'unmanaged' };
        return { outcome: 'succeeded', result: { ...applied, ...(payload.action === 'probe' ? { exit: { ip: '203.0.113.7', revision: payload.revision, latency_ms: 12, observed_at: new Date().toISOString(), source: 'browser' } } : {}) } };
      }
    } as unknown as OctopusExtensionPort;
    const profiles = new ProfileManager(store, {
      prepare() {}, launch: async () => { throw new Error('Unexpected launch'); }, inspect: async () => processClosed ? 'stopped' : 'running',
      ensureWindow: async () => {}, close: async () => { throw new Error('Unexpected close'); }, isClosed: async () => processClosed
    }, () => null);
    network = new ProfileNetworkService(store, () => port, { read: async () => { throw new Error('secret not found'); } }, profiles);
    broker.setNetworkService(network);
  });
  afterEach(async () => { broker.beginShutdown(); await broker.waitForIdle(); await network.close(); store.close(); });
  const refOf = (reply: Record<string, unknown>) => (reply.facts as { ticket: { request_ref: string } }).ticket.request_ref;
  async function finish(tool: 'set_browser_proxy' | 'clear_browser_proxy' | 'check_browser_proxy', body: Record<string, unknown>) {
    parseMcpToolInput(tool, body);
    const reply = broker.submit(tool, body, evidence); parseMcpToolOutput(tool, reply);
    expect(reply.disposition).toBe('accepted'); const ref = refOf(reply); broker.confirmAcknowledgement(ref, true);
    await waitFor(() => ['succeeded', 'failed'].includes(store.canonical.requests.getRequest(ref)!.state));
    const result = broker.getBrowserRequest({ request_ref: ref }, evidence); parseMcpToolOutput('get_browser_request', result);
    return store.canonical.requests.getRequest(ref)!;
  }
  it('saves a closed broker-owned Profile after acknowledgement and applies on its next connection', async () => {
    const reply = broker.submit('set_browser_proxy', input(), evidence); const ref = refOf(reply);
    await new Promise(r => setTimeout(r, 20)); expect(commands).toEqual([]); expect(store.proxies.get(profileRef).revision).toBe(0);
    broker.confirmAcknowledgement(ref, true); await waitFor(() => store.canonical.requests.getRequest(ref)!.state === 'succeeded');
    expect(network.ready(profileRef)).toBe(false); expect(commands).toEqual([]);
    connected = true; generation++; await network.reconcile(profileRef);
    expect(network.ready(profileRef)).toBe(true);
    const facts = broker.getBrowserProxy({ profile_ref: profileRef }, evidence); parseMcpToolOutput('get_browser_proxy', facts);
    expect(facts).toMatchObject({ facts: { proxy: { revision: 1, application: { state: 'applied' } } } });
    expect(JSON.stringify(facts)).not.toMatch(/password|listener|display_name/u);
    expect((await finish('check_browser_proxy', { profile_ref: profileRef, expected_revision: 1 })).state).toBe('succeeded');
    expect(network.facts(profileRef).exit).toMatchObject({ ip: '203.0.113.7', source: 'browser' });
    connected = false;
    expect((await finish('clear_browser_proxy', { profile_ref: profileRef, expected_revision: 1, idempotency_key: 'clear-key-0001' })).state).toBe('succeeded');
    expect(network.facts(profileRef).application).toMatchObject({ state: 'pending_connection' });
    connected = true; generation++; await network.reconcile(profileRef);
    expect(network.facts(profileRef).application).toMatchObject({ state: 'unmanaged' });
  });
  it('deduplicates requests and fences concurrent mutation and lifecycle admission', async () => {
    const first = broker.submit('set_browser_proxy', input(), evidence);
    expect(refOf(broker.submit('set_browser_proxy', input(), evidence))).toBe(refOf(first));
    expect(broker.submit('set_browser_proxy', input(profileRef, 'different-key'), evidence)).toMatchObject({ problem: { code: 'PROXY_BUSY' } });
    expect(() => network.assertLifecycle(profileRef)).toThrow('PROXY_BUSY');
    broker.confirmAcknowledgement(refOf(first), false);
    expect(store.proxies.get(profileRef).revision).toBe(0); expect(commands).toEqual([]);
  });
  it('reuses terminal requests across sessions but never across principals', async () => {
    const ticket = await finish('set_browser_proxy', input());
    const next = { ...evidence, runtimeSessionKey: 'agent-two' };
    expect(broker.getBrowserRequest({ request_ref: ticket.requestRef }, next).disposition).toBe('complete');
    const repeated = broker.submit('set_browser_proxy', input(), next); parseMcpToolOutput('set_browser_proxy', repeated); expect(repeated.disposition).toBe('complete');
    const other = store.createAgent('other', ['profiles:read', 'profiles:network:manage']).principal;
    expect(broker.getBrowserRequest({ request_ref: ticket.requestRef }, { ...next, managementAuthority: other }).disposition).toBe('rejected');
    expect(broker.closeBrowserRequest({ request_ref: ticket.requestRef }, next).disposition).toBe('complete');
    expect(store.proxies.get(profileRef).revision).toBe(1);
  });
  it('stores offline intent and reconciles the next connection without claiming it applied', async () => {
    connected = false;
    expect((await finish('set_browser_proxy', input())).state).toBe('succeeded');
    expect(network.facts(profileRef).application).toMatchObject({ state: 'pending_connection', applied_revision: null });
    connected = true; generation++; await network.reconcile(profileRef); expect(network.ready(profileRef)).toBe(true);
    applied.state = 'control_conflict'; await network.reconcile(profileRef); expect(network.ready(profileRef)).toBe(false);
  });
  it('requires capability and scopes and validates revision and credentials', async () => {
    const readonly = { ...evidence, managementAuthority: { ...evidence.managementAuthority!, scopes: ['profiles:read'] } };
    expect(broker.submit('set_browser_proxy', input(), readonly)).toMatchObject({ problem: { code: 'PROFILE_FORBIDDEN' } });
    capable = false; expect((await finish('set_browser_proxy', input())).state).toBe('succeeded');
    connected = true; generation++; await network.reconcile(profileRef);
    expect(network.facts(profileRef).application).toMatchObject({ problem_code: 'PROXY_UNSUPPORTED' });
    expect(broker.submit('set_browser_proxy', input(profileRef, 'next-key-0001'), evidence)).toMatchObject({ problem: { code: 'PROXY_REVISION_CONFLICT' } });
    connected = false;
    const missing = input(profileRef, 'next-key-0002', 1);
    expect((await finish('set_browser_proxy', { ...missing, proxy: { ...missing.proxy, credential_ref: 'pcr_00000000-0000-0000-0000-000000000000' } })).state).toBe('failed');
    expect(store.proxies.get(profileRef).revision).toBe(1);
  });
  it('rejects changes even when the caller owns the active workspace', () => {
    const caller = broker.resolveCaller(evidence);
    store.canonical.logical.upsertWindow({ windowRef: 'window', endpointRef: endpoint, privateWindowKey: 'window', locatorGeneration: 1, focused: true, eligible: true });
    store.canonical.logical.createWorkspace({ workspaceRef: 'workspace', endpointRef: endpoint, windowRef: 'window', ownerSessionRef: caller.sessionRef, lineageRef: caller.lineageRef, groupLabel: 'Proxy test' });
    expect(broker.submit('set_browser_proxy', input(), evidence)).toMatchObject({ problem: { code: 'PROFILE_HAS_ACTIVE_WORK' } });
  });
  it('uses broker launch references without requiring creator ownership', async () => {
    const profile = store.profiles.get(profileRef)!;
    connected = false;
    expect((await finish('set_browser_proxy', input(profile.profileRef))).state).toBe('succeeded');
    expect(network.ready(profile.profileRef)).toBe(false); expect(commands).toEqual([]);
    connected = true; generation++; await network.reconcile(profile.profileRef);
    expect(network.ready(profile.profileRef)).toBe(true);
    expect(() => network.resolve(endpoint)).toThrow('PROFILE_NOT_FOUND');
  });
  it('rejects proxy changes on an idle but open managed Profile', () => {
    connected = true;
    const profile = store.profiles.get(profileRef)!;
    expect(broker.submit('set_browser_proxy', input(profile.profileRef), evidence)).toMatchObject({ problem: { code: 'PROFILE_IN_USE' } });
    expect(broker.submit('clear_browser_proxy', { profile_ref: profile.profileRef, expected_revision: 0, idempotency_key: 'clear-running-profile' }, evidence)).toMatchObject({ problem: { code: 'PROFILE_IN_USE' } });
    expect(store.proxies.get(profile.profileRef).revision).toBe(0);
  });
  it('does not treat an extension outage as proof that a managed browser closed', async () => {
    const profile = store.profiles.get(profileRef)!;
    connected = false; processClosed = false;
    const ticket = await finish('set_browser_proxy', input(profile.profileRef));
    expect(ticket.state).toBe('failed'); expect(ticket.problem).toMatchObject({ code: 'PROFILE_IN_USE' });
    expect(store.proxies.get(profile.profileRef).revision).toBe(0); expect(commands).toEqual([]);
  });
  it('saves a managed clear while closed and waits for the next launch to confirm release', async () => {
    const profile = store.profiles.get(profileRef)!;
    connected = false; await finish('set_browser_proxy', input(profile.profileRef));
    connected = true; generation++; await network.reconcile(profile.profileRef); expect(network.ready(profile.profileRef)).toBe(true);
    connected = false; commands = [];
    expect((await finish('clear_browser_proxy', { profile_ref: profile.profileRef, expected_revision: 1, idempotency_key: 'clear-closed-profile' })).state).toBe('succeeded');
    expect(network.ready(profile.profileRef)).toBe(false); expect(commands).toEqual([]);
    connected = true; generation++; await network.reconcile(profile.profileRef);
    expect(network.facts(profile.profileRef).application).toMatchObject({ state: 'unmanaged' });
    expect(commands).toEqual(['clear']);
  });
  it('holds the mutation and lifecycle barrier while an exit check is pending', async () => {
    await finish('set_browser_proxy', input());
    connected = true; generation++; await network.reconcile(profileRef);
    const check = broker.submit('check_browser_proxy', { profile_ref: profileRef, expected_revision: 1 }, evidence);
    expect(broker.submit('clear_browser_proxy', { profile_ref: profileRef, expected_revision: 1, idempotency_key: 'clear-during-check' }, evidence)).toMatchObject({ problem: { code: 'PROXY_BUSY' } });
    expect(() => network.assertLifecycle(profileRef)).toThrow('PROXY_BUSY');
    broker.confirmAcknowledgement(refOf(check), false); expect(network.ready(profileRef)).toBe(true);
  });
  it('retains the working configuration when credential validation fails before commit', async () => {
    await finish('set_browser_proxy', input());
    connected = true; generation++; await network.reconcile(profileRef); connected = false;
    const body = input(profileRef, 'missing-credential', 1);
    expect((await finish('set_browser_proxy', { ...body, proxy: { ...body.proxy, credential_ref: 'pcr_00000000-0000-0000-0000-000000000000' } })).state).toBe('failed');
    expect(store.proxies.get(profileRef)).toMatchObject({ revision: 1, state: 'applied' });
    connected = true; generation++; await network.reconcile(profileRef); expect(network.ready(profileRef)).toBe(true);
  });
  it.each([true, false])('rejects user-owned configuration when connected=%s but retains readable facts', async online => {
    const userRef = 'ext_user_proxy';
    store.canonical.logical.createEndpoint({ endpointRef: userRef, nickname: 'userproxy' });
    broker.openEndpointConnection({ endpointRef: userRef, connectionRef: 'user-connection', transport: 'test', protocolVersion: '2' });
    connected = online;
    for (const tool of ['set_browser_proxy', 'clear_browser_proxy', 'check_browser_proxy'] as const) {
      const body = tool === 'set_browser_proxy' ? input(userRef) : { profile_ref: userRef, expected_revision: 0, ...(tool === 'clear_browser_proxy' ? { idempotency_key: 'clear-user-proxy' } : {}) };
      const reply = broker.submit(tool, body, evidence); parseMcpToolOutput(tool, reply);
      expect(reply).toMatchObject({ problem: { code: 'PROFILE_USER_OWNED' } });
    }
    expect(broker.getBrowserProxy({ profile_ref: userRef }, evidence)).toMatchObject({ facts: { proxy: { revision: 0, proxy: null } } });
    // Older saved intent must never bypass the ownership rule through background recovery.
    store.proxies.save({ ...store.proxies.get(userRef), revision: 1, proxy: { scheme: 'http', host: '127.0.0.1', port: 54321 } });
    await network.reconcile(userRef);
    expect(commands).toEqual([]); expect(network.ready(userRef)).toBe(false);
    expect(network.facts(userRef).application).toMatchObject({ state: 'failed', problem_code: 'PROFILE_USER_OWNED' });
  });
  it('rechecks process closure after acknowledgement before committing any change', async () => {
    const reply = broker.submit('set_browser_proxy', input(), evidence); const ref = refOf(reply);
    processClosed = false;
    broker.confirmAcknowledgement(ref, true); await waitFor(() => store.canonical.requests.getRequest(ref)!.state === 'failed');
    expect(store.canonical.requests.getRequest(ref)!.problem).toMatchObject({ code: 'PROFILE_IN_USE' });
    expect(store.proxies.get(profileRef).revision).toBe(0); expect(commands).toEqual([]);
  });
});
