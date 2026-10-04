import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { OctopusBroker, type CallerEvidence } from '../../apps/broker/src/core/index.js';
import { ProfileManager } from '../../apps/broker/src/profiles/profile-manager.js';
import { parseMcpToolOutput } from '../../apps/shared/protocol/src/index.js';
import { requestTicketFacts } from '../../apps/broker/src/core/octopus/mcp-presenter.js';
import { problem } from '../../apps/broker/src/core/octopus/broker-problem.js';

describe('Profile MCP tickets', () => {
  let store: SqliteRelayStore;
  let broker: OctopusBroker;
  let manager: ProfileManager;
  let evidence: CallerEvidence;
  let starts: number;
  beforeEach(() => {
    store = new SqliteRelayStore(':memory:'); broker = new OctopusBroker(store.canonical); starts = 0;
    const principal = store.createAgent('test', ['profiles:read', 'profiles:manage']).principal;
    evidence = { runtimeName: 'test', runtimeSessionKey: 'one', managementAuthority: { principalId: principal.principalId, scopes: principal.scopes } };
    manager = new ProfileManager(store, {
      prepare() {}, async inspect() { return 'running'; }, async close() {}, async ensureWindow() {},
      async launch(profile, instance, checkpoint) {
        starts++;
        const running = { ...instance, browserState: 'running' as const };
        checkpoint(running);
        const ep = `ep_${profile.profileRef}`;
        store.canonical.logical.createEndpoint({ endpointRef: ep, nickname: 'testprofile' });
        store.canonical.logical.openEndpointConnection({ endpointRef: ep, connectionRef: 'con', transport: 'test', protocolVersion: '2' });
        store.profiles.bind(profile.profileRef, ep, 'hash'); store.profiles.authenticateInstance(instance.instanceRef);
        store.canonical.logical.upsertWindow({ windowRef: 'win', endpointRef: ep, privateWindowKey: 'key', locatorGeneration: 1, eligible: true, focused: true });
        return running;
      }
    }, endpointRef => ({ endpointRef, connected: true, inventoryGeneration: 1, connectionGeneration: 1 }), 100);
    broker.setProfileManager(manager);
  });
  afterEach(async () => { broker.beginShutdown(); await manager.shutdown(); await broker.waitForIdle(); store.close(); });
  const input = { idempotency_key: 'create-alice' };
  function requestRef(reply: Record<string, unknown>): string {
    return ((reply.facts as { ticket: { request_ref: string } }).ticket).request_ref;
  }
  async function complete(ref: string) {
    broker.confirmAcknowledgement(ref, true);
    await viWait(() => store.canonical.requests.getRequest(ref)?.state === 'succeeded');
  }
  it('persists admission before dispatch and validates accepted, terminal and cross-session outputs', async () => {
    const result = broker.submit('create_browser_profile', input, evidence);
    expect(() => parseMcpToolOutput('create_browser_profile', result)).not.toThrow();
    const ref = requestRef(result);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(starts).toBe(0);
    await complete(ref); expect(starts).toBe(1);
    const next = { ...evidence, runtimeSessionKey: 'two' };
    const read = broker.getBrowserRequest({ request_ref: ref }, next);
    expect(read.disposition).toBe('complete');
    expect(() => parseMcpToolOutput('get_browser_request', read)).not.toThrow();
    expect(read.facts).toMatchObject({ ticket: { result: { facts: { profile: { endpoint_nickname: 'testprofile' } } } } });
    expect(JSON.stringify(read)).not.toContain('display_name');
    const closed = broker.closeBrowserRequest({ request_ref: ref }, next);
    expect(closed.disposition).toBe('complete');
    const repeated = broker.submit('create_browser_profile', input, next);
    expect(repeated.disposition).toBe('complete');
    expect(() => parseMcpToolOutput('create_browser_profile', repeated)).not.toThrow();
    expect(store.profiles.all()).toHaveLength(1);
    expect(() => parseMcpToolOutput('list_browser_profiles', broker.listBrowserProfiles({}, next))).not.toThrow();
  });
  it('rejects cross-principal ticket reads and closes, including matching session labels', async () => {
    const ref = requestRef(broker.submit('create_browser_profile', input, evidence)); await complete(ref);
    const other = store.createAgent('other', ['profiles:read', 'profiles:manage']).principal;
    const foreign = { ...evidence, managementAuthority: { principalId: other.principalId, scopes: other.scopes } };
    expect(broker.getBrowserRequest({ request_ref: ref }, foreign).disposition).toBe('rejected');
    expect(broker.closeBrowserRequest({ request_ref: ref }, foreign).disposition).toBe('rejected');
    expect((broker.listBrowserProfiles({}, foreign).facts as { profiles: unknown[] }).profiles).toMatchObject([
      { endpoint_nickname: 'testprofile', ownership: 'broker' }
    ]);
  });
  it('does not dispatch after failed acknowledgement and rejects retired display names before reservation', async () => {
    const ref = requestRef(broker.submit('create_browser_profile', input, evidence));
    broker.confirmAcknowledgement(ref, false);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(starts).toBe(0);
    const conflict = broker.submit('create_browser_profile', { ...input, display_name: 'Bob' }, evidence);
    expect(conflict.disposition).toBe('rejected');
    expect((conflict.problem as { code: string }).code).toBe('INVALID_ARGUMENT');
    expect(store.profiles.all()).toHaveLength(1);
  });

  it.each(['succeeded', 'failed', 'uncertain'] as const)('reads historical %s Profile facts without rewriting saved results or raw CDP', state => {
    const ref = requestRef(broker.submit('create_browser_profile', input, evidence));
    const profile = store.profiles.get(store.profiles.request(ref)!.profileRef)!;
    const facts = manager.facts(profile);
    delete facts.ownership;
    const failure = { tool: 'create_browser_profile', problem: { ...problem('PROFILE_OPERATION_FAILED', 'failed', false) }, known_facts: { profile: facts } };
    const result = state === 'succeeded'
      ? { tool: 'create_browser_profile', disposition: 'complete', facts: { profile: facts } }
      : state === 'uncertain' ? failure : { ...failure, kind: 'octopus_problem', debugger_error: null };
    store.canonical.requests.terminalizeRequest({ requestRef: ref, state, phase: 'complete', checkpoint: {}, result });
    const read = broker.getBrowserRequest({ request_ref: ref }, evidence);
    expect(() => parseMcpToolOutput('get_browser_request', read)).not.toThrow();
    expect(JSON.stringify(read)).toContain('"ownership":"broker"');
    expect(JSON.stringify(read)).not.toContain('display_name');
    expect(store.canonical.requests.getRequest(ref)!.result).toEqual(result);
    expect(JSON.stringify(store.canonical.requests.getRequest(ref)!.result)).not.toContain('ownership');
    const rawTicket = { ...store.canonical.requests.getRequest(ref)!, toolName: 'send_cdp_command' as const, state: 'succeeded' as const };
    expect(requestTicketFacts(rawTicket).result).toEqual(result);
  });

  it('does not reschedule terminal uncertainty or starve timers and other requests', async () => {
    const ref = requestRef(broker.submit('create_browser_profile', input, evidence));
    store.canonical.requests.terminalizeRequest({ requestRef: ref, state: 'uncertain', phase: 'uncertain', checkpoint: {} });
    broker.confirmAcknowledgement(ref, true);
    broker.recover();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(starts).toBe(0);
    expect(store.canonical.requests.getRequest(ref)?.claimGeneration).toBe(0);
  });

  it('explains active-work closure failures after lifecycle permission passed', async () => {
    const created = requestRef(broker.submit('create_browser_profile', input, evidence)); await complete(created);
    const profile = store.profiles.all()[0]!;
    const caller = broker.getBrowserContext({ view: { kind: 'broker' } }, evidence).caller as { session_ref: string; lineage_ref: string };
    store.canonical.logical.createWorkspace({ workspaceRef: 'live-work', endpointRef: profile.endpointRef!, windowRef: 'win',
      lineageRef: caller.lineage_ref, ownerSessionRef: caller.session_ref, groupLabel: 'Live work' });
    const stopped = requestRef(broker.submit('stop_browser_profile', { profile_ref: profile.profileRef }, evidence));
    broker.confirmAcknowledgement(stopped, true);
    await viWait(() => store.canonical.requests.getRequest(stopped)?.state === 'failed');
    const result = broker.getBrowserRequest({ request_ref: stopped }, evidence);
    expect(() => parseMcpToolOutput('get_browser_request', result)).not.toThrow();
    expect(result.facts).toMatchObject({ ticket: { failure: { problem: {
      code: 'PROFILE_HAS_ACTIVE_WORK', message: expect.stringContaining('Profile lifecycle permission passed.')
    } } } });
  });
});

async function viWait(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Profile ticket did not complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
