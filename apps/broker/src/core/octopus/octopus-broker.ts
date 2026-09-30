import { randomUUID } from 'node:crypto';
import type { ProfileManager } from '../../profiles/profile-manager.js';
import { ProfileRequestService, isProfileOperation } from '../../profiles/profile-request-service.js';
import { ProfileError, type ProfileAuthority } from '../../profiles/types.js';
import { PublicProblemCodes } from '../../../../shared/protocol/src/error-codes.js';
import {
  CONSERVATIVE_CAPABILITY_MANIFEST,
  supportsCdpMethod,
  type McpAsyncToolName,
  type RelayV2PayloadByType
} from '../../../../shared/protocol/src/index.js';
import type {
  CanonicalRepositories,
  JsonRecord,
  StoredCallerSession,
  StoredControlRecord,
  StoredEndpoint,
  StoredLogicalWindow,
  StoredManagedTab,
  StoredRequestAttempt,
  StoredRequestTicket,
  StoredWorkspace
} from '../../storage/index.js';
import { OctopusBrokerError, problem, type PublicProblem } from './broker-problem.js';
import { CallerRegistry, type CallerEvidence } from './caller-registry.js';
import type { ExtensionEventSink, OctopusExtensionPort } from './extension-port.js';
import {
  acceptedSubmission,
  callerFacts,
  closeAction,
  completeRead,
  pollAction,
  rejectedRead,
  rejectedSubmission,
  requestTicketFacts,
  type JsonObject
} from './mcp-presenter.js';
import { RandomReferenceFactory, type ReferenceFactory } from './reference-factory.js';

type AsyncInput = JsonObject;

interface CursorEntry {
  callerSessionRef: string;
  query: string;
  after: string;
}

