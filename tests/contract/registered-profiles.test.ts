import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { OctopusBroker, type CallerEvidence } from '../../apps/broker/src/core/index.js';
import { parseMcpToolOutput } from '../../apps/shared/protocol/src/index.js';

describe('extension-registered Profile discovery', () => {
  let store: SqliteRelayStore;
  let broker: OctopusBroker;
  const caller: CallerEvidence = { runtimeName: 'test', runtimeSessionKey: 'a' };
  const other: CallerEvidence = { runtimeName: 'test', runtimeSessionKey: 'b' };
  beforeEach(() => { store = new SqliteRelayStore(':memory:'); broker = new OctopusBroker(store.canonical); });
  afterEach(async () => { broker.beginShutdown(); await broker.waitForIdle(); store.close(); });

  function register(nickname: string) {
    const endpoint = broker.ensureEndpoint({ nickname });
    const generation = broker.openEndpointConnection({ endpointRef: endpoint.endpointRef, connectionRef: `con_${nickname}`, transport: 'test', protocolVersion: '2' });
    store.canonical.logical.upsertWindow({ windowRef: `win_${nickname}`, endpointRef: endpoint.endpointRef,
      privateWindowKey: JSON.stringify({ windowId: 1, connectionGeneration: generation }), locatorGeneration: 1, eligible: true, focused: true });
    return endpoint;
  }

  function list(input: Record<string, unknown> = {}, evidence = caller) {
    const result = broker.listBrowserProfiles(input, evidence);
    parseMcpToolOutput('list_browser_profiles', result);
    expect(result.disposition).toBe('complete');
    return result.facts as { profiles: Record<string, unknown>[]; next_cursor: string | null; returned_count: number };
  }

  it('automatically lists both ownerships for every agent without a configured launcher or a second registration', () => {
    const user = register('goldjay');
    const managed = register('mapleglen');
    const principal = store.createAgent('creator', ['profiles:manage']).principal;
    const profile = store.profiles.create(principal.principalId, 'chrome');
    store.profiles.bind(profile.profileRef, managed.endpointRef, 'identity');
    store.profiles.create(principal.principalId, 'chrome');
    broker.ensureEndpoint({ nickname: 'unauthenticated' });

    const first = list();
    expect(first.returned_count).toBe(2);
    expect(first.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile_ref: user.endpointRef, endpoint_nickname: 'goldjay', ownership: 'user', ready: true, extension_state: 'connected' }),
      expect.objectContaining({ profile_ref: profile.profileRef, endpoint_nickname: 'mapleglen', ownership: 'broker', ready: true })
    ]));
    expect(list({}, other).profiles).toEqual(first.profiles);
    expect(JSON.stringify(first)).not.toContain('display_name');
    expect(JSON.stringify(first)).not.toContain('Demo Profile');
    const windows = broker.getBrowserContext({ view: { kind: 'windows', endpoint_nickname: 'goldjay', page_size: 20, cursor: null } }, other);
    parseMcpToolOutput('get_browser_context', windows);
    expect(windows.facts).toMatchObject({ windows: [{ ownership: 'user' }] });
  });

  it('retains offline user identity and waits for fresh window inventory on reconnect', () => {
    const endpoint = register('goldjay');
    const ref = list().profiles[0]!.profile_ref;
    broker.closeEndpointConnection(endpoint.endpointRef, 1, 'closed');
    expect(list().profiles[0]).toMatchObject({ profile_ref: ref, ownership: 'user', ready: false, extension_state: 'disconnected', browser_state: 'unknown' });
    broker.openEndpointConnection({ endpointRef: endpoint.endpointRef, connectionRef: 'reconnected', transport: 'test', protocolVersion: '2' });
    expect(list().profiles[0]).toMatchObject({ profile_ref: ref, extension_state: 'connected', ready: false });
    expect(list().returned_count).toBe(1);
  });

  it('rejects MCP launch and close of user-owned Chrome without creating lifecycle tickets', () => {
    const endpoint = register('goldjay');
    for (const tool of ['open_browser_profile', 'stop_browser_profile'] as const) {
      const result = broker.submit(tool, { profile_ref: endpoint.endpointRef }, caller);
      parseMcpToolOutput(tool, result);
      expect(result).toMatchObject({ disposition: 'rejected', problem: { code: 'PROFILE_USER_OWNED' } });
    }
    expect(store.canonical.requests.scanRequestRecovery().requests).toHaveLength(0);
    expect(list().profiles[0]).toMatchObject({ ready: true, ownership: 'user' });
  });

  it('paginates the complete registry beyond 200 entries and fences cursors to the caller', () => {
    for (let index = 0; index < 205; index++) register(`profile${index}`);
    const first = list({ limit: 100 });
    expect(broker.listBrowserProfiles({ limit: 100, cursor: first.next_cursor }, other)).toMatchObject({ disposition: 'rejected', problem: { code: 'CURSOR_INVALID' } });
    const second = list({ limit: 100, cursor: first.next_cursor });
    const last = list({ limit: 100, cursor: second.next_cursor });
    expect([first.returned_count, second.returned_count, last.returned_count]).toEqual([100, 100, 5]);
    expect(new Set([...first.profiles, ...second.profiles, ...last.profiles].map(profile => profile.profile_ref)).size).toBe(205);
    expect(last.next_cursor).toBeNull();
  });
});
