import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  type JsonWebKey as NodeJsonWebKey
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  BrokerCore,
  CommandTransport,
  ExtensionConnectionSnapshot,
  ExtensionEventSink,
  ExtensionOperationType,
  OctopusBroker,
  OctopusExtensionPort
} from '../core/index.js';
import type { BrokerCommand, RelayEnvelope } from '../../../shared/protocol/src/index.js';
import {
  CONSERVATIVE_CAPABILITY_MANIFEST,
  MAX_RELAY_V2_ENVELOPE_BYTES,
  RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_V2,
  createRelayEnvelope,
  createRelayV2Envelope,
  negotiateRelayProtocol,
  parseRelayEnvelope,
  parseRelayV2Envelope,
  selectCapabilityManifest,
  type RelayV2Envelope,
  type RelayV2MessageType,
  type RelayV2PayloadByType
} from '../../../shared/protocol/src/index.js';
import type { RelayRepositories, StoredTarget } from '../storage/index.js';
import { ConnectionRegistry, type LiveExtensionConnection } from './connection-registry.js';
import type { BootstrapGrants, ManagedConnectionClaim } from '../profiles/bootstrap-grants.js';

interface BrowserHelloFacts {
  product: string;
  version: string;
  userAgent: string | null;
}

interface PendingSocketState {
  profileProxy?: boolean;
  managedClaim?: ManagedConnectionClaim | undefined;
  protocolVersion?: 1 | 2;
  targetId?: string;
  endpointId?: string;
  endpointRef?: string;
  alias?: string;
  requestedAlias: string | null;
  epoch?: number;
  challenge?: string;
  authenticated: boolean;
  canonicalConnectionOpened: boolean;
  selectedCapabilityManifestId?: string;
  extensionVersion?: string;
  browser?: BrowserHelloFacts;
  negotiatedMaxEnvelopeBytes: number;
  handshakeTimer: NodeJS.Timeout;
}

interface PendingInventory {
  kind: 'inventory';
  endpointRef: string;
  connectionGeneration: number;
  timer: NodeJS.Timeout;
  resolve(payload: RelayV2PayloadByType['INVENTORY_SNAPSHOT']): void;
  reject(error: Error): void;
}

interface PendingOperation {
  kind: 'operation';
  endpointRef: string;
  connectionGeneration: number;
  operation: ExtensionOperationType;
  acknowledged: boolean;
  timer: NodeJS.Timeout;
  resolve(payload: RelayV2PayloadByType['OPERATION_RESULT']): void;
  reject(error: Error): void;
}

type PendingAttempt = PendingInventory | PendingOperation;

/** The extension rejected the inventory fence before acknowledging execution. */
class InventoryRejectedBeforeDispatch extends Error {}

export interface ExtensionGatewayOptions {
  host: string;
  port: number;
  serviceVersion: string;
  maxPayloadBytes?: number;
  handshakeTimeoutMs?: number;
  operationTimeoutMs?: number;
}

/**
 * Hosts legacy relay-v1 during migration and the canonical private relay-v2
 * extension port used by OctopusBroker.
 */
export class ExtensionGateway implements CommandTransport, OctopusExtensionPort {
  private readonly registry = new ConnectionRegistry();
  private readonly httpServer: Server;
  private readonly wsServer: WebSocketServer;
  private readonly states = new WeakMap<WebSocket, PendingSocketState>();
  private readonly messageTasks = new Set<Promise<void>>();
  private readonly pendingAttempts = new Map<string, PendingAttempt>();
  private eventSink: ExtensionEventSink | null = null;
  private upgradeAttempts = 0;
  private upgradeAccepted = 0;
  private upgradeRejected = 0;
  private lastUpgradeAt: string | null = null;
  private lastUpgradeResult: 'accepted' | 'rejected-path' | 'rejected-host' | null = null;
  private lastUpgradeHostKind: 'loopback-ip' | 'localhost' | 'other' | 'missing' | null = null;
  private lastUpgradePath: string | null = null;

