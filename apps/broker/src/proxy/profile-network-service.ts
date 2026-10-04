import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { SqliteRelayStore, StoredCallerSession, StoredRequestTicket, JsonRecord } from '../storage/index.js';
import type { OctopusExtensionPort } from '../core/octopus/extension-port.js';
import { acceptedSubmission, completeRead, pollAction, type JsonObject } from '../core/octopus/mcp-presenter.js';
import { problem } from '../core/octopus/broker-problem.js';
import { ProfileError, type ProfileAuthority } from '../profiles/types.js';
import type { ProfileManager } from '../profiles/profile-manager.js';
import { PublicProblemCodes, type PublicProblemCode } from '../../../shared/protocol/src/error-codes.js';
import { isProxyOperation, upstreamProxySchema, type ProxyOperation, type CredentialReader, type ProxyExit } from './types.js';
import { ProxyGatewayManager } from './proxy-gateway-manager.js';

export class ProfileNetworkService {
  readonly gateways: ProxyGatewayManager;
  private readonly reconciling = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  constructor(readonly store: SqliteRelayStore, private readonly port: () => OctopusExtensionPort | null,
    private readonly credentials: CredentialReader, private readonly profiles: ProfileManager | null = null) {
    this.gateways = new ProxyGatewayManager(credentials, (ref, port) => {
      const binding = store.proxies.get(ref); store.proxies.save({ ...binding, port });
    });
  }
  resolve(ref: string): { profileRef: string; endpointRef: string | null } {
    const profile = this.store.profiles.get(ref);
    if (profile) return { profileRef: ref, endpointRef: profile.endpointRef };
    const endpoint = this.store.canonical.logical.getEndpoint(ref);
    if (!endpoint || endpoint.lifecycle !== 'paired' || endpoint.connectionGeneration < 1) throw new ProfileError('PROFILE_NOT_FOUND');
    if (this.store.profiles.forEndpoint(ref)) throw new ProfileError('PROFILE_NOT_FOUND');
    return { profileRef: ref, endpointRef: ref };
  }
  authorize(authority: ProfileAuthority | undefined, mutate: boolean): void {
    const required = mutate ? 'profiles:network:manage' : 'profiles:read';
    if (!authority?.scopes.includes(required) || !this.store.getAgentById(authority.principalId)?.scopes.includes(required)) throw new ProfileError('PROFILE_FORBIDDEN');
  }
  facts(ref: string): JsonObject {
    const binding = this.store.proxies.get(ref);
    const { endpointRef } = this.resolve(ref);
    const connection = endpointRef ? this.port()?.connection(endpointRef) : null;
    const current = connection?.connected && connection.connectionGeneration === binding.connectionGeneration;
    const unsupported = !!binding.proxy && !this.store.profiles.get(ref);
    return { profile_ref: ref, revision: binding.revision, proxy: binding.proxy ? { ...binding.proxy } : null,
      application: { state: unsupported ? 'failed' : binding.proxy && !current ? 'pending_connection' : binding.state,
        applied_revision: current && !unsupported ? binding.appliedRevision : null, observed_at: binding.observedAt,
        problem_code: unsupported ? 'PROFILE_USER_OWNED' : binding.problemCode },
      exit: binding.exit ? { ...binding.exit } : null };
  }
  summary(ref: string): JsonObject {
    const facts = this.facts(ref);
    return { revision: facts.revision!, configured: facts.proxy !== null, application: facts.application!, exit: facts.exit! };
  }
  get(input: JsonObject, authority: ProfileAuthority | undefined, caller: StoredCallerSession): JsonObject {
    this.authorize(authority, false); this.resolve(String(input.profile_ref));
    return completeRead(caller, { proxy: this.facts(String(input.profile_ref)) });
  }
  canRead(ticket: StoredRequestTicket, authority: ProfileAuthority | undefined): boolean {
    const saved = this.store.proxies.request(ticket.requestRef);
    if (!saved || saved.principalId !== authority?.principalId) return false;
    try { this.authorize(authority, false); return true; } catch { return false; }
  }
  private assertIdle(ref: string, except = ''): void {
    const { endpointRef } = this.resolve(ref);
    if (this.store.proxies.busy(ref, except, true)) throw new ProfileError('PROXY_BUSY');
    if (endpointRef && this.store.canonical.logical.listActiveWorkspaces({ endpointRef }).length) throw new ProfileError('PROFILE_HAS_ACTIVE_WORK');
    for (const request of this.store.canonical.requests.scanRequestRecovery().requests) {
      if (request.requestRef === except) continue;
      if (request.toolName === 'request_browser_workspace'
        || (endpointRef && request.endpointRef === endpointRef)
        || this.store.profiles.request(request.requestRef)?.profileRef === ref) throw new ProfileError('PROFILE_HAS_ACTIVE_WORK');
    }
  }
  private requireManaged(ref: string) {
    const profile = this.store.profiles.get(ref);
    if (!profile) throw new ProfileError('PROFILE_USER_OWNED', 'Proxy configuration is available only for broker-owned Profiles.');
    return profile;
  }
  private assertManagedClosed(ref: string): void {
    const profile = this.requireManaged(ref);
    const instance = this.store.profiles.currentInstance(ref);
    if ((profile.endpointRef && this.port()?.connection(profile.endpointRef)?.connected)
      || (instance && instance.browserState !== 'stopped')) {
      throw new ProfileError('PROFILE_IN_USE', 'Close the Profile before changing its proxy.');
    }
  }
  private async verifyManagedClosed(ref: string, guard: () => void): Promise<void> {
    const profile = this.requireManaged(ref);
    if (!this.profiles) throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
    await this.profiles.assertClosed(profile, guard);
    this.assertManagedClosed(ref);
  }
  assertLifecycle(ref: string, except = ''): void { if (this.store.proxies.busy(ref, except, true)) throw new ProfileError('PROXY_BUSY'); }
  submit(tool: ProxyOperation, input: JsonObject, authority: ProfileAuthority | undefined, caller: StoredCallerSession): JsonObject {
    this.authorize(authority, tool !== 'check_browser_proxy');
    const ref = String(input.profile_ref); this.resolve(ref); this.requireManaged(ref);
    if (!Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 0) throw new ProfileError('INVALID_ARGUMENT');
    const allowed = tool === 'set_browser_proxy' ? ['profile_ref', 'expected_revision', 'idempotency_key', 'proxy'] : tool === 'clear_browser_proxy' ? ['profile_ref', 'expected_revision', 'idempotency_key'] : ['profile_ref', 'expected_revision'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new ProfileError('INVALID_ARGUMENT');
    if (tool === 'set_browser_proxy') {
      const parsed = upstreamProxySchema.safeParse(input.proxy);
      if (!parsed.success) throw new ProfileError('INVALID_ARGUMENT');
      input = { ...input, proxy: parsed.data };
    }
    const key = tool === 'check_browser_proxy' ? null : input.idempotency_key;
    if (key !== null && (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/u.test(key))) throw new ProfileError('INVALID_ARGUMENT');
    input = { profile_ref: ref, expected_revision: input.expected_revision!, ...(key === null ? {} : { idempotency_key: String(key) }),
      ...(tool === 'set_browser_proxy' ? { proxy: input.proxy! } : {}) };
    const hash = createHash('sha256').update(JSON.stringify({ tool, ...input })).digest('hex');
    return this.store.proxies.transaction(() => {
      const reused = key === null ? null : this.store.proxies.reuse(authority!.principalId, String(key));
      if (reused) {
        if (reused.bodyHash !== hash) throw new ProfileError('IDEMPOTENCY_CONFLICT');
        const ticket = this.store.canonical.requests.getRequest(reused.requestRef)!;
        if (ticket.state === 'queued' && ticket.publiclyVisible) return acceptedSubmission(caller, ticket);
        return completeRead(caller, { proxy: this.facts(ref), request_ref: ticket.publiclyVisible ? ticket.requestRef : null }, ticket.publiclyVisible ? [pollAction(ticket.requestRef)] : []);
      }
      if (this.store.proxies.get(ref).revision !== input.expected_revision) throw new ProfileError('PROXY_REVISION_CONFLICT');
      if (tool !== 'check_browser_proxy') { this.assertIdle(ref); this.assertManagedClosed(ref); }
      else if (!this.ready(ref) || !this.store.proxies.get(ref).proxy) throw new ProfileError('PROXY_NOT_READY');
      if (this.store.canonical.requests.scanRequestRecovery().requests.filter(t => isProxyOperation(t.toolName)).length >= 32) throw new ProfileError('PROXY_BUSY');
      const requestRef = `req_${randomUUID()}`;
      this.store.canonical.requests.acceptRequest({ requestRef, toolName: tool, requesterSessionRef: caller.sessionRef,
        authorityScope: 'requester', authoritySessionRef: caller.sessionRef, authorityLineageRef: caller.lineageRef,
        normalizedBody: { tool, arguments: input } as JsonRecord, phase: 'proxy_reserved',
        checkpoint: { name: 'proxy_reserved', recorded_at: new Date().toISOString(), details: {} } });
      this.store.proxies.associate(requestRef, ref, authority!.principalId, hash, key as string | null);
      return acceptedSubmission(caller, this.store.canonical.requests.getRequest(requestRef)!);
    });
  }
  ready(ref: string, ignoreBusy = false): boolean {
    const binding = this.store.proxies.get(ref);
    if (!ignoreBusy && this.store.proxies.busy(ref)) return false;
    if (binding.revision === 0) return true;
    if (binding.proxy && !this.store.profiles.get(ref)) return false;
    const { endpointRef } = this.resolve(ref); const connection = endpointRef ? this.port()?.connection(endpointRef) : null;
    if (!binding.proxy) return binding.state === 'unmanaged';
    return !!connection?.connected && binding.state === 'applied' && binding.appliedRevision === binding.revision
      && connection.connectionGeneration === binding.connectionGeneration && this.gateways.ready(ref, binding.revision);
  }
  blocksEndpoint(endpoint: string): boolean {
    const ref = this.store.profiles.forEndpoint(endpoint)?.profileRef ?? endpoint;
    return !this.ready(ref);
  }
  async prepareLaunch(ref: string): Promise<number | null> {
    const binding = this.store.proxies.get(ref);
    return binding.proxy ? await this.gateways.ensure(binding) : null;
  }
  private async command(ref: string, action: 'read' | 'apply' | 'clear' | 'probe', guard: () => void = () => {}): Promise<JsonObject | null> {
    this.requireManaged(ref);
    const binding = this.store.proxies.get(ref); const { endpointRef } = this.resolve(ref);
    const port = this.port(); const connection = endpointRef ? port?.connection(endpointRef) : null;
    if (!endpointRef || !connection?.connected) return null;
    if (!connection.profileProxy) throw new ProfileError('PROXY_UNSUPPORTED');
    guard();
    const reply = await port!.execute(endpointRef, 'PROFILE_PROXY', { attemptId: randomUUID(), expected: {
      connectionGeneration: connection.connectionGeneration, inventoryGeneration: connection.inventoryGeneration },
      action, revision: binding.revision, port: binding.port });
    guard();
    if (port!.connection(endpointRef)?.connectionGeneration !== connection.connectionGeneration || this.store.proxies.get(ref).revision !== binding.revision) throw new ProfileError('PROXY_REVISION_CONFLICT');
    if (reply.outcome !== 'succeeded' || !reply.result) {
      const code = reply.error?.message.split(':')[0] ?? 'PROXY_APPLY_FAILED';
      throw new ProfileError((PublicProblemCodes as readonly string[]).includes(code) ? code : 'PROXY_APPLY_FAILED');
    }
    const result = reply.result;
    const state = result.state === 'applied' && result.revision === binding.revision && binding.proxy ? 'applied'
      : result.state === 'unmanaged' && !binding.proxy ? 'unmanaged' : 'control_conflict';
    this.store.proxies.save({ ...this.store.proxies.get(ref), state, appliedRevision: state === 'applied' ? binding.revision : null,
      connectionGeneration: connection.connectionGeneration, observedAt: new Date().toISOString(), problemCode: state === 'control_conflict' ? 'PROXY_CONTROL_CONFLICT' : null });
    return result;
  }
  async execute(ticket: StoredRequestTicket): Promise<void> {
    const association = this.store.proxies.request(ticket.requestRef)!;
    const ref = association.profileRef;
    const input = ticket.normalizedBody.arguments as JsonObject;
    const guard = () => {
      if (this.stopping || !this.store.profiles.ownsRequest(ticket.requestRef, ticket.claimGeneration)) throw new ProfileError('PROFILE_LEASE_LOST');
      const principal = this.store.getAgentById(association.principalId);
      this.authorize(principal ? { principalId: principal.principalId, scopes: principal.scopes } : undefined, ticket.toolName !== 'check_browser_proxy');
      this.requireManaged(ref);
    };
    const timer = setInterval(() => this.store.profiles.renewRequest(ticket.requestRef, ticket.claimGeneration, 30_000), 8_000);
    try {
      guard();
      await this.reconciling.get(ref); guard();
      if (ticket.toolName === 'check_browser_proxy') {
        if (this.store.proxies.get(ref).revision !== input.expected_revision) throw new ProfileError('PROXY_REVISION_CONFLICT');
        const reply = await this.command(ref, 'probe', guard);
        const exit = reply?.exit as unknown as ProxyExit | undefined;
        if (!exit || isIP(exit.ip) === 0 || exit.revision !== input.expected_revision) throw new ProfileError('PROXY_CHECK_FAILED');
        this.store.proxies.save({ ...this.store.proxies.get(ref), exit });
      } else {
        this.assertIdle(ref, ticket.requestRef);
        if (association.savedRevision === null) {
          if (this.store.proxies.get(ref).revision !== input.expected_revision) throw new ProfileError('PROXY_REVISION_CONFLICT');
          const proxy = ticket.toolName === 'set_browser_proxy' ? upstreamProxySchema.parse(input.proxy) : null;
          if (proxy?.credential_ref) await this.credentials.read(proxy.credential_ref, association.principalId);
          await this.verifyManagedClosed(ref, guard);
          guard(); this.assertIdle(ref, ticket.requestRef);
          this.store.proxies.transaction(() => {
            const current = this.store.proxies.get(ref);
            if (current.revision !== input.expected_revision) throw new ProfileError('PROXY_REVISION_CONFLICT');
            this.store.proxies.save({ ...current, revision: current.revision + 1, proxy, principalId: association.principalId,
              state: 'pending_connection', appliedRevision: null, exit: null, problemCode: null });
            this.store.proxies.markSaved(ticket.requestRef, current.revision + 1);
          });
        }
        guard(); await this.gateways.ensure(this.store.proxies.get(ref)); guard();
        // Save while closed. Only the next launch/reconnection applies or clears the setting.
      }
      guard();
      this.store.canonical.requests.terminalizeRequest({ requestRef: ticket.requestRef, expectedClaimGeneration: ticket.claimGeneration,
        state: 'succeeded', phase: 'complete', checkpoint: { name: 'complete', recorded_at: new Date().toISOString(), details: {} },
        result: { tool: ticket.toolName, disposition: 'complete', facts: { proxy: this.facts(ref) } } as JsonRecord });
    } catch (error) {
      if (!this.store.profiles.ownsRequest(ticket.requestRef, ticket.claimGeneration)) return;
      const code = error instanceof ProfileError && (PublicProblemCodes as readonly string[]).includes(error.code) ? error.code as PublicProblemCode : 'PROXY_APPLY_FAILED';
      if (ticket.toolName !== 'check_browser_proxy' && this.store.proxies.request(ticket.requestRef)?.savedRevision != null) this.store.proxies.save({ ...this.store.proxies.get(ref), state: code === 'PROXY_CONTROL_CONFLICT' ? 'control_conflict' : 'failed', problemCode: code });
      const failure = problem(code, code, false);
      this.store.canonical.requests.terminalizeRequest({ requestRef: ticket.requestRef, expectedClaimGeneration: ticket.claimGeneration,
        state: 'failed', phase: 'failed', checkpoint: { name: 'proxy_failed', recorded_at: new Date().toISOString(), details: {} },
        problem: failure as unknown as JsonRecord, effectMayHaveOccurred: this.store.proxies.request(ticket.requestRef)?.savedRevision !== null,
        result: { tool: ticket.toolName, kind: 'octopus_problem', problem: failure, debugger_error: null, known_facts: { proxy: this.facts(ref) } } as JsonRecord });
    } finally { clearInterval(timer); }
  }
  async reconcile(ref: string, exceptRequest = ''): Promise<void> {
    if (this.stopping || !this.store.profiles.get(ref) || this.store.proxies.busy(ref, exceptRequest)) return;
    if (this.reconciling.has(ref)) return this.reconciling.get(ref);
    const work = (async () => {
      const binding = this.store.proxies.get(ref); if (binding.revision === 0) return;
      try {
        await this.gateways.ensure(binding);
        if (this.stopping || this.store.proxies.busy(ref, exceptRequest)) return;
        const { endpointRef } = this.resolve(ref); const connection = endpointRef ? this.port()?.connection(endpointRef) : null;
        const action = !binding.proxy ? 'clear' : binding.connectionGeneration === connection?.connectionGeneration && binding.appliedRevision === binding.revision ? 'read' : 'apply';
        await this.command(ref, action);
      } catch (error) {
        const code = error instanceof ProfileError ? error.code : 'PROXY_APPLY_FAILED';
        this.store.proxies.save({ ...this.store.proxies.get(ref), state: code === 'PROXY_CONTROL_CONFLICT' ? 'control_conflict' : 'failed', problemCode: code });
      }
    })();
    this.reconciling.set(ref, work);
    try { await work; } finally { this.reconciling.delete(ref); }
  }
  start(): void {
    this.timer = setInterval(() => { for (const binding of this.store.proxies.all()) void this.reconcile(binding.profileRef); }, 2_000);
    this.timer.unref();
  }
  async close(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); await Promise.allSettled(this.reconciling.values()); await this.gateways.close(); }
}
