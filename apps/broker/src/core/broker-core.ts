import { randomUUID } from 'node:crypto';
import type {
  AgentPrincipal,
  AgentTargetBinding,
  BrokerCommand,
  BrokerResult,
  CommandState,
  DispatchReceipt,
  IdempotencyClass,
  RequestContext,
  RoutingDecision,
  SanitizedCommand,
  SanitizedTarget,
  SessionHandle
} from '../../../shared/protocol/src/index.js';
import { RelayError, ErrorCodes, validateOperation } from '../../../shared/protocol/src/index.js';
import type { RelayRepositories, StoredBinding, StoredCommand, StoredTarget, StoredTraceEvent } from '../storage/index.js';
import { assertCommandTransition, isTerminalCommandState } from './command-state-machine.js';
import { LeaseManager } from './lease-manager.js';
import { RoutingPolicy } from './routing-policy.js';
import { TargetStateIndex } from './target-state-index.js';

export interface CommandTransport {
  getConnectionEpoch(targetId: string): number | null;
  send(targetId: string, epoch: number, command: BrokerCommand): void;
  disconnectTarget(targetId: string): void;
}

export interface DispatchInput {
  principal: AgentPrincipal;
  runId?: string;
  bindingRef: string;
  sessionHandle?: string;
  operation: string;
  parameters: unknown;
  idempotencyClass: IdempotencyClass;
  idempotencyKey?: string;
  waitMs: number;
  deadlineMs: number;
}

export class BrokerCore {
  readonly stateIndex: TargetStateIndex;
  readonly leases: LeaseManager;
  private readonly policy: RoutingPolicy;
  private transport: CommandTransport | null = null;

  constructor(
    private readonly store: RelayRepositories,
    options: { heartbeatTimeoutMs?: number; errorThreshold?: number; maxQueuedPerTarget?: number } = {}
  ) {
    this.stateIndex = new TargetStateIndex(store, options.heartbeatTimeoutMs, options.errorThreshold);
    this.leases = new LeaseManager(store);
    this.policy = new RoutingPolicy({
      maxQueuedPerTarget: options.maxQueuedPerTarget ?? 100,
      queueDepth: (targetId) => this.store.countQueuedForTarget(targetId),
      ownsLease: (targetId, principalId) => this.leases.owns(targetId, principalId)
    });
  }

  setTransport(transport: CommandTransport): void {
    this.transport = transport;
  }

  listTargets(principal: AgentPrincipal): SanitizedTarget[] {
    this.requireScope(principal, 'targets:read');
    const targets = principal.scopes.includes('broker:admin')
      ? this.store.listTargets()
      : [this.store.getActiveBindingForPrincipal(principal.principalId)]
        .filter((binding): binding is StoredBinding => binding !== null)
        .map((binding) => this.store.getTargetById(binding.targetId))
        .filter((target): target is StoredTarget => target !== null);
    return targets.map((target) => this.sanitizeTarget(target)).filter((target): target is SanitizedTarget => target !== null);
  }

  getMyBinding(principal: AgentPrincipal): AgentTargetBinding & { target: SanitizedTarget } {
    const binding = this.store.getActiveBindingForPrincipal(principal.principalId);
    if (!binding) throw new RelayError(ErrorCodes.InvalidBinding, 'No active extension binding exists for this agent.');
    const target = this.store.getTargetById(binding.targetId);
    const sanitized = target ? this.sanitizeTarget(target) : null;
    if (!sanitized) throw new RelayError(ErrorCodes.BindingRevoked, 'The bound extension target is revoked or unavailable.');
    return { ...this.sanitizeBinding(binding), target: sanitized };
  }

  getTarget(principal: AgentPrincipal, bindingRef: string): SanitizedTarget {
    const { target } = this.resolveBinding(bindingRef, principal);
    const sanitized = this.sanitizeTarget(target);
    if (!sanitized) throw new RelayError(ErrorCodes.TargetNotFound, 'Target not found.');
    return sanitized;
  }

