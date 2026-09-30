import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SqliteRelayStore } from '../storage/index.js';
import type { ExtensionConnectionSnapshot } from '../core/octopus/extension-port.js';
import { BootstrapGrants } from './bootstrap-grants.js';
import type { ChromeLauncher } from './chrome-launcher.js';
import { ProfileError, type ManagedBrowserInstance, type ManagedProfile, type ProfileAuthority, type ProfileOperation } from './types.js';

export type ProfileLifecycleLauncher = Pick<ChromeLauncher, 'prepare' | 'launch' | 'inspect' | 'ensureWindow' | 'close'> & Partial<Pick<ChromeLauncher, 'clearBootstrapSecret' | 'repair'>>;
export class ProfileManager {
  readonly grants: BootstrapGrants;
  private readonly queues = new Map<string, Promise<unknown>>();
  private active = 0;
  private pending = 0;
  private stopping = false;
  private observation: Promise<void> | null = null;
  private observationTimer: NodeJS.Timeout | null = null;
  private readonly barriers = new Set<string>();
  constructor(readonly store: SqliteRelayStore, private readonly launcher: ProfileLifecycleLauncher,
    private readonly connection: (endpointRef: string) => ExtensionConnectionSnapshot | null,
    private readonly timeoutMs = 120_000, readonly launchesEnabled = true) {
    this.grants = new BootstrapGrants(store.profiles, async value => await launcher.inspect(value) === 'running');
  }

  authorize(authority: ProfileAuthority | undefined, scope: 'profiles:read' | 'profiles:manage', profileRef?: string): ManagedProfile | null {
    if (!authority || !authority.scopes.includes(scope) || !this.store.getAgentById(authority.principalId)?.scopes.includes(scope)) throw new ProfileError('PROFILE_FORBIDDEN');
    if (!profileRef) return null;
    const profile = this.store.profiles.getVisible(authority.principalId, profileRef);
    if (!profile) throw new ProfileError('PROFILE_NOT_FOUND');
    return profile;
  }

  blocksEndpoint(endpointRef: string): boolean {
    const profile = this.store.profiles.forEndpoint(endpointRef);
    return !!profile && (this.barriers.has(profile.profileRef) || this.store.profiles.currentInstance(profile.profileRef)?.browserState === 'stopping');
  }

  facts(profile: ManagedProfile): Record<string, unknown> {
    const value = this.store.profiles.currentInstance(profile.profileRef);
    const endpoint = profile.endpointRef ? this.store.canonical.logical.getEndpoint(profile.endpointRef) : null;
    const connected = profile.endpointRef ? this.connection(profile.endpointRef) : null;
    const ready = !!value && value.browserState === 'running' && this.store.profiles.instanceAuthenticated(value.instanceRef)
      && connected?.connected === true && connected.inventoryGeneration > 0
      && this.store.canonical.logical.listWindows(profile.endpointRef!).some(window => window.eligible);
    return { profile_ref: profile.profileRef, display_name: profile.displayName,
      browser_state: value?.browserState ?? 'stopped', extension_state: value?.browserState === 'stopped' || (!value && profile.endpointRef) ? 'disconnected' : connected?.connected ? 'connected' : profile.endpointRef ? 'disconnected' : value?.extensionState ?? 'unknown',
      instance_ref: value?.instanceRef ?? null, endpoint_nickname: endpoint?.nickname ?? null,
      ready, automation_paused: profile.endpointRef === null ? null : this.store.canonical.logical.getEndpointKillState(profile.endpointRef).killed || this.store.canonical.logical.listActiveWorkspaces({ endpointRef: profile.endpointRef }).some(workspace => workspace.pauseCauses.length > 0),
      problem_code: profile.problemCode, observed_at: value?.observedAt ?? profile.updatedAt };
  }