interface BrokerOptions {
  referenceFactory?: ReferenceFactory;
  maxPageSize?: number;
  workerLeaseMs?: number;
}

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a nonempty string.`);
  return value;
};

const checkpoint = (name: string, details: JsonObject = {}, at = new Date().toISOString()): JsonRecord => ({
  name,
  recorded_at: at,
  details
});

const parsePrivate = <T extends JsonObject>(value: string, kind: string): T => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isObject(parsed)) throw new Error('not an object');
    return parsed as T;
  } catch {
    throw new Error(`Stored ${kind} locator is invalid.`);
  }
};

const browserRefFor = (endpointRef: string): string => `brw_${Buffer.from(endpointRef).toString('base64url')}`;

export class OctopusBroker implements ExtensionEventSink {
  private profileManager: ProfileManager | null = null;
  private profileRequests: ProfileRequestService | null = null;
  private readonly managementAuthorities = new Map<string, ProfileAuthority>();

  setProfileManager(manager: ProfileManager): void { this.profileManager = manager; this.profileRequests = new ProfileRequestService(manager); }
  private readonly references: ReferenceFactory;
  private readonly callers: CallerRegistry;
  private readonly maxPageSize: number;
  private readonly workerLeaseMs: number;
  private readonly cursors = new Map<string, CursorEntry>();
  private readonly runningWorkers = new Set<string>();
  private readonly pendingEndpointReconciliation = new Set<string>();
  private readonly endpointReconciliationRequests = new Set<string>();
  private readonly recoveryPump: NodeJS.Timeout;
  private extensionPort: OctopusExtensionPort | null = null;
  private shuttingDown = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly repositories: CanonicalRepositories,
    options: BrokerOptions = {}
  ) {
    this.references = options.referenceFactory ?? new RandomReferenceFactory();
    this.callers = new CallerRegistry(repositories, this.references);
    this.maxPageSize = options.maxPageSize ?? 100;
    this.workerLeaseMs = options.workerLeaseMs ?? 30_000;
    this.recoveryPump = setInterval(() => this.pump(), Math.max(100, Math.min(1_000, Math.floor(this.workerLeaseMs / 4))));
    this.recoveryPump.unref();
  }

  setExtensionPort(port: OctopusExtensionPort): void {
    this.extensionPort = port;
    port.setEventSink(this);
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    clearInterval(this.recoveryPump);
  }

  async waitForIdle(): Promise<void> {
    if (this.runningWorkers.size === 0 && this.endpointReconciliationRequests.size === 0) return;
    await new Promise<void>(resolve => this.idleWaiters.add(resolve));
  }

  private notifyIdle(): void {
    if (this.runningWorkers.size || this.endpointReconciliationRequests.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  resolveCaller(evidence: CallerEvidence): StoredCallerSession {
    const caller = this.callers.resolve(evidence);
    if (evidence.managementAuthority) this.managementAuthorities.set(caller.sessionRef, evidence.managementAuthority);
    else this.managementAuthorities.delete(caller.sessionRef);
    return caller;
  }

  endpointForLegacyTarget(targetId: string): StoredEndpoint | null {
    return this.repositories.logical.scanLogicalRecovery().endpoints.find(endpoint => endpoint.legacyTargetId === targetId) ?? null;
  }

  ensureEndpoint(input: {
    nickname: string;
    pairingIdentityHash?: string;
    credential?: JsonRecord;
    legacyTargetId?: string;
  }): StoredEndpoint {
    const existing = this.repositories.logical.getEndpointByNickname(input.nickname);
    if (existing) return existing;
    return this.repositories.logical.createEndpoint({
      endpointRef: this.references.issue('extension'),
      nickname: input.nickname,
      ...(input.pairingIdentityHash === undefined ? {} : { pairingIdentityHash: input.pairingIdentityHash }),
      ...(input.credential === undefined ? {} : { credential: input.credential }),
      ...(input.legacyTargetId === undefined ? {} : { legacyTargetId: input.legacyTargetId })
    });
  }

  openEndpointConnection(input: {
    endpointRef: string;
    connectionRef: string;
    transport: string;
    protocolVersion: string;
    extensionVersion?: string;
    browserProduct?: string;
    browserVersion?: string;
  }): number {
    const connection = this.repositories.logical.openEndpointConnection(input);
    this.repositories.logical.recordCapabilitySelection({
      capabilitySelectionRef: `cap_${randomUUID()}`,
      endpointRef: input.endpointRef,
      connectionGeneration: connection.connectionGeneration,
      profileVersion: CONSERVATIVE_CAPABILITY_MANIFEST.manifestId,
      ...(input.browserProduct === undefined ? {} : { browserProduct: input.browserProduct }),
      ...(input.browserVersion === undefined ? {} : { browserVersion: input.browserVersion }),
      ...(input.extensionVersion === undefined ? {} : { extensionVersion: input.extensionVersion }),
      methods: CONSERVATIVE_CAPABILITY_MANIFEST.cdpMethods.map(({ method }) => method)
    });
    return connection.connectionGeneration;
  }

  /**
   * Completes the transport-ready half of endpoint connection establishment.
   * The gateway calls this only after the authenticated socket is bound, so a
   * recovered ticket cannot be dispatched into the handshake gap.
   */
  onExtensionReady(endpointRef: string, connectionGeneration: number): void {
    if (this.shuttingDown) return;
    const current = this.repositories.logical.getCurrentConnection(endpointRef);
    if (!current || current.connectionGeneration !== connectionGeneration
      || this.extensionPort?.connection(endpointRef)?.connected !== true) return;
    // READY is only a transport fact. A fresh inventory snapshot is the
    // reconciliation barrier. Paused work must not resume against locators
    // from the previous browser/connection epoch.
    this.pendingEndpointReconciliation.add(endpointRef);
    queueMicrotask(() => void this.requestEndpointReconciliation(endpointRef, connectionGeneration));
  }

  closeEndpointConnection(endpointRef: string, connectionGeneration: number, reason: string): void {
    if (this.shuttingDown) return;
    if (!this.repositories.logical.disconnectEndpoint({ endpointRef, connectionGeneration, reason })) return;
    this.pendingEndpointReconciliation.add(endpointRef);
    this.pauseEndpointRequests(endpointRef, 'extension_disconnected');
  }

  submit(tool: McpAsyncToolName, rawInput: unknown, evidence: CallerEvidence): JsonObject {
    const caller = this.resolveCaller(evidence);
    try {
      const input = isObject(rawInput) ? rawInput : {};
      if (isProfileOperation(tool)) {
        if (!this.profileRequests) throw new ProfileError('PROFILE_MANAGEMENT_UNAVAILABLE');
        return this.profileRequests.submit(tool, input, evidence.managementAuthority, caller);
      }
      const accepted = this.admit(tool, input, caller);
      return acceptedSubmission(caller, accepted);
    } catch (error) {
      const rejectedProblem = error instanceof OctopusBrokerError
        ? error.problem
        : error instanceof ProfileError ? this.publicProblem(error)
        : problem('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid request.');
      return rejectedSubmission(caller, rejectedProblem);
    }
  }

  confirmAcknowledgement(requestRef: string, delivered: boolean): void {
    if (delivered) {
      const ticket = this.repositories.requests.markAcknowledgementDelivered(requestRef);
      if (!ticket) return;
      if (!this.activateControl(ticket)) {
        this.failTicket(ticket, problem('CONTROL_RACE_LOST', 'Another control already owns this scope.', false, {
          ...(ticket.workspaceRef === null ? {} : { workspace_ref: ticket.workspaceRef })
        }));
        return;
      }
      if (ticket.toolName === 'terminate_workspace') this.fenceTerminationQueue(ticket);
      this.pump();
    } else {
      this.repositories.requests.failAcknowledgement(requestRef, 'MCP_ACKNOWLEDGEMENT_DELIVERY_FAILED');
    }
  }

  listBrowserProfiles(rawInput: unknown, evidence: CallerEvidence): JsonObject {
    const caller = this.resolveCaller(evidence);
    try {
      if (!this.profileRequests) throw new ProfileError('PROFILE_MANAGEMENT_UNAVAILABLE');
      return this.profileRequests.list(isObject(rawInput) ? rawInput : {}, evidence.managementAuthority, caller);
    } catch (error) { return rejectedRead(caller, this.publicProblem(error)); }
  }

  getBrowserRequest(rawInput: unknown, evidence: CallerEvidence): JsonObject {
    const caller = this.resolveCaller(evidence);
    try {
      const input = isObject(rawInput) ? rawInput : {};
      const requestRef = asString(input.request_ref, 'request_ref');
      const ticket = this.repositories.requests.getRequest(requestRef);
      if (!ticket || !ticket.publiclyVisible || !this.canReadTicket(caller, ticket)) {
        throw new OctopusBrokerError(problem('REQUEST_NOT_FOUND', 'No authority-visible request has that reference.', false, { request_ref: requestRef }));
      }
      const actions = ticket.state === 'queued' || ticket.state === 'running'
        ? [pollAction(ticket.requestRef)]
        : [closeAction(ticket.requestRef)];
      if (ticket.state === 'failed' && isObject(ticket.result) && isObject(ticket.result.known_facts)) {
        const knownFacts = ticket.result.known_facts;
        const knownWorkspace = isObject(knownFacts.workspace) ? knownFacts.workspace : null;
        if (knownFacts.workspace_active === true && knownFacts.replacement_tab === null
          && knownFacts.old_tab_remains_managed === true && knownFacts.lane_released === true
          && typeof knownWorkspace?.workspace_ref === 'string') {
          actions.unshift({
            tool: 'create_browser_tab',
            arguments: { workspace_ref: knownWorkspace.workspace_ref },
            required_arguments: []
          });
        }
      }
      if (ticket.pauseCondition === 'user_confirmation_required') {
        actions.unshift({
          tool: 'resolve_browser_request',
          arguments: { request_ref: ticket.requestRef },
          required_arguments: ['decision']
        });
      }
      return completeRead(caller, { ticket: requestTicketFacts(ticket) }, actions);
    } catch (error) {
      return rejectedRead(caller, this.publicProblem(error));
    }
  }

  closeBrowserRequest(rawInput: unknown, evidence: CallerEvidence): JsonObject {
    const caller = this.resolveCaller(evidence);
    try {
      const input = isObject(rawInput) ? rawInput : {};
      const requestRef = asString(input.request_ref, 'request_ref');
      const ticket = this.repositories.requests.getRequest(requestRef);
      if (!ticket || !ticket.publiclyVisible || !this.canReadTicket(caller, ticket)) {
        throw new OctopusBrokerError(problem('REQUEST_NOT_FOUND', 'No authority-visible request has that reference.', false, { request_ref: requestRef }));
      }
      if (!['succeeded', 'failed', 'uncertain'].includes(ticket.state)) {
        throw new OctopusBrokerError(problem('REQUEST_NOT_TERMINAL', 'Only a terminal request can be closed.', false, { request_ref: requestRef }));
      }
      if (isProfileOperation(ticket.toolName) && !this.profileRequests?.canRead(ticket, evidence.managementAuthority, 'profiles:manage')) {
        throw new OctopusBrokerError(problem('REQUEST_NOT_FOUND', 'No authority-visible request has that reference.'));
      }
      if (!this.repositories.requests.closeRequest({
        requestRef,
        authoritySessionRef: isProfileOperation(ticket.toolName) ? ticket.authoritySessionRef : caller.sessionRef,
        ...(ticket.acceptedOwnerEpoch === null ? {} : { expectedOwnerEpoch: ticket.acceptedOwnerEpoch })
      })) {
        throw new OctopusBrokerError(problem('REQUEST_NOT_FOUND', 'Request authority changed before closure.', false, { request_ref: requestRef }));
      }
      const closedAt = new Date().toISOString();
      return completeRead(caller, {
        request_ref: requestRef,
        closed_at: closedAt,
        removed_from_public_view: true,
        internal_audit_retained: true
      });
    } catch (error) {
      return rejectedRead(caller, this.publicProblem(error));
    }
  }

  getBrowserContext(rawInput: unknown, evidence: CallerEvidence): JsonObject {
    const caller = this.resolveCaller(evidence);
    try {
      const input = isObject(rawInput) ? rawInput : {};
      const view = isObject(input.view) ? input.view : {};
      const kind = asString(view.kind, 'view.kind');
      const facts = this.contextFacts(kind, view, caller);
      return completeRead(caller, facts);
    } catch (error) {
      return rejectedRead(caller, this.publicProblem(error));
    }
  }

  readCdpEvents(rawInput: unknown, evidence: CallerEvidence): JsonObject {
    const caller = this.resolveCaller(evidence);
    try {
      const input = isObject(rawInput) ? rawInput : {};
      const workspaceRef = asString(input.workspace_ref, 'workspace_ref');
      const target = isObject(input.target) ? input.target : {};
      const tabRef = asString(target.tab_ref, 'target.tab_ref');
      const cursor = asString(input.cursor, 'cursor');
      const pageSize = this.pageSize(input.page_size);
      const workspace = this.requireOwnedWorkspace(caller, workspaceRef);
      this.requireTab(workspace, tabRef);
      const filters = Array.isArray(input.method_filters)
        ? input.method_filters.filter((value): value is string => typeof value === 'string')
        : [];
      // Filters affect presentation, not stream position identity. This lets the
      // required initial cursor start any bounded filtered read.
      const queryHash = JSON.stringify({ workspaceRef, tabRef });
      const page = this.repositories.events.readEvents({ cursorRef: cursor, queryHash, ownerEpoch: workspace.ownerEpoch, limit: pageSize });
      if (!page) throw new OctopusBrokerError(problem('CURSOR_INVALID', 'The event cursor is invalid for this tab and query.', false, { workspace_ref: workspaceRef, tab_ref: tabRef }));
      const events = page.events
        .filter((event) => filters.length === 0 || filters.includes(event.method))
        .map((event) => ({ method: event.method, params: event.params, received_at: event.observedAt }));
      return {
        contract_version: '2',
        disposition: 'complete',
        observed_at: new Date().toISOString(),
        caller: callerFacts(caller),
        problem: null,
        facts: {
          workspace_ref: workspaceRef,
          target: { kind: 'tab', tab_ref: tabRef },
          events,
          returned_count: events.length,
          next_cursor: page.cursor.cursorRef,
          caught_up: events.length < pageSize
        },
        available_actions: [{
          tool: 'read_cdp_events',
          arguments: { workspace_ref: workspaceRef, target: { kind: 'tab', tab_ref: tabRef }, cursor: page.cursor.cursorRef },
          required_arguments: ['page_size']
        }]
      };
    } catch (error) {
      const rejectedProblem = this.publicProblem(error);
      return {
        contract_version: '2', disposition: 'rejected', observed_at: new Date().toISOString(), caller: callerFacts(caller),
        problem: rejectedProblem, facts: null, available_actions: []
      };
    }
  }

  recover(): void {
    if (this.shuttingDown) return;
    const snapshot = this.repositories.requests.scanRequestRecovery();
    for (const ticket of snapshot.requests) {
      if (ticket.state === 'running' && ticket.pauseCondition === null) {
        this.repositories.requests.recordCheckpoint({
          requestRef: ticket.requestRef,
          expectedClaimGeneration: ticket.claimGeneration,
          phase: 'broker_restart_recovery',
          checkpoint: isProfileOperation(ticket.toolName)
            ? checkpoint('profile_restart_reconciliation', { previous_phase: ticket.phase, reconcile_persisted_instance: true })
            : checkpoint('broker_restart_recovery', { restart_from_page_start: true }),
          pauseCondition: ticket.endpointRef && !this.isEndpointConnected(ticket.endpointRef) ? 'extension_disconnected' : null,
          reasonCode: 'BROKER_RESTART'
        });
      }
    }
    this.pump();
  }

  onInventory(endpointRef: string, payload: RelayV2PayloadByType['INVENTORY_SNAPSHOT']): void {
    if (this.shuttingDown) return;
    const resetStreams = this.pendingEndpointReconciliation.has(endpointRef);
    const reconciled = this.reconcileInventory(endpointRef, payload, resetStreams);
    if (resetStreams && reconciled) {
      this.pendingEndpointReconciliation.delete(endpointRef);
      this.resumeEndpointPausedRequests(endpointRef, 'extension_disconnected');
      this.pump();
    }
  }

  private async requestEndpointReconciliation(endpointRef: string, connectionGeneration: number): Promise<void> {
    if (this.shuttingDown) return;
    const key = `${endpointRef}:${connectionGeneration}`;
    if (this.endpointReconciliationRequests.has(key)) return;
    const current = this.repositories.logical.getCurrentConnection(endpointRef);
    const extension = this.extensionPort?.connection(endpointRef);
    if (!this.pendingEndpointReconciliation.has(endpointRef)
      || current?.connectionGeneration !== connectionGeneration
      || extension?.connected !== true
      || extension.connectionGeneration !== connectionGeneration) return;
    this.endpointReconciliationRequests.add(key);
    let retry = false;
    try {
      const inventory = await this.requireExtensionPort().requestInventory(endpointRef, null);
      if (this.pendingEndpointReconciliation.has(endpointRef)) this.onInventory(endpointRef, inventory);
    } catch {
      if (this.shuttingDown) return;
      const latest = this.repositories.logical.getCurrentConnection(endpointRef);
      const live = this.extensionPort?.connection(endpointRef);
      retry = this.pendingEndpointReconciliation.has(endpointRef)
        && latest?.connectionGeneration === connectionGeneration
        && live?.connected === true
        && live.connectionGeneration === connectionGeneration;
    } finally {
      this.endpointReconciliationRequests.delete(key);
      this.notifyIdle();
    }
    if (retry) {
      const timer = setTimeout(() => void this.requestEndpointReconciliation(endpointRef, connectionGeneration), 1_000);
      timer.unref();
    }
  }

  onCdpEvent(endpointRef: string, payload: RelayV2PayloadByType['CDP_EVENT']): void {
    if (this.shuttingDown) return;
    const tab = this.findTabByPrivateId(endpointRef, payload.tab.tabId);
    if (!tab) return;
    const stream = this.repositories.events.scanEventRecovery().streams.find((candidate) => candidate.tabRef === tab.tabRef && candidate.state === 'active');
    const workspace = this.repositories.logical.getWorkspace(tab.workspaceRef);
    if (!stream || !workspace) return;
    this.repositories.events.appendEvent({
      streamRef: stream.streamRef,
      method: payload.method,
      params: payload.params,
      connectionGeneration: payload.connectionGeneration,
      cursorRef: this.references.issue('cursor'),
      queryHash: JSON.stringify({ workspaceRef: tab.workspaceRef, tabRef: tab.tabRef }),
      ownerEpoch: workspace.ownerEpoch,
      observedAt: payload.emittedAt
    });
  }

  onDebuggerDetached(endpointRef: string, payload: RelayV2PayloadByType['DEBUGGER_DETACHED']): void {
    if (this.shuttingDown) return;
    const tab = this.findTabByPrivateId(endpointRef, payload.tab.tabId);
    if (!tab) return;
    this.repositories.logical.updateTab({
      workspaceRef: tab.workspaceRef,
      tabRef: tab.tabRef,
      expectedLocatorGeneration: tab.locatorGeneration,
      attachmentGeneration: 0,
      observedAt: payload.detachedAt
    });
    this.pauseTabRequests(tab.workspaceRef, tab.tabRef, 'extension_disconnected');
  }

  onDisconnected(endpointRef: string, connectionGeneration: number, reason: string): void {
    this.closeEndpointConnection(endpointRef, connectionGeneration, reason);
  }

  private admit(tool: McpAsyncToolName, input: AsyncInput, caller: StoredCallerSession): StoredRequestTicket {
    let normalized = { ...input };
    let endpointRef: string | undefined;
    let workspaceRef: string | undefined;
    let tabRef: string | undefined;
    let ownerEpoch: number | undefined;
    let authorityScope: 'owner' | 'requester' = 'owner';
    let resolutionOfRequestRef: string | undefined;
    let privateAdmissionDetails: JsonObject = {};

    if (tool === 'request_browser_workspace') {
      authorityScope = 'requester';
      const requested = Array.isArray(input.designated_endpoints) ? input.designated_endpoints : [];
      const explicitlyDesignated = new Set(requested
        .filter(isObject)
        .map((entry) => entry.endpoint_nickname)
        .filter((value): value is string => typeof value === 'string'));
      normalized = this.normalizeWorkspaceRequest(input);
      const normalizedSelections = Array.isArray(normalized.designated_endpoints) ? normalized.designated_endpoints : [];
      privateAdmissionDetails = {
        assigned_endpoint_nicknames: normalizedSelections
          .filter(isObject)
          .map((entry) => entry.endpoint_nickname)
          .filter((value): value is string => typeof value === 'string' && !explicitlyDesignated.has(value))
      };
    } else if (tool === 'kill_browser_endpoint' || tool === 'resume_browser_endpoint') {
      authorityScope = 'requester';
      const nickname = asString(input.endpoint_nickname, 'endpoint_nickname');
      const endpoint = this.repositories.logical.getEndpointByNickname(nickname);
      if (!endpoint) throw new OctopusBrokerError(problem('ENDPOINT_NOT_FOUND', `No endpoint is named ${nickname}.`, false, { endpoint_nickname: nickname }));
      endpointRef = endpoint.endpointRef;
      const workspaces = this.repositories.logical.listActiveWorkspaces({ endpointRef });
      if (workspaces.some((workspace) => workspace.ownerSessionRef !== caller.sessionRef)) {
        throw new OctopusBrokerError(problem('WORKSPACE_NOT_OWNED', 'Endpoint control requires ownership of every active workspace on the endpoint.', false, { endpoint_nickname: nickname }));
      }
      if (this.repositories.logical.getActiveEndpointControl(endpointRef)) {
        throw new OctopusBrokerError(problem('BROKER_BUSY', 'Another endpoint control is still running.', true, { endpoint_nickname: nickname }));
      }
    } else if (tool === 'resolve_browser_request') {
      const targetRef = asString(input.request_ref, 'request_ref');
      const target = this.repositories.requests.getRequest(targetRef);
      if (!target || !this.canReadTicket(caller, target)) throw new OctopusBrokerError(problem('REQUEST_NOT_FOUND', 'The target request is not visible.', false, { request_ref: targetRef }));
        if (isProfileOperation(target.toolName) || target.state !== 'running' || target.pauseCondition !== 'user_confirmation_required') {
        throw new OctopusBrokerError(problem('REQUEST_NOT_PAUSED', 'The target request is not waiting for user confirmation.', false, { request_ref: targetRef }));
      }
      workspaceRef = target.workspaceRef ?? undefined;
      tabRef = undefined;
      endpointRef = target.endpointRef ?? undefined;
      ownerEpoch = target.acceptedOwnerEpoch ?? undefined;
      resolutionOfRequestRef = targetRef;
    } else {
      workspaceRef = asString(input.workspace_ref, 'workspace_ref');
      const workspace = tool === 'take_over_workspace'
        ? this.requireTakeoverTarget(input, caller)
        : this.requireOwnedWorkspace(caller, workspaceRef);
      endpointRef = workspace.endpointRef;
      ownerEpoch = workspace.ownerEpoch;
      privateAdmissionDetails = {
        ...privateAdmissionDetails,
        accepted_control_epoch: workspace.controlEpoch
      };
      if (tool === 'send_cdp_command') {
        const target = isObject(input.target) ? input.target : {};
        tabRef = asString(target.tab_ref, 'target.tab_ref');
        this.requireTab(workspace, tabRef);
        const method = asString(input.method, 'method');
        if (!supportsCdpMethod(CONSERVATIVE_CAPABILITY_MANIFEST, method, typeof input.sessionId === 'string')) {
          throw new OctopusBrokerError(problem('CDP_METHOD_UNSUPPORTED_BY_EXTENSION', `${method} is not in the active extension capability profile.`, false, { workspace_ref: workspaceRef, tab_ref: tabRef }));
        }
      }
      if (tool === 'take_over_workspace') authorityScope = 'requester';
    }

    const acceptedAt = new Date().toISOString();
    const requestRef = this.references.issue('request');
    const body = { tool, arguments: normalized };
    const ticket = this.repositories.requests.acceptRequest({
      requestRef,
      toolName: tool,
      requesterSessionRef: caller.sessionRef,
      authorityScope,
      authoritySessionRef: caller.sessionRef,
      authorityLineageRef: caller.lineageRef,
      normalizedBody: body,
      phase: 'accepted',
      checkpoint: checkpoint('accepted', { ticket_before_dispatch: true, ...privateAdmissionDetails }, acceptedAt),
      ...(endpointRef === undefined ? {} : { endpointRef }),
      ...(workspaceRef === undefined ? {} : { workspaceRef }),
      ...(tabRef === undefined ? {} : { tabRef }),
      ...(ownerEpoch === undefined ? {} : { acceptedOwnerEpoch: ownerEpoch }),
      ...(resolutionOfRequestRef === undefined ? {} : { resolutionOfRequestRef }),
      at: acceptedAt
    });
    this.repositories.audit.append({
      auditRef: `aud_${randomUUID()}`,
      eventType: 'request.accepted',
      actorSessionRef: caller.sessionRef,
      ...(endpointRef === undefined ? {} : { endpointRef }),
      ...(workspaceRef === undefined ? {} : { workspaceRef }),
      ...(tabRef === undefined ? {} : { tabRef }),
      requestRef,
      context: { tool, ticket_before_dispatch: true },
      observedAt: acceptedAt
    });
    return ticket;
  }

  private normalizeWorkspaceRequest(input: AsyncInput): JsonObject {
    const count = Number(input.required_workspace_count);
    if (!Number.isInteger(count) || count < 1) throw new TypeError('required_workspace_count must be a positive integer.');
    const requested = Array.isArray(input.designated_endpoints) ? input.designated_endpoints : [];
    const byNickname = new Map<string, { endpoint_nickname: string; window_ref?: string }>();
    for (const entry of requested) {
      if (!isObject(entry)) throw new TypeError('Each designated endpoint must be an object.');
      const nickname = asString(entry.endpoint_nickname, 'endpoint_nickname');
      const windowRef = typeof entry.window_ref === 'string' ? entry.window_ref : undefined;
      const current = byNickname.get(nickname);
      if (current?.window_ref !== undefined && windowRef !== undefined && current.window_ref !== windowRef) {
        throw new OctopusBrokerError(problem('INVALID_ARGUMENT', `Endpoint ${nickname} was repeated with conflicting window references.`, false, { endpoint_nickname: nickname }));
      }
      byNickname.set(nickname, { endpoint_nickname: nickname, ...(windowRef === undefined ? {} : { window_ref: windowRef }) });
    }
    if (byNickname.size > count) throw new TypeError('The distinct designated endpoint count exceeds required_workspace_count.');
    for (const selection of byNickname.values()) {
      const endpoint = this.repositories.logical.getEndpointByNickname(selection.endpoint_nickname);
      if (!endpoint) throw new OctopusBrokerError(problem('ENDPOINT_NOT_FOUND', `No endpoint is named ${selection.endpoint_nickname}.`, false, { endpoint_nickname: selection.endpoint_nickname }));
      if (this.profileManager?.blocksEndpoint(endpoint.endpointRef)) throw new OctopusBrokerError(problem('ENDPOINT_UNAVAILABLE', 'This Profile is stopping.', true));
      if (!this.isEndpointConnected(endpoint.endpointRef)) throw new OctopusBrokerError(problem('ENDPOINT_UNAVAILABLE', `Endpoint ${selection.endpoint_nickname} is not connected.`, true, { endpoint_nickname: selection.endpoint_nickname }));
      if (selection.window_ref) {
        const window = this.repositories.logical.getWindow(selection.window_ref);
        if (!window) throw new OctopusBrokerError(problem('WINDOW_NOT_FOUND', 'The designated window does not exist.', false, { window_ref: selection.window_ref }));
        if (window.endpointRef !== endpoint.endpointRef) throw new OctopusBrokerError(problem('WINDOW_ENDPOINT_MISMATCH', 'The designated window belongs to another endpoint.', false, { window_ref: selection.window_ref }));
      }
    }
    const endpoints = this.repositories.logical.listEndpoints({ limit: 200 }).items
      .filter((endpoint) => this.isEndpointConnected(endpoint.endpointRef) && !this.profileManager?.blocksEndpoint(endpoint.endpointRef))
      .sort((left, right) => left.nickname.localeCompare(right.nickname));
    for (const endpoint of endpoints) {
      if (byNickname.size >= count) break;
      if (!byNickname.has(endpoint.nickname)) byNickname.set(endpoint.nickname, { endpoint_nickname: endpoint.nickname });
    }
    if (byNickname.size !== count) {
      throw new OctopusBrokerError(problem('INSUFFICIENT_ELIGIBLE_ENDPOINTS', `Requested ${count} browser profiles but only ${byNickname.size} eligible endpoints are available.`, true));
    }
    return {
      required_workspace_count: count,
      designated_endpoints: [...byNickname.values()]
    };
  }

  private requireTakeoverTarget(input: AsyncInput, caller: StoredCallerSession): StoredWorkspace {
    const workspaceRef = asString(input.workspace_ref, 'workspace_ref');
    const previousOwner = asString(input.previous_owner_session_ref, 'previous_owner_session_ref');
    const nickname = asString(input.endpoint_nickname, 'endpoint_nickname');
    const workspace = this.repositories.logical.getWorkspace(workspaceRef);
    const endpoint = workspace ? this.repositories.logical.getEndpoint(workspace.endpointRef) : null;
    if (!workspace || !endpoint) throw new OctopusBrokerError(problem('WORKSPACE_NOT_FOUND', 'The workspace does not exist.', false, { workspace_ref: workspaceRef }));
    if (workspace.lifecycle !== 'active') throw new OctopusBrokerError(problem('WORKSPACE_TERMINATED', 'The workspace has ended.', false, { workspace_ref: workspaceRef }));
    if (endpoint.nickname !== nickname || workspace.ownerSessionRef !== previousOwner) {
      throw new OctopusBrokerError(problem('TAKEOVER_BINDING_MISMATCH', 'Workspace, endpoint nickname, or previous owner does not match current broker truth.', false, { workspace_ref: workspaceRef }));
    }
    if (this.repositories.logical.getActiveEndpointControl(endpoint.endpointRef)) {
      throw new OctopusBrokerError(problem('ENDPOINT_OWNERSHIP_FROZEN', 'Endpoint ownership is frozen by a nonterminal endpoint control.', false, { workspace_ref: workspaceRef }));
    }
    if (workspace.ownerSessionRef === caller.sessionRef) throw new TypeError('The caller already owns this workspace.');
    return workspace;
  }

  private requireOwnedWorkspace(caller: StoredCallerSession, workspaceRef: string): StoredWorkspace {
    const workspace = this.repositories.logical.getWorkspace(workspaceRef);
    if (!workspace) throw new OctopusBrokerError(problem('WORKSPACE_NOT_FOUND', 'The workspace does not exist.', false, { workspace_ref: workspaceRef }));
    if (workspace.lifecycle !== 'active') throw new OctopusBrokerError(problem('WORKSPACE_TERMINATED', 'The workspace has ended.', false, { workspace_ref: workspaceRef }));
    if (workspace.ownerSessionRef !== caller.sessionRef && workspace.lineageRef !== caller.lineageRef) {
      throw new OctopusBrokerError(problem('WORKSPACE_NOT_OWNED', 'The caller does not own this workspace.', false, { workspace_ref: workspaceRef }));
    }
    return workspace;
  }

  private requireTab(workspace: StoredWorkspace, tabRef: string): StoredManagedTab {
    const tab = this.repositories.logical.getTab(workspace.workspaceRef, tabRef);
    if (!tab) throw new OctopusBrokerError(problem('TAB_NOT_FOUND', 'The tab reference does not exist in this workspace.', false, { workspace_ref: workspace.workspaceRef, tab_ref: tabRef }));
    if (tab.lifecycle !== 'active') throw new OctopusBrokerError(problem('TAB_CLOSED', 'The managed tab is no longer active.', false, { workspace_ref: workspace.workspaceRef, tab_ref: tabRef }));
    return tab;
  }

  private canReadTicket(caller: StoredCallerSession, ticket: StoredRequestTicket): boolean {
    if (isProfileOperation(ticket.toolName)) return this.profileRequests?.canRead(ticket, this.managementAuthorities.get(caller.sessionRef)) ?? false;
    if (ticket.authorityScope === 'requester') return ticket.requesterSessionRef === caller.sessionRef;
    return ticket.authoritySessionRef === caller.sessionRef || ticket.authorityLineageRef === caller.lineageRef;
  }

  private activateControl(ticket: StoredRequestTicket): boolean {
    const descriptor = this.controlDescriptor(ticket);
    if (!descriptor) return true;
    return this.repositories.transaction(({ logical }) => {
      const existingForRequest = logical.scanLogicalRecovery().activeControls
        .find((control) => control.requestRef === ticket.requestRef);
      if (existingForRequest) return true;
      if (descriptor.scopeType === 'endpoint') {
        const active = logical.getActiveEndpointControl(descriptor.scopeRef);
        if (active && active.requestRef !== ticket.requestRef) return false;
        const ownershipChanged = logical.listActiveWorkspaces({ endpointRef: descriptor.scopeRef })
          .some((workspace) => workspace.ownerSessionRef !== ticket.requesterSessionRef);
        if (ownershipChanged) return false;
      }
      logical.recordControl({
        controlRef: `ctl_${randomUUID()}`,
        requestRef: ticket.requestRef,
        kind: descriptor.kind,
        scopeType: descriptor.scopeType,
        scopeRef: descriptor.scopeRef,
        controlEpoch: descriptor.controlEpoch,
        details: {
          acknowledgement_delivered: true,
          accepted_owner_epoch: ticket.acceptedOwnerEpoch,
          tool: ticket.toolName
        }
      });
      return true;
    });
  }

  private controlDescriptor(ticket: StoredRequestTicket): {
    kind: StoredControlRecord['kind'];
    scopeType: StoredControlRecord['scopeType'];
    scopeRef: string;
    controlEpoch: number;
  } | null {
    const workspaceEpoch = this.acceptedControlEpoch(ticket) + 1;
    switch (ticket.toolName) {
      case 'stop_workspace_automation':
        return ticket.workspaceRef ? { kind: 'workspace_stop', scopeType: 'workspace', scopeRef: ticket.workspaceRef, controlEpoch: workspaceEpoch } : null;
      case 'resume_workspace_automation':
        return ticket.workspaceRef ? { kind: 'workspace_resume', scopeType: 'workspace', scopeRef: ticket.workspaceRef, controlEpoch: workspaceEpoch } : null;
      case 'take_over_workspace':
        return ticket.workspaceRef ? { kind: 'takeover', scopeType: 'workspace', scopeRef: ticket.workspaceRef, controlEpoch: workspaceEpoch } : null;
      case 'terminate_workspace':
        return ticket.workspaceRef ? { kind: 'termination', scopeType: 'workspace', scopeRef: ticket.workspaceRef, controlEpoch: workspaceEpoch } : null;
      case 'kill_browser_endpoint':
        return ticket.endpointRef ? { kind: 'endpoint_kill', scopeType: 'endpoint', scopeRef: ticket.endpointRef, controlEpoch: Math.max(1, Date.parse(ticket.acceptedAt)) } : null;
      case 'resume_browser_endpoint':
        return ticket.endpointRef ? { kind: 'endpoint_resume', scopeType: 'endpoint', scopeRef: ticket.endpointRef, controlEpoch: Math.max(1, Date.parse(ticket.acceptedAt)) } : null;
      case 'resolve_browser_request':
        return ticket.resolutionOfRequestRef ? { kind: 'human_resolution', scopeType: 'request', scopeRef: ticket.resolutionOfRequestRef, controlEpoch: Math.max(1, Date.parse(ticket.acceptedAt)) } : null;
      default:
        return null;
    }
  }

  private acceptedControlEpoch(ticket: StoredRequestTicket): number {
    const details = isObject(ticket.checkpoint.details) ? ticket.checkpoint.details : {};
    const value = Number(details.accepted_control_epoch ?? 0);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  private activeWorkspaceControl(workspaceRef: string, kind: StoredControlRecord['kind']): StoredControlRecord | null {
    return this.repositories.logical.scanLogicalRecovery().activeControls
      .find((control) => control.scopeType === 'workspace' && control.scopeRef === workspaceRef && control.kind === kind) ?? null;
  }

  private fenceTerminationQueue(termination: StoredRequestTicket): void {
    if (!termination.workspaceRef) return;
    const attempts = this.repositories.requests.scanRequestRecovery().attempts;
    const invalidated: string[] = [];
    for (const candidate of this.repositories.requests.scanRequestRecovery().requests) {
      if (candidate.requestRef === termination.requestRef || candidate.workspaceRef !== termination.workspaceRef
        || !['create_browser_tab', 'send_cdp_command'].includes(candidate.toolName)
        || !['queued', 'running'].includes(candidate.state)) continue;
      const dispatched = attempts.some((attempt) => attempt.requestRef === candidate.requestRef
        && (attempt.state === 'prepared' || attempt.state === 'dispatched'));
      if (dispatched || this.runningWorkers.has(candidate.requestRef)) continue;
      const invalidationProblem = problem('WORKSPACE_TERMINATED', 'Workspace termination fenced this request before browser dispatch.', false, {
        workspace_ref: termination.workspaceRef,
        termination_request_ref: termination.requestRef
      });
      const terminal = this.repositories.requests.terminalizeRequest({
        requestRef: candidate.requestRef,
        state: 'failed',
        phase: 'termination_fenced_before_dispatch',
        checkpoint: checkpoint('termination_fenced_before_dispatch', { termination_request_ref: termination.requestRef }),
        problem: { ...invalidationProblem },
        result: {
          tool: candidate.toolName,
          kind: 'octopus_problem',
          problem: invalidationProblem,
          debugger_error: null,
          known_facts: {
            workspace_ref: termination.workspaceRef,
            dispatched: false,
            invalidated_by_request_ref: termination.requestRef
          }
        },
        reasonCode: 'WORKSPACE_TERMINATED'
      });
      if (terminal) invalidated.push(candidate.requestRef);
    }
    const current = this.repositories.requests.getRequest(termination.requestRef);
    if (current && ['queued', 'running'].includes(current.state)) {
      const details = isObject(current.checkpoint.details) ? current.checkpoint.details : {};
      this.repositories.requests.recordCheckpoint({
        requestRef: current.requestRef,
        expectedClaimGeneration: current.claimGeneration,
        phase: 'termination_fence_active',
        checkpoint: checkpoint('termination_fence_active', { ...details, invalidated_request_refs: invalidated }),
        pauseCondition: null,
        reasonCode: 'TERMINATION_FENCE_ACTIVE'
      });
    }
  }

  private pump(): void {
    queueMicrotask(() => {
      if (this.shuttingDown) return;
      const snapshot = this.repositories.requests.scanRequestRecovery();
      const laneHeads = new Set(snapshot.lanes.map((lane) => lane.headRequestRef).filter((value): value is string => value !== null));
      for (const ticket of snapshot.requests) {
        if (ticket.state !== 'queued' && ticket.state !== 'running') continue;
        if (ticket.acknowledgementState !== 'delivered' || ticket.pauseCondition !== null
          || this.runningWorkers.has(ticket.requestRef)) continue;
        if (ticket.workspaceRef !== null && ticket.tabRef !== null && !laneHeads.has(ticket.requestRef)) continue;
        void this.runWorker(ticket.requestRef);
      }
    });
  }

  private async runWorker(requestRef: string): Promise<void> {
    if (this.shuttingDown || this.runningWorkers.has(requestRef)) return;
    this.runningWorkers.add(requestRef);
    try {
      const claim = this.repositories.requests.claimRequest({
        requestRef,
        workerRef: `worker_${process.pid}`,
        leaseExpiresAt: new Date(Date.now() + this.workerLeaseMs).toISOString()
      });
      if (!claim) return;
      const claimEndpointRef = this.executionEndpointRef(claim);
      if (claimEndpointRef && !this.isEndpointReady(claimEndpointRef) && this.needsExtension(claim)) {
        this.repositories.requests.recordCheckpoint({
          requestRef,
          expectedClaimGeneration: claim.claimGeneration,
          phase: 'waiting_for_extension',
          checkpoint: checkpoint('waiting_for_extension', {
            ...(isObject(claim.checkpoint.details) ? claim.checkpoint.details : {}),
            endpoint_ref: claimEndpointRef,
            current_endpoint_ref: claimEndpointRef
          }),
          pauseCondition: 'extension_disconnected',
          reasonCode: 'EXTENSION_DISCONNECTED'
        });
        return;
      }
      await this.executeClaim(claim);
    } catch (error) {
      const current = this.repositories.requests.getRequest(requestRef);
      if (current && current.state === 'running' && current.pauseCondition === null) {
        const currentEndpointRef = this.executionEndpointRef(current);
        if (currentEndpointRef && !this.isEndpointReady(currentEndpointRef) && this.needsExtension(current)) {
          this.pauseTicket(current, 'extension_disconnected');
        } else {
          this.failTicket(current, this.publicProblem(error));
        }
      }
    } finally {
      this.runningWorkers.delete(requestRef);
      this.notifyIdle();
      this.pump();
    }
  }

  private needsExtension(ticket: StoredRequestTicket): boolean {
    if (ticket.toolName === 'resolve_browser_request') {
      return this.requestArguments(ticket).decision === 'restart_failed';
    }
    return ['request_browser_workspace', 'create_browser_tab', 'send_cdp_command', 'resume_workspace_automation',
      'resume_browser_endpoint', 'terminate_workspace'].includes(ticket.toolName);
  }

  private async executeClaim(ticket: StoredRequestTicket): Promise<void> {
    if (isProfileOperation(ticket.toolName)) {
      if (!this.profileRequests) throw new ProfileError('PROFILE_MANAGEMENT_UNAVAILABLE');
      await this.profileRequests.execute(ticket); return;
    }
    switch (ticket.toolName) {
      case 'request_browser_workspace': await this.executeWorkspaceRequest(ticket); break;
      case 'create_browser_tab': await this.executeCreateTab(ticket); break;
      case 'send_cdp_command': await this.executeCdp(ticket); break;
      case 'take_over_workspace': this.executeTakeover(ticket); break;
      case 'terminate_workspace': await this.executeTermination(ticket); break;
      case 'resolve_browser_request': await this.executeResolution(ticket); break;
      case 'stop_workspace_automation': this.executeWorkspaceStop(ticket); break;
      case 'resume_workspace_automation': await this.executeWorkspaceResume(ticket); break;
      case 'kill_browser_endpoint': this.executeEndpointKill(ticket); break;
      case 'resume_browser_endpoint': await this.executeEndpointResume(ticket); break;
      default: throw new Error(`Unknown request tool: ${ticket.toolName}`);
    }
  }

  private async executeWorkspaceRequest(ticket: StoredRequestTicket): Promise<void> {
    const args = this.requestArguments(ticket);
    const count = Number(args.required_workspace_count);
    const selections = Array.isArray(args.designated_endpoints) ? args.designated_endpoints : [];
    const admissionDetails = isObject(ticket.checkpoint.details) ? ticket.checkpoint.details : {};
    const assignedNicknames = new Set(Array.isArray(admissionDetails.assigned_endpoint_nicknames)
      ? admissionDetails.assigned_endpoint_nicknames.filter((value): value is string => typeof value === 'string')
      : []);
    const previouslyCreated = Array.isArray(admissionDetails.created_workspaces)
      ? admissionDetails.created_workspaces.filter(isObject)
      : [];
    const resolved: JsonObject[] = [...previouslyCreated];
    const completedNicknames = new Set(resolved
      .map((entry) => entry.endpoint_nickname)
      .filter((value): value is string => typeof value === 'string'));
    for (const rawSelection of selections) {
      if (!isObject(rawSelection)) continue;
      const nickname = asString(rawSelection.endpoint_nickname, 'endpoint_nickname');
      if (completedNicknames.has(nickname)) continue;
      const endpoint = this.repositories.logical.getEndpointByNickname(nickname);
      if (!endpoint) throw new Error(`Endpoint disappeared after acceptance: ${nickname}`);
      const current = this.repositories.requests.getRequest(ticket.requestRef);
      if (!current || !['queued', 'running'].includes(current.state)) return;
      const currentDetails = isObject(current.checkpoint.details) ? current.checkpoint.details : {};
      this.repositories.requests.recordCheckpoint({
        requestRef: current.requestRef,
        expectedClaimGeneration: current.claimGeneration,
        phase: 'workspace_allocation_in_progress',
        checkpoint: checkpoint('workspace_allocation_in_progress', {
          ...currentDetails,
          current_endpoint_ref: endpoint.endpointRef
        }),
        pauseCondition: null,
        reasonCode: 'WORKSPACE_ENDPOINT_SELECTED'
      });
      const inventory = await this.requireExtensionPort().requestInventory(endpoint.endpointRef, null);
      this.reconcileInventory(endpoint.endpointRef, inventory);
      const window = typeof rawSelection.window_ref === 'string'
        ? this.repositories.logical.getWindow(rawSelection.window_ref)
        : this.mostRecentWindow(endpoint.endpointRef);
      if (!window) throw new OctopusBrokerError(problem('WINDOW_UNAVAILABLE', `Endpoint ${nickname} has no unambiguous most-recently-focused eligible window; discover its windows and supply window_ref.`, true, { endpoint_nickname: nickname }));
      const created = await this.createWorkspaceInWindow(ticket, endpoint, window, resolved.length + 1);
      resolved.push({
        endpoint_nickname: nickname,
        allocation_source: assignedNicknames.has(nickname) ? 'assigned' : 'designated',
        window_selection: typeof rawSelection.window_ref === 'string' ? 'designated' : 'most_recently_focused',
        workspace_result: 'created',
        ended_workspace: null,
        workspace: this.workspaceFact(created.workspace, this.sessionForTicket(ticket)),
        tabs: [this.tabFact(created.tab, 'workspace_initial')],
        tab_page: { returned_count: 1, next_cursor: null }
      });
      const currentAfterCreation = this.repositories.requests.getRequest(ticket.requestRef);
      if (!currentAfterCreation || !['queued', 'running'].includes(currentAfterCreation.state)) return;
      const detailsAfterCreation = isObject(currentAfterCreation.checkpoint.details) ? currentAfterCreation.checkpoint.details : {};
      this.repositories.requests.recordCheckpoint({
        requestRef: currentAfterCreation.requestRef,
        expectedClaimGeneration: currentAfterCreation.claimGeneration,
        phase: 'workspace_allocation_in_progress',
        checkpoint: checkpoint('workspace_allocation_in_progress', {
          ...detailsAfterCreation,
          created_workspaces: resolved
        }),
        pauseCondition: null,
        reasonCode: 'WORKSPACE_CREATED'
      });
    }
    if (resolved.length !== count) throw new Error('Workspace allocation did not produce the accepted exact count.');
    this.succeedTicket(ticket, {
      tool: 'request_browser_workspace',
      disposition: 'complete',
      facts: { requested_workspace_count: count, resolved }
    });
  }

  private async createWorkspaceInWindow(
    ticket: StoredRequestTicket,
    endpoint: StoredEndpoint,
    window: StoredLogicalWindow,
    ordinal: number
  ): Promise<{ workspace: StoredWorkspace; tab: StoredManagedTab }> {
    if (this.profileManager?.blocksEndpoint(endpoint.endpointRef)) throw new OctopusBrokerError(problem('ENDPOINT_UNAVAILABLE', 'This Profile is stopping.', true));
    const creation = await this.createTabReliably(ticket, endpoint.endpointRef, window.windowRef, null);
    const connection = this.requireConnection(endpoint.endpointRef);
    const createdTab = creation.rawTab;
    const privateWindow = this.currentPrivateWindow(endpoint.endpointRef, window.windowRef, connection.connectionGeneration);
    const groupResult = await this.extensionOperation(endpoint.endpointRef, 'GROUP_TABS', {
      attemptId: randomUUID(),
      expected: {
        connectionGeneration: connection.connectionGeneration,
        inventoryGeneration: creation.observedInventoryGeneration
      },
      window: this.windowLocator(privateWindow) as never,
      tabs: [this.tabLocator(createdTab) as never],
      group: null
    });
    const group = this.resultObject(groupResult, 'GROUP_TABS').group;
    if (!isObject(group)) throw new Error('Extension did not return the created tab group locator.');
    const groupLabel = `Tabro ${ticket.requesterSessionRef.slice(-6)} ${ordinal}`;
    await this.extensionOperation(endpoint.endpointRef, 'RENAME_GROUP', {
      attemptId: randomUUID(),
      expected: {
        connectionGeneration: connection.connectionGeneration,
        inventoryGeneration: Number(groupResult.observed.inventoryGeneration),
        groupGeneration: Number(group.groupGeneration)
      },
      group: this.groupLocator(group) as never,
      title: groupLabel
    });
    const caller = this.sessionForTicket(ticket);
    const workspace = this.repositories.logical.createWorkspace({
      workspaceRef: this.references.issue('workspace'),
      endpointRef: endpoint.endpointRef,
      windowRef: window.windowRef,
      lineageRef: caller.lineageRef,
      ownerSessionRef: caller.sessionRef,
      groupLabel,
      privateGroupKey: JSON.stringify({ ...this.groupLocator(group), connectionGeneration: connection.connectionGeneration }),
      locatorGeneration: Number(group.groupGeneration)
    });
    const tab = this.repositories.logical.addTab({
      tabRef: this.references.issue('tab'),
      workspaceRef: workspace.workspaceRef,
      endpointRef: endpoint.endpointRef,
      windowRef: window.windowRef,
      privateTabKey: JSON.stringify({ ...this.tabLocator(createdTab), connectionGeneration: connection.connectionGeneration }),
      locatorGeneration: Number(createdTab.tabGeneration),
      title: typeof createdTab.title === 'string' ? createdTab.title : '',
      url: typeof createdTab.url === 'string' ? createdTab.url : 'about:blank'
    });
    this.createEventStream(tab, workspace);
    return { workspace, tab };
  }

  private async executeCreateTab(ticket: StoredRequestTicket): Promise<void> {
    const workspace = this.requireWorkspaceForTicket(ticket);
    let tab: StoredManagedTab;
    let creationAttempts = 0;
    try {
      const created = await this.createManagedTabInWorkspace(workspace, ticket);
      tab = created.tab;
      creationAttempts = created.creationAttempts;
    } catch (error) {
      if (!this.isEndpointReady(workspace.endpointRef)) throw error;
      const currentTicket = this.repositories.requests.getRequest(ticket.requestRef) ?? ticket;
      const attempts = this.createTabAttempts(currentTicket, workspace.endpointRef).length;
      const currentWorkspace = this.repositories.logical.getWorkspace(workspace.workspaceRef) ?? workspace;
      const tabs = this.repositories.logical.listWorkspaceTabs(currentWorkspace.workspaceRef)
        .filter((candidate) => candidate.lifecycle === 'active');
      const failureProblem = this.publicProblem(error);
      this.failTicket(currentTicket, failureProblem, {
        tool: 'create_browser_tab', kind: 'octopus_problem', problem: failureProblem, debugger_error: null,
        known_facts: {
          workspace: this.workspaceFact(currentWorkspace, this.sessionForTicket(currentTicket)),
          tabs: tabs.map((candidate) => this.tabFact(candidate, 'agent_created')),
          tab_page: { returned_count: tabs.length, next_cursor: null },
          creation_attempts: Math.max(1, Math.min(3, attempts)),
          reconciled_before_each_retry: true
        }
      });
      return;
    }
    this.succeedTicket(ticket, {
      tool: 'create_browser_tab', disposition: 'complete', facts: {
        workspace_ref: workspace.workspaceRef,
        tab: this.tabFact(tab, 'agent_created'),
        creation_attempts: creationAttempts,
        reconciled_before_each_retry: true
      }
    });
  }

  private async createManagedTabInWorkspace(
    workspace: StoredWorkspace,
    recoveryTicket?: StoredRequestTicket
  ): Promise<{ tab: StoredManagedTab; creationAttempts: number }> {
    const inventory = await this.requireExtensionPort().requestInventory(workspace.endpointRef, null);
    this.reconcileInventory(workspace.endpointRef, inventory);
    const currentWorkspace = this.repositories.logical.getWorkspace(workspace.workspaceRef);
    if (!currentWorkspace || currentWorkspace.lifecycle !== 'active') {
      throw new Error('Workspace is no longer active.');
    }
    const creation = recoveryTicket
      ? await this.createTabReliably(recoveryTicket, currentWorkspace.endpointRef, currentWorkspace.windowRef, currentWorkspace.workspaceRef)
      : await this.createTabOnce(currentWorkspace.endpointRef, currentWorkspace.windowRef, currentWorkspace.workspaceRef);
    const rawTab = creation.rawTab;
    const connection = this.requireConnection(currentWorkspace.endpointRef);
    const existing = this.findTabByPrivateId(currentWorkspace.endpointRef, Number(rawTab.tabId));
    if (existing?.workspaceRef === currentWorkspace.workspaceRef && existing.lifecycle === 'active') {
      return { tab: existing, creationAttempts: creation.creationAttempts };
    }
    const tab = this.repositories.logical.addTab({
      tabRef: this.references.issue('tab'),
      workspaceRef: currentWorkspace.workspaceRef,
      endpointRef: currentWorkspace.endpointRef,
      windowRef: currentWorkspace.windowRef,
      privateTabKey: JSON.stringify({ ...this.tabLocator(rawTab), connectionGeneration: connection.connectionGeneration }),
      locatorGeneration: Number(rawTab.tabGeneration),
      title: typeof rawTab.title === 'string' ? rawTab.title : '',
      url: typeof rawTab.url === 'string' ? rawTab.url : 'about:blank'
    });
    this.createEventStream(tab, currentWorkspace);
    return { tab, creationAttempts: creation.creationAttempts };
  }

  private async createTabOnce(
    endpointRef: string,
    windowRef: string,
    workspaceRef: string | null
  ): Promise<{ rawTab: JsonObject; creationAttempts: number; observedInventoryGeneration: number }> {
    const inventory = await this.requireExtensionPort().requestInventory(endpointRef, null);
    this.reconcileInventory(endpointRef, inventory);
    const connection = this.requireConnection(endpointRef);
    const privateWindow = this.currentPrivateWindow(endpointRef, windowRef, connection.connectionGeneration);
    const privateGroup = this.currentPrivateGroup(workspaceRef, connection.connectionGeneration);
    const result = await this.extensionOperation(endpointRef, 'CREATE_TAB', {
      attemptId: randomUUID(),
      expected: { connectionGeneration: connection.connectionGeneration, inventoryGeneration: inventory.inventoryGeneration },
      window: this.windowLocator(privateWindow) as never,
      group: privateGroup === null ? null : this.groupLocator(privateGroup) as never,
      url: null,
      active: true,
      index: null
    });
    const rawTab = this.resultObject(result, 'CREATE_TAB').tab;
    if (!isObject(rawTab)) throw new Error('Extension did not return a created tab.');
    return {
      rawTab,
      creationAttempts: 1,
      observedInventoryGeneration: Number(result.observed.inventoryGeneration)
    };
  }

  /**
   * CREATE_TAB is the one browser mutation that cannot be replayed blindly: a
   * lost response may still have opened the tab. The request attempt journal
   * and the extension's durable attempt cache let the broker reconcile that
   * exact mutation after a fresh inventory snapshot before considering retry.
   */
  private async createTabReliably(
    ticket: StoredRequestTicket,
    endpointRef: string,
    windowRef: string,
    workspaceRef: string | null
  ): Promise<{ rawTab: JsonObject; creationAttempts: number; observedInventoryGeneration: number }> {
    let lastError: unknown = new Error('Tab creation did not complete.');
    for (;;) {
      const inventory = await this.requireExtensionPort().requestInventory(endpointRef, null);
      this.reconcileInventory(endpointRef, inventory);
      const connection = this.requireConnection(endpointRef);
      const privateWindow = this.currentPrivateWindow(endpointRef, windowRef, connection.connectionGeneration);
      const privateGroup = this.currentPrivateGroup(workspaceRef, connection.connectionGeneration);
      const attempts = this.createTabAttempts(ticket, endpointRef);

      const priorSuccess = [...attempts].reverse().find((attempt) =>
        attempt.state === 'completed' && attempt.effectClassification === 'create_tab_succeeded');
      if (priorSuccess) {
        const recorded = this.createdTabFromAttempt(priorSuccess);
        const current = recorded === null ? null : this.currentInventoryTab(inventory, Number(recorded.tabId));
        if (current) {
          return {
            rawTab: current,
            creationAttempts: attempts.length,
            observedInventoryGeneration: inventory.inventoryGeneration
          };
        }
      }

      const pending = [...attempts].reverse().find((attempt) =>
        attempt.state === 'prepared' || attempt.state === 'dispatched');
      if (pending?.privateMessageRef) {
        try {
          const reconciliation = await this.extensionOperation(endpointRef, 'RECONCILE_ATTEMPT', {
            attemptId: randomUUID(),
            reconciledAttemptId: pending.privateMessageRef,
            expected: {
              connectionGeneration: connection.connectionGeneration,
              inventoryGeneration: inventory.inventoryGeneration
            },
            window: this.windowLocator(privateWindow) as never
          });
          const reconciliationBody = this.resultObject(reconciliation, 'RECONCILE_ATTEMPT');
          const outcome = isObject(reconciliationBody.outcome) ? reconciliationBody.outcome : null;
          if (reconciliationBody.found === true && outcome) {
            if (outcome.ok === true && isObject(outcome.output)) {
              const rawTab = outcome.output.tab;
              if (!isObject(rawTab)) throw new Error('Reconciled CREATE_TAB result has no tab locator.');
              this.repositories.requests.finishAttempt({
                attemptRef: pending.attemptRef,
                state: 'completed',
                outcome: { operation: 'CREATE_TAB', result: outcome.output, observed: reconciliation.observed },
                effectClassification: 'create_tab_succeeded'
              });
              return {
                rawTab: this.currentInventoryTab(inventory, Number(rawTab.tabId)) ?? rawTab,
                creationAttempts: attempts.length,
                observedInventoryGeneration: Math.max(inventory.inventoryGeneration, Number(outcome.inventoryGeneration ?? inventory.inventoryGeneration))
              };
            }
            lastError = new Error(isObject(outcome.error) && typeof outcome.error.message === 'string'
              ? outcome.error.message
              : 'The extension reported that CREATE_TAB failed.');
            this.repositories.requests.finishAttempt({
              attemptRef: pending.attemptRef,
              state: 'completed',
              outcome: { operation: 'CREATE_TAB', reconciled_outcome: outcome },
              effectClassification: 'create_tab_failed'
            });
          } else {
            lastError = new Error('The extension has no result for the prior CREATE_TAB attempt after inventory reconciliation.');
            this.repositories.requests.finishAttempt({
              attemptRef: pending.attemptRef,
              state: 'missing',
              outcome: { operation: 'CREATE_TAB', inventory_reconciled: true },
              effectClassification: 'create_tab_not_found'
            });
          }
        } catch (error) {
          if (!this.isEndpointReady(endpointRef)) throw error;
          lastError = error;
          // A connected reconciliation failure is not proof that CREATE_TAB
          // had no effect. Leave the attempt pending for the next inventory
          // barrier instead of dispatching another tab creation.
          throw error;
        }
        continue;
      }

      if (attempts.length >= 3) throw lastError;
      const attemptId = randomUUID();
      const attempt = this.repositories.requests.startAttempt({
        attemptRef: `att_${randomUUID()}`,
        requestRef: ticket.requestRef,
        endpointRef,
        connectionGeneration: connection.connectionGeneration,
        locatorGeneration: Number(privateWindow.windowGeneration),
        privateMessageRef: attemptId
      });
      this.repositories.requests.markAttemptDispatched(attempt.attemptRef);
      let result: RelayV2PayloadByType['OPERATION_RESULT'];
      try {
        result = await this.requireExtensionPort().execute(endpointRef, 'CREATE_TAB', {
          attemptId,
          expected: { connectionGeneration: connection.connectionGeneration, inventoryGeneration: inventory.inventoryGeneration },
          window: this.windowLocator(privateWindow) as never,
          group: privateGroup === null ? null : this.groupLocator(privateGroup) as never,
          url: null,
          active: true,
          index: null
        });
      } catch (error) {
        if (!this.isEndpointReady(endpointRef)) throw error;
        lastError = error;
        // The effect may exist even though the result was lost. Re-enter the
        // loop so inventory + RECONCILE_ATTEMPT runs before any retry.
        continue;
      }
      if (result.outcome === 'succeeded' && isObject(result.result) && isObject(result.result.tab)) {
        this.repositories.requests.finishAttempt({
          attemptRef: attempt.attemptRef,
          state: 'completed',
          outcome: { operation: 'CREATE_TAB', result: result.result, observed: result.observed },
          effectClassification: 'create_tab_succeeded'
        });
        return {
          rawTab: result.result.tab,
          creationAttempts: attempts.length + 1,
          observedInventoryGeneration: Number(result.observed.inventoryGeneration)
        };
      }
      if (result.outcome === 'failed') {
        lastError = new Error(result.error?.message ?? 'CREATE_TAB failed.');
        this.repositories.requests.finishAttempt({
          attemptRef: attempt.attemptRef,
          state: 'completed',
          outcome: { operation: 'CREATE_TAB', error: result.error },
          effectClassification: 'create_tab_failed'
        });
        continue;
      }
      lastError = new Error(`CREATE_TAB returned ${result.outcome}.`);
    }
  }

  private createTabAttempts(ticket: StoredRequestTicket, endpointRef: string): StoredRequestAttempt[] {
    return this.repositories.requests.scanRequestRecovery().attempts
      .filter((attempt) => attempt.requestRef === ticket.requestRef && attempt.endpointRef === endpointRef)
      .sort((left, right) => left.attemptNumber - right.attemptNumber);
  }

  private createdTabFromAttempt(attempt: StoredRequestAttempt): JsonObject | null {
    if (!attempt.outcome || !isObject(attempt.outcome.result)) return null;
    return isObject(attempt.outcome.result.tab) ? attempt.outcome.result.tab : null;
  }

  private currentInventoryTab(
    inventory: RelayV2PayloadByType['INVENTORY_SNAPSHOT'],
    tabId: number
  ): JsonObject | null {
    for (const window of inventory.windows) {
      const tab = window.tabs.find((candidate) => candidate.tabId === tabId);
      if (!tab) continue;
      return {
        tabId: tab.tabId,
        tabGeneration: tab.tabGeneration,
        windowId: window.windowId,
        windowGeneration: window.windowGeneration,
        title: tab.title ?? '',
        url: tab.url ?? 'about:blank'
      };
    }
    return null;
  }

  private currentPrivateWindow(endpointRef: string, windowRef: string, connectionGeneration: number): JsonObject {
    const window = this.repositories.logical.getWindow(windowRef);
    if (!window || window.endpointRef !== endpointRef) throw new Error('Workspace window no longer exists.');
    if (!window.eligible) {
      throw new OctopusBrokerError(problem('WINDOW_UNAVAILABLE', 'The designated window is absent from the current browser inventory.', true, {
        window_ref: windowRef
      }));
    }
    const privateWindow = parsePrivate<JsonObject>(window.privateWindowKey, 'window');
    this.assertCurrentLocator(privateWindow, connectionGeneration, 'window');
    return privateWindow;
  }

  private currentPrivateGroup(workspaceRef: string | null, connectionGeneration: number): JsonObject | null {
    if (workspaceRef === null) return null;
    const workspace = this.repositories.logical.getWorkspace(workspaceRef);
    if (!workspace || workspace.lifecycle !== 'active' || workspace.privateGroupKey === null) {
      throw new Error('Workspace tab group no longer exists.');
    }
    const privateGroup = parsePrivate<JsonObject>(workspace.privateGroupKey, 'group');
    this.assertCurrentLocator(privateGroup, connectionGeneration, 'group');
    return privateGroup;
  }

  private async executeCdp(ticket: StoredRequestTicket): Promise<void> {
    const workspace = this.requireWorkspaceForTicket(ticket);
    const endpointControl = this.repositories.logical.getActiveEndpointControl(workspace.endpointRef);
    if (endpointControl?.kind === 'endpoint_kill') return this.pauseTicket(ticket, 'endpoint_killed');
    if (this.activeWorkspaceControl(workspace.workspaceRef, 'workspace_stop')) return this.pauseTicket(ticket, 'manual_workspace_stop');
    if (this.activeWorkspaceControl(workspace.workspaceRef, 'termination')) {
      return this.failTicket(ticket, problem('WORKSPACE_TERMINATED', 'Workspace termination fenced this command before dispatch.', false, {
        workspace_ref: workspace.workspaceRef
      }));
    }
    if (workspace.pauseCauses.includes('endpoint_killed')) return this.pauseTicket(ticket, 'endpoint_killed');
    if (workspace.pauseCauses.includes('manual_workspace_stop')) return this.pauseTicket(ticket, 'manual_workspace_stop');
    const tab = this.requireTab(workspace, ticket.tabRef!);
    const args = this.requestArguments(ticket);
    const connection = this.requireConnection(workspace.endpointRef);
    const privateTab = parsePrivate<JsonObject>(tab.privateTabKey, 'tab');
    this.assertCurrentLocator(privateTab, connection.connectionGeneration, 'tab');
    let attachmentGeneration = tab.attachmentGeneration;
    if (attachmentGeneration <= 0) {
      const attached = await this.extensionOperation(workspace.endpointRef, 'ATTACH_DEBUGGER', {
        attemptId: randomUUID(),
        expected: {
          connectionGeneration: connection.connectionGeneration,
          inventoryGeneration: this.requireExtensionConnection(workspace.endpointRef).inventoryGeneration,
          tabGeneration: tab.locatorGeneration,
          attachmentGeneration: null
        },
        tab: this.tabLocator(privateTab) as never,
        debuggerProtocolVersion: CONSERVATIVE_CAPABILITY_MANIFEST.debuggerProtocolVersion
      });
      const attachBody = this.resultObject(attached, 'ATTACH_DEBUGGER');
      attachmentGeneration = Number(attachBody.attachmentGeneration ?? attached.observed.attachmentGeneration ?? 1);
      this.repositories.logical.updateTab({
        workspaceRef: workspace.workspaceRef,
        tabRef: tab.tabRef,
        expectedLocatorGeneration: tab.locatorGeneration,
        attachmentGeneration
      });
    }
    const pendingAttempt = this.repositories.requests.scanRequestRecovery().attempts
      .filter((attempt) => attempt.requestRef === ticket.requestRef && ['prepared', 'dispatched'].includes(attempt.state))
      .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
    if (pendingAttempt?.privateMessageRef) {
      await this.reconcileCdpAttempt(ticket, workspace, tab, args, pendingAttempt.privateMessageRef, pendingAttempt.attemptRef, attachmentGeneration);
      return;
    }

    const attemptId = randomUUID();
    const attempt = this.repositories.requests.startAttempt({
      attemptRef: attemptId,
      requestRef: ticket.requestRef,
      endpointRef: workspace.endpointRef,
      connectionGeneration: connection.connectionGeneration,
      locatorGeneration: tab.locatorGeneration,
      attachmentGeneration,
      privateMessageRef: attemptId
    });
    this.repositories.requests.markAttemptDispatched(attempt.attemptRef);
    let result: RelayV2PayloadByType['OPERATION_RESULT'];
    try {
      result = await this.requireExtensionPort().execute(workspace.endpointRef, 'SEND_CDP', {
        attemptId,
        expected: {
          connectionGeneration: connection.connectionGeneration,
          inventoryGeneration: this.requireExtensionConnection(workspace.endpointRef).inventoryGeneration,
          tabGeneration: tab.locatorGeneration,
          attachmentGeneration
        },
        tab: this.tabLocator(privateTab) as never,
        method: asString(args.method, 'method'),
        params: (isObject(args.params) ? args.params : {}) as never,
        sessionId: typeof args.sessionId === 'string' ? args.sessionId : null
      });
    } catch (error) {
      if (!this.isEndpointReady(workspace.endpointRef)) {
        this.pauseTicket(ticket, 'extension_disconnected');
      } else {
        this.repositories.requests.finishAttempt({
          attemptRef: attempt.attemptRef,
          state: 'missing',
          outcome: { error: error instanceof Error ? error.message : 'Extension response missing.' },
          effectClassification: 'effect_unknown'
        });
        this.pauseForHumanConfirmation(ticket, attemptId);
      }
      return;
    }
    if (result.outcome !== 'succeeded') {
      if (result.outcome === 'failed') {
        this.repositories.requests.finishAttempt({
          attemptRef: attempt.attemptRef,
          state: 'completed',
          outcome: { outcome: 'failed', error: result.error },
          effectClassification: 'confirmed_failed'
        });
        this.failCdpWithDebuggerError(ticket, result.error);
      } else {
        this.repositories.requests.finishAttempt({
          attemptRef: attempt.attemptRef,
          state: 'missing',
          outcome: { outcome: result.outcome },
          effectClassification: 'effect_unknown'
        });
        this.pauseForHumanConfirmation(ticket, attemptId);
      }
      return;
    }
    const body = this.resultObject(result, 'SEND_CDP');
    this.repositories.requests.finishAttempt({
      attemptRef: attempt.attemptRef,
      state: 'completed',
      outcome: body,
      effectClassification: 'confirmed_succeeded'
    });
    this.completeCdpTicket(ticket, workspace, tab, args, body);
  }

  private async reconcileCdpAttempt(
    ticket: StoredRequestTicket,
    workspace: StoredWorkspace,
    tab: StoredManagedTab,
    args: JsonObject,
    privateAttemptId: string,
    attemptRef: string,
    attachmentGeneration: number
  ): Promise<void> {
    const connection = this.requireConnection(workspace.endpointRef);
    let result: RelayV2PayloadByType['OPERATION_RESULT'];
    try {
      result = await this.requireExtensionPort().execute(workspace.endpointRef, 'RECONCILE_ATTEMPT', {
        attemptId: randomUUID(),
        reconciledAttemptId: privateAttemptId,
        expected: {
          connectionGeneration: connection.connectionGeneration,
          inventoryGeneration: this.requireExtensionConnection(workspace.endpointRef).inventoryGeneration,
          tabGeneration: tab.locatorGeneration,
          attachmentGeneration
        },
        tab: this.tabLocator(parsePrivate<JsonObject>(tab.privateTabKey, 'tab')) as never
      });
    } catch (error) {
      if (!this.isEndpointReady(workspace.endpointRef)) return this.pauseTicket(ticket, 'extension_disconnected');
      this.repositories.requests.finishAttempt({
        attemptRef, state: 'missing',
        outcome: { error: error instanceof Error ? error.message : 'Reconciliation response missing.' },
        effectClassification: 'effect_unknown'
      });
      this.pauseForHumanConfirmation(ticket, privateAttemptId);
      return;
    }
    if (result.outcome !== 'succeeded') {
      if (!this.isEndpointReady(workspace.endpointRef)) return this.pauseTicket(ticket, 'extension_disconnected');
      this.repositories.requests.finishAttempt({
        attemptRef, state: 'missing', outcome: { outcome: result.outcome, error: result.error }, effectClassification: 'effect_unknown'
      });
      this.pauseForHumanConfirmation(ticket, privateAttemptId);
      return;
    }
    const reconciliation = this.resultObject(result, 'RECONCILE_ATTEMPT');
    if (reconciliation.found !== true || !isObject(reconciliation.outcome)) {
      this.repositories.requests.finishAttempt({
        attemptRef, state: 'missing', outcome: reconciliation, effectClassification: 'effect_unknown'
      });
      this.pauseForHumanConfirmation(ticket, privateAttemptId);
      return;
    }
    const outcome = reconciliation.outcome;
    if (outcome.ok === true && isObject(outcome.output)) {
      this.repositories.requests.finishAttempt({
        attemptRef, state: 'completed', outcome, effectClassification: 'confirmed_succeeded'
      });
      this.completeCdpTicket(ticket, workspace, tab, args, outcome.output);
      return;
    }
    this.repositories.requests.finishAttempt({
      attemptRef, state: 'completed', outcome, effectClassification: 'confirmed_failed'
    });
    const cachedError = isObject(outcome.error) ? outcome.error : null;
    this.failCdpWithDebuggerError(ticket, {
      source: 'chrome_debugger',
      code: null,
      message: typeof cachedError?.message === 'string'
        ? `${typeof cachedError.code === 'string' ? `${cachedError.code}: ` : ''}${cachedError.message}`
        : 'The reconciled CDP command failed.',
      data: cachedError === null ? null : cachedError
    });
  }

  private completeCdpTicket(
    ticket: StoredRequestTicket,
    workspace: StoredWorkspace,
    tab: StoredManagedTab,
    args: JsonObject,
    body: JsonObject
  ): void {
    const stream = this.activeStream(tab.tabRef);
    this.succeedTicket(ticket, {
      tool: 'send_cdp_command', disposition: 'complete', facts: { command: {
        workspace_ref: workspace.workspaceRef,
        target: { kind: 'tab', tab_ref: tab.tabRef },
        method: asString(args.method, 'method'),
        completion_basis: 'raw_result',
        result: isObject(body.rawResult) ? body.rawResult : isObject(body.result) ? body.result : {},
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : typeof args.sessionId === 'string' ? args.sessionId : null,
        events_cursor: stream.initialCursorRef
      } }
    });
  }

  private failCdpWithDebuggerError(
    ticket: StoredRequestTicket,
    debuggerError: RelayV2PayloadByType['OPERATION_RESULT']['error'] | JsonObject | null
  ): void {
    this.failTicket(ticket, null, {
      tool: 'send_cdp_command', kind: 'debugger_error', problem: null,
      debugger_error: debuggerError ?? { source: 'chrome_debugger', code: null, message: 'CDP command failed.', data: null },
      known_facts: null
    });
  }

  private pauseForHumanConfirmation(ticket: StoredRequestTicket, privateAttemptId: string): void {
    this.repositories.requests.recordCheckpoint({
      requestRef: ticket.requestRef,
      expectedClaimGeneration: ticket.claimGeneration,
      phase: 'awaiting_human_confirmation',
      checkpoint: checkpoint('extension_result_missing', { private_attempt_recorded: true, attempt_id_redacted: privateAttemptId.length > 0 }),
      pauseCondition: 'user_confirmation_required',
      reasonCode: 'USER_CONFIRMATION_REQUIRED'
    });
  }

  private executeTakeover(ticket: StoredRequestTicket): void {
    const workspace = this.requireWorkspaceForTicket(ticket);
    const caller = this.sessionForTicket(ticket);
    const args = this.requestArguments(ticket);
    const previousOwner = asString(args.previous_owner_session_ref, 'previous_owner_session_ref');
    const updated = this.repositories.transaction(({ logical, events }) => {
      const next = logical.takeOverWorkspace({
        workspaceRef: workspace.workspaceRef,
        expectedOwnerSessionRef: previousOwner,
        expectedOwnerEpoch: ticket.acceptedOwnerEpoch ?? workspace.ownerEpoch,
        expectedControlEpoch: this.acceptedControlEpoch(ticket),
        newOwnerSessionRef: caller.sessionRef,
        newLineageRef: caller.lineageRef
      });
      if (!next) return null;
      for (const tab of logical.listWorkspaceTabs(next.workspaceRef).filter((candidate) => candidate.lifecycle === 'active')) {
        events.replaceStreamBaseline({
          tabRef: tab.tabRef,
          streamRef: `stream_${randomUUID()}`,
          initialCursorRef: this.references.issue('cursor'),
          queryHash: JSON.stringify({ workspaceRef: next.workspaceRef, tabRef: tab.tabRef }),
          ownerEpoch: next.ownerEpoch,
          baseline: { title: tab.title ?? '', url: tab.url ?? '', observed_at: tab.lastObservedAt }
        });
      }
      return next;
    });
    if (!updated) return this.failTicket(ticket, problem('CONTROL_RACE_LOST', 'Another workspace control committed first.', false, { workspace_ref: workspace.workspaceRef }));
    const tabs = this.repositories.logical.listWorkspaceTabs(updated.workspaceRef).map((tab) => this.tabFact(tab, 'agent_created'));
    this.succeedTicket(ticket, {
      tool: 'take_over_workspace', disposition: 'complete', facts: {
        workspace: this.workspaceFact(updated, caller),
        previous_owner_session_ref: previousOwner,
        new_owner_session_ref: caller.sessionRef,
        ticket_access_transferred: true,
        tabs,
        tab_page: { returned_count: tabs.length, next_cursor: null }
      }
    });
  }

  private async executeTermination(ticket: StoredRequestTicket): Promise<void> {
    let workspace = this.requireWorkspaceForTicket(ticket);
    const checkpointDetails = isObject(ticket.checkpoint.details) ? ticket.checkpoint.details : {};
    let claimedControlEpoch = Number(checkpointDetails.termination_control_epoch ?? 0);
    if (!Number.isInteger(claimedControlEpoch) || claimedControlEpoch <= 0) {
      const claimed = this.repositories.logical.claimWorkspaceControl({
        workspaceRef: workspace.workspaceRef,
        expectedControlEpoch: this.acceptedControlEpoch(ticket)
      });
      if (!claimed) {
        return this.failTicket(ticket, problem('CONTROL_RACE_LOST', 'Another workspace control committed first.', false, {
          workspace_ref: workspace.workspaceRef
        }));
      }
      claimedControlEpoch = claimed.controlEpoch;
      workspace = claimed;
      this.repositories.requests.recordCheckpoint({
        requestRef: ticket.requestRef,
        expectedClaimGeneration: ticket.claimGeneration,
        phase: 'waiting_for_dispatched_reconciliation',
        checkpoint: checkpoint('waiting_for_dispatched_reconciliation', {
          ...checkpointDetails,
          termination_control_epoch: claimedControlEpoch
        }),
        pauseCondition: null,
        reasonCode: 'TERMINATION_CONTROL_COMMITTED'
      });
    } else if (workspace.controlEpoch !== claimedControlEpoch) {
      return this.failTicket(ticket, problem('CONTROL_RACE_LOST', 'The workspace control epoch changed before termination resumed.', false, {
        workspace_ref: workspace.workspaceRef
      }));
    }

    this.fenceTerminationQueue(ticket);
    if (!await this.waitForWorkspaceReconciliation(ticket)) return;
    workspace = this.repositories.logical.getWorkspace(workspace.workspaceRef) ?? workspace;
    if (!workspace.privateGroupKey) {
      return this.failTermination(ticket, claimedControlEpoch, true, false, 'Workspace tab group locator is missing.');
    }
    if (!this.isEndpointReady(workspace.endpointRef)) {
      this.pauseTicket(ticket, 'extension_disconnected');
      return;
    }

    const title = `${workspace.groupLabel.replace(/\s+archive$/i, '')} archive`;
    try {
      const before = await this.requireExtensionPort().requestInventory(workspace.endpointRef, null);
      this.reconcileInventory(workspace.endpointRef, before);
      workspace = this.repositories.logical.getWorkspace(workspace.workspaceRef) ?? workspace;
      let archiveConfirmed = this.inventoryHasGroupTitle(workspace, before, title);
      if (!archiveConfirmed) {
        const connection = this.requireConnection(workspace.endpointRef);
        if (!workspace.privateGroupKey) {
          return this.failTermination(ticket, claimedControlEpoch, true, false, 'Workspace tab group locator disappeared during reconciliation.');
        }
        const group = parsePrivate<JsonObject>(workspace.privateGroupKey, 'group');
        this.assertCurrentLocator(group, connection.connectionGeneration, 'group');
        const result = await this.extensionOperation(workspace.endpointRef, 'RENAME_GROUP', {
          attemptId: randomUUID(),
          expected: {
            connectionGeneration: connection.connectionGeneration,
            inventoryGeneration: before.inventoryGeneration,
            groupGeneration: Number(group.groupGeneration)
          },
          group: this.groupLocator(group) as never,
          title
        });
        if (result.outcome !== 'succeeded') {
          return this.failTermination(ticket, claimedControlEpoch, true, false, 'Archive rename failed.');
        }
        const after = await this.requireExtensionPort().requestInventory(workspace.endpointRef, null);
        this.reconcileInventory(workspace.endpointRef, after);
        archiveConfirmed = this.inventoryHasGroupTitle(workspace, after, title);
      }
      if (!archiveConfirmed) {
        return this.failTermination(ticket, claimedControlEpoch, true, false, 'Archive rename could not be confirmed.');
      }
    } catch (error) {
      if (!this.isEndpointReady(workspace.endpointRef)) {
        this.pauseTicket(ticket, 'extension_disconnected');
        return;
      }
      return this.failTermination(ticket, claimedControlEpoch, true, false,
        error instanceof Error ? error.message : 'Archive confirmation failed.');
    }

    const ended = this.repositories.logical.finishWorkspaceTermination({
      workspaceRef: workspace.workspaceRef,
      expectedControlEpoch: claimedControlEpoch,
      succeeded: true
    });
    if (!ended) return this.failTicket(ticket, problem('CONTROL_RACE_LOST', 'Another workspace control committed first.', false, { workspace_ref: workspace.workspaceRef }));
    this.succeedTicket(ticket, {
      tool: 'terminate_workspace', disposition: 'complete', facts: {
        workspace: this.workspaceFact(ended, this.sessionForTicket(ticket)),
        archived_tab_group_name: title,
        agent_control_ended: true,
        ticket_inspection_preserved: true,
        workspace_requests_cursor_reset: true,
        manual_close_required: true
      }
    });
  }

  private async waitForWorkspaceReconciliation(termination: StoredRequestTicket): Promise<boolean> {
    while (true) {
      const currentTermination = this.repositories.requests.getRequest(termination.requestRef);
      if (!currentTermination || !['queued', 'running'].includes(currentTermination.state)) return false;
      if (currentTermination.pauseCondition !== null) return false;
      const blockers = this.repositories.requests.scanRequestRecovery().requests.filter((candidate) =>
        candidate.workspaceRef === termination.workspaceRef
        && candidate.requestRef !== termination.requestRef
        && ['create_browser_tab', 'send_cdp_command'].includes(candidate.toolName)
        && ['queued', 'running'].includes(candidate.state));
      if (blockers.length === 0) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private inventoryHasGroupTitle(
    workspace: StoredWorkspace,
    inventory: RelayV2PayloadByType['INVENTORY_SNAPSHOT'],
    title: string
  ): boolean {
    if (!workspace.privateGroupKey) return false;
    const stored = parsePrivate<JsonObject>(workspace.privateGroupKey, 'group');
    const groupId = Number(stored.tabGroupId);
    return inventory.windows.some((window) => window.groups.some((group) => group.tabGroupId === groupId && group.title === title));
  }

  private failTermination(
    ticket: StoredRequestTicket,
    controlEpoch: number,
    dispatchedWorkReconciled: boolean,
    archiveRenameConfirmed: boolean,
    message: string
  ): void {
    const workspace = this.repositories.logical.finishWorkspaceTermination({
      workspaceRef: ticket.workspaceRef!,
      expectedControlEpoch: controlEpoch,
      succeeded: false
    }) ?? this.repositories.logical.getWorkspace(ticket.workspaceRef!);
    if (!workspace) {
      return this.failTicket(ticket, problem('CONTROL_RACE_LOST', 'The workspace changed before termination failure could commit.', false));
    }
    const failureProblem = problem('CDP_TRANSPORT_UNAVAILABLE', message, true, { workspace_ref: workspace.workspaceRef });
    this.failTicket(ticket, failureProblem, {
      tool: 'terminate_workspace',
      kind: 'octopus_problem',
      problem: failureProblem,
      debugger_error: null,
      known_facts: {
        workspace: this.workspaceFact(workspace, this.sessionForTicket(ticket)),
        agent_control_ended: false,
        workspace_active: true,
        workspace_paused: true,
        dispatched_work_reconciled: dispatchedWorkReconciled,
        archive_rename_confirmed: archiveRenameConfirmed
      }
    });
  }

  private async executeResolution(ticket: StoredRequestTicket): Promise<void> {
    const targetRef = ticket.resolutionOfRequestRef;
    if (!targetRef) throw new Error('Resolver target is missing.');
    const target = this.repositories.requests.getRequest(targetRef);
    if (!target || target.state !== 'running' || target.pauseCondition !== 'user_confirmation_required') {
      return this.failTicket(ticket, problem('REQUEST_RESOLUTION_RACE_LOST', 'The target request was already resolved.', false, { request_ref: targetRef }));
    }
    const args = this.requestArguments(ticket);
    const decision = asString(args.decision, 'decision');
    if (decision === 'confirmed_succeeded') {
      const workspace = this.requireWorkspaceForTicket(target);
      const tab = this.repositories.logical.getTab(workspace.workspaceRef, target.tabRef!);
      if (!tab) throw new Error('Target tab is missing.');
      const targetArgs = this.requestArguments(target);
      const stream = this.activeStream(tab.tabRef);
      const targetResult = {
        tool: 'send_cdp_command', disposition: 'complete', facts: { command: {
          workspace_ref: workspace.workspaceRef,
          target: { kind: 'tab', tab_ref: tab.tabRef },
          method: asString(targetArgs.method, 'method'), completion_basis: 'human_confirmed', result: null,
          sessionId: typeof targetArgs.sessionId === 'string' ? targetArgs.sessionId : null,
          events_cursor: stream.initialCursorRef
        } }
      };
      const resolverResult = {
        tool: 'resolve_browser_request', disposition: 'complete', facts: {
          resolved_request_ref: target.requestRef,
          workspace: this.workspaceFact(workspace, this.sessionForTicket(ticket)),
          workspace_active: true,
          decision: 'confirmed_succeeded',
          resolved_request_state: 'succeeded',
          effect_may_have_occurred: null,
          old_tab_ref: tab.tabRef,
          replacement_tab: null,
          old_tab_remains_managed: true,
          replacement_creation_attempts: null,
          reconciled_before_each_retry: null,
          invalidated_request_refs: [],
          lane_released: true
        }
      };
      if (!this.repositories.requests.resolveRequest({
        resolverRequestRef: ticket.requestRef,
        targetRequestRef: target.requestRef,
        targetState: 'succeeded',
        targetResult,
        resolverResult
      })) return this.failTicket(ticket, problem('REQUEST_RESOLUTION_RACE_LOST', 'Another resolver committed first.', false, { request_ref: targetRef }));
      return;
    }
    if (decision !== 'restart_failed') throw new TypeError(`Unsupported resolution decision: ${decision}`);

    const workspace = this.requireWorkspaceForTicket(target);
    if (workspace.pauseCauses.includes('endpoint_killed')) return this.pauseTicket(ticket, 'endpoint_killed');
    if (workspace.pauseCauses.includes('manual_workspace_stop')) return this.pauseTicket(ticket, 'manual_workspace_stop');
    const oldTab = this.requireTab(workspace, target.tabRef!);
    let attemptCount = this.replacementAttemptCount(ticket);
    let replacementTab: StoredManagedTab | null = null;
    while (attemptCount < 3 && replacementTab === null) {
      try {
        replacementTab = (await this.createManagedTabInWorkspace(workspace)).tab;
        attemptCount += 1;
      } catch (error) {
        if (!this.isEndpointReady(workspace.endpointRef)) {
          this.repositories.requests.recordCheckpoint({
            requestRef: ticket.requestRef,
            expectedClaimGeneration: ticket.claimGeneration,
            phase: 'replacement_waiting_for_extension',
            checkpoint: checkpoint('replacement_waiting_for_extension', {
              reason: 'extension_disconnected',
              replacement_creation_attempts: attemptCount
            }),
            pauseCondition: 'extension_disconnected',
            reasonCode: 'EXTENSION_DISCONNECTED'
          });
          return;
        }
        attemptCount += 1;
        this.repositories.requests.recordCheckpoint({
          requestRef: ticket.requestRef,
          expectedClaimGeneration: ticket.claimGeneration,
          phase: attemptCount < 3 ? 'replacement_retry' : 'replacement_exhausted',
          checkpoint: checkpoint(attemptCount < 3 ? 'replacement_retry' : 'replacement_exhausted', {
            replacement_creation_attempts: attemptCount,
            last_error: error instanceof Error ? error.message : 'Replacement creation failed.'
          }),
          pauseCondition: null,
          reasonCode: attemptCount < 3 ? 'TAB_CREATION_RETRY' : 'TAB_CREATION_EXHAUSTED'
        });
      }
    }

    const currentWorkspace = this.repositories.logical.getWorkspace(workspace.workspaceRef);
    if (!currentWorkspace || currentWorkspace.lifecycle !== 'active') {
      return this.failTicket(ticket, problem('WORKSPACE_TERMINATED', 'The workspace ended during request resolution.', false, { workspace_ref: workspace.workspaceRef }));
    }
    const followers = this.repositories.requests.scanRequestRecovery().requests
      .filter((candidate) => candidate.toolName === 'send_cdp_command'
        && candidate.workspaceRef === target.workspaceRef
        && candidate.tabRef === target.tabRef
        && candidate.lanePosition !== null
        && target.lanePosition !== null
        && candidate.lanePosition > target.lanePosition
        && ['queued', 'running'].includes(candidate.state))
      .sort((left, right) => (left.lanePosition ?? 0) - (right.lanePosition ?? 0));
    const invalidatedRequestRefs = followers.map((candidate) => candidate.requestRef);
    const caller = this.sessionForTicket(ticket);
    const workspaceFact = this.workspaceFact(currentWorkspace, caller);
    const replacementFact = replacementTab === null ? null : this.tabFact(replacementTab, 'agent_created');
    const exhausted = replacementTab === null;
    const sharedFacts: JsonObject = {
      resolved_request_ref: target.requestRef,
      workspace: workspaceFact,
      workspace_active: true,
      original_request_state: 'failed',
      resolver_request_state: exhausted ? 'failed' : 'succeeded',
      old_tab_ref: oldTab.tabRef,
      effect_may_have_occurred: true,
      replacement_tab: replacementFact,
      old_tab_remains_managed: true,
      replacement_creation_attempts: exhausted ? 3 : attemptCount,
      reconciled_before_each_retry: true,
      invalidated_request_refs: invalidatedRequestRefs,
      ...(exhausted ? {
        queued_followers_failed: true,
        queued_followers_dispatched: false,
        queued_followers_retargeted: false
      } : {}),
      lane_released: true
    };
    const targetFailure: JsonObject = {
      tool: 'send_cdp_command',
      kind: 'human_resolution_restart_failed',
      problem: null,
      debugger_error: null,
      known_facts: sharedFacts
    };
    const resolverResult: JsonObject = exhausted
      ? {
          tool: 'resolve_browser_request',
          kind: 'human_resolution_restart_failed',
          problem: null,
          debugger_error: null,
          known_facts: sharedFacts
        }
      : {
          tool: 'resolve_browser_request',
          disposition: 'complete',
          facts: {
            resolved_request_ref: target.requestRef,
            workspace: workspaceFact,
            workspace_active: true,
            decision: 'restart_failed',
            resolved_request_state: 'failed',
            effect_may_have_occurred: true,
            old_tab_ref: oldTab.tabRef,
            replacement_tab: replacementFact,
            old_tab_remains_managed: true,
            replacement_creation_attempts: attemptCount,
            reconciled_before_each_retry: true,
            invalidated_request_refs: invalidatedRequestRefs,
            lane_released: true
          }
        };
    const resolved = this.repositories.transaction((repositories) => {
      if (!repositories.requests.resolveRequest({
        resolverRequestRef: ticket.requestRef,
        targetRequestRef: target.requestRef,
        targetState: 'failed',
        resolverState: exhausted ? 'failed' : 'succeeded',
        targetEffectMayHaveOccurred: true,
        targetResult: targetFailure,
        resolverResult
      })) return false;
      for (const follower of followers) {
        const followerFacts: JsonObject = {
          workspace: workspaceFact,
          workspace_active: true,
          old_tab_ref: oldTab.tabRef,
          replacement_tab: replacementFact,
          old_tab_remains_managed: true,
          dispatched: false,
          retargeted: false,
          lane_released: true
        };
        const terminal = repositories.requests.terminalizeRequest({
          requestRef: follower.requestRef,
          state: 'failed',
          phase: 'restart_failed_follower_invalidated',
          checkpoint: checkpoint('restart_failed_follower_invalidated', { resolved_request_ref: target.requestRef }),
          result: {
            tool: 'send_cdp_command',
            kind: 'restart_failed_follower_invalidated',
            problem: null,
            debugger_error: null,
            known_facts: followerFacts
          },
          reasonCode: 'RESTART_FAILED_FOLLOWER_INVALIDATED'
        });
        if (!terminal) throw new Error(`Failed to invalidate queued follower ${follower.requestRef}.`);
      }
      return true;
    });
    if (!resolved) {
      return this.failTicket(ticket, problem('REQUEST_RESOLUTION_RACE_LOST', 'Another resolver committed first.', false, { request_ref: targetRef }));
    }
  }

  private executeWorkspaceStop(ticket: StoredRequestTicket): void {
    const workspace = this.requireWorkspaceForTicket(ticket);
    const updated = this.repositories.logical.setWorkspacePauseCause({
      workspaceRef: workspace.workspaceRef,
      cause: 'manual_workspace_stop',
      sourceRequestRef: ticket.requestRef
    });
    this.succeedTicket(ticket, {
      tool: 'stop_workspace_automation', disposition: 'complete', facts: {
        workspace: this.workspaceFact(updated, this.sessionForTicket(ticket)),
        pause_reason: 'manual_workspace_stop'
      }
    });
  }

  private async executeWorkspaceResume(ticket: StoredRequestTicket): Promise<void> {
    const workspace = this.requireWorkspaceForTicket(ticket);
    const inventory = await this.requireExtensionPort().requestInventory(workspace.endpointRef, null);
    this.reconcileInventory(workspace.endpointRef, inventory);
    const updated = this.repositories.logical.clearWorkspacePauseCause({ workspaceRef: workspace.workspaceRef, cause: 'manual_workspace_stop' });
    this.resumeWorkspacePausedRequests(updated, 'manual_workspace_stop');
    this.succeedTicket(ticket, {
      tool: 'resume_workspace_automation', disposition: 'complete', facts: {
        workspace: this.workspaceFact(updated, this.sessionForTicket(ticket)),
        cleared_pause_reason: 'manual_workspace_stop', reconciled: true
      }
    });
  }

  private executeEndpointKill(ticket: StoredRequestTicket): void {
    const endpoint = this.requireEndpointForTicket(ticket);
    const workspaces = this.repositories.logical.listActiveWorkspaces({ endpointRef: endpoint.endpointRef })
      .map((workspace) => this.repositories.logical.setWorkspacePauseCause({
        workspaceRef: workspace.workspaceRef, cause: 'endpoint_killed', sourceRequestRef: ticket.requestRef
      }));
    this.succeedTicket(ticket, {
      tool: 'kill_browser_endpoint', disposition: 'complete', facts: {
        endpoint: this.endpointFact(endpoint, false, false),
        paused_workspaces: workspaces.map((workspace) => this.workspaceFact(workspace, this.sessionForTicket(ticket)))
      }
    });
  }

  private async executeEndpointResume(ticket: StoredRequestTicket): Promise<void> {
    const endpoint = this.requireEndpointForTicket(ticket);
    const inventory = await this.requireExtensionPort().requestInventory(endpoint.endpointRef, null);
    this.reconcileInventory(endpoint.endpointRef, inventory);
    const workspaces = this.repositories.logical.listActiveWorkspaces({ endpointRef: endpoint.endpointRef })
      .map((workspace) => this.repositories.logical.clearWorkspacePauseCause({ workspaceRef: workspace.workspaceRef, cause: 'endpoint_killed' }));
    for (const workspace of workspaces) this.resumeWorkspacePausedRequests(workspace, 'endpoint_killed');
    this.succeedTicket(ticket, {
      tool: 'resume_browser_endpoint', disposition: 'complete', facts: {
        endpoint: this.endpointFact(endpoint, false, false),
        reconciled_workspaces: workspaces.map((workspace) => this.workspaceFact(workspace, this.sessionForTicket(ticket)))
      }
    });
  }

  private contextFacts(kind: string, view: JsonObject, caller: StoredCallerSession): JsonObject {
    if (kind === 'broker') return { view_kind: 'broker', broker: { condition: 'ready', observed_at: new Date().toISOString() } };
    if (kind === 'endpoints') {
      const endpoints = this.repositories.logical.listEndpoints({ limit: 200 }).items;
      const conditions = Array.isArray(view.conditions) ? view.conditions : [];
      const filtered = conditions.length > 0
        ? endpoints.filter((endpoint) => conditions.includes(this.endpointFact(endpoint, false).condition))
        : endpoints;
      const page = this.paginate(filtered, view, caller, 'endpoints', (endpoint) => endpoint.endpointRef);
      return { view_kind: 'endpoints', endpoints: page.items.map((endpoint) => this.endpointFact(endpoint, false)), page: page.fact };
    }
    if (kind === 'endpoint') {
      const nickname = asString(view.endpoint_nickname, 'endpoint_nickname');
      const endpoint = this.repositories.logical.getEndpointByNickname(nickname);
      if (!endpoint) throw new OctopusBrokerError(problem('ENDPOINT_NOT_FOUND', `No endpoint is named ${nickname}.`, false, { endpoint_nickname: nickname }));
      const connection = this.repositories.logical.getCurrentConnection(endpoint.endpointRef);
      return {
        view_kind: 'endpoint', endpoint: this.endpointFact(endpoint, false),
        extension: {
          extension_ref: endpoint.endpointRef, endpoint_nickname: endpoint.nickname,
          connection_condition: connection ? 'connected' : 'disconnected',
          extension_version: connection?.extensionVersion ?? null,
          protocol_version: connection?.protocolVersion ?? null,
          last_seen_at: connection?.connectedAt ?? endpoint.updatedAt,
          browser_ref: connection ? browserRefFor(endpoint.endpointRef) : null
        },
        browser: connection ? {
          browser_ref: browserRefFor(endpoint.endpointRef), extension_ref: endpoint.endpointRef, endpoint_nickname: endpoint.nickname,
          process_condition: 'running', reported_product: connection.browserProduct, reported_version: connection.browserVersion,
          reported_platform: null, observed_at: connection.connectedAt
        } : null
      };
    }
    if (kind === 'windows') {
      const nickname = asString(view.endpoint_nickname, 'endpoint_nickname');
      const endpoint = this.repositories.logical.getEndpointByNickname(nickname);
      if (!endpoint) throw new OctopusBrokerError(problem('ENDPOINT_NOT_FOUND', `No endpoint is named ${nickname}.`, false, { endpoint_nickname: nickname }));
      const connection = this.repositories.logical.getCurrentConnection(endpoint.endpointRef);
      const windows = this.repositories.logical.listWindows(endpoint.endpointRef)
        .filter((window) => connection !== null && this.locatorUsesConnection(window.privateWindowKey, connection.connectionGeneration))
        .filter((window) => view.eligible_only !== true || window.eligible);
      const page = this.paginate(windows, view, caller, `windows:${endpoint.endpointRef}`, (window) => window.windowRef);
      return { view_kind: 'windows', endpoint_nickname: nickname, windows: page.items.map((window) => this.windowFact(window)), page: page.fact };
    }
    if (kind === 'window') {
      const windowRef = asString(view.window_ref, 'window_ref');
      const window = this.repositories.logical.getWindow(windowRef);
      if (!window) throw new OctopusBrokerError(problem('WINDOW_NOT_FOUND', 'The window does not exist.', false, { window_ref: windowRef }));
      const workspaces = this.repositories.logical.listActiveWorkspaces({ endpointRef: window.endpointRef })
        .filter((workspace) => workspace.windowRef === windowRef && (workspace.ownerSessionRef === caller.sessionRef || workspace.lineageRef === caller.lineageRef));
      const page = this.paginate(workspaces, view, caller, `window:${windowRef}`, (workspace) => workspace.workspaceRef);
      return { view_kind: 'window', window: this.windowFact(window), workspaces: page.items.map((workspace) => this.workspaceFact(workspace, caller)), page: page.fact };
    }
    if (kind === 'capabilities') {
      const nickname = asString(view.endpoint_nickname, 'endpoint_nickname');
      const endpoint = this.repositories.logical.getEndpointByNickname(nickname);
      if (!endpoint) throw new OctopusBrokerError(problem('ENDPOINT_NOT_FOUND', `No endpoint is named ${nickname}.`, false, { endpoint_nickname: nickname }));
      const prefix = typeof view.method_prefix === 'string' ? view.method_prefix : '';
      const selection = this.repositories.logical.getCurrentCapability(endpoint.endpointRef);
      const methods = (selection?.methods ?? CONSERVATIVE_CAPABILITY_MANIFEST.cdpMethods.map(({ method }) => method))
        .filter((method) => method.startsWith(prefix));
      const page = this.paginate(methods, view, caller, `capabilities:${endpoint.endpointRef}:${prefix}`, (method) => method);
      return {
        view_kind: 'capabilities', endpoint_nickname: nickname,
        window_ref: typeof view.window_ref === 'string' ? view.window_ref : null,
        capabilities: page.items.map((method) => ({
          method,
          available: this.isEndpointReady(endpoint.endpointRef),
          reason: this.isEndpointReady(endpoint.endpointRef) ? null
            : this.isEndpointConnected(endpoint.endpointRef) ? 'endpoint_reconciling' : 'endpoint_offline',
          observed_at: selection?.selectedAt ?? endpoint.updatedAt
        })),
        page: page.fact
      };
    }
    if (kind === 'workspaces') {
      const parent = typeof view.parent_workspace_ref === 'string' ? view.parent_workspace_ref : null;
      const workspaces = this.repositories.logical.listActiveWorkspaces()
        .filter((workspace) => (workspace.ownerSessionRef === caller.sessionRef || workspace.lineageRef === caller.lineageRef)
          && workspace.parentWorkspaceRef === parent);
      const page = this.paginate(workspaces, view, caller, `workspaces:${parent ?? ''}`, (workspace) => workspace.workspaceRef);
      return { view_kind: 'workspaces', workspaces: page.items.map((workspace) => this.workspaceFact(workspace, caller)), page: page.fact };
    }
    if (kind === 'workspace') {
      const workspace = this.requireOwnedWorkspace(caller, asString(view.workspace_ref, 'workspace_ref'));
      const tabs = this.repositories.logical.listWorkspaceTabs(workspace.workspaceRef).filter((tab) => tab.lifecycle === 'active');
      const page = this.paginate(tabs, view, caller, `workspace:${workspace.workspaceRef}`, (tab) => tab.tabRef);
      const children = this.repositories.logical.listActiveWorkspaces().filter((child) => child.parentWorkspaceRef === workspace.workspaceRef);
      return {
        view_kind: 'workspace', workspace: this.workspaceFact(workspace, caller),
        tabs: page.items.map((tab) => this.tabFact(tab, tab.openerTabRef ? 'same_window_child' : 'agent_created')),
        related_child_workspaces: children.map((child) => this.workspaceFact(child, caller)), page: page.fact
      };
    }
    if (kind === 'workspace_requests') {
      const workspace = this.requireOwnedWorkspace(caller, asString(view.workspace_ref, 'workspace_ref'));
      const states = Array.isArray(view.states) ? view.states.filter((state): state is string => typeof state === 'string') : [];
      const requests = this.repositories.requests.listVisibleRequests({
        authorityLineageRef: caller.lineageRef, authoritySessionRef: caller.sessionRef, workspaceRef: workspace.workspaceRef,
        includeTerminal: true, page: { limit: 200 }
      }).items.filter((ticket) => states.includes(ticket.state) && !['request_browser_workspace', 'take_over_workspace', 'kill_browser_endpoint', 'resume_browser_endpoint'].includes(ticket.toolName));
      const page = this.paginate(requests, view, caller, `workspace_requests:${workspace.workspaceRef}:${states.join(',')}:${workspace.ownerEpoch}`, (request) => request.requestRef);
      return {
        view_kind: 'workspace_requests', workspace_ref: workspace.workspaceRef,
        requests: page.items.map((request) => ({
          workspace_ref: workspace.workspaceRef, request_ref: request.requestRef, tool: request.toolName,
          state: request.state, pause_condition: request.pauseCondition === null ? null : { reason: request.pauseCondition, paused_at: request.updatedAt },
          submitted_at: request.acceptedAt, updated_at: request.updatedAt
        })), page: page.fact
      };
    }
    throw new TypeError(`Unsupported context view: ${kind}`);
  }

  private paginate<T>(
    items: T[],
    view: JsonObject,
    caller: StoredCallerSession,
    query: string,
    key: (item: T) => string
  ): { items: T[]; fact: JsonObject } {
    const limit = this.pageSize(view.page_size);
    let after = '';
    if (typeof view.cursor === 'string') {
      const entry = this.cursors.get(view.cursor);
      if (!entry || entry.callerSessionRef !== caller.sessionRef || entry.query !== query) {
        throw new OctopusBrokerError(problem('CURSOR_INVALID', 'The pagination cursor does not match this query.'));
      }
      after = entry.after;
    }
    const ordered = [...items].sort((left, right) => key(left).localeCompare(key(right)));
    const start = after === '' ? 0 : Math.max(0, ordered.findIndex((item) => key(item) === after) + 1);
    const pageItems = ordered.slice(start, start + limit);
    const hasMore = start + pageItems.length < ordered.length;
    let nextCursor: string | null = null;
    if (hasMore && pageItems.length > 0) {
      nextCursor = this.references.issue('cursor');
      this.cursors.set(nextCursor, { callerSessionRef: caller.sessionRef, query, after: key(pageItems.at(-1)!) });
    }
    return { items: pageItems, fact: { returned_count: pageItems.length, next_cursor: nextCursor } };
  }

  private pageSize(value: unknown): number {
    const pageSize = Number(value);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > this.maxPageSize) {
      throw new TypeError(`page_size must be between 1 and ${this.maxPageSize}.`);
    }
    return pageSize;
  }

  private reconcileInventory(
    endpointRef: string,
    payload: RelayV2PayloadByType['INVENTORY_SNAPSHOT'],
    resetEventStreams = false
  ): boolean {
    const connection = this.repositories.logical.getCurrentConnection(endpointRef);
    if (!connection || connection.connectionGeneration !== payload.connectionGeneration) return false;
    const existingWindows = this.repositories.logical.listWindows(endpointRef);
    const windowsByBrowserId = new Map<number, StoredLogicalWindow>();
    for (const rawWindow of payload.windows) {
      const privateKey = JSON.stringify({
        windowId: rawWindow.windowId,
        windowGeneration: rawWindow.windowGeneration,
        connectionGeneration: payload.connectionGeneration
      });
      const existing = existingWindows.find((window) => {
        try { return Number(parsePrivate<JsonObject>(window.privateWindowKey, 'window').windowId) === rawWindow.windowId; }
        catch { return false; }
      });
      const stored = this.repositories.logical.upsertWindow({
        windowRef: existing?.windowRef ?? this.references.issue('window'),
        endpointRef,
        privateWindowKey: privateKey,
        locatorGeneration: rawWindow.windowGeneration,
        focused: rawWindow.focused,
        eligible: rawWindow.type === 'normal',
        observedAt: payload.capturedAt
      });
      windowsByBrowserId.set(rawWindow.windowId, stored);
    }
    this.repositories.logical.markMissingWindows({
      endpointRef,
      observedWindowRefs: [...windowsByBrowserId.values()].map((window) => window.windowRef),
      at: payload.capturedAt
    });

    for (const workspaceSnapshot of this.repositories.logical.listActiveWorkspaces({ endpointRef })) {
      if (!workspaceSnapshot.privateGroupKey) continue;
      const priorGroup = parsePrivate<JsonObject>(workspaceSnapshot.privateGroupKey, 'group');
      const groupId = Number(priorGroup.tabGroupId);
      const rawWindow = payload.windows.find((candidate) => candidate.groups.some((group) => group.tabGroupId === groupId));
      const rawGroup = rawWindow?.groups.find((group) => group.tabGroupId === groupId);
      const logicalWindow = rawWindow ? windowsByBrowserId.get(rawWindow.windowId) : undefined;
      if (!rawWindow || !rawGroup || !logicalWindow) {
        this.repositories.logical.setWorkspacePauseCause({
          workspaceRef: workspaceSnapshot.workspaceRef,
          cause: 'workspace_missing_after_reconnect',
          at: payload.capturedAt
        });
        continue;
      }

      let workspace = this.repositories.logical.updateWorkspaceLocator({
        workspaceRef: workspaceSnapshot.workspaceRef,
        expectedLocatorGeneration: workspaceSnapshot.locatorGeneration,
        privateGroupKey: JSON.stringify({
          tabGroupId: rawGroup.tabGroupId,
          groupGeneration: rawGroup.groupGeneration,
          windowId: rawWindow.windowId,
          windowGeneration: rawWindow.windowGeneration,
          connectionGeneration: payload.connectionGeneration
        }),
        newLocatorGeneration: rawGroup.groupGeneration,
        at: payload.capturedAt
      }) ?? this.repositories.logical.getWorkspace(workspaceSnapshot.workspaceRef);
      if (!workspace) continue;
      workspace = this.repositories.logical.clearWorkspacePauseCause({
        workspaceRef: workspace.workspaceRef,
        cause: 'workspace_missing_after_reconnect',
        at: payload.capturedAt
      });

      const liveTabs = rawWindow.tabs.filter((tab) => tab.groupId === rawGroup.tabGroupId);
      const existingTabs = this.repositories.logical.listWorkspaceTabs(workspace.workspaceRef);
      const existingByBrowserId = new Map<number, StoredManagedTab>();
      for (const tab of existingTabs) {
        try {
          existingByBrowserId.set(Number(parsePrivate<JsonObject>(tab.privateTabKey, 'tab').tabId), tab);
        } catch {
          // An unreadable stale locator cannot be trusted as an identity match.
        }
      }
      const reconciledByBrowserId = new Map<number, StoredManagedTab>();
      for (const rawTab of liveTabs) {
        const existing = existingByBrowserId.get(rawTab.tabId);
        if (!existing) continue;
        const updated = this.repositories.logical.updateTab({
          workspaceRef: workspace.workspaceRef,
          tabRef: existing.tabRef,
          expectedLocatorGeneration: existing.locatorGeneration,
          privateTabKey: JSON.stringify({
            tabId: rawTab.tabId,
            tabGeneration: rawTab.tabGeneration,
            windowId: rawWindow.windowId,
            windowGeneration: rawWindow.windowGeneration,
            connectionGeneration: payload.connectionGeneration
          }),
          newLocatorGeneration: rawTab.tabGeneration,
          attachmentGeneration: rawTab.debugger.attachmentGeneration ?? 0,
          lifecycle: 'active',
          title: rawTab.title,
          url: rawTab.url,
          observedAt: payload.capturedAt
        });
        if (updated) reconciledByBrowserId.set(rawTab.tabId, updated);
      }
      for (const existing of existingTabs) {
        const browserId = [...existingByBrowserId.entries()].find(([, candidate]) => candidate.tabRef === existing.tabRef)?.[0];
        if (browserId !== undefined && !liveTabs.some((tab) => tab.tabId === browserId) && existing.lifecycle === 'active') {
          this.repositories.logical.updateTab({
            workspaceRef: workspace.workspaceRef,
            tabRef: existing.tabRef,
            expectedLocatorGeneration: existing.locatorGeneration,
            lifecycle: 'closed',
            observedAt: payload.capturedAt
          });
        }
      }
      for (const rawTab of liveTabs) {
        if (reconciledByBrowserId.has(rawTab.tabId)) continue;
        const opener = rawTab.openerTabId === null ? null : reconciledByBrowserId.get(rawTab.openerTabId) ?? existingByBrowserId.get(rawTab.openerTabId) ?? null;
        const adopted = this.repositories.logical.addTab({
          tabRef: this.references.issue('tab'),
          workspaceRef: workspace.workspaceRef,
          endpointRef,
          windowRef: logicalWindow.windowRef,
          ...(opener === null ? {} : { openerTabRef: opener.tabRef }),
          privateTabKey: JSON.stringify({
            tabId: rawTab.tabId,
            tabGeneration: rawTab.tabGeneration,
            windowId: rawWindow.windowId,
            windowGeneration: rawWindow.windowGeneration,
            connectionGeneration: payload.connectionGeneration
          }),
          locatorGeneration: rawTab.tabGeneration,
          attachmentGeneration: rawTab.debugger.attachmentGeneration ?? 0,
          title: rawTab.title ?? '',
          url: rawTab.url ?? '',
          observedAt: payload.capturedAt
        });
        reconciledByBrowserId.set(rawTab.tabId, adopted);
      }
      for (const tab of reconciledByBrowserId.values()) {
        this.reconcileEventStream(tab, workspace, resetEventStreams, payload.capturedAt);
      }
    }
    return true;
  }

  private reconcileEventStream(tab: StoredManagedTab, workspace: StoredWorkspace, reset: boolean, observedAt: string): void {
    const existing = this.repositories.events.scanEventRecovery().streams
      .find((stream) => stream.tabRef === tab.tabRef && stream.state === 'active');
    if (!existing) {
      this.createEventStream(tab, workspace);
      return;
    }
    if (!reset) return;
    this.repositories.events.replaceStreamBaseline({
      tabRef: tab.tabRef,
      streamRef: `stream_${randomUUID()}`,
      initialCursorRef: this.references.issue('cursor'),
      queryHash: JSON.stringify({ workspaceRef: workspace.workspaceRef, tabRef: tab.tabRef }),
      ownerEpoch: workspace.ownerEpoch,
      baseline: { title: tab.title ?? '', url: tab.url ?? '', observed_at: observedAt },
      at: observedAt
    });
  }

  private mostRecentWindow(endpointRef: string): StoredLogicalWindow | null {
    if (this.profileManager?.blocksEndpoint(endpointRef)) return null;
    const connection = this.repositories.logical.getCurrentConnection(endpointRef);
    if (!connection) return null;
    const eligible = this.repositories.logical.listWindows(endpointRef)
      .filter((window) => window.eligible && this.locatorUsesConnection(window.privateWindowKey, connection.connectionGeneration));
    if (eligible.length === 1) return eligible[0] ?? null;
    return eligible
      .filter((window) => window.lastFocusedAt !== null)
      .sort((left, right) => right.lastFocusedAt!.localeCompare(left.lastFocusedAt!))[0] ?? null;
  }

  private createEventStream(tab: StoredManagedTab, workspace: StoredWorkspace): void {
    const existing = this.repositories.events.scanEventRecovery().streams.find((stream) => stream.tabRef === tab.tabRef && stream.state === 'active');
    if (existing) return;
    this.repositories.events.createStream({
      streamRef: `stream_${randomUUID()}`,
      tabRef: tab.tabRef,
      initialCursorRef: this.references.issue('cursor'),
      queryHash: JSON.stringify({ workspaceRef: workspace.workspaceRef, tabRef: tab.tabRef }),
      ownerEpoch: workspace.ownerEpoch,
      baseline: { title: tab.title ?? '', url: tab.url ?? '', observed_at: tab.lastObservedAt }
    });
  }

  private activeStream(tabRef: string) {
    const stream = this.repositories.events.scanEventRecovery().streams.find((candidate) => candidate.tabRef === tabRef && candidate.state === 'active');
    if (!stream) throw new Error('The tab event stream is missing.');
    return stream;
  }

  private workspaceFact(workspace: StoredWorkspace, caller: StoredCallerSession): JsonObject {
    const endpoint = this.repositories.logical.getEndpoint(workspace.endpointRef);
    const tabs = this.repositories.logical.listWorkspaceTabs(workspace.workspaceRef).filter((tab) => tab.lifecycle === 'active');
    const connection = this.repositories.logical.getCurrentConnection(workspace.endpointRef);
    const condition = workspace.lifecycle === 'ended' ? 'terminated'
      : workspace.pauseCauses.length > 0 ? 'paused'
        : connection ? 'ready' : 'unavailable';
    return {
      workspace_ref: workspace.workspaceRef,
      endpoint_nickname: endpoint?.nickname ?? 'unknown-endpoint',
      window_ref: workspace.windowRef,
      parent_workspace_ref: workspace.parentWorkspaceRef,
      condition,
      automation_pause_reasons: workspace.pauseCauses.filter((cause) => cause === 'manual_workspace_stop' || cause === 'endpoint_killed'),
      owner_session_ref: workspace.ownerSessionRef,
      lineage_ref: workspace.lineageRef,
      caller_relationship: workspace.ownerSessionRef === caller.sessionRef ? 'owner' : workspace.lineageRef === caller.lineageRef ? 'lineage_member' : 'none',
      tab_count: tabs.length,
      updated_at: workspace.updatedAt
    };
  }

  private tabFact(tab: StoredManagedTab, adoptionSource: 'workspace_initial' | 'agent_created' | 'same_window_child' | 'new_window_child'): JsonObject {
    return {
      workspace_ref: tab.workspaceRef,
      tab_ref: tab.tabRef,
      window_ref: tab.windowRef,
      adoption_source: adoptionSource,
      title: tab.title ?? '',
      url: tab.url ?? '',
      active: tab.lifecycle === 'active',
      initial_event_cursor: this.activeStream(tab.tabRef).initialCursorRef
    };
  }

  private windowFact(window: StoredLogicalWindow): JsonObject {
    const endpoint = this.repositories.logical.getEndpoint(window.endpointRef);
    return {
      window_ref: window.windowRef,
      endpoint_nickname: endpoint?.nickname ?? 'unknown-endpoint',
      eligible_for_workspace: window.eligible,
      eligibility_reason: window.eligible ? null : 'window_not_eligible',
      last_focused_at: window.lastFocusedAt,
      observed_at: window.lastObservedAt
    };
  }

  private endpointFact(endpoint: StoredEndpoint, frozen: boolean, includeActiveControl = true): JsonObject {
    const connection = this.repositories.logical.getCurrentConnection(endpoint.endpointRef);
    const kill = this.repositories.logical.getEndpointKillState(endpoint.endpointRef);
    const activeControl = this.repositories.logical.getActiveEndpointControl(endpoint.endpointRef);
    return {
      endpoint_nickname: endpoint.nickname,
      extension_ref: endpoint.endpointRef,
      browser_ref: connection ? browserRefFor(endpoint.endpointRef) : null,
      condition: connection ? (this.isEndpointReady(endpoint.endpointRef) ? 'usable' : 'busy') : 'offline',
      killed: kill.killed,
      workspace_ownership_frozen: frozen || (includeActiveControl
        && (activeControl?.kind === 'endpoint_kill' || activeControl?.kind === 'endpoint_resume')),
      observed_at: connection?.connectedAt ?? endpoint.updatedAt
    };
  }

  private sessionForTicket(ticket: StoredRequestTicket): StoredCallerSession {
    const session = this.repositories.logical.scanLogicalRecovery().activeSessions
      .find((candidate) => candidate.sessionRef === ticket.requesterSessionRef);
    if (!session) throw new Error('Request caller session is unavailable.');
    return session;
  }

  private requestArguments(ticket: StoredRequestTicket): JsonObject {
    const body = ticket.normalizedBody;
    return isObject(body.arguments) ? body.arguments : {};
  }

  private requireWorkspaceForTicket(ticket: StoredRequestTicket): StoredWorkspace {
    if (!ticket.workspaceRef) throw new Error('Request is missing workspace scope.');
    const workspace = this.repositories.logical.getWorkspace(ticket.workspaceRef);
    if (!workspace) throw new Error('Request workspace no longer exists.');
    return workspace;
  }

  private requireEndpointForTicket(ticket: StoredRequestTicket): StoredEndpoint {
    if (!ticket.endpointRef) throw new Error('Request is missing endpoint scope.');
    const endpoint = this.repositories.logical.getEndpoint(ticket.endpointRef);
    if (!endpoint) throw new Error('Request endpoint no longer exists.');
    return endpoint;
  }

  private requireConnection(endpointRef: string) {
    const connection = this.repositories.logical.getCurrentConnection(endpointRef);
    if (!connection) throw new OctopusBrokerError(problem('ENDPOINT_UNAVAILABLE', 'The extension endpoint is disconnected.', true));
    const extensionConnection = this.extensionPort?.connection(endpointRef);
    if (this.pendingEndpointReconciliation.has(endpointRef)) {
      throw new OctopusBrokerError(problem('ENDPOINT_UNAVAILABLE', 'The extension endpoint is reconciling its browser inventory.', true));
    }
    if (extensionConnection && (!extensionConnection.connected
      || extensionConnection.connectionGeneration !== connection.connectionGeneration)) {
      throw new OctopusBrokerError(problem('ENDPOINT_UNAVAILABLE', 'The extension transport connection generation is not current.', true));
    }
    return connection;
  }

  private requireExtensionConnection(endpointRef: string) {
    const connection = this.requireExtensionPort().connection(endpointRef);
    if (!connection?.connected) throw new OctopusBrokerError(problem('ENDPOINT_UNAVAILABLE', 'The extension transport is disconnected.', true));
    return connection;
  }

  private requireExtensionPort(): OctopusExtensionPort {
    if (!this.extensionPort) throw new OctopusBrokerError(problem('BROKER_NOT_READY', 'The extension gateway is not ready.', true));
    return this.extensionPort;
  }

  private isEndpointConnected(endpointRef: string): boolean {
    const connection = this.repositories.logical.getCurrentConnection(endpointRef);
    if (!connection) return false;
    if (this.extensionPort === null) return true;
    const extensionConnection = this.extensionPort.connection(endpointRef);
    return extensionConnection?.connected === true
      && extensionConnection.connectionGeneration === connection.connectionGeneration;
  }

  private isEndpointReady(endpointRef: string): boolean {
    return this.isEndpointConnected(endpointRef) && !this.pendingEndpointReconciliation.has(endpointRef);
  }

  private locatorUsesConnection(privateKey: string, connectionGeneration: number): boolean {
    try {
      return Number(parsePrivate<JsonObject>(privateKey, 'browser').connectionGeneration) === connectionGeneration;
    } catch {
      return false;
    }
  }

  private async extensionOperation<Type extends Parameters<OctopusExtensionPort['execute']>[1]>(
    endpointRef: string,
    type: Type,
    payload: RelayV2PayloadByType[Type]
  ): Promise<RelayV2PayloadByType['OPERATION_RESULT']> {
    const result = await this.requireExtensionPort().execute(endpointRef, type, payload);
    if (result.outcome === 'failed') {
      throw new OctopusBrokerError(problem('CDP_TRANSPORT_UNAVAILABLE', result.error?.message ?? `${type} failed.`, false));
    }
    return result;
  }

  private resultObject(result: RelayV2PayloadByType['OPERATION_RESULT'], operation: string): JsonObject {
    if (result.outcome !== 'succeeded' || !isObject(result.result)) throw new Error(`${operation} did not return a successful result.`);
    return result.result;
  }

  private windowLocator(value: JsonObject): JsonObject {
    return {
      windowId: Number(value.windowId),
      windowGeneration: Number(value.windowGeneration)
    };
  }

  private tabLocator(value: JsonObject): JsonObject {
    return {
      tabId: Number(value.tabId), tabGeneration: Number(value.tabGeneration),
      windowId: Number(value.windowId), windowGeneration: Number(value.windowGeneration)
    };
  }

  private groupLocator(value: JsonObject): JsonObject {
    return {
      tabGroupId: Number(value.tabGroupId), groupGeneration: Number(value.groupGeneration),
      windowId: Number(value.windowId), windowGeneration: Number(value.windowGeneration)
    };
  }

  private assertCurrentLocator(value: JsonObject, connectionGeneration: number, kind: string): void {
    if (Number(value.connectionGeneration) !== connectionGeneration) {
      throw new OctopusBrokerError(problem('ENDPOINT_UNAVAILABLE', `The ${kind} locator belongs to an earlier browser connection and must be reconciled.`, true));
    }
  }

  private findTabByPrivateId(endpointRef: string, tabId: number): StoredManagedTab | null {
    return this.repositories.logical.scanLogicalRecovery().activeTabs.find((tab) => {
      if (tab.endpointRef !== endpointRef) return false;
      try { return Number(parsePrivate<JsonObject>(tab.privateTabKey, 'tab').tabId) === tabId; }
      catch { return false; }
    }) ?? null;
  }

  private succeedTicket(ticket: StoredRequestTicket, result: JsonObject): void {
    this.repositories.transaction(({ requests, logical }) => {
      const terminal = requests.terminalizeRequest({
        requestRef: ticket.requestRef,
        expectedClaimGeneration: ticket.claimGeneration,
        state: 'succeeded',
        phase: 'completed',
        checkpoint: checkpoint('completed'),
        result,
        reasonCode: 'SUCCEEDED'
      });
      if (!terminal) return;
      const active = logical.scanLogicalRecovery().activeControls.find((control) => control.requestRef === ticket.requestRef);
      if (active) logical.finishControl({ controlRef: active.controlRef, state: 'succeeded' });
    });
  }

  private failTicket(ticket: StoredRequestTicket, failureProblem: PublicProblem | null, exactFailure?: JsonObject): void {
    const checkpointDetails = isObject(ticket.checkpoint.details) ? ticket.checkpoint.details : {};
    const createdWorkspaces = Array.isArray(checkpointDetails.created_workspaces)
      ? checkpointDetails.created_workspaces.filter(isObject)
      : [];
    const publicFailure = exactFailure ?? {
      tool: ticket.toolName,
      kind: 'octopus_problem',
      problem: failureProblem ?? problem('INTERNAL_ERROR', 'The request failed.'),
      debugger_error: null,
      known_facts: ticket.toolName === 'request_browser_workspace' ? { created_workspaces: createdWorkspaces } : null
    };
    this.repositories.transaction(({ requests, logical }) => {
      const terminal = requests.terminalizeRequest({
        requestRef: ticket.requestRef,
        expectedClaimGeneration: ticket.claimGeneration,
        state: 'failed',
        phase: 'failed',
        checkpoint: checkpoint('failed'),
        ...(failureProblem === null ? {} : { problem: { ...failureProblem } }),
        result: publicFailure,
        reasonCode: failureProblem?.code ?? 'FAILED'
      });
      if (!terminal) return;
      const active = logical.scanLogicalRecovery().activeControls.find((control) => control.requestRef === ticket.requestRef);
      if (active) logical.finishControl({ controlRef: active.controlRef, state: 'failed' });
    });
  }

  private pauseTicket(ticket: StoredRequestTicket, pauseCondition: string): void {
    const priorDetails = isObject(ticket.checkpoint.details) ? ticket.checkpoint.details : {};
    this.repositories.requests.recordCheckpoint({
      requestRef: ticket.requestRef,
      expectedClaimGeneration: ticket.claimGeneration,
      phase: 'paused',
      checkpoint: checkpoint('paused', { ...priorDetails, reason: pauseCondition }),
      pauseCondition,
      reasonCode: pauseCondition.toUpperCase()
    });
  }

  private replacementAttemptCount(ticket: StoredRequestTicket): number {
    const details = isObject(ticket.checkpoint.details) ? ticket.checkpoint.details : {};
    const value = Number(details.replacement_creation_attempts ?? 0);
    return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0;
  }

  private pauseEndpointRequests(endpointRef: string, pauseCondition: string): void {
    for (const ticket of this.repositories.requests.scanRequestRecovery().requests) {
      if (this.executionEndpointRef(ticket) === endpointRef && ticket.state === 'running') this.pauseTicket(ticket, pauseCondition);
    }
  }

  private resumeEndpointPausedRequests(endpointRef: string, clearedCondition: string): void {
    for (const ticket of this.repositories.requests.scanRequestRecovery().requests) {
      if (this.executionEndpointRef(ticket) !== endpointRef || ticket.pauseCondition !== clearedCondition
        || !['queued', 'running'].includes(ticket.state)) continue;
      const workspace = ticket.workspaceRef === null ? null : this.repositories.logical.getWorkspace(ticket.workspaceRef);
      const remaining = workspace?.pauseCauses.includes('endpoint_killed') ? 'endpoint_killed'
        : workspace?.pauseCauses.includes('manual_workspace_stop') ? 'manual_workspace_stop'
          : null;
      const priorDetails = isObject(ticket.checkpoint.details) ? ticket.checkpoint.details : {};
      this.repositories.requests.recordCheckpoint({
        requestRef: ticket.requestRef,
        expectedClaimGeneration: ticket.claimGeneration,
        phase: remaining === null ? 'resuming' : 'paused',
        checkpoint: checkpoint(remaining === null ? 'resuming' : 'paused', {
          ...priorDetails,
          ...(remaining === null ? {} : { reason: remaining })
        }),
        pauseCondition: remaining,
        reasonCode: remaining === null ? 'RESUMED_AFTER_RECONNECT' : remaining.toUpperCase()
      });
    }
  }

  private executionEndpointRef(ticket: StoredRequestTicket): string | null {
    if (ticket.endpointRef !== null) return ticket.endpointRef;
    const details = isObject(ticket.checkpoint.details) ? ticket.checkpoint.details : {};
    return typeof details.current_endpoint_ref === 'string' ? details.current_endpoint_ref : null;
  }

  private resumeWorkspacePausedRequests(workspace: StoredWorkspace, clearedCondition: string): void {
    for (const ticket of this.repositories.requests.scanRequestRecovery().requests) {
      if (ticket.workspaceRef !== workspace.workspaceRef || ticket.pauseCondition !== clearedCondition
        || !['queued', 'running'].includes(ticket.state)) continue;
      const remaining = workspace.pauseCauses.includes('endpoint_killed') ? 'endpoint_killed'
        : workspace.pauseCauses.includes('manual_workspace_stop') ? 'manual_workspace_stop'
          : null;
      const priorDetails = isObject(ticket.checkpoint.details) ? ticket.checkpoint.details : {};
      this.repositories.requests.recordCheckpoint({
        requestRef: ticket.requestRef,
        expectedClaimGeneration: ticket.claimGeneration,
        phase: remaining === null ? 'resuming' : 'paused',
        checkpoint: checkpoint(remaining === null ? 'resuming' : 'paused', {
          ...priorDetails,
          ...(remaining === null ? {} : { reason: remaining })
        }),
        pauseCondition: remaining,
        reasonCode: remaining === null ? 'RESUMED_AFTER_CONTROL' : remaining.toUpperCase()
      });
    }
    this.pump();
  }

  private pauseTabRequests(workspaceRef: string, tabRef: string, pauseCondition: string): void {
    for (const ticket of this.repositories.requests.scanRequestRecovery().requests) {
      if (ticket.workspaceRef === workspaceRef && ticket.tabRef === tabRef && ticket.state === 'running') this.pauseTicket(ticket, pauseCondition);
    }
  }

  private publicProblem(error: unknown): PublicProblem {
    if (error instanceof OctopusBrokerError) return error.problem;
    if (error instanceof ProfileError && (PublicProblemCodes as readonly string[]).includes(error.code)) return problem(error.code as PublicProblem['code'], error.code);
    return problem('INTERNAL_ERROR', error instanceof Error ? error.message : 'Unexpected broker error.', false);
  }
}