  private sanitizeTarget(target: StoredTarget): SanitizedTarget | null {
    const snapshot = this.stateIndex.snapshot(target.targetId);
    if (!snapshot) return null;
    return {
      alias: snapshot.alias,
      connectivity: snapshot.connectivity,
      health: snapshot.health,
      occupancy: snapshot.occupancy,
      capabilities: snapshot.capabilities,
      lastSeenAt: snapshot.lastSeenAt,
      status: snapshot.status,
      statusVersion: snapshot.statusVersion
    };
  }

  async acquireSession(principal: AgentPrincipal, bindingRef: string, ttlMs: number, waitMs: number): Promise<SessionHandle> {
    this.requireScope(principal, 'sessions:write');
    const { target } = this.resolveBinding(bindingRef, principal);
    const session = await this.leases.acquire(target.targetId, target.alias, bindingRef, principal, ttlMs, waitMs);
    if (!session) throw new RelayError(ErrorCodes.LeaseConflict, `Target is already leased: ${target.alias}`, 250);
    this.store.bumpStatusVersion(target.targetId);
    this.store.audit('lease.acquired', { principalId: principal.principalId, targetAlias: target.alias, bindingRef, fencingToken: session.fencingToken });
    return session;
  }

  releaseSession(principal: AgentPrincipal, bindingRef: string, handle: string): void {
    this.requireScope(principal, 'sessions:write');
    const { target } = this.resolveBinding(bindingRef, principal);
    const resolved = this.leases.resolve(handle, principal.principalId);
    if (!resolved || resolved.targetId !== target.targetId || !this.leases.release(handle, principal.principalId)) {
      throw new RelayError(ErrorCodes.LeaseExpired, 'Session is missing, expired, or belongs to another principal.');
    }
    this.store.bumpStatusVersion(resolved.targetId);
    this.flushTargetQueue(resolved.targetId);
  }

