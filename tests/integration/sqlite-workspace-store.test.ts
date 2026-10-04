import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'octopus-storage-'));
  roots.push(root);
  return join(root, 'relay.sqlite');
}

function seed(store: SqliteRelayStore) {
  const logical = store.canonical.logical;
  const endpoint = logical.createEndpoint({ endpointRef: 'ep_a', nickname: 'profile-a' });
  const connection = logical.openEndpointConnection({
    endpointRef: endpoint.endpointRef,
    connectionRef: 'conn_a_1',
    transport: 'native-messaging',
    protocolVersion: '2',
    extensionVersion: '0.2.0',
    browserProduct: 'Chrome',
    browserVersion: '140'
  });
  const lineage = logical.registerLineage({ lineageRef: 'lin_a', runtimeName: 'codex' });
  const session = logical.registerSession({
    sessionRef: 'ses_a',
    lineageRef: lineage.lineageRef,
    runtimeSessionKeyHash: 'runtime-session-a'
  });
  const window = logical.upsertWindow({
    windowRef: 'win_a', endpointRef: endpoint.endpointRef, privateWindowKey: 'chrome-window-7',
    locatorGeneration: 1, focused: true, eligible: true
  });
  const workspace = logical.createWorkspace({
    workspaceRef: 'ws_a', endpointRef: endpoint.endpointRef, windowRef: window.windowRef,
    lineageRef: lineage.lineageRef, ownerSessionRef: session.sessionRef,
    groupLabel: 'Tabro task', privateGroupKey: 'chrome-group-4'
  });
  const tab = logical.addTab({
    tabRef: 'tab_a', workspaceRef: workspace.workspaceRef, endpointRef: endpoint.endpointRef,
    windowRef: window.windowRef, privateTabKey: 'chrome-tab-11', locatorGeneration: 1,
    title: 'Example', url: 'https://example.com/'
  });
  return { endpoint, connection, lineage, session, window, workspace, tab };
}

