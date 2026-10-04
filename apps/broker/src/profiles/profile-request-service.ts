import { createHash, randomUUID } from 'node:crypto';
import type { StoredCallerSession, StoredRequestTicket, JsonRecord } from '../storage/index.js';
import { acceptedSubmission, completeRead, pollAction, type JsonObject } from '../core/octopus/mcp-presenter.js';
import { problem } from '../core/octopus/broker-problem.js';
import { ProfileError, type ProfileAuthority, type ProfileOperation } from './types.js';
import type { ProfileManager } from './profile-manager.js';
import { PublicProblemCodes, type PublicProblemCode } from '../../../shared/protocol/src/error-codes.js';

export const PROFILE_OPERATIONS = ['create_browser_profile', 'open_browser_profile', 'stop_browser_profile'] as const;
export const isProfileOperation = (tool: string): tool is ProfileOperation => (PROFILE_OPERATIONS as readonly string[]).includes(tool);
export class ProfileRequestService {
  constructor(readonly manager: ProfileManager) {}

  submit(tool: ProfileOperation, input: JsonObject, authority: ProfileAuthority | undefined, caller: StoredCallerSession): JsonObject {
    this.manager.authorize(authority, 'profiles:manage');
    if (!this.manager.launchesEnabled && tool !== 'stop_browser_profile') throw new ProfileError('PROFILE_MANAGEMENT_UNAVAILABLE');
    const store = this.manager.store;
    const accept = () => {
      if (store.canonical.requests.scanRequestRecovery().requests.filter(t => isProfileOperation(t.toolName) && (t.state === 'queued' || t.state === 'running')).length >= 32) throw new ProfileError('PROFILE_QUEUE_FULL');
      const ref = `req_${randomUUID()}`;
      store.canonical.requests.acceptRequest({ requestRef: ref, toolName: tool, requesterSessionRef: caller.sessionRef,
        authorityScope: 'requester', authoritySessionRef: caller.sessionRef, authorityLineageRef: caller.lineageRef,
        normalizedBody: { tool, arguments: input } as JsonRecord, phase: 'reserved',
        checkpoint: { name: 'profile_reserved', recorded_at: new Date().toISOString(), details: {} } });
      return ref;
    };
    let requestRef: string;
    if (tool === 'create_browser_profile') {
      if (Object.keys(input).some(key => key !== 'idempotency_key') || typeof input.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/u.test(input.idempotency_key)) throw new ProfileError('INVALID_ARGUMENT');
      input = { idempotency_key: input.idempotency_key };
      const reserved = store.profiles.reserveCreation({ principalId: authority!.principalId, key: input.idempotency_key as string,
        bodyHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), runtimeRef: 'configured-chrome' }, accept);
      requestRef = reserved.requestRef;
      const ticket = store.canonical.requests.getRequest(requestRef)!;
      if (reserved.reused && (ticket.state !== 'queued' || !ticket.publiclyVisible)) {
        return completeRead(caller, { profile: this.manager.facts(reserved.profile), request_ref: ticket.publiclyVisible ? requestRef : null },
          ticket.publiclyVisible ? [pollAction(requestRef)] : []);
      }
    } else {
      const profile = this.manager.authorize(authority, 'profiles:manage', String(input.profile_ref))!;
      requestRef = store.profiles.transaction(() => {
        const ref = accept();
        store.profiles.associateRequest({ requestRef: ref, profileRef: profile.profileRef, principalId: authority!.principalId });
        return ref;
      });
    }
    return acceptedSubmission(caller, store.canonical.requests.getRequest(requestRef)!);
  }

  canRead(ticket: StoredRequestTicket, authority: ProfileAuthority | undefined, scope: 'profiles:read' | 'profiles:manage' = 'profiles:read'): boolean {
    const association = this.manager.store.profiles.request(ticket.requestRef);
    if (!association || association.principalId !== authority?.principalId) return false;
    try { this.manager.authorize(authority, scope, association.profileRef); return true; } catch { return false; }
  }

  async execute(ticket: StoredRequestTicket): Promise<void> {
    const store = this.manager.store;
    const association = store.profiles.request(ticket.requestRef);
    if (!association || !isProfileOperation(ticket.toolName)) throw new ProfileError('PROFILE_NOT_FOUND');
    const guard = () => {
      if (!store.profiles.ownsRequest(ticket.requestRef, ticket.claimGeneration)) throw new ProfileError('PROFILE_LEASE_LOST');
      const principal = store.getAgentById(association.principalId);
      this.manager.authorize(principal ? { principalId: principal.principalId, scopes: principal.scopes } : undefined, 'profiles:manage', association.profileRef);
    };
    const timer = setInterval(() => store.profiles.renewRequest(ticket.requestRef, ticket.claimGeneration, 30_000), 8_000);
    const checkpoint = (phase: string) => {
      guard();
      store.canonical.requests.recordCheckpoint({ requestRef: ticket.requestRef, expectedClaimGeneration: ticket.claimGeneration,
        phase, checkpoint: { name: phase, recorded_at: new Date().toISOString(), details: { profile_ref: association.profileRef } } });
    };
    try {
      const profile = store.profiles.get(association.profileRef)!;
      const facts = await this.manager.run(ticket.toolName, profile, guard, checkpoint);
      guard();
      store.canonical.requests.terminalizeRequest({ requestRef: ticket.requestRef, expectedClaimGeneration: ticket.claimGeneration,
        state: 'succeeded', phase: 'complete', checkpoint: { name: 'complete', recorded_at: new Date().toISOString(), details: {} },
        result: { tool: ticket.toolName, disposition: 'complete', facts: { profile: facts } } as JsonRecord });
    } catch (error) {
      if (!store.profiles.ownsRequest(ticket.requestRef, ticket.claimGeneration)) return;
      const code = error instanceof ProfileError ? error.code : 'PROFILE_OPERATION_FAILED';
      const message = code === 'PROFILE_HAS_ACTIVE_WORK'
        ? 'Profile lifecycle permission passed. Closing is blocked by active workspaces or unfinished browser requests; finish that work before stopping the Profile.' : code;
      const failure = problem((PublicProblemCodes as readonly string[]).includes(code) ? code as PublicProblemCode : 'PROFILE_OPERATION_FAILED', message, false);
      const uncertain = code === 'PROFILE_INSTANCE_UNVERIFIED' || code === 'PROFILE_STOP_TIMEOUT' || code === 'PROFILE_LEASE_LOST';
      const known = { profile: this.manager.facts(store.profiles.get(association.profileRef)!) };
      store.canonical.requests.terminalizeRequest({ requestRef: ticket.requestRef, expectedClaimGeneration: ticket.claimGeneration,
        state: uncertain ? 'uncertain' : 'failed', phase: uncertain ? 'uncertain' : 'failed',
        checkpoint: { name: 'profile_operation_ended', recorded_at: new Date().toISOString(), details: { profile_ref: association.profileRef } },
        problem: failure as unknown as JsonRecord, effectMayHaveOccurred: true,
        result: (uncertain ? { tool: ticket.toolName, problem: failure, known_facts: known }
          : { tool: ticket.toolName, kind: 'octopus_problem', problem: failure, debugger_error: null, known_facts: known }) as JsonRecord });
    } finally { clearInterval(timer); }
  }
}