  dispatch(input: DispatchInput): DispatchReceipt {
    const existing = input.idempotencyKey
      ? this.store.findCommandByIdempotency(input.principal.principalId, input.idempotencyKey)
      : null;
    if (existing) {
      if (existing.bindingRef !== input.bindingRef) {
        throw new RelayError(ErrorCodes.BindingForbidden, 'The idempotency key belongs to another binding.');
      }
      return this.receipt(existing);
    }

    const parameters = validateOperation(input.operation, input.parameters);
    const requestId = randomUUID();
    const commandId = randomUUID();
    const deadlineAt = new Date(Date.now() + input.deadlineMs).toISOString();
    this.trace(input.runId, {
      requestId,
      commandId,
      targetAlias: null,
      bindingRef: input.bindingRef,
      principalId: input.principal.principalId,
      stage: 'MCP_ACCEPT',
      connectionEpoch: null,
      outcomeCode: null
    });
    const resolvedBinding = this.resolveBinding(input.bindingRef, input.principal);
    const target = resolvedBinding.target;
    this.trace(input.runId, {
      requestId,
      commandId,
      targetAlias: target.alias,
      bindingRef: input.bindingRef,
      principalId: input.principal.principalId,
      stage: 'BINDING_VALIDATED',
      connectionEpoch: null,
      outcomeCode: 'BOUND_TARGET_RESOLVED'
    });
    const contextBase = {
      requestId,
      principal: input.principal,
      bindingRef: input.bindingRef,
      operation: input.operation,
      deadlineAt,
      requestedWait: input.waitMs > 0
    };
    const context: RequestContext = {
      ...contextBase,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey })
    };
    let decision: RoutingDecision | null = null;
    let snapshotVersion = -1;
    const session = input.sessionHandle ? this.leases.resolve(input.sessionHandle, input.principal.principalId) : null;
    if (input.sessionHandle && !session) throw new RelayError(ErrorCodes.LeaseExpired, 'Session is missing or expired.');
    if (session && session.targetId !== target.targetId) {
      throw new RelayError(ErrorCodes.BindingForbidden, 'The session handle does not belong to this binding.');
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = this.stateIndex.snapshot(target.targetId);
      if (!snapshot) throw new RelayError(ErrorCodes.TargetNotFound, 'Target not found.');
      decision = this.policy.evaluate(snapshot, context);
      snapshotVersion = snapshot.statusVersion;
      const current = this.stateIndex.snapshot(target.targetId);
      if (current?.statusVersion === snapshotVersion) break;
      decision = null;
    }
    if (!decision) throw new RelayError(ErrorCodes.TargetBusy, 'Target changed too quickly; retry the request.', 100);

    this.trace(input.runId, {
      requestId,
      commandId,
      targetAlias: target.alias,
      bindingRef: input.bindingRef,
      principalId: input.principal.principalId,
      stage: 'POLICY_DECISION',
      connectionEpoch: null,
      outcomeCode: decision.reasonCode
    });

    const commandBase: BrokerCommand = {
      commandId,
      requestId,
      principalId: input.principal.principalId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      bindingRef: input.bindingRef,
      targetId: target.targetId,
      operation: input.operation,
      parameters,
      idempotencyClass: input.idempotencyClass,
      deadlineAt
    };
    const command: BrokerCommand = session
      ? { ...commandBase, leaseId: session.leaseId, fencingToken: session.fencingToken }
      : commandBase;
    const initialState: 'QUEUED' | 'REJECTED' = decision.disposition === 'reject' ? 'REJECTED' : 'QUEUED';
    const createInput = input.idempotencyKey
      ? { command, decision, idempotencyKey: input.idempotencyKey, initialState }
      : { command, decision, initialState };
    let stored = this.store.createCommand(createInput);
    this.trace(input.runId, {
      requestId,
      commandId: command.commandId,
      targetAlias: target.alias,
      bindingRef: input.bindingRef,
      principalId: input.principal.principalId,
      stage: 'COMMAND_COMMIT',
      connectionEpoch: null,
      outcomeCode: initialState
    });
    this.store.audit('command.created', {
      principalId: input.principal.principalId,
      targetAlias: target.alias,
      commandId: command.commandId,
      decision: decision.disposition,
      reasonCode: decision.reasonCode,
      statusVersion: snapshotVersion
    });
    if (decision.disposition === 'deliver') stored = this.deliver(stored);
    return this.receipt(stored);
  }

  getCommand(principal: AgentPrincipal, bindingRef: string, commandId: string): SanitizedCommand {
    this.resolveBinding(bindingRef, principal);
    const command = this.store.getCommand(commandId);
    if (!command) throw new RelayError(ErrorCodes.CommandNotFound, 'Command not found.');
    if (command.principalId !== principal.principalId && !principal.scopes.includes('broker:admin')) {
      throw new RelayError(ErrorCodes.Forbidden, 'Command belongs to another principal.');
    }
    if (command.bindingRef !== bindingRef) throw new RelayError(ErrorCodes.BindingForbidden, 'Command belongs to another binding.');
    this.trace(command.runId, {
      requestId: command.requestId,
      commandId: command.commandId,
      targetAlias: command.targetAlias,
      bindingRef: command.bindingRef,
      principalId: principal.principalId,
      stage: 'MCP_OBSERVED',
      connectionEpoch: command.deliveredEpoch,
      outcomeCode: command.state
    });
    return this.sanitizeCommand(command);
  }

  createPairingCode(principal: AgentPrincipal, alias: string, expiresInMs: number): { alias: string; pairingCode: string; expiresAt: string } {
    this.requireScope(principal, 'broker:admin');
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
    const pairingCode = this.store.createPairingCode(alias, expiresAt);
    this.store.audit('target.pairing_code_created', { principalId: principal.principalId, targetAlias: alias, expiresAt });
    return { alias, pairingCode, expiresAt };
  }

  bindAgent(principal: AgentPrincipal, principalId: string, alias: string): AgentTargetBinding {
    this.requireScope(principal, 'broker:admin');
    const target = this.store.getTargetByAlias(alias);
    if (!target) throw new RelayError(ErrorCodes.TargetNotFound, `Target not found: ${alias}`);
    try {
      const binding = this.store.createBinding(principalId, target.targetId);
      this.store.audit('binding.created', { principalId, targetAlias: alias, bindingRef: binding.bindingRef, actorPrincipalId: principal.principalId });
      return this.sanitizeBinding(binding);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'BINDING_CONFLICT') throw new RelayError(ErrorCodes.BindingConflict, 'The agent or target already has another active binding.');
      if (message === 'AGENT_NOT_FOUND') throw new RelayError(ErrorCodes.InvalidInput, 'Agent principal not found.');
      throw error;
    }
  }

  unbindAgent(principal: AgentPrincipal, principalId: string): void {
    this.requireScope(principal, 'broker:admin');
    const binding = this.store.getActiveBindingForPrincipal(principalId);
    if (!binding || !this.store.revokeBindingForPrincipal(principalId)) {
      throw new RelayError(ErrorCodes.InvalidBinding, 'No active binding exists for that agent.');
    }
    this.store.bumpStatusVersion(binding.targetId);
    this.flushTargetQueue(binding.targetId);
    this.store.audit('binding.revoked', { principalId, targetAlias: binding.targetAlias, bindingRef: binding.bindingRef, actorPrincipalId: principal.principalId });
  }

  listBindings(principal: AgentPrincipal): Array<AgentTargetBinding & { principalId: string }> {
    this.requireScope(principal, 'broker:admin');
    return this.store.listBindings().map((binding) => ({ ...this.sanitizeBinding(binding), principalId: binding.principalId }));
  }

  pairExtension(pairingCode: string, publicKeyJwk: JsonWebKey, capabilities: string[]): StoredTarget {
    const target = this.store.consumePairingCode(pairingCode, publicKeyJwk, capabilities);
    this.store.audit('target.paired', { targetAlias: target.alias });
    return target;
  }

  autoPairExtension(alias: string, publicKeyJwk: JsonWebKey, capabilities: string[]): StoredTarget {
    const target = this.store.registerExtension(alias, publicKeyJwk, capabilities);
    this.store.audit('target.auto_paired', { targetAlias: target.alias, pairingMode: 'extension_generated' });
    return target;
  }

  renameAuthenticatedExtension(targetId: string, newAlias: string): StoredTarget {
    if (!/^[a-z]{6,16}$/.test(newAlias)) throw new Error('ENDPOINT_NICKNAME_INVALID');
    const target = this.store.getTargetById(targetId);
    if (!target) throw new Error('ENDPOINT_NOT_FOUND');
    if (target.alias === newAlias) return target;
    this.store.renameTarget(target.alias, newAlias);
    this.store.audit('target.renamed', {
      targetAlias: newAlias,
      previousAlias: target.alias,
      pairingMode: 'authenticated_extension'
    });
    return this.store.getTargetById(targetId)!;
  }

  renameTarget(principal: AgentPrincipal, alias: string, newAlias: string): void {
    this.requireScope(principal, 'broker:admin');
    this.store.renameTarget(alias, newAlias);
    this.store.audit('target.renamed', { principalId: principal.principalId, targetAlias: newAlias, previousAlias: alias });
  }

  revokeTarget(principal: AgentPrincipal, alias: string): void {
    this.requireScope(principal, 'broker:admin');
    const target = this.store.getTargetByAlias(alias);
    if (!target) throw new RelayError(ErrorCodes.TargetNotFound, 'Target not found.');
    this.transport?.disconnectTarget(target.targetId);
    this.store.revokeTarget(alias);
    this.store.audit('target.revoked', { principalId: principal.principalId, targetAlias: alias });
  }

  onExtensionConnected(targetId: string, epoch: number): void {
    this.stateIndex.markConnected(targetId, epoch);
    this.flushTargetQueue(targetId);
  }

  onExtensionHeartbeat(targetId: string, epoch: number): void {
    this.stateIndex.markHeartbeat(targetId, epoch);
  }

  onExtensionDisconnected(targetId: string, epoch: number): void {
    this.stateIndex.markDisconnected(targetId, epoch);
  }

  onExtensionAck(targetId: string, epoch: number, commandId: string): void {
    const command = this.store.getCommand(commandId);
    if (!command || command.targetId !== targetId || command.deliveredEpoch !== epoch || command.state !== 'DELIVERED') return;
    this.transition(command, 'ACKED', 'EXTENSION_ACK', epoch);
    this.trace(command.runId, {
      requestId: command.requestId, commandId, targetAlias: command.targetAlias, bindingRef: command.bindingRef, principalId: command.principalId,
      stage: 'EXT_ACK', connectionEpoch: epoch, outcomeCode: 'ACKED'
    });
    this.transition(this.store.getCommand(commandId)!, 'RUNNING', 'EXTENSION_RUNNING', epoch);
  }

  onExtensionResult(targetId: string, epoch: number, payload: { commandId: string; ok: boolean; output?: unknown; errorCode?: string }): void {
    const command = this.store.getCommand(payload.commandId);
    if (!command || command.targetId !== targetId || command.deliveredEpoch !== epoch || isTerminalCommandState(command.state)) return;
    const state: CommandState = payload.ok ? 'SUCCEEDED' : 'FAILED';
    const resultBase: BrokerResult = { commandId: command.commandId, state };
    const result: BrokerResult = {
      ...resultBase,
      ...(payload.output === undefined ? {} : { output: payload.output }),
      ...(payload.errorCode === undefined ? {} : { errorCode: payload.errorCode })
    };
    this.transition(command, state, payload.ok ? 'EXTENSION_SUCCEEDED' : 'EXTENSION_FAILED', epoch, result);
    this.trace(command.runId, {
      requestId: command.requestId, commandId: command.commandId, targetAlias: command.targetAlias, bindingRef: command.bindingRef, principalId: command.principalId,
      stage: 'EXT_RESULT', connectionEpoch: epoch, outcomeCode: state
    });
    if (payload.ok) this.stateIndex.recordSuccess(targetId);
    else this.stateIndex.recordFailure(targetId);
    this.flushTargetQueue(targetId);
  }

  sweep(): void {
    const now = new Date().toISOString();
    this.store.expireLeases(now);
    this.stateIndex.sweepExpiredConnections();
    for (const command of this.store.listRecoverableCommands(now)) {
      if (Date.parse(command.deadlineAt) <= Date.now()) {
        const terminal = command.state === 'ACKED' || command.state === 'RUNNING'
          ? command.idempotencyClass === 'non-idempotent' ? 'UNKNOWN_OUTCOME' : 'TIMED_OUT'
          : 'TIMED_OUT';
        const result: BrokerResult = { commandId: command.commandId, state: terminal };
        this.transition(command, terminal, terminal, command.deliveredEpoch ?? undefined, result);
      } else if (command.state === 'QUEUED') {
        this.deliver(command);
      }
    }
  }

  recover(): void {
    for (const command of this.store.listRecoverableCommands(new Date().toISOString())) {
      if ((command.state === 'ACKED' || command.state === 'RUNNING' || command.state === 'DELIVERED') && command.idempotencyClass === 'non-idempotent') {
        const result: BrokerResult = { commandId: command.commandId, state: 'UNKNOWN_OUTCOME' };
        this.transition(command, 'UNKNOWN_OUTCOME', 'BROKER_RESTART_AMBIGUITY', command.deliveredEpoch ?? undefined, result);
      } else if (command.state === 'ACKED' || command.state === 'RUNNING' || command.state === 'DELIVERED') {
        this.transition(command, 'QUEUED', 'BROKER_RESTART_SAFE_REDELIVERY', command.deliveredEpoch ?? undefined);
      }
    }
  }

  private flushTargetQueue(targetId: string): void {
    for (const command of this.store.listRecoverableCommands(new Date().toISOString())) {
      if (command.targetId === targetId && command.state === 'QUEUED') this.deliver(command);
    }
  }

  private deliver(command: StoredCommand): StoredCommand {
    if (!this.transport || command.state !== 'QUEUED') return command;
    if (this.store.hasInFlightForTarget(command.targetId, command.commandId)) return command;
    const snapshot = this.stateIndex.snapshot(command.targetId);
    if (!snapshot) return command;
    const context: RequestContext = {
      requestId: command.requestId,
      principal: this.principalForCommand(command),
      bindingRef: command.bindingRef,
      operation: command.operation,
      deadlineAt: command.deadlineAt,
      requestedWait: true
    };
    const decision = this.policy.evaluate(snapshot, context);
    if (decision.disposition !== 'deliver') return command;
    const epoch = this.transport.getConnectionEpoch(command.targetId);
    if (epoch === null) return command;
    const delivered = this.transition(command, 'DELIVERED', 'SOCKET_DELIVERY', epoch);
    try {
      this.transport.send(command.targetId, epoch, command);
      this.trace(command.runId, {
        requestId: command.requestId, commandId: command.commandId, targetAlias: command.targetAlias, bindingRef: command.bindingRef, principalId: command.principalId,
        stage: 'WS_SEND', connectionEpoch: epoch, outcomeCode: 'DELIVERED'
      });
      return delivered;
    } catch {
      const terminal = command.idempotencyClass === 'non-idempotent' ? 'UNKNOWN_OUTCOME' : 'FAILED';
      const result: BrokerResult = { commandId: command.commandId, state: terminal, errorCode: 'SOCKET_SEND_FAILED' };
      return this.transition(delivered, terminal, 'SOCKET_SEND_FAILED', epoch, result);
    }
  }

  private transition(command: StoredCommand, state: CommandState, reasonCode: string, epoch?: number, result?: BrokerResult): StoredCommand {
    assertCommandTransition(command.state, state);
    return this.store.transitionCommand(command.commandId, state, reasonCode, epoch, result);
  }

  private resolveBinding(bindingRef: string, principal: AgentPrincipal): { binding: StoredBinding; target: StoredTarget } {
    const binding = this.store.getBindingByRef(bindingRef);
    if (!binding) throw new RelayError(ErrorCodes.InvalidBinding, 'Binding reference is invalid.');
    if (binding.revokedAt) throw new RelayError(ErrorCodes.BindingRevoked, 'Binding reference has been revoked.');
    if (binding.principalId !== principal.principalId && !principal.scopes.includes('broker:admin')) {
      throw new RelayError(ErrorCodes.BindingForbidden, 'Binding belongs to another agent.');
    }
    const target = this.store.getTargetById(binding.targetId);
    if (!target) throw new RelayError(ErrorCodes.BindingRevoked, 'The bound extension target is revoked.');
    return { binding, target };
  }

  private sanitizeBinding(binding: StoredBinding): AgentTargetBinding {
    return {
      bindingRef: binding.bindingRef,
      targetAlias: binding.targetAlias,
      mode: binding.mode,
      createdAt: binding.createdAt
    };
  }

  private receipt(command: StoredCommand): DispatchReceipt {
    return {
      commandId: command.commandId,
      state: command.state,
      decision: command.decision,
      ...(command.result ? { result: command.result } : {})
    };
  }

  private sanitizeCommand(command: StoredCommand): SanitizedCommand {
    return {
      commandId: command.commandId,
      requestId: command.requestId,
      bindingRef: command.bindingRef,
      targetAlias: command.targetAlias,
      operation: command.operation,
      state: command.state,
      deadlineAt: command.deadlineAt,
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
      ...(command.result ? { result: command.result } : {})
    };
  }

  private requireScope(principal: AgentPrincipal, scope: string): void {
    if (!principal.scopes.includes(scope) && !principal.scopes.includes('broker:admin')) {
      throw new RelayError(ErrorCodes.Forbidden, `Missing required scope: ${scope}`);
    }
  }

  private principalForCommand(command: StoredCommand): AgentPrincipal {
    return { principalId: command.principalId, displayName: command.principalId, scopes: ['browser:read', 'browser:write', 'sessions:write'] };
  }

  private trace(
    runId: string | undefined,
    event: Omit<StoredTraceEvent, 'runId' | 'observedAt'> & { observedAt?: string }
  ): void {
    if (runId) this.store.trace({ ...event, runId });
  }
}
