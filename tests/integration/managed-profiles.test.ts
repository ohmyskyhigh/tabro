import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { ProfileManager, type ProfileLifecycleLauncher } from '../../apps/broker/src/profiles/profile-manager.js';
import type { ManagedBrowserInstance } from '../../apps/broker/src/profiles/types.js';

describe('Profile lifecycle coordination', () => {
  let store: SqliteRelayStore;
  let manager: ProfileManager;
  let launcher: ProfileLifecycleLauncher;
  let starts: number;
  let live: Set<string>;
  beforeEach(() => {
    store = new SqliteRelayStore(':memory:'); starts = 0; live = new Set();
    launcher = {
      prepare() {},
      async launch(profile, instance, checkpoint) {
        starts++; live.add(instance.instanceRef);
        const current: ManagedBrowserInstance = { ...instance, browserState: 'running', pid: starts, processCreatedAt: 'now' };
        checkpoint(current);
        const endpoint = `ep_${profile.profileRef}`;
        if (!store.canonical.logical.getEndpoint(endpoint)) store.canonical.logical.createEndpoint({ endpointRef: endpoint, nickname: profile.profileRef });
        store.profiles.bind(profile.profileRef, endpoint, 'identity');
        store.profiles.authenticateInstance(instance.instanceRef);
        store.canonical.logical.upsertWindow({ windowRef: `win_${profile.profileRef}`, endpointRef: endpoint, privateWindowKey: 'key', locatorGeneration: 1, focused: true, eligible: true });
        return current;
      },
      async inspect(instance) { return live.has(instance.instanceRef) ? 'running' : 'stopped'; },
      async ensureWindow() {},
      async close(_profile, instance) { live.delete(instance.instanceRef); }
    };
    manager = new ProfileManager(store, launcher, endpointRef => ({ endpointRef, connected: true, connectionGeneration: 1, inventoryGeneration: 1 }), 250);
  });
  afterEach(async () => { await manager.shutdown(); store.close(); });
  function profile() {
    const principal = store.createAgent('test', ['profiles:read', 'profiles:manage']).principal;
    return store.profiles.create(principal.principalId, 'chrome');
  }
  it('serializes open/open and reuses the authenticated browser instance', async () => {
    const p = profile();
    const results = await Promise.all([manager.run('open_browser_profile', p), manager.run('open_browser_profile', p)]);
    expect(starts).toBe(1);
    expect(results.every(result => result.ready === true)).toBe(true);
    await manager.run('stop_browser_profile', store.profiles.get(p.profileRef)!);
    expect(store.profiles.currentInstance(p.profileRef)).toBeNull();
    expect(store.profiles.get(p.profileRef)?.identityHash).toBe('identity');
    await manager.run('open_browser_profile', store.profiles.get(p.profileRef)!);
    expect(starts).toBe(2);
  });
  it('keeps partial resources and never repeats an uncertain spawn', async () => {
    const p = profile();
    launcher.launch = async () => { starts++; throw new Error('crash after spawn'); };
    launcher.inspect = async () => 'unknown';
    await expect(manager.run('open_browser_profile', p)).rejects.toThrow('crash after spawn');
    expect(store.profiles.get(p.profileRef)).not.toBeNull();
    await expect(manager.run('open_browser_profile', p)).rejects.toThrow('PROFILE_INSTANCE_UNVERIFIED');
    expect(starts).toBe(1);
  });
  it('shares broker-owned Profiles while checking current scopes even if cached transport scopes were broader', () => {
    const p = profile();
    const evidence = { principalId: p.principalId, scopes: ['profiles:read', 'profiles:manage'] };
    expect(manager.authorize(evidence, 'profiles:manage', p.profileRef)?.profileRef).toBe(p.profileRef);
    store.updateAgentScopes(p.principalId, ['profiles:read']);
    expect(() => manager.authorize(evidence, 'profiles:manage', p.profileRef)).toThrow('PROFILE_FORBIDDEN');
    const other = profile();
    expect(manager.authorize({ principalId: other.principalId, scopes: ['profiles:manage'] }, 'profiles:manage', p.profileRef)?.profileRef).toBe(p.profileRef);
  });
  it('refuses stop while an active workspace remains and releases its barrier', async () => {
    const p = profile(); await manager.run('open_browser_profile', p);
    const endpoint = store.profiles.get(p.profileRef)!.endpointRef!;
    store.canonical.logical.registerLineage({ lineageRef: 'lin', runtimeName: 'test' });
    store.canonical.logical.registerSession({ sessionRef: 'ses', lineageRef: 'lin', runtimeSessionKeyHash: 'test' });
    store.canonical.logical.createWorkspace({ workspaceRef: 'ws', endpointRef: endpoint, windowRef: `win_${p.profileRef}`, lineageRef: 'lin', ownerSessionRef: 'ses', groupLabel: 'test' });
    await expect(manager.run('stop_browser_profile', store.profiles.get(p.profileRef)!)).rejects.toThrow('PROFILE_HAS_ACTIVE_WORK');
    expect(live.size).toBe(1);
    expect(manager.blocksEndpoint(endpoint)).toBe(false);
  });
  it('does not start a browser after request ownership has been lost', async () => {
    const p = profile();
    await expect(manager.run('open_browser_profile', p, () => { throw new Error('lost request lease'); })).rejects.toThrow('lost request lease');
    expect(starts).toBe(0);
  });
  it('observes manual closure and never overwrites another worker lease', async () => {
    const p = profile(); await manager.run('open_browser_profile', p);
    live.clear();
    const lease = store.profiles.acquire(p.profileRef, 'other-worker', 30_000)!;
    await manager.reconcile();
    expect(store.profiles.currentInstance(p.profileRef)?.browserState).toBe('running');
    store.profiles.release(lease);
    await manager.reconcile();
    expect(manager.facts(store.profiles.get(p.profileRef)!)).toMatchObject({ browser_state: 'stopped', extension_state: 'disconnected', ready: false });
  });
  it('limits concurrent starts to three and releases capacity for queued profiles', async () => {
    let count = 0; let peak = 0;
    const original = launcher.launch;
    launcher.launch = async (...args) => {
      count++; peak = Math.max(peak, count);
      try { await new Promise(resolve => setTimeout(resolve, 40)); return await original(...args); }
      finally { count--; }
    };
    const profiles = Array.from({ length: 5 }, profile);
    const results = await Promise.all(profiles.map(p => manager.run('open_browser_profile', p)));
    expect(results.every(r => r.ready)).toBe(true); expect(peak).toBe(3);
  });
  it('disables new launches while retaining authorized list facts and normal stop', async () => {
    const p = profile(); await manager.run('open_browser_profile', p); await manager.shutdown();
    manager = new ProfileManager(store, launcher, () => null, 250, false);
    expect(manager.facts(store.profiles.get(p.profileRef)!).profile_ref).toBe(p.profileRef);
    await expect(manager.run('open_browser_profile', p)).rejects.toThrow('PROFILE_MANAGEMENT_UNAVAILABLE');
    await manager.run('stop_browser_profile', p); expect(live.size).toBe(0);
  });
  it('repairs a running disconnected instance once without spawning and leaves a failed lane independent', async () => {
    const p = profile(); await manager.run('open_browser_profile', p);
    const instance = store.profiles.currentInstance(p.profileRef)!;
    let repairs = 0;
    await manager.shutdown();
    launcher.repair = async () => { repairs++; throw new Error('repair unavailable'); };
    manager = new ProfileManager(store, launcher, () => null, 20);
    await expect(manager.run('open_browser_profile', store.profiles.get(p.profileRef)!)).rejects.toThrow('repair unavailable');
    expect(repairs).toBe(1); expect(starts).toBe(1);
    expect(store.profiles.currentInstance(p.profileRef)?.instanceRef).toBe(instance.instanceRef);
    await manager.run('stop_browser_profile', p); expect(live.size).toBe(0);
  });
});
