import type {
  AgentPrincipal,
  BrokerCommand,
  BrokerResult,
  CommandState,
  RoutingDecision
} from '../../../shared/protocol/src/index.js';

export interface StoredTarget {
  targetId: string;
  alias: string;
  publicKeyJwk: JsonWebKey;
  capabilities: string[];
  revoked: boolean;
  consecutiveFailures: number;
  lastSeenAt: string | null;
  lastErrorAt: string | null;
  statusVersion: number;
}

export interface StoredBinding {
  bindingId: string;
  bindingRef: string;
  principalId: string;
  targetId: string;
  targetAlias: string;
  mode: 'dedicated';
  createdAt: string;
  revokedAt: string | null;
}

export interface StoredLease {
  leaseId: string;
  targetId: string;
  principalId: string;
  fencingToken: number;
  expiresAt: string;
  releasedAt: string | null;
}

export interface ResolvedSession extends StoredLease {
  alias: string;
  sessionExpiresAt: string;
}

export interface StoredCommand extends BrokerCommand {
  state: CommandState;
  decision: RoutingDecision;
  idempotencyKey: string | null;
  deliveredEpoch: number | null;
  createdAt: string;
  updatedAt: string;
  targetAlias: string;
  result?: BrokerResult;
}

export interface StoredTraceEvent {
  runId: string;
  requestId: string;
  commandId: string | null;
  targetAlias: string | null;
  bindingRef: string | null;
  principalId: string;
  stage: 'MCP_ACCEPT' | 'BINDING_VALIDATED' | 'POLICY_DECISION' | 'COMMAND_COMMIT' | 'WS_SEND' | 'EXT_ACK' | 'EXT_RESULT' | 'MCP_OBSERVED';
  connectionEpoch: number | null;
  outcomeCode: string | null;
  observedAt: string;
}

export interface LeaseGrant {
  lease: StoredLease;
  sessionHandle: string;
}

export interface CreateCommandInput {
  command: BrokerCommand;
  decision: RoutingDecision;
  idempotencyKey?: string;
  initialState: Extract<CommandState, 'QUEUED' | 'REJECTED'>;
}

export interface RelayRepositories {
  close(): void;
  createAgent(displayName: string, scopes: string[], token?: string): { principal: AgentPrincipal; token: string };
  authenticateAgent(token: string): AgentPrincipal | null;
  getAgentById(principalId: string): AgentPrincipal | null;
  createPairingCode(alias: string, expiresAt: string): string;
  consumePairingCode(code: string, publicKeyJwk: JsonWebKey, capabilities: string[]): StoredTarget;
  registerExtension(alias: string, publicKeyJwk: JsonWebKey, capabilities: string[]): StoredTarget;
  listTargets(): StoredTarget[];
  getTargetByAlias(alias: string): StoredTarget | null;
  getTargetById(targetId: string): StoredTarget | null;
  renameTarget(alias: string, newAlias: string): void;
  revokeTarget(alias: string): void;
  createBinding(principalId: string, targetId: string): StoredBinding;
  getBindingByRef(bindingRef: string): StoredBinding | null;
  getActiveBindingForPrincipal(principalId: string): StoredBinding | null;
  listBindings(): StoredBinding[];
  revokeBindingForPrincipal(principalId: string): boolean;
  revokeBindingsForTarget(targetId: string): number;
  updateTargetObservation(targetId: string, observation: 'heartbeat' | 'success' | 'failure', capabilities?: string[]): StoredTarget;
  bumpStatusVersion(targetId: string): number;
  getActiveLease(targetId: string, at: string): StoredLease | null;
  acquireLease(targetId: string, principalId: string, expiresAt: string): LeaseGrant | null;
  resolveSession(handle: string, principalId: string, at: string): ResolvedSession | null;
  releaseSession(handle: string, principalId: string): boolean;
  expireLeases(at: string): number;
  createCommand(input: CreateCommandInput): StoredCommand;
  findCommandByIdempotency(principalId: string, idempotencyKey: string): StoredCommand | null;
  getCommand(commandId: string): StoredCommand | null;
  transitionCommand(commandId: string, state: CommandState, reasonCode?: string, connectionEpoch?: number, result?: BrokerResult): StoredCommand;
  listRecoverableCommands(at: string): StoredCommand[];
  countQueuedForTarget(targetId: string): number;
  hasInFlightForTarget(targetId: string, excludingCommandId?: string): boolean;
  trace(event: Omit<StoredTraceEvent, 'observedAt'> & { observedAt?: string }): void;
  listTrace(runId: string): StoredTraceEvent[];
  listCommandsByRunId(runId: string): StoredCommand[];
  audit(eventType: string, context: { principalId?: string; targetAlias?: string; [key: string]: unknown }): void;
}

