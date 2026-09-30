import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { OctopusBroker, type CallerEvidence } from '../../apps/broker/src/core/index.js';
import { ProfileManager } from '../../apps/broker/src/profiles/profile-manager.js';
import { parseMcpToolOutput } from '../../apps/shared/protocol/src/index.js';

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
        store.profiles.bind(profile.profileRef, ep, 'hash'); store.profiles.authenticateInstance(instance.instanceRef);
        store.canonical.logical.upsertWindow({ windowRef: 'win', endpointRef: ep, privateWindowKey: 'key', locatorGeneration: 1, eligible: true, focused: true });
        return running;
      }
    }, endpointRef => ({ endpointRef, connected: true, inventoryGeneration: 1, connectionGeneration: 1 }), 100);
    broker.setProfileManager(manager);
  });
  afterEach(async () => { broker.beginShutdown(); await manager.shutdown(); await broker.waitForIdle(); store.close(); });
  const input = { display_name: ' Alice ', idempotency_key: 'create-alice' };
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
    expect((broker.listBrowserProfiles({}, foreign).facts as { profiles: unknown[] }).profiles).toEqual([]);
  });
  it('does not dispatch after failed acknowledgement and does not reserve on conflicting keys', async () => {
    const ref = requestRef(broker.submit('create_browser_profile', input, evidence));
    broker.confirmAcknowledgement(ref, false);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(starts).toBe(0);
    const conflict = broker.submit('create_browser_profile', { ...input, display_name: 'Bob' }, evidence);
    expect(conflict.disposition).toBe('rejected');
    expect((conflict.problem as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(store.profiles.all()).toHaveLength(1);
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
});

async function viWait(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Profile ticket did not complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