  async run(operation: ProfileOperation, profile: ManagedProfile, assertRequestOwner: () => void = () => {},
    checkpoint: (phase: string) => void = () => {}): Promise<Record<string, unknown>> {
    if (this.stopping) throw new ProfileError('PROFILE_MANAGER_STOPPING');
    if (!this.launchesEnabled && operation !== 'stop_browser_profile') throw new ProfileError('PROFILE_MANAGEMENT_UNAVAILABLE');
    if (this.pending >= 32) throw new ProfileError('PROFILE_QUEUE_FULL');
    this.pending++;
    const prior = this.queues.get(profile.profileRef) ?? Promise.resolve();
    const queuedAt = Date.now();
    const work = prior.catch(() => {}).then(async () => {
      while (this.active >= 3) {
        if (this.stopping || Date.now() - queuedAt > 120_000) throw new ProfileError('PROFILE_QUEUE_TIMEOUT');
        assertRequestOwner(); await delay(100);
      }
      if (this.stopping || Date.now() - queuedAt > 120_000) throw new ProfileError('PROFILE_QUEUE_TIMEOUT');
      this.active++;
      const repository = this.store.profiles;
      const lease = repository.acquire(profile.profileRef, randomUUID(), 30_000);
      if (!lease) { this.active--; throw new ProfileError('PROFILE_IN_USE'); }
      let lost = false;
      const guard = () => {
        assertRequestOwner();
        if (lost || this.stopping || !repository.owns(lease)) throw new ProfileError('PROFILE_LEASE_LOST');
      };
      const timer = setInterval(() => { if (!repository.renew(lease, 30_000)) lost = true; }, 8_000);
      try {
        guard();
        const update = (value: ManagedBrowserInstance) => repository.transaction(() => { guard(); repository.updateInstance(value); });
        if (operation === 'stop_browser_profile') await this.stopProfile(profile, guard, update);
        else await this.openProfile(profile, guard, update, checkpoint);
        guard(); repository.setProblem(profile.profileRef, null);
        return this.facts(repository.get(profile.profileRef)!);
      } catch (error) {
        if (!lost && repository.owns(lease)) repository.setProblem(profile.profileRef, error instanceof ProfileError ? error.code : 'PROFILE_OPERATION_FAILED');
        throw error;
      } finally {
        clearInterval(timer); repository.release(lease); this.active--; this.barriers.delete(profile.profileRef);
      }
    });
    this.queues.set(profile.profileRef, work);
    try { return await work; } finally { this.pending--; if (this.queues.get(profile.profileRef) === work) this.queues.delete(profile.profileRef); }
  }

  private async openProfile(profile: ManagedProfile, guard: () => void, update: (value: ManagedBrowserInstance) => void, checkpoint: (phase: string) => void): Promise<void> {
    let instance = this.store.profiles.currentInstance(profile.profileRef);
    if (instance) {
      const state = await this.launcher.inspect(instance); guard();
      if (state === 'unknown') throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
      if (state === 'stopped') {
        await this.launcher.close(profile, instance, guard); guard();
        update({ ...instance, browserState: 'stopped', extensionState: 'disconnected', endedAt: new Date().toISOString() });
        instance = null;
      } else {
        await this.launcher.ensureWindow(instance, guard); guard();
        instance = { ...instance, browserState: 'running', observedAt: new Date().toISOString() }; update(instance);
        if (!this.facts(this.store.profiles.get(profile.profileRef)!).ready && this.launcher.repair
          && (!profile.endpointRef || this.store.canonical.logical.listActiveWorkspaces({ endpointRef: profile.endpointRef }).length === 0)) {
          checkpoint('repairing_extension');
          const claim = this.grants.issue(instance);
          await this.launcher.repair(profile, instance, { ...claim, existingIdentity: profile.identityHash !== null }, guard);
          guard();
        }
      }
    }
    if (!instance) {
      guard(); instance = this.store.profiles.createInstance(profile.profileRef);
      checkpoint('preparing_profile');
      const claim = this.grants.issue(instance);
      this.launcher.prepare(profile, { ...claim, existingIdentity: profile.identityHash !== null });
      guard(); checkpoint('starting_browser');
      instance = await this.launcher.launch(profile, instance, value => {
        update(value); if (value.browserState === 'running') checkpoint('loading_extension');
      }); guard();
    }
    checkpoint('waiting_for_extension');
    const deadline = Date.now() + this.timeoutMs;
    let waitingPhase = '';
    while (Date.now() < deadline) {
      guard();
      const currentProfile = this.store.profiles.get(profile.profileRef)!;
      if (this.facts(currentProfile).ready) {
        if (await this.launcher.inspect(instance) !== 'running') throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
        guard(); update({ ...instance, browserState: 'running', extensionState: 'connected', observedAt: new Date().toISOString() });
        this.launcher.clearBootstrapSecret?.(currentProfile, instance);
        checkpoint('ready'); return;
      }
      const phase = this.store.profiles.instanceAuthenticated(instance.instanceRef) ? 'waiting_for_inventory' : 'waiting_for_authentication';
      if (phase !== waitingPhase) { checkpoint(phase); waitingPhase = phase; }
      await delay(100);
    }
    throw new ProfileError('PROFILE_EXTENSION_TIMEOUT');
  }

