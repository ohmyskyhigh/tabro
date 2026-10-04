import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { OctopusBroker, type OctopusExtensionPort } from '../../apps/broker/src/core/index.js';
import { ProfileManager } from '../../apps/broker/src/profiles/profile-manager.js';
import type { RelayV2PayloadByType } from '../../apps/shared/protocol/src/index.js';

describe('missing idle workspace retirement', () => {
  let store: SqliteRelayStore;
  let broker: OctopusBroker;
  let manager: ProfileManager;
  let endpointRef: string;
  let profileRef: string;
  let connected: boolean;
  let closed: number;
  let inventory: RelayV2PayloadByType['INVENTORY_SNAPSHOT'];
  beforeEach(() => {
    store = new SqliteRelayStore(':memory:'); broker = new OctopusBroker(store.canonical);
    const owner = store.createAgent('original creator', ['profiles:manage']).principal;
    const profile = store.profiles.create(owner.principalId, 'chrome'); profileRef = profile.profileRef;
    endpointRef = broker.ensureEndpoint({ nickname: 'mapleglen' }).endpointRef;
    broker.openEndpointConnection({ endpointRef, connectionRef: 'connection', transport: 'test', protocolVersion: '2' });
    store.profiles.bind(profileRef, endpointRef, 'identity');
    const instance = store.profiles.createInstance(profileRef);
    store.profiles.updateInstance({ ...instance, browserState: 'running' });
    connected = true; closed = 0;
    inventory = { attemptId: 'inventory', connectionGeneration: 1, inventoryGeneration: 10,
      capturedAt: new Date().toISOString(), browser: { product: 'Chrome', version: '153', userAgent: null },
      windows: [{ windowId: 1, windowGeneration: 1, focused: true, incognito: false,
        type: 'normal', state: 'normal', groups: [], tabs: [] }] };
    const port: OctopusExtensionPort = {
      setEventSink() {}, connection: () => ({ endpointRef, connected, connectionGeneration: 1, inventoryGeneration: 10 }),
      requestInventory: async () => inventory, execute: async () => { throw new Error('No browser mutation expected'); }
    };
    broker.setExtensionPort(port);
    manager = new ProfileManager(store, { prepare() {}, inspect: async () => 'running',
      ensureWindow: async () => {}, launch: async () => { throw new Error('No launch expected'); }, close: async () => { closed++; } }, port.connection);
    broker.setProfileManager(manager);
    const logical = store.canonical.logical;
    logical.registerLineage({ lineageRef: 'old_lineage', runtimeName: 'old demo' });
    logical.registerSession({ sessionRef: 'old_session', lineageRef: 'old_lineage', runtimeSessionKeyHash: 'old' });
    logical.upsertWindow({ windowRef: 'window', endpointRef, privateWindowKey: JSON.stringify({ windowId: 1, connectionGeneration: 1 }),
      locatorGeneration: 1, eligible: true, focused: true });
    logical.createWorkspace({ workspaceRef: 'workspace', endpointRef, windowRef: 'window', lineageRef: 'old_lineage',
      ownerSessionRef: 'old_session', groupLabel: 'old demo', privateGroupKey: JSON.stringify({ tabGroupId: 99, connectionGeneration: 1 }), locatorGeneration: 1 });
    logical.addTab({ tabRef: 'tab', workspaceRef: 'workspace', endpointRef, windowRef: 'window',
      privateTabKey: JSON.stringify({ tabId: 77, connectionGeneration: 1 }), locatorGeneration: 1 });
    logical.setWorkspacePauseCause({ workspaceRef: 'workspace', cause: 'termination_failed' });
  });
  afterEach(async () => { broker.beginShutdown(); await manager.shutdown(); await broker.waitForIdle(); store.close(); });

  it('retires only absent idle work and lets another authorized principal close the Profile', async () => {
    const other = store.createAgent('Hermes', ['profiles:manage', 'profiles:read']).principal;
    const profile = manager.authorize(other, 'profiles:manage', profileRef)!;
    await expect(manager.run('stop_browser_profile', profile)).rejects.toThrow('PROFILE_HAS_ACTIVE_WORK');
    broker.onInventory(endpointRef, inventory);
    expect(store.canonical.logical.getWorkspace('workspace')).toMatchObject({ lifecycle: 'ended', ownerSessionRef: 'old_session', pauseCauses: [] });
    expect(store.canonical.logical.getTab('workspace', 'tab')?.lifecycle).toBe('closed');
    expect(manager.facts(profile).automation_paused).toBe(false);
    await manager.run('stop_browser_profile', profile);
    expect(closed).toBe(1);
    expect(store.profiles.currentInstance(profileRef)).toBeNull();
    expect(store.profiles.get(profileRef)?.identityHash).toBe('identity');
  });

  it.each(['old inventory', 'old connection', 'disconnected'] as const)('does not retire from %s evidence', kind => {
    if (kind === 'old inventory') inventory.inventoryGeneration = 9;
    if (kind === 'old connection') inventory.connectionGeneration = 0;
    if (kind === 'disconnected') connected = false;
    broker.onInventory(endpointRef, inventory);
    expect(store.canonical.logical.getWorkspace('workspace')?.lifecycle).toBe('active');
    expect(closed).toBe(0);
  });

  it.each(['live group', 'surviving tab', 'unreadable tab'] as const)('keeps a workspace with a %s', kind => {
    if (kind === 'live group') inventory.windows[0]!.groups.push({ tabGroupId: 99, groupGeneration: 1, windowId: 1,
      title: 'old demo', color: 'blue', collapsed: false });
    if (kind === 'surviving tab') inventory.windows[0]!.tabs.push({ tabId: 77, tabGeneration: 1, windowId: 1, groupId: null,
      title: '', url: 'about:blank', openerTabId: null, active: true, pinned: false, discarded: false, status: 'complete',
      debugger: { attached: false, attachmentGeneration: null, protocolVersion: null } });
    if (kind === 'unreadable tab') store.canonical.logical.updateTab({ workspaceRef: 'workspace', tabRef: 'tab',
      expectedLocatorGeneration: 1, privateTabKey: 'invalid' });
    broker.onInventory(endpointRef, inventory);
    expect(store.canonical.logical.getWorkspace('workspace')?.lifecycle).toBe('active');
  });

  it.each(['send_cdp_command', 'take_over_workspace', 'kill_browser_endpoint', 'request_browser_workspace'] as const)('preserves unfinished %s requests and their workspace', toolName => {
    store.canonical.requests.acceptRequest({ requestRef: 'pending', toolName, requesterSessionRef: 'old_session',
      authorityScope: 'requester', authoritySessionRef: 'old_session', authorityLineageRef: 'old_lineage',
      ...(toolName === 'send_cdp_command' || toolName === 'take_over_workspace' ? { workspaceRef: 'workspace' } : {}),
      endpointRef, normalizedBody: {}, phase: 'queued', checkpoint: {} });
    broker.onInventory(endpointRef, inventory);
    expect(store.canonical.logical.getWorkspace('workspace')?.lifecycle).toBe('active');
    expect(store.canonical.requests.getRequest('pending')?.state).toBe('queued');
    store.canonical.requests.terminalizeRequest({ requestRef: 'pending', state: 'failed', phase: 'done', checkpoint: {} });
    broker.onInventory(endpointRef, inventory);
    expect(store.canonical.logical.getWorkspace('workspace')?.lifecycle).toBe('ended');
  });
});