describe('canonical SQLite workspace store', () => {
  it('upgrades an existing version-three database without deleting legacy rows', () => {
    const path = databasePath();
    const raw = new DatabaseSync(path);
    for (let version = 1; version <= 3; version += 1) {
      const filename = version === 1 ? '001-initial.sql' : version === 2 ? '002-real-world-trace.sql' : '003-agent-target-bindings.sql';
      raw.exec(readFileSync(new URL(`../../apps/broker/src/storage/sqlite/migrations/${filename}`, import.meta.url), 'utf8'));
      raw.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version, new Date().toISOString());
    }
    const at = new Date().toISOString();
    raw.prepare(`INSERT INTO targets(target_id,alias,public_key_jwk,capabilities_json,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(randomUUID(), 'legacy-profile', '{}', '["snapshot"]', at, at);
    raw.close();

    const store = new SqliteRelayStore(path);
    expect(store.listTargets()).toHaveLength(1);
    const migrated = store.canonical.logical.getEndpointByNickname('legacy-profile');
    expect(migrated?.legacyTargetId).toBe(store.listTargets()[0]?.targetId);
    expect(migrated?.credential).toEqual({});
    expect(store.sqliteDiagnostics()).toEqual({ journalMode: 'wal', foreignKeys: true, migrationVersion: 8 });
    store.close();
  });

  it('retains the last focused timestamp after focus moves to another window', () => {
    const store = new SqliteRelayStore(':memory:');
    const logical = store.canonical.logical;
    const endpoint = logical.createEndpoint({ endpointRef: 'ep-focus', nickname: 'focus-profile' });
    logical.upsertWindow({
      windowRef: 'win-first', endpointRef: endpoint.endpointRef, privateWindowKey: 'chrome-window-1',
      locatorGeneration: 1, focused: true, eligible: true, observedAt: '2026-08-31T10:00:00.000Z'
    });
    logical.upsertWindow({
      windowRef: 'win-second', endpointRef: endpoint.endpointRef, privateWindowKey: 'chrome-window-2',
      locatorGeneration: 1, focused: true, eligible: true, observedAt: '2026-08-31T10:01:00.000Z'
    });
    logical.upsertWindow({
      windowRef: 'win-second', endpointRef: endpoint.endpointRef, privateWindowKey: 'chrome-window-2',
      locatorGeneration: 2, focused: false, eligible: true, observedAt: '2026-08-31T10:02:00.000Z'
    });

    expect(logical.getWindow('win-first')).toMatchObject({ focused: false, lastFocusedAt: '2026-08-31T10:00:00.000Z' });
    expect(logical.getWindow('win-second')).toMatchObject({ focused: false, lastFocusedAt: '2026-08-31T10:01:00.000Z' });
    expect(logical.listWindows(endpoint.endpointRef).map((window) => window.windowRef)).toEqual(['win-second', 'win-first']);
    store.close();
  });

  it('marks windows missing from a reconciled inventory as ineligible without changing their last observation', () => {
    const store = new SqliteRelayStore(':memory:');
    const logical = store.canonical.logical;
    const endpoint = logical.createEndpoint({ endpointRef: 'ep-missing', nickname: 'missing-profile' });
    logical.upsertWindow({
      windowRef: 'win-current', endpointRef: endpoint.endpointRef, privateWindowKey: 'current-window',
      locatorGeneration: 1, focused: true, eligible: true, observedAt: '2026-09-02T10:00:00.000Z'
    });
    logical.upsertWindow({
      windowRef: 'win-missing', endpointRef: endpoint.endpointRef, privateWindowKey: 'missing-window',
      locatorGeneration: 1, focused: false, eligible: true, observedAt: '2026-09-02T09:00:00.000Z'
    });

    logical.markMissingWindows({
      endpointRef: endpoint.endpointRef,
      observedWindowRefs: ['win-current'],
      at: '2026-09-02T10:01:00.000Z'
    });

    expect(logical.getWindow('win-current')).toMatchObject({ eligible: true, focused: true });
    expect(logical.getWindow('win-missing')).toMatchObject({
      eligible: false,
      focused: false,
      lastObservedAt: '2026-09-02T09:00:00.000Z'
    });
    store.close();
  });

  it('reconstructs workspaces, lanes, pause causes, attempts, streams, and audit after restart', () => {
    const path = databasePath();
    let store = new SqliteRelayStore(path);
    const fixture = seed(store);
    store.canonical.logical.setWorkspacePauseCause({ workspaceRef: fixture.workspace.workspaceRef, cause: 'endpoint_killed', sourceRequestRef: 'req_kill' });
    const accepted = store.canonical.requests.acceptRequest({
      requestRef: 'req_cdp_1', toolName: 'send_cdp_command', requesterSessionRef: fixture.session.sessionRef,
      authorityScope: 'owner', authoritySessionRef: fixture.session.sessionRef, authorityLineageRef: fixture.lineage.lineageRef,
      endpointRef: fixture.endpoint.endpointRef, workspaceRef: fixture.workspace.workspaceRef, tabRef: fixture.tab.tabRef,
      acceptedOwnerEpoch: 1, normalizedBody: { method: 'Runtime.evaluate', params: { expression: '1+1' } },
      phase: 'accepted', checkpoint: { name: 'accepted' }
    });
    expect(accepted.lanePosition).toBe(1);
    store.canonical.requests.markAcknowledgementDelivered(accepted.requestRef);
    const claimed = store.canonical.requests.claimRequest({ requestRef: accepted.requestRef, workerRef: 'worker-1', leaseExpiresAt: '2999-01-01T00:00:00.000Z' });
    expect(claimed?.claimGeneration).toBe(1);
    store.canonical.requests.recordCheckpoint({
      requestRef: accepted.requestRef, expectedClaimGeneration: 1, phase: 'extension_dispatched',
      checkpoint: { name: 'extension_dispatched' }, pauseCondition: 'endpoint_disconnected'
    });
    const attempt = store.canonical.requests.startAttempt({
      attemptRef: 'attempt-1', requestRef: accepted.requestRef, endpointRef: fixture.endpoint.endpointRef,
      connectionGeneration: fixture.connection.connectionGeneration, locatorGeneration: 1, attachmentGeneration: 1
    });
    store.canonical.requests.markAttemptDispatched(attempt.attemptRef);
    const stream = store.canonical.events.createStream({
      streamRef: 'stream-1', tabRef: fixture.tab.tabRef, initialCursorRef: 'cursor-0', queryHash: 'all',
      ownerEpoch: 1, baseline: { url: 'https://example.com/' }
    });
    expect(stream.cursor.sequence).toBe(0);
    store.canonical.audit.append({
      auditRef: 'audit-1', eventType: 'request_dispatched', actorSessionRef: fixture.session.sessionRef,
      endpointRef: fixture.endpoint.endpointRef, workspaceRef: fixture.workspace.workspaceRef,
      tabRef: fixture.tab.tabRef, requestRef: accepted.requestRef, context: { attempt_ref: attempt.attemptRef }
    });
    store.close();

    store = new SqliteRelayStore(path);
    const logical = store.canonical.logical.scanLogicalRecovery();
    const requests = store.canonical.requests.scanRequestRecovery();
    const events = store.canonical.events.scanEventRecovery();
    expect(logical.activeWorkspaces[0]?.pauseCauses).toEqual(['endpoint_killed']);
    expect(logical.liveConnections[0]?.connectionGeneration).toBe(1);
    expect(requests.requests[0]).toMatchObject({ requestRef: 'req_cdp_1', state: 'running', pauseCondition: 'endpoint_disconnected' });
    expect(requests.attempts[0]).toMatchObject({ attemptRef: 'attempt-1', state: 'dispatched' });
    expect(requests.lanes[0]?.headRequestRef).toBe('req_cdp_1');
    expect(events.streams[0]?.initialCursorRef).toBe('cursor-0');
    expect(store.canonical.audit.list({ requestRef: 'req_cdp_1', page: { limit: 10 } }).items).toHaveLength(1);
    store.close();
  });

  it('enforces owner, locator, connection, claim, and same-tab lane generations', () => {
    const store = new SqliteRelayStore(':memory:');
    const fixture = seed(store);
    const logical = store.canonical.logical;
    const requests = store.canonical.requests;
    const sessionB = logical.registerSession({
      sessionRef: 'ses_b', lineageRef: fixture.lineage.lineageRef, parentSessionRef: fixture.session.sessionRef,
      runtimeSessionKeyHash: 'runtime-session-b'
    });
    expect(logical.takeOverWorkspace({
      workspaceRef: fixture.workspace.workspaceRef, expectedOwnerSessionRef: 'wrong', expectedOwnerEpoch: 1,
      expectedControlEpoch: fixture.workspace.controlEpoch,
      newOwnerSessionRef: sessionB.sessionRef, newLineageRef: fixture.lineage.lineageRef
    })).toBeNull();
    expect(logical.updateTab({
      workspaceRef: fixture.workspace.workspaceRef, tabRef: fixture.tab.tabRef, expectedLocatorGeneration: 99, title: 'stale'
    })).toBeNull();
    expect(logical.disconnectEndpoint({
      endpointRef: fixture.endpoint.endpointRef, connectionGeneration: fixture.connection.connectionGeneration + 1, reason: 'stale'
    })).toBe(false);

    for (const requestRef of ['req-1', 'req-2']) {
      requests.acceptRequest({
        requestRef, toolName: 'send_cdp_command', requesterSessionRef: fixture.session.sessionRef,
        authorityScope: 'owner', authoritySessionRef: fixture.session.sessionRef, authorityLineageRef: fixture.lineage.lineageRef,
        endpointRef: fixture.endpoint.endpointRef, workspaceRef: fixture.workspace.workspaceRef, tabRef: fixture.tab.tabRef,
        acceptedOwnerEpoch: 1, normalizedBody: { method: 'Runtime.evaluate' }, phase: 'accepted', checkpoint: { name: 'accepted' }
      });
      requests.markAcknowledgementDelivered(requestRef);
    }
    expect(requests.claimRequest({ requestRef: 'req-2', workerRef: 'worker-2', leaseExpiresAt: '2999-01-01T00:00:00.000Z' })).toBeNull();
    const first = requests.claimRequest({ requestRef: 'req-1', workerRef: 'worker-1', leaseExpiresAt: '2999-01-01T00:00:00.000Z' });
    expect(requests.recordCheckpoint({
      requestRef: 'req-1', expectedClaimGeneration: 99, phase: 'stale', checkpoint: { name: 'stale' }
    })).toBeNull();
    expect(requests.terminalizeRequest({
      requestRef: 'req-1', expectedClaimGeneration: first!.claimGeneration, state: 'succeeded', phase: 'complete',
      checkpoint: { name: 'complete' }, result: { value: 2 }
    })?.state).toBe('succeeded');
    expect(requests.claimRequest({ requestRef: 'req-2', workerRef: 'worker-2', leaseExpiresAt: '2999-01-01T00:00:00.000Z' })?.state).toBe('running');
    store.close();
  });

  it('binds event reads to broker-issued cursor query and owner epochs', () => {
    const store = new SqliteRelayStore(':memory:');
    const fixture = seed(store);
    store.canonical.events.createStream({
      streamRef: 'stream-a', tabRef: fixture.tab.tabRef, initialCursorRef: 'cursor-initial',
      queryHash: 'page-events', ownerEpoch: 1, baseline: { ready: true }
    });
    store.canonical.events.appendEvent({
      streamRef: 'stream-a', method: 'Page.loadEventFired', params: { timestamp: 1 },
      connectionGeneration: 1, cursorRef: 'cursor-after-1', queryHash: 'page-events', ownerEpoch: 1
    });
    expect(store.canonical.events.readEvents({ cursorRef: 'cursor-initial', queryHash: 'wrong', ownerEpoch: 1, limit: 10 })).toBeNull();
    expect(store.canonical.events.readEvents({ cursorRef: 'cursor-initial', queryHash: 'page-events', ownerEpoch: 2, limit: 10 })).toBeNull();
    const page = store.canonical.events.readEvents({ cursorRef: 'cursor-initial', queryHash: 'page-events', ownerEpoch: 1, limit: 10 });
    expect(page?.events).toMatchObject([{ method: 'Page.loadEventFired', sequence: 1 }]);
    expect(page?.cursor.cursorRef).toBe('cursor-after-1');
    store.close();
  });

  it('resolves a user-confirmation pause atomically with its resolver ticket', () => {
    const store = new SqliteRelayStore(':memory:');
    const fixture = seed(store);
    const requests = store.canonical.requests;
    requests.acceptRequest({
      requestRef: 'req-effect', toolName: 'send_cdp_command', requesterSessionRef: fixture.session.sessionRef,
      authorityScope: 'owner', authoritySessionRef: fixture.session.sessionRef, authorityLineageRef: fixture.lineage.lineageRef,
      endpointRef: fixture.endpoint.endpointRef, workspaceRef: fixture.workspace.workspaceRef, tabRef: fixture.tab.tabRef,
      acceptedOwnerEpoch: 1, normalizedBody: { method: 'Input.dispatchMouseEvent' }, phase: 'accepted', checkpoint: { name: 'accepted' }
    });
    requests.markAcknowledgementDelivered('req-effect');
    const target = requests.claimRequest({ requestRef: 'req-effect', workerRef: 'worker', leaseExpiresAt: '2999-01-01T00:00:00.000Z' })!;
    requests.recordCheckpoint({
      requestRef: target.requestRef, expectedClaimGeneration: target.claimGeneration, phase: 'awaiting_user_confirmation',
      checkpoint: { name: 'extension_result_missing' }, pauseCondition: 'user_confirmation_required'
    });
    requests.acceptRequest({
      requestRef: 'req-resolver', toolName: 'resolve_browser_request', requesterSessionRef: fixture.session.sessionRef,
      authorityScope: 'owner', authoritySessionRef: fixture.session.sessionRef, authorityLineageRef: fixture.lineage.lineageRef,
      endpointRef: fixture.endpoint.endpointRef, workspaceRef: fixture.workspace.workspaceRef, acceptedOwnerEpoch: 1,
      normalizedBody: { target_request_ref: 'req-effect', resolution: 'confirmed_succeeded' },
      phase: 'accepted', checkpoint: { name: 'accepted' }, resolutionOfRequestRef: 'req-effect'
    });
    requests.markAcknowledgementDelivered('req-resolver');
    expect(requests.resolveRequest({
      resolverRequestRef: 'req-resolver', targetRequestRef: 'req-effect', targetState: 'succeeded',
      targetResult: { resolution: 'confirmed_succeeded' }
    })).toBe(true);
    expect(requests.getRequest('req-effect')).toMatchObject({ state: 'succeeded', pauseCondition: null });
    expect(requests.getRequest('req-resolver')).toMatchObject({ state: 'succeeded', phase: 'resolved' });
    expect(requests.scanRequestRecovery().lanes).toHaveLength(0);
    store.close();
  });
});