  private async stopProfile(profile: ManagedProfile, guard: () => void, update: (value: ManagedBrowserInstance) => void): Promise<void> {
    let instance = this.store.profiles.currentInstance(profile.profileRef);
    if (!instance) return;
    guard(); this.barriers.add(profile.profileRef);
    const snapshot = this.store.canonical.logical.scanLogicalRecovery();
    const requests = this.store.canonical.requests.scanRequestRecovery().requests;
    if (snapshot.activeWorkspaces.some(workspace => workspace.endpointRef === profile.endpointRef)
      || requests.some(request => request.toolName === 'request_browser_workspace'
        || (profile.endpointRef && request.endpointRef === profile.endpointRef && !this.store.profiles.request(request.requestRef)))) {
      throw new ProfileError('PROFILE_HAS_ACTIVE_WORK');
    }
    const before = instance;
    instance = { ...instance, browserState: 'stopping' }; update(instance);
    try {
      guard(); await this.launcher.close(profile, instance, guard); guard();
      update({ ...instance, browserState: 'stopped', extensionState: 'disconnected', endedAt: new Date().toISOString(), observedAt: new Date().toISOString() });
    } catch (error) {
      guard(); update({ ...before, browserState: 'unknown', observedAt: new Date().toISOString() }); throw error;
    }
  }

  async reconcile(): Promise<void> {
    if (this.observation) return this.observation;
    const work = this.observeInstances();
    this.observation = work;
    try { await work; } finally { this.observation = null; }
  }

  startObserving(): void {
    if (this.observationTimer || this.stopping) return;
    this.observationTimer = setInterval(() => { void this.reconcile().catch(() => {}); }, 10_000);
    this.observationTimer.unref();
  }

  private async observeInstances(): Promise<void> {
    for (const profile of this.store.profiles.all()) {
      if (this.stopping) return;
      if (this.queues.has(profile.profileRef)) continue;
      const instance = this.store.profiles.currentInstance(profile.profileRef);
      if (!instance) continue;
      const observed = await this.launcher.inspect(instance).catch(() => 'unknown' as const);
      if (this.stopping || this.queues.has(profile.profileRef)) continue;
      const current = this.store.profiles.currentInstance(profile.profileRef);
      if (current?.instanceRef !== instance.instanceRef) continue;
      const lease = this.store.profiles.acquire(profile.profileRef, randomUUID(), 30_000);
      if (!lease) continue;
      try {
        this.store.profiles.updateInstance({ ...current, browserState: observed,
          extensionState: observed === 'stopped' ? 'disconnected' : current.extensionState, observedAt: new Date().toISOString() });
      } finally { this.store.profiles.release(lease); }
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.observationTimer) clearInterval(this.observationTimer);
    await this.observation;
    await Promise.allSettled([...this.queues.values()]);
  }
}