  constructor(
    private readonly broker: BrokerCore,
    private readonly store: RelayRepositories,
    private readonly options: ExtensionGatewayOptions,
    private readonly octopusBroker: OctopusBroker | null = null,
    private readonly managedBootstrap?: BootstrapGrants
  ) {
    this.octopusBroker?.setExtensionPort(this);
    this.httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        const connections = this.registry.values();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          connectedTargets: connections.length,
          connectedEndpoints: connections.filter((connection) => connection.protocolVersion === 2).length,
          websocketUpgrades: {
            attempts: this.upgradeAttempts,
            accepted: this.upgradeAccepted,
            rejected: this.upgradeRejected,
            lastAttemptAt: this.lastUpgradeAt,
            lastResult: this.lastUpgradeResult,
            lastHostKind: this.lastUpgradeHostKind,
            lastPath: this.lastUpgradePath
          }
        }));
        return;
      }
      res.writeHead(404).end();
    });
    this.wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayloadBytes ?? MAX_RELAY_V2_ENVELOPE_BYTES,
      perMessageDeflate: false
    });
    this.httpServer.on('upgrade', (request, socket, head) => {
      this.upgradeAttempts += 1;
      this.lastUpgradeAt = new Date().toISOString();
      this.lastUpgradePath = request.url ?? null;
      this.lastUpgradeHostKind = this.hostKind(request.headers.host);
      if (request.url !== '/relay') {
        this.upgradeRejected += 1;
        this.lastUpgradeResult = 'rejected-path';
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!this.allowedHost(request.headers.host)) {
        this.upgradeRejected += 1;
        this.lastUpgradeResult = 'rejected-host';
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.upgradeAccepted += 1;
      this.lastUpgradeResult = 'accepted';
      this.wsServer.handleUpgrade(request, socket, head, (ws) => this.wsServer.emit('connection', ws, request));
    });
    this.wsServer.on('connection', (socket) => this.onConnection(socket));
  }

  setEventSink(sink: ExtensionEventSink): void {
    this.eventSink = sink;
  }

  connection(endpointRef: string): ExtensionConnectionSnapshot | null {
    const connection = this.registry.getEndpoint(endpointRef);
    if (!connection) return null;
    return {
      endpointRef,
      connectionGeneration: connection.epoch,
      inventoryGeneration: connection.inventoryGeneration,
      profileProxy: connection.profileProxy === true,
      connected: connection.socket.readyState === WebSocket.OPEN
    };
  }

  requestInventory(
    endpointRef: string,
    afterInventoryGeneration: number | null
  ): Promise<RelayV2PayloadByType['INVENTORY_SNAPSHOT']> {
    const connection = this.requireV2Connection(endpointRef);
    const attemptId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = this.attemptTimer(attemptId, reject);
      this.pendingAttempts.set(attemptId, {
        kind: 'inventory', endpointRef, connectionGeneration: connection.epoch, timer, resolve, reject
      });
      try {
        this.sendV2(connection, 'INVENTORY_REQUEST', {
          attemptId,
          expectedConnectionGeneration: connection.epoch,
          afterInventoryGeneration
        });
      } catch (error) {
        this.rejectPending(attemptId, this.asError(error));
      }
    });
  }

  async execute<Type extends ExtensionOperationType>(
    endpointRef: string,
    type: Type,
    payload: RelayV2PayloadByType[Type]
  ): Promise<RelayV2PayloadByType['OPERATION_RESULT']> {
    let current = payload;
    for (let retry = 0; ; retry += 1) {
      try { return await this.executeOnce(endpointRef, type, current); }
      catch (error) {
        if (!(error instanceof InventoryRejectedBeforeDispatch) || retry >= 2) throw error;
        const inventory = await this.requestInventory(endpointRef, current.expected.inventoryGeneration);
        if (inventory.connectionGeneration !== payload.expected.connectionGeneration) throw error;
        // Preserve the attempt identity and locator fences; never retry an ACKed
        // command or infer that a transport failure means no browser effect.
        current = { ...current, expected: { ...current.expected, inventoryGeneration: inventory.inventoryGeneration } };
      }
    }
  }

  private executeOnce<Type extends ExtensionOperationType>(
    endpointRef: string,
    type: Type,
    payload: RelayV2PayloadByType[Type]
  ): Promise<RelayV2PayloadByType['OPERATION_RESULT']> {
    const connection = this.requireV2Connection(endpointRef);
    if (type === 'PROFILE_PROXY' && !connection.profileProxy) throw new Error('PROXY_UNSUPPORTED');
    const attemptId = payload.attemptId;
    if (this.pendingAttempts.has(attemptId)) {
      return Promise.reject(new Error(`Attempt ${attemptId} is already pending.`));
    }
    return new Promise((resolve, reject) => {
      const timer = this.attemptTimer(attemptId, reject);
      this.pendingAttempts.set(attemptId, {
        kind: 'operation', endpointRef, connectionGeneration: connection.epoch,
        operation: type, acknowledged: false, timer, resolve, reject
      });
      try {
        this.sendV2(connection, type, payload);
      } catch (error) {
        this.rejectPending(attemptId, this.asError(error));
      }
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.options.port, this.options.host, () => {
        this.httpServer.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.wsServer.clients) socket.close(1001, 'Broker shutting down');
    for (const attemptId of [...this.pendingAttempts.keys()]) {
      this.rejectPending(attemptId, new Error('Broker extension gateway stopped.'));
    }
    await new Promise<void>((resolve) => this.wsServer.close(() => resolve()));
    await Promise.allSettled([...this.messageTasks]);
    await new Promise<void>((resolve, reject) => this.httpServer.close((error) => error ? reject(error) : resolve()));
  }

  address(): { host: string; port: number } {
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') return { host: this.options.host, port: this.options.port };
    return { host: address.address, port: address.port };
  }

  getConnectionEpoch(targetId: string): number | null {
    const connection = this.registry.get(targetId);
    return connection?.socket.readyState === WebSocket.OPEN ? connection.epoch : null;
  }

  send(targetId: string, epoch: number, command: BrokerCommand): void {
    const connection = this.registry.get(targetId);
    if (!connection || connection.protocolVersion !== 1 || connection.epoch !== epoch || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Legacy target socket is not available.');
    }
    this.sendLegacy(connection.socket, 'COMMAND', {
      commandId: command.commandId,
      operation: command.operation,
      parameters: command.parameters,
      deadlineAt: command.deadlineAt,
      ...(command.fencingToken === undefined ? {} : { fencingToken: command.fencingToken })
    });
  }

  disconnectTarget(targetId: string): void {
    this.registry.get(targetId)?.socket.close(4003, 'Target revoked');
  }

  sweepHeartbeat(timeoutMs: number): void {
    const now = Date.now();
    const cutoff = now - timeoutMs;
    const probeInterval = Math.max(1_000, Math.floor(timeoutMs / 3));
    for (const connection of this.registry.values()) {
      if (connection.lastHeartbeatAt < cutoff) {
        connection.socket.close(4000, 'Heartbeat timeout');
      } else if (connection.socket.readyState === WebSocket.OPEN && connection.lastProbeAt <= now - probeInterval) {
        connection.lastProbeAt = now;
        connection.socket.ping();
      }
    }
  }

  private onConnection(socket: WebSocket): void {
    const handshakeTimer = setTimeout(
      () => socket.close(4001, 'Authentication timeout'),
      this.options.handshakeTimeoutMs ?? 10_000
    );
    const state: PendingSocketState = {
      authenticated: false,
      canonicalConnectionOpened: false,
      requestedAlias: null,
      negotiatedMaxEnvelopeBytes: Math.min(
        this.options.maxPayloadBytes ?? MAX_RELAY_V2_ENVELOPE_BYTES,
        MAX_RELAY_V2_ENVELOPE_BYTES
      ),
      handshakeTimer
    };
    this.states.set(socket, state);
    let messages = Promise.resolve();
    socket.on('message', (data, isBinary) => {
      const text = data.toString();
      const maximum = this.options.maxPayloadBytes ?? MAX_RELAY_V2_ENVELOPE_BYTES;
      if (isBinary || Buffer.byteLength(text) > maximum) {
        socket.close(1009, 'Invalid payload');
        return;
      }
      messages = messages.then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        const raw = JSON.parse(text) as { protocolVersion?: unknown };
        if (raw.protocolVersion === RELAY_PROTOCOL_V2) {
          await this.onV2Message(socket, parseRelayV2Envelope(raw, state.negotiatedMaxEnvelopeBytes));
        } else {
          this.onLegacyMessage(socket, parseRelayEnvelope(raw));
        }
      } catch (error) {
        this.sendProtocolError(socket, state, 'INVALID_MESSAGE', this.asError(error).message, false, null);
      }
      });
      const task = messages;
      this.messageTasks.add(task);
      void task.finally(() => this.messageTasks.delete(task));
    });
    socket.on('close', (_code, reason) => this.onSocketClose(socket, state, reason.toString() || 'socket_closed'));
    socket.on('error', () => undefined);
    socket.on('pong', () => {
      const current = state.endpointRef
        ? this.registry.getEndpoint(state.endpointRef)
        : state.targetId ? this.registry.get(state.targetId) : null;
      if (current?.socket === socket && current.epoch === state.epoch) current.lastHeartbeatAt = Date.now();
    });
  }

  private async onV2Message(socket: WebSocket, envelope: RelayV2Envelope): Promise<void> {
    const state = this.states.get(socket);
    if (!state) return;
    if (state.protocolVersion && state.protocolVersion !== 2) {
      socket.close(4004, 'Relay protocol cannot change on a live socket');
      return;
    }
    state.protocolVersion = 2;
    if (envelope.type === 'HELLO') {
      await this.handleV2Hello(socket, state, (envelope as RelayV2Envelope<'HELLO'>).payload);
      return;
    }
    if (envelope.type === 'AUTH') {
      await this.handleV2Auth(socket, state, (envelope as RelayV2Envelope<'AUTH'>).payload);
      return;
    }
    const connection = this.currentV2Connection(socket, state);
    if (!connection) {
      socket.close(4001, 'Authentication required');
      return;
    }
    connection.lastHeartbeatAt = Date.now();
    switch (envelope.type) {
      case 'HEARTBEAT':
        this.handleV2Heartbeat(connection, (envelope as RelayV2Envelope<'HEARTBEAT'>).payload);
        break;
      case 'INVENTORY_SNAPSHOT':
        this.handleInventory(connection, (envelope as RelayV2Envelope<'INVENTORY_SNAPSHOT'>).payload);
        break;
      case 'ACK':
        this.handleOperationAck(connection, (envelope as RelayV2Envelope<'ACK'>).payload);
        break;
      case 'OPERATION_RESULT':
        this.handleOperationResult(connection, (envelope as RelayV2Envelope<'OPERATION_RESULT'>).payload);
        break;
      case 'CDP_EVENT':
        this.handleCdpEvent(connection, (envelope as RelayV2Envelope<'CDP_EVENT'>).payload);
        break;
      case 'DEBUGGER_DETACHED':
        this.handleDebuggerDetached(connection, (envelope as RelayV2Envelope<'DEBUGGER_DETACHED'>).payload);
        break;
      case 'ERROR':
        this.handleV2Error(connection, (envelope as RelayV2Envelope<'ERROR'>).payload);
        break;
      default:
        this.sendProtocolError(socket, state, 'UNEXPECTED_MESSAGE', `The broker cannot receive ${envelope.type}.`, false, null);
    }
  }

  private async handleV2Hello(
    socket: WebSocket,
    state: PendingSocketState,
    payload: RelayV2PayloadByType['HELLO']
  ): Promise<void> {
    if (!this.octopusBroker) throw new Error('Relay v2 requires an OctopusBroker.');
    if (state.authenticated) throw new Error('An authenticated socket cannot start another handshake.');
    if (payload.managedClaim && !this.managedBootstrap) throw new Error('PROFILE_MANAGEMENT_UNAVAILABLE');
    const knownEndpoint = payload.endpointId
      ? this.octopusBroker.endpointForLegacyTarget(payload.endpointId) : undefined;
    await this.managedBootstrap?.check(payload.managedClaim, knownEndpoint?.endpointRef ?? null, payload.publicKeyJwk as JsonWebKey);
    if (socket.readyState !== WebSocket.OPEN) return;
    state.managedClaim = payload.managedClaim;
    state.profileProxy = payload.profileProxy === 1;
    negotiateRelayProtocol(payload.supportedProtocolVersions);
    const browserMajorMatch = payload.browser.version.match(/\d+/);
    const selection = selectCapabilityManifest({
      relayProtocolVersion: RELAY_PROTOCOL_V2,
      extensionVersion: payload.extensionVersion,
      browserProduct: payload.browser.product,
      browserMajor: browserMajorMatch ? Number(browserMajorMatch[0]) : null,
      advertisedManifestIds: payload.capabilityManifestIds
    });
    state.selectedCapabilityManifestId = selection.manifest.manifestId;
    state.extensionVersion = payload.extensionVersion;
    state.browser = payload.browser;
    state.negotiatedMaxEnvelopeBytes = Math.min(
      payload.maxEnvelopeBytes,
      selection.manifest.limits.maxEnvelopeBytes,
      this.options.maxPayloadBytes ?? MAX_RELAY_V2_ENVELOPE_BYTES
    );
    const requestedAlias = payload.pairingCode
      ? payload.pairingCode.replace('-', '').toLowerCase()
      : undefined;
    if (requestedAlias && payload.proposedNickname !== requestedAlias) {
      throw new Error('The proposed nickname must match the saved pairing code.');
    }
    state.requestedAlias = requestedAlias ?? null;

    if (!payload.endpointId) {
      if (!payload.pairingCode) throw new Error('An unpaired extension must provide its generated pairing code.');
      if (state.endpointId) throw new Error('A pairing identity is already assigned to this socket.');
      let target: StoredTarget;
      try {
        target = this.broker.autoPairExtension(
          requestedAlias!,
          payload.publicKeyJwk as JsonWebKey,
          [selection.manifest.manifestId]
        );
      } catch (error) {
        if (this.asError(error).message === 'ENDPOINT_NICKNAME_CONFLICT') {
          this.sendProtocolError(
            socket,
            state,
            'ENDPOINT_NICKNAME_CONFLICT',
            'That two-word endpoint nickname is already registered; generate another and retry.',
            true,
            null
          );
          return;
        }
        throw error;
      }
      const endpoint = this.canonicalizeTarget(target, payload.publicKeyJwk as JsonWebKey);
      state.targetId = target.targetId;
      state.endpointId = target.targetId;
      state.endpointRef = endpoint.endpointRef;
      state.alias = target.alias;
      this.sendV2Socket(socket, state, 'PAIRED', {
        endpointId: target.targetId,
        nickname: target.alias,
        connectionGeneration: endpoint.connectionGeneration + 1,
        selectedCapabilityManifestId: selection.manifest.manifestId
      });
      return;
    }

    if (state.endpointId && state.endpointId !== payload.endpointId) {
      throw new Error('A paired socket cannot change endpoint identity.');
    }
    const target = this.requireTarget(payload.endpointId);
    const endpoint = this.canonicalizeTarget(target, target.publicKeyJwk);
    const previous = this.registry.getEndpoint(endpoint.endpointRef);
    if (previous && previous.socket !== socket) previous.socket.close(4002, 'Replaced by newer connection');
    const epoch = this.octopusBroker.openEndpointConnection({
      endpointRef: endpoint.endpointRef,
      connectionRef: `con_${randomUUID()}`,
      transport: 'websocket',
      protocolVersion: String(RELAY_PROTOCOL_V2),
      extensionVersion: payload.extensionVersion,
      browserProduct: payload.browser.product,
      browserVersion: payload.browser.version
    });
    state.targetId = target.targetId;
    state.endpointId = target.targetId;
    state.endpointRef = endpoint.endpointRef;
    state.alias = target.alias;
    state.epoch = epoch;
    state.canonicalConnectionOpened = true;
    state.challenge = randomBytes(32).toString('base64url');
    this.sendV2Socket(socket, state, 'CHALLENGE', {
      nonce: state.challenge,
      connectionGeneration: epoch,
      selectedProtocolVersion: RELAY_PROTOCOL_V2,
      selectedCapabilityManifestId: selection.manifest.manifestId,
      pairingRequired: false,
      brokerMaxEnvelopeBytes: state.negotiatedMaxEnvelopeBytes
    });
  }

  private async handleV2Auth(
    socket: WebSocket,
    state: PendingSocketState,
    payload: RelayV2PayloadByType['AUTH']
  ): Promise<void> {
    if (!state.targetId || !state.endpointId || !state.endpointRef || !state.alias || !state.epoch || !state.challenge
      || payload.endpointId !== state.endpointId || payload.connectionGeneration !== state.epoch) {
      throw new Error('Authentication state mismatch.');
    }
    let target = this.requireTarget(state.targetId);
    if (!this.verifySignature(target, state.challenge, payload.signature)) {
      socket.close(4003, 'Authentication failed');
      return;
    }
    await this.managedBootstrap?.authenticated(state.managedClaim, state.endpointRef, target.publicKeyJwk);
    if (socket.readyState !== WebSocket.OPEN) return;
    if (state.requestedAlias && state.requestedAlias !== target.alias) {
      try {
        target = this.broker.renameAuthenticatedExtension(target.targetId, state.requestedAlias);
        state.alias = target.alias;
      } catch (error) {
        const code = this.asError(error).message;
        if (code === 'ENDPOINT_NICKNAME_CONFLICT' || code === 'ENDPOINT_NICKNAME_INVALID') {
          this.sendProtocolError(
            socket,
            state,
            code,
            code === 'ENDPOINT_NICKNAME_CONFLICT'
              ? 'That pairing code belongs to another browser profile. Choose a different code and save again.'
              : 'The saved pairing code does not produce a valid endpoint nickname.',
            false,
            null
          );
          return;
        }
        throw error;
      }
    }
    clearTimeout(state.handshakeTimer);
    state.authenticated = true;
    delete state.challenge;
    const connection: LiveExtensionConnection = {
      targetId: state.targetId,
      endpointId: state.endpointId,
      endpointRef: state.endpointRef,
      protocolVersion: 2,
      profileProxy: state.profileProxy === true,
      epoch: state.epoch,
      socket,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      lastProbeAt: 0,
      inventoryGeneration: 0,
      maxEnvelopeBytes: state.negotiatedMaxEnvelopeBytes
    };
    const previous = this.registry.bind(connection);
    if (previous && previous.socket !== socket) previous.socket.close(4002, 'Replaced by newer connection');
    this.octopusBroker?.onExtensionReady(state.endpointRef, state.epoch);
    this.store.updateTargetObservation(state.targetId, 'heartbeat');
    this.store.audit('extension.connected', {
      targetAlias: state.alias,
      endpointRef: state.endpointRef,
      connectionGeneration: state.epoch,
      protocolVersion: RELAY_PROTOCOL_V2
    });
    this.sendV2(connection, 'READY', {
      endpointId: state.endpointId,
      nickname: state.alias,
      connectionGeneration: state.epoch,
      selectedCapabilityManifestId: state.selectedCapabilityManifestId ?? CONSERVATIVE_CAPABILITY_MANIFEST.manifestId,
      brokerVersion: this.options.serviceVersion,
      // Echo HELLO for older clients that require this field and compare it locally.
      // Compatibility is negotiated by relay protocol, not package version equality.
      requiredExtensionVersion: state.extensionVersion!,
      reloadExtension: false
    });
  }

  private onLegacyMessage(socket: WebSocket, envelope: RelayEnvelope): void {
    const state = this.states.get(socket);
    if (!state) return;
    if (state.protocolVersion && state.protocolVersion !== 1) {
      socket.close(4004, 'Relay protocol cannot change on a live socket');
      return;
    }
    state.protocolVersion = 1;
    if (envelope.type === 'HELLO') {
      this.handleLegacyHello(socket, state, envelope.payload as {
        targetId?: string;
        publicKeyJwk: JsonWebKey;
        pairingCode?: string;
        capabilities: string[];
        extensionVersion: string;
      });
      return;
    }
    if (envelope.type === 'AUTH') {
      this.handleLegacyAuth(socket, state, envelope.payload as { targetId: string; signature: string; connectionEpoch: number });
      return;
    }
    if (!state.authenticated || !state.targetId || !state.epoch) {
      socket.close(4001, 'Authentication required');
      return;
    }
    const current = this.registry.get(state.targetId);
    if (!current || current.socket !== socket || current.epoch !== state.epoch) return;
    const payload = envelope.payload as Record<string, unknown>;
    if (Number(payload.connectionEpoch) !== state.epoch) return;
    if (envelope.type === 'HEARTBEAT') {
      current.lastHeartbeatAt = Date.now();
      this.broker.onExtensionHeartbeat(state.targetId, state.epoch);
    } else if (envelope.type === 'ACK') {
      this.broker.onExtensionAck(state.targetId, state.epoch, String(payload.commandId));
    } else if (envelope.type === 'RESULT') {
      this.broker.onExtensionResult(state.targetId, state.epoch, {
        commandId: String(payload.commandId),
        ok: Boolean(payload.ok),
        ...(payload.output === undefined ? {} : { output: payload.output }),
        ...(payload.errorCode === undefined ? {} : { errorCode: String(payload.errorCode) })
      });
    }
  }

  private handleLegacyHello(socket: WebSocket, state: PendingSocketState, payload: {
    targetId?: string;
    publicKeyJwk: JsonWebKey;
    pairingCode?: string;
    capabilities: string[];
    extensionVersion: string;
  }): void {
    if (payload.pairingCode && !payload.targetId) {
      const target = this.broker.pairExtension(payload.pairingCode, payload.publicKeyJwk, payload.capabilities);
      const epoch = this.registry.nextEpoch(target.targetId);
      this.authenticateLegacySocket(socket, state, target.targetId, target.alias, epoch);
      this.sendLegacy(socket, 'PAIRED', { targetId: target.targetId, alias: target.alias, connectionEpoch: epoch });
      return;
    }
    if (!payload.targetId) throw new Error('targetId or pairingCode is required.');
    const target = this.requireTarget(payload.targetId);
    const epoch = this.registry.nextEpoch(target.targetId);
    state.targetId = target.targetId;
    state.epoch = epoch;
    state.challenge = randomBytes(32).toString('base64url');
    this.sendLegacy(socket, 'CHALLENGE', { nonce: state.challenge, connectionEpoch: epoch });
  }

  private handleLegacyAuth(
    socket: WebSocket,
    state: PendingSocketState,
    payload: { targetId: string; signature: string; connectionEpoch: number }
  ): void {
    if (!state.targetId || !state.epoch || !state.challenge || payload.targetId !== state.targetId || payload.connectionEpoch !== state.epoch) {
      throw new Error('Authentication state mismatch.');
    }
    const target = this.requireTarget(state.targetId);
    if (!this.verifySignature(target, state.challenge, payload.signature)) {
      socket.close(4003, 'Authentication failed');
      return;
    }
    this.authenticateLegacySocket(socket, state, target.targetId, target.alias, state.epoch);
    this.sendLegacy(socket, 'READY', { targetId: target.targetId, alias: target.alias, connectionEpoch: state.epoch });
  }

  private authenticateLegacySocket(
    socket: WebSocket,
    state: PendingSocketState,
    targetId: string,
    alias: string,
    epoch: number
  ): void {
    clearTimeout(state.handshakeTimer);
    state.authenticated = true;
    state.targetId = targetId;
    state.epoch = epoch;
    delete state.challenge;
    const previous = this.registry.bind({
      targetId,
      protocolVersion: 1,
      epoch,
      socket,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      lastProbeAt: 0,
      inventoryGeneration: 0,
      maxEnvelopeBytes: this.options.maxPayloadBytes ?? MAX_RELAY_V2_ENVELOPE_BYTES
    });
    if (previous && previous.socket !== socket) previous.socket.close(4002, 'Replaced by newer connection');
    this.store.updateTargetObservation(targetId, 'heartbeat');
    this.broker.onExtensionConnected(targetId, epoch);
    this.store.audit('extension.connected', { targetAlias: alias, connectionEpoch: epoch, protocolVersion: RELAY_PROTOCOL_VERSION });
  }

  private handleV2Heartbeat(
    connection: LiveExtensionConnection,
    payload: RelayV2PayloadByType['HEARTBEAT']
  ): void {
    if (payload.endpointId !== connection.endpointId || payload.connectionGeneration !== connection.epoch) return;
    connection.lastHeartbeatAt = Date.now();
    connection.inventoryGeneration = Math.max(connection.inventoryGeneration, payload.inventoryGeneration);
    this.store.updateTargetObservation(connection.targetId, 'heartbeat');
  }

  private handleInventory(
    connection: LiveExtensionConnection,
    payload: RelayV2PayloadByType['INVENTORY_SNAPSHOT']
  ): void {
    if (payload.connectionGeneration !== connection.epoch) return;
    connection.inventoryGeneration = Math.max(connection.inventoryGeneration, payload.inventoryGeneration);
    if (connection.endpointRef) this.eventSink?.onInventory(connection.endpointRef, payload);
    const pending = this.pendingAttempts.get(payload.attemptId);
    if (!pending || pending.kind !== 'inventory' || !this.sameGeneration(pending, connection)) return;
    clearTimeout(pending.timer);
    this.pendingAttempts.delete(payload.attemptId);
    pending.resolve(payload);
  }

  private handleOperationAck(connection: LiveExtensionConnection, payload: RelayV2PayloadByType['ACK']): void {
    if (payload.connectionGeneration !== connection.epoch) return;
    const pending = this.pendingAttempts.get(payload.attemptId);
    if (!pending || pending.kind !== 'operation' || !this.sameGeneration(pending, connection)
      || pending.operation !== payload.operation) return;
    pending.acknowledged = true;
  }

  private handleOperationResult(
    connection: LiveExtensionConnection,
    payload: RelayV2PayloadByType['OPERATION_RESULT']
  ): void {
    if (payload.observed.connectionGeneration !== connection.epoch) return;
    connection.inventoryGeneration = Math.max(connection.inventoryGeneration, payload.observed.inventoryGeneration);
    const pending = this.pendingAttempts.get(payload.attemptId);
    if (!pending || pending.kind !== 'operation' || !this.sameGeneration(pending, connection)
      || pending.operation !== payload.operation) return;
    clearTimeout(pending.timer);
    this.pendingAttempts.delete(payload.attemptId);
    pending.resolve(payload);
  }

  private handleCdpEvent(connection: LiveExtensionConnection, payload: RelayV2PayloadByType['CDP_EVENT']): void {
    if (payload.connectionGeneration !== connection.epoch || !connection.endpointRef) return;
    connection.inventoryGeneration = Math.max(connection.inventoryGeneration, payload.inventoryGeneration);
    this.eventSink?.onCdpEvent(connection.endpointRef, payload);
  }

  private handleDebuggerDetached(
    connection: LiveExtensionConnection,
    payload: RelayV2PayloadByType['DEBUGGER_DETACHED']
  ): void {
    if (payload.connectionGeneration !== connection.epoch || !connection.endpointRef) return;
    connection.inventoryGeneration = Math.max(connection.inventoryGeneration, payload.inventoryGeneration);
    this.eventSink?.onDebuggerDetached(connection.endpointRef, payload);
  }

  private handleV2Error(connection: LiveExtensionConnection, payload: RelayV2PayloadByType['ERROR']): void {
    if (payload.connectionGeneration !== null && payload.connectionGeneration !== connection.epoch) return;
    if (payload.attemptId) {
      const pending = this.pendingAttempts.get(payload.attemptId);
      if (!pending || !this.sameGeneration(pending, connection)) return;
      const message = `${payload.code}: ${payload.message}`;
      this.rejectPending(payload.attemptId,
        pending.kind === 'operation' && !pending.acknowledged && payload.code === 'STALE_INVENTORY_GENERATION'
          ? new InventoryRejectedBeforeDispatch(message) : new Error(message));
    }
  }

  private onSocketClose(socket: WebSocket, state: PendingSocketState, reason: string): void {
    clearTimeout(state.handshakeTimer);
    if (state.protocolVersion === 2 && state.endpointRef && state.epoch) {
      const removed = this.registry.removeEndpoint(state.endpointRef, state.epoch);
      if (removed) {
        this.rejectEndpointAttempts(state.endpointRef, state.epoch, reason);
        this.eventSink?.onDisconnected(state.endpointRef, state.epoch, reason);
      } else if (state.canonicalConnectionOpened && !state.authenticated) {
        this.octopusBroker?.closeEndpointConnection(state.endpointRef, state.epoch, reason);
      }
      return;
    }
    if (state.targetId && state.epoch && this.registry.remove(state.targetId, state.epoch)) {
      this.broker.onExtensionDisconnected(state.targetId, state.epoch);
    }
    void socket;
  }

  private canonicalizeTarget(target: StoredTarget, publicKeyJwk: JsonWebKey) {
    const fingerprint = createHash('sha256').update(JSON.stringify({
      kty: publicKeyJwk.kty,
      crv: publicKeyJwk.crv,
      x: publicKeyJwk.x,
      y: publicKeyJwk.y,
      n: publicKeyJwk.n,
      e: publicKeyJwk.e
    })).digest('hex');
    const endpoint = this.octopusBroker!.ensureEndpoint({
      nickname: target.alias,
      pairingIdentityHash: fingerprint,
      credential: { endpointId: target.targetId, publicKeyJwk },
      legacyTargetId: target.targetId
    });
    if (endpoint.pairingIdentityHash && endpoint.pairingIdentityHash !== fingerprint) {
      throw new Error(`Endpoint nickname ${target.alias} belongs to another pairing identity.`);
    }
    return endpoint;
  }

  private currentV2Connection(socket: WebSocket, state: PendingSocketState): LiveExtensionConnection | null {
    if (!state.authenticated || !state.endpointRef || !state.epoch) return null;
    const connection = this.registry.getEndpoint(state.endpointRef);
    if (!connection || connection.socket !== socket || connection.epoch !== state.epoch || connection.protocolVersion !== 2) return null;
    return connection;
  }

  private requireV2Connection(endpointRef: string): LiveExtensionConnection {
    const connection = this.registry.getEndpoint(endpointRef);
    if (!connection || connection.protocolVersion !== 2 || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Extension endpoint is not connected through relay v2.');
    }
    return connection;
  }

  private requireTarget(targetId: string): StoredTarget {
    const target = this.store.getTargetById(targetId);
    if (!target || target.revoked) throw new Error('Unknown or revoked target.');
    return target;
  }

  private verifySignature(target: StoredTarget, challenge: string, signature: string): boolean {
    const publicKey = createPublicKey({ key: target.publicKeyJwk as unknown as NodeJsonWebKey, format: 'jwk' });
    return verify(
      'sha256',
      Buffer.from(challenge),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    );
  }

  private attemptTimer(attemptId: string, reject: (error: Error) => void): NodeJS.Timeout {
    return setTimeout(() => {
      if (!this.pendingAttempts.delete(attemptId)) return;
      reject(new Error(`Extension attempt ${attemptId} timed out.`));
    }, this.options.operationTimeoutMs ?? 120_000);
  }

  private sameGeneration(pending: PendingAttempt, connection: LiveExtensionConnection): boolean {
    return pending.endpointRef === connection.endpointRef && pending.connectionGeneration === connection.epoch;
  }

  private rejectPending(attemptId: string, error: Error): void {
    const pending = this.pendingAttempts.get(attemptId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAttempts.delete(attemptId);
    pending.reject(error);
  }

  private rejectEndpointAttempts(endpointRef: string, generation: number, reason: string): void {
    for (const [attemptId, pending] of this.pendingAttempts) {
      if (pending.endpointRef === endpointRef && pending.connectionGeneration === generation) {
        this.rejectPending(attemptId, new Error(`Extension disconnected: ${reason}`));
      }
    }
  }

  private sendLegacy(socket: WebSocket, type: Parameters<typeof createRelayEnvelope>[0], payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(createRelayEnvelope(type, payload)));
  }

  private sendV2<Type extends RelayV2MessageType>(
    connection: LiveExtensionConnection,
    type: Type,
    payload: RelayV2PayloadByType[Type]
  ): void {
    if (connection.socket.readyState !== WebSocket.OPEN) throw new Error('Extension socket is not open.');
    connection.socket.send(JSON.stringify(createRelayV2Envelope(type, payload, connection.maxEnvelopeBytes)));
  }

  private sendV2Socket<Type extends RelayV2MessageType>(
    socket: WebSocket,
    state: PendingSocketState,
    type: Type,
    payload: RelayV2PayloadByType[Type]
  ): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(createRelayV2Envelope(type, payload, state.negotiatedMaxEnvelopeBytes)));
    }
  }

  private sendProtocolError(
    socket: WebSocket,
    state: PendingSocketState,
    code: string,
    message: string,
    retryable: boolean,
    attemptId: string | null
  ): void {
    if (state.protocolVersion === 2) {
      this.sendV2Socket(socket, state, 'ERROR', {
        connectionGeneration: state.epoch ?? null,
        attemptId,
        code,
        message: message.slice(0, 4096),
        retryable,
        details: null
      });
    } else {
      this.sendLegacy(socket, 'ERROR', { code, message });
    }
  }

  private asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private allowedHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const hostname = hostHeader.replace(/^\[/, '').split(']')[0]!.split(':')[0]!.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  }

  private hostKind(hostHeader: string | undefined): 'loopback-ip' | 'localhost' | 'other' | 'missing' {
    if (!hostHeader) return 'missing';
    const hostname = hostHeader.replace(/^\[/, '').split(']')[0]!.split(':')[0]!.toLowerCase();
    if (hostname === '127.0.0.1' || hostname === '::1') return 'loopback-ip';
    if (hostname === 'localhost') return 'localhost';
    return 'other';
  }
}