export type JsonRecord = Record<string, unknown>;
export type RequestLifecycle = 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';
export type WorkspaceLifecycle = 'active' | 'ended';

export interface StoredEndpoint {
  endpointRef: string;
  nickname: string;
  legacyTargetId: string | null;
  pairingIdentityHash: string | null;
  credential: JsonRecord | null;
  lifecycle: 'paired' | 'revoked';
  connectionGeneration: number;
  statusVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredEndpointConnection {
  endpointRef: string;
  connectionGeneration: number;
  connectionRef: string;
  transport: string;
  protocolVersion: string;
  extensionVersion: string | null;
  browserProduct: string | null;
  browserVersion: string | null;
  connectedAt: string;
  disconnectedAt: string | null;
  disconnectReason: string | null;
}

export interface StoredLineage {
  lineageRef: string;
  runtimeName: string;
  createdAt: string;
}

export interface StoredCallerSession {
  sessionRef: string;
  lineageRef: string;
  parentSessionRef: string | null;
  runtimeSessionKeyHash: string;
  lifecycle: 'active' | 'ended';
  createdAt: string;
  lastSeenAt: string;
  endedAt: string | null;
}

export interface StoredLogicalWindow {
  windowRef: string;
  endpointRef: string;
  privateWindowKey: string;
  locatorGeneration: number;
  focused: boolean;
  eligible: boolean;
  lastFocusedAt: string | null;
  lastObservedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredWorkspace {
  workspaceRef: string;
  endpointRef: string;
  windowRef: string;
  lineageRef: string;
  ownerSessionRef: string;
  parentWorkspaceRef: string | null;
  groupLabel: string;
  privateGroupKey: string | null;
  locatorGeneration: number;
  lifecycle: WorkspaceLifecycle;
  ownerEpoch: number;
  controlEpoch: number;
  pauseCauses: string[];
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface StoredManagedTab {
  tabRef: string;
  workspaceRef: string;
  endpointRef: string;
  windowRef: string;
  openerTabRef: string | null;
  privateTabKey: string;
  locatorGeneration: number;
  attachmentGeneration: number;
  lifecycle: 'active' | 'closed' | 'replaced';
  title: string | null;
  url: string | null;
  lastObservedAt: string;
  replacedByTabRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredCapabilitySelection {
  capabilitySelectionRef: string;
  endpointRef: string;
  connectionGeneration: number;
  profileVersion: string;
  browserProduct: string | null;
  browserVersion: string | null;
  extensionVersion: string | null;
  methods: string[];
  selectedAt: string;
  retiredAt: string | null;
}

export interface StoredStatusObservation {
  observationId: number;
  subjectType: 'broker' | 'endpoint' | 'window' | 'workspace' | 'tab' | 'request' | 'attachment';
  subjectRef: string;
  condition: string;
  facts: JsonRecord;
  source: string;
  sourceGeneration: number;
  observedAt: string;
}

export interface StoredRequestTicket {
  requestRef: string;
  toolName: string;
  requesterSessionRef: string;
  authorityScope: 'owner' | 'requester';
  authoritySessionRef: string;
  authorityLineageRef: string;
  endpointRef: string | null;
  workspaceRef: string | null;
  tabRef: string | null;
  acceptedOwnerEpoch: number | null;
  normalizedBody: JsonRecord;
  state: RequestLifecycle;
  phase: string;
  checkpoint: JsonRecord;
  pauseCondition: string | null;
  problem: JsonRecord | null;
  result: JsonRecord | null;
  effectMayHaveOccurred: boolean;
  acknowledgementState: 'pending' | 'delivered' | 'failed';
  acknowledgedAt: string | null;
  publiclyVisible: boolean;
  lanePosition: number | null;
  claimGeneration: number;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  acceptedAt: string;
  updatedAt: string;
  terminalAt: string | null;
  closedAt: string | null;
  resolutionOfRequestRef: string | null;
}

export interface StoredRequestAttempt {
  attemptRef: string;
  requestRef: string;
  attemptNumber: number;
  endpointRef: string;
  connectionGeneration: number;
  locatorGeneration: number | null;
  attachmentGeneration: number | null;
  privateMessageRef: string | null;
  state: 'prepared' | 'dispatched' | 'completed' | 'missing';
  outcome: JsonRecord | null;
  effectClassification: string | null;
  preparedAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
}

export interface StoredTabLane {
  workspaceRef: string;
  tabRef: string;
  nextPosition: number;
  headRequestRef: string | null;
  laneGeneration: number;
  updatedAt: string;
}

export interface StoredControlRecord {
  controlRef: string;
  requestRef: string;
  kind: 'workspace_stop' | 'workspace_resume' | 'endpoint_kill' | 'endpoint_resume' | 'takeover' | 'termination' | 'human_resolution';
  scopeType: 'request' | 'workspace' | 'endpoint';
  scopeRef: string;
  controlEpoch: number;
  state: 'active' | 'succeeded' | 'failed';
  details: JsonRecord;
  createdAt: string;
  terminalAt: string | null;
}

export interface StoredEventStream {
  streamRef: string;
  tabRef: string;
  streamGeneration: number;
  initialCursorRef: string;
  baseline: JsonRecord;
  nextSequence: number;
  state: 'active' | 'replaced' | 'ended';
  createdAt: string;
  endedAt: string | null;
}

export interface StoredCdpEvent {
  streamRef: string;
  sequence: number;
  method: string;
  params: JsonRecord;
  connectionGeneration: number;
  observedAt: string;
}

export interface StoredEventCursor {
  cursorRef: string;
  streamRef: string;
  sequence: number;
  queryHash: string;
  ownerEpoch: number;
  issuedAt: string;
  expiresAt: string | null;
}

export interface StoredCanonicalAuditEvent {
  auditRef: string;
  eventType: string;
  actorSessionRef: string | null;
  endpointRef: string | null;
  workspaceRef: string | null;
  tabRef: string | null;
  requestRef: string | null;
  context: JsonRecord;
  observedAt: string;
}

export interface PageQuery {
  limit: number;
  after?: string;
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface LogicalRecoverySnapshot {
  endpoints: StoredEndpoint[];
  liveConnections: StoredEndpointConnection[];
  activeSessions: StoredCallerSession[];
  activeWorkspaces: StoredWorkspace[];
  activeTabs: StoredManagedTab[];
  activeControls: StoredControlRecord[];
}

export interface RequestRecoverySnapshot {
  requests: StoredRequestTicket[];
  attempts: StoredRequestAttempt[];
  lanes: StoredTabLane[];
}

export interface EventRecoverySnapshot {
  streams: StoredEventStream[];
}

export interface LogicalRepository {
  createEndpoint(input: {
    endpointRef: string;
    nickname: string;
    pairingIdentityHash?: string;
    credential?: JsonRecord;
    legacyTargetId?: string;
    at?: string;
  }): StoredEndpoint;
  getEndpoint(endpointRef: string): StoredEndpoint | null;
  getEndpointByNickname(nickname: string): StoredEndpoint | null;
  listEndpoints(query: PageQuery): Page<StoredEndpoint>;
  getCurrentConnection(endpointRef: string): StoredEndpointConnection | null;
  openEndpointConnection(input: {
    endpointRef: string;
    connectionRef: string;
    transport: string;
    protocolVersion: string;
    extensionVersion?: string;
    browserProduct?: string;
    browserVersion?: string;
    at?: string;
  }): StoredEndpointConnection;
  disconnectEndpoint(input: {
    endpointRef: string;
    connectionGeneration: number;
    reason: string;
    at?: string;
  }): boolean;
  registerLineage(input: { lineageRef: string; runtimeName: string; at?: string }): StoredLineage;
  registerSession(input: {
    sessionRef: string;
    lineageRef: string;
    parentSessionRef?: string;
    runtimeSessionKeyHash: string;
    at?: string;
  }): StoredCallerSession;
  touchSession(sessionRef: string, at?: string): StoredCallerSession | null;
  upsertWindow(input: {
    windowRef: string;
    endpointRef: string;
    privateWindowKey: string;
    locatorGeneration: number;
    focused: boolean;
    eligible: boolean;
    observedAt?: string;
  }): StoredLogicalWindow;
  markMissingWindows(input: {
    endpointRef: string;
    observedWindowRefs: string[];
    at?: string;
  }): void;
  getWindow(windowRef: string): StoredLogicalWindow | null;
  listWindows(endpointRef: string): StoredLogicalWindow[];
  createWorkspace(input: {
    workspaceRef: string;
    endpointRef: string;
    windowRef: string;
    lineageRef: string;
    ownerSessionRef: string;
    parentWorkspaceRef?: string;
    groupLabel: string;
    privateGroupKey?: string;
    locatorGeneration?: number;
    at?: string;
  }): StoredWorkspace;
  addTab(input: {
    tabRef: string;
    workspaceRef: string;
    endpointRef: string;
    windowRef: string;
    openerTabRef?: string;
    privateTabKey: string;
    locatorGeneration: number;
    attachmentGeneration?: number;
    title?: string;
    url?: string;
    observedAt?: string;
  }): StoredManagedTab;
  getWorkspace(workspaceRef: string): StoredWorkspace | null;
  listActiveWorkspaces(input?: { endpointRef?: string; ownerSessionRef?: string }): StoredWorkspace[];
  getTab(workspaceRef: string, tabRef: string): StoredManagedTab | null;
  listWorkspaceTabs(workspaceRef: string): StoredManagedTab[];
  updateWorkspaceLocator(input: {
    workspaceRef: string;
    expectedLocatorGeneration: number;
    privateGroupKey: string;
    newLocatorGeneration: number;
    at?: string;
  }): StoredWorkspace | null;
  updateTab(input: {
    workspaceRef: string;
    tabRef: string;
    expectedLocatorGeneration: number;
    privateTabKey?: string;
    newLocatorGeneration?: number;
    attachmentGeneration?: number;
    lifecycle?: StoredManagedTab['lifecycle'];
    title?: string | null;
    url?: string | null;
    replacedByTabRef?: string;
    observedAt?: string;
  }): StoredManagedTab | null;
  setWorkspacePauseCause(input: { workspaceRef: string; cause: string; sourceRequestRef?: string; at?: string }): StoredWorkspace;
  clearWorkspacePauseCause(input: { workspaceRef: string; cause: string; at?: string }): StoredWorkspace;
  takeOverWorkspace(input: {
    workspaceRef: string;
    expectedOwnerSessionRef: string;
    expectedOwnerEpoch: number;
    expectedControlEpoch: number;
    newOwnerSessionRef: string;
    newLineageRef: string;
    at?: string;
  }): StoredWorkspace | null;
  claimWorkspaceControl(input: {
    workspaceRef: string;
    expectedControlEpoch: number;
    at?: string;
  }): StoredWorkspace | null;
  finishWorkspaceTermination(input: { workspaceRef: string; expectedControlEpoch: number; succeeded: boolean; at?: string }): StoredWorkspace | null;
  recordControl(input: {
    controlRef: string;
    requestRef: string;
    kind: StoredControlRecord['kind'];
    scopeType: StoredControlRecord['scopeType'];
    scopeRef: string;
    controlEpoch: number;
    details?: JsonRecord;
    at?: string;
  }): StoredControlRecord;
  finishControl(input: { controlRef: string; state: 'succeeded' | 'failed'; at?: string }): StoredControlRecord | null;
  recordCapabilitySelection(input: {
    capabilitySelectionRef: string;
    endpointRef: string;
    connectionGeneration: number;
    profileVersion: string;
    browserProduct?: string;
    browserVersion?: string;
    extensionVersion?: string;
    methods: string[];
    at?: string;
  }): StoredCapabilitySelection;
  getCurrentCapability(endpointRef: string): StoredCapabilitySelection | null;
  getActiveEndpointControl(endpointRef: string): StoredControlRecord | null;
  getEndpointKillState(endpointRef: string): { killed: boolean; sourceRequestRefs: string[] };
  recordStatusObservation(input: {
    subjectType: StoredStatusObservation['subjectType'];
    subjectRef: string;
    condition: string;
    facts?: JsonRecord;
    source: string;
    sourceGeneration: number;
    observedAt?: string;
  }): StoredStatusObservation;
  scanLogicalRecovery(): LogicalRecoverySnapshot;
}

export interface RequestRepository {
  acceptRequest(input: {
    requestRef: string;
    toolName: string;
    requesterSessionRef: string;
    authorityScope: StoredRequestTicket['authorityScope'];
    authoritySessionRef: string;
    authorityLineageRef: string;
    normalizedBody: JsonRecord;
    phase: string;
    checkpoint: JsonRecord;
    endpointRef?: string;
    workspaceRef?: string;
    tabRef?: string;
    acceptedOwnerEpoch?: number;
    resolutionOfRequestRef?: string;
    at?: string;
  }): StoredRequestTicket;
  getRequest(requestRef: string): StoredRequestTicket | null;
  listVisibleRequests(input: {
    authorityLineageRef: string;
    authoritySessionRef?: string;
    workspaceRef?: string;
    includeTerminal?: boolean;
    page: PageQuery;
  }): Page<StoredRequestTicket>;
  markAcknowledgementDelivered(requestRef: string, at?: string): StoredRequestTicket | null;
  failAcknowledgement(requestRef: string, reasonCode: string, at?: string): StoredRequestTicket | null;
  claimRequest(input: { requestRef: string; workerRef: string; leaseExpiresAt: string; at?: string }): StoredRequestTicket | null;
  recordCheckpoint(input: {
    requestRef: string;
    expectedClaimGeneration: number;
    phase: string;
    checkpoint: JsonRecord;
    pauseCondition?: string | null;
    reasonCode?: string;
    at?: string;
  }): StoredRequestTicket | null;
  startAttempt(input: {
    attemptRef: string;
    requestRef: string;
    endpointRef: string;
    connectionGeneration: number;
    locatorGeneration?: number;
    attachmentGeneration?: number;
    privateMessageRef?: string;
    at?: string;
  }): StoredRequestAttempt;
  markAttemptDispatched(attemptRef: string, at?: string): StoredRequestAttempt | null;
  finishAttempt(input: {
    attemptRef: string;
    state: 'completed' | 'missing';
    outcome?: JsonRecord;
    effectClassification?: string;
    at?: string;
  }): StoredRequestAttempt | null;
  terminalizeRequest(input: {
    requestRef: string;
    expectedClaimGeneration?: number;
    state: 'succeeded' | 'failed' | 'uncertain';
    phase: string;
    checkpoint: JsonRecord;
    problem?: JsonRecord;
    result?: JsonRecord;
    effectMayHaveOccurred?: boolean;
    reasonCode?: string;
    at?: string;
  }): StoredRequestTicket | null;
  closeRequest(input: {
    requestRef: string;
    authoritySessionRef: string;
    expectedOwnerEpoch?: number;
    at?: string;
  }): boolean;
  resolveRequest(input: {
    resolverRequestRef: string;
    targetRequestRef: string;
    targetState: 'succeeded' | 'failed';
    resolverState?: 'succeeded' | 'failed';
    targetEffectMayHaveOccurred?: boolean;
    targetProblem?: JsonRecord;
    targetResult?: JsonRecord;
    resolverResult?: JsonRecord;
    at?: string;
  }): boolean;
  scanRequestRecovery(at?: string): RequestRecoverySnapshot;
}

export interface EventRepository {
  createStream(input: {
    streamRef: string;
    tabRef: string;
    initialCursorRef: string;
    queryHash: string;
    ownerEpoch: number;
    baseline: JsonRecord;
    cursorExpiresAt?: string;
    at?: string;
  }): { stream: StoredEventStream; cursor: StoredEventCursor };
  appendEvent(input: {
    streamRef: string;
    method: string;
    params: JsonRecord;
    connectionGeneration: number;
    cursorRef: string;
    queryHash: string;
    ownerEpoch: number;
    cursorExpiresAt?: string;
    observedAt?: string;
  }): { event: StoredCdpEvent; cursor: StoredEventCursor };
  readEvents(input: { cursorRef: string; queryHash: string; ownerEpoch: number; limit: number; at?: string }): {
    events: StoredCdpEvent[];
    cursor: StoredEventCursor;
    stream: StoredEventStream;
  } | null;
  replaceStreamBaseline(input: {
    tabRef: string;
    streamRef: string;
    initialCursorRef: string;
    queryHash: string;
    ownerEpoch: number;
    baseline: JsonRecord;
    cursorExpiresAt?: string;
    at?: string;
  }): { stream: StoredEventStream; cursor: StoredEventCursor };
  scanEventRecovery(): EventRecoverySnapshot;
}

export interface AuditRepository {
  append(input: {
    auditRef: string;
    eventType: string;
    actorSessionRef?: string;
    endpointRef?: string;
    workspaceRef?: string;
    tabRef?: string;
    requestRef?: string;
    context?: JsonRecord;
    observedAt?: string;
  }): StoredCanonicalAuditEvent;
  list(input: { requestRef?: string; workspaceRef?: string; page: PageQuery }): Page<StoredCanonicalAuditEvent>;
}

export interface CanonicalRepositorySet {
  logical: LogicalRepository;
  requests: RequestRepository;
  events: EventRepository;
  audit: AuditRepository;
}

export interface CanonicalRepositories extends CanonicalRepositorySet {
  transaction<T>(work: (repositories: CanonicalRepositorySet) => T): T;
}
