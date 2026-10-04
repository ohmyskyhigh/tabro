import {
  MAX_RELAY_V2_ENVELOPE_BYTES,
  RELAY_PROTOCOL_V2,
  createRelayV2Envelope,
  parseRelayV2Envelope,
  relayV2PayloadSchemas,
  type RelayV2Envelope,
  type RelayV2MessageType,
  type RelayV2PayloadByType
} from '../../../shared/protocol/src/relay/v2-messages.js';
import { detectBrowserDescriptor } from '../browser/browser-descriptor.js';
import { initializeManagedBootstrap, rememberManagedAuthentication } from '../identity/managed-bootstrap.js';
import { BrowserInventory } from '../browser/inventory.js';
import { TabGroupOperations } from '../browser/tab-groups.js';
import { loadSettings } from '../config.js';
import { DebuggerAttachmentManager } from '../debugger/attachment-manager.js';
import { CdpExecutor } from '../debugger/cdp-executor.js';
import { RecentAttemptCache } from '../executor/recent-command-cache.js';
import {
  loadOrCreateIdentity,
  regeneratePairingLabel,
  savePairing,
  signChallenge,
  type DeviceIdentity
} from '../identity/device-identity.js';
import { RelayDispatcher } from '../protocol/dispatcher.js';
import { decideExtensionReload, normalizeLegacyReadyEnvelope } from '../update/extension-update.js';
import { openRelayTransport, type RelayTransport, type RelayTransportClose } from './relay-transport.js';

const CAPABILITY_MANIFEST_ID = 'octopus-extension-baseline-v1';

const jitter = (max: number): number => {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] ?? 0) % Math.max(1, max);
};

const serializedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const checkedPublicJwk = (value: JsonWebKey): RelayV2PayloadByType['HELLO']['publicKeyJwk'] => {
  if (typeof value.kty !== 'string' || value.kty.length === 0) {
    throw new Error('The profile pairing public key is invalid.');
  }
  return value as RelayV2PayloadByType['HELLO']['publicKeyJwk'];
};

export class RelayClient {
  private managedClaim: RelayV2PayloadByType['HELLO']['managedClaim'];
  private socket: RelayTransport | null = null;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private managedNicknameRetries = 0;
  private connectionGeneration: number | null = null;
  private endpointId: string | null = null;
  private stopped = false;
  private lastProtocolError: string | null = null;
  private negotiatedMaxEnvelopeBytes = MAX_RELAY_V2_ENVELOPE_BYTES;

  private readonly browser = detectBrowserDescriptor();
  private readonly inventory = new BrowserInventory();
  private readonly tabGroups = new TabGroupOperations(this.inventory);
  private readonly attempts = new RecentAttemptCache();
  private readonly attachments = new DebuggerAttachmentManager(this.inventory);
  private readonly cdp = new CdpExecutor(this.attachments, this.attempts);
  private readonly dispatcher = new RelayDispatcher({
    inventory: this.inventory,
    tabGroups: this.tabGroups,
    attachments: this.attachments,
    cdp: this.cdp,
    attempts: this.attempts,
    context: {
      connectionGeneration: () => this.connectionGeneration,
      endpointId: () => this.endpointId,
      browser: this.browser
    },
    send: (envelope) => this.sendEnvelope(envelope)
  });
  private inventoryPublishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const schedule = (): void => this.scheduleInventoryPublish();
    chrome.tabs.onCreated.addListener(schedule);
    chrome.tabs.onUpdated.addListener(schedule);
    chrome.tabs.onRemoved.addListener(schedule);
    chrome.tabs.onMoved.addListener(schedule);
    chrome.tabs.onAttached.addListener(schedule);
    chrome.tabs.onDetached.addListener(schedule);
    chrome.windows.onCreated.addListener(schedule);
    chrome.windows.onRemoved.addListener(schedule);
    chrome.windows.onFocusChanged.addListener(schedule);
    chrome.tabGroups.onCreated.addListener(schedule);
    chrome.tabGroups.onUpdated.addListener(schedule);
    chrome.tabGroups.onMoved.addListener(schedule);
    chrome.tabGroups.onRemoved.addListener(schedule);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    if (this.socket || this.connecting) return;
    this.connecting = true;
    await chrome.storage.local.set({ connectionStatus: 'connecting', lastError: null });
    try {
      this.managedClaim = await initializeManagedBootstrap();
      const settings = await loadSettings();
      const identity = await loadOrCreateIdentity();
      this.endpointId = identity.endpointId ?? null;
      const transport = await openRelayTransport(settings.transportMode, settings.brokerUrl);
      if (this.stopped) {
        transport.close(1000, 'Connection cancelled');
        return;
      }
      this.socket = transport;
      transport.onMessage((message) => void this.onMessage(transport, message));
      transport.onClose((event) => this.onClose(transport, event));
      transport.onError((message) => {
        if (this.socket !== transport) return;
        void chrome.storage.local.set({
          connectionStatus: 'error',
          lastError: message,
          transportKind: transport.kind
        });
      });
      this.reconnectAttempt = 0;
      this.lastProtocolError = null;
      this.negotiatedMaxEnvelopeBytes = MAX_RELAY_V2_ENVELOPE_BYTES;
      await chrome.storage.local.set({
        connectionStatus: 'authenticating',
        lastError: null,
        transportKind: transport.kind,
        relayProtocolVersion: RELAY_PROTOCOL_V2
      });
      this.sendHello(identity);
    } catch (error) {
      await chrome.storage.local.set({
        connectionStatus: 'error',
        lastError: error instanceof Error ? error.message : 'Connection initialization failed',
        transportKind: null
      });
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.inventoryPublishTimer) clearTimeout(this.inventoryPublishTimer);
    this.socket?.close(1000, 'Extension disconnect');
    this.socket = null;
    this.connectionGeneration = null;
  }

  async resetRuntime(): Promise<void> {
    this.disconnect();
    await this.attachments.detachAll();
    this.endpointId = null;
    setTimeout(() => void this.connect(), 50);
  }

  private async onMessage(transport: RelayTransport, raw: unknown): Promise<void> {
    if (this.socket !== transport || typeof raw !== 'string') return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const compatible = normalizeLegacyReadyEnvelope(parsed, chrome.runtime.getManifest().version);
      const envelope = parseRelayV2Envelope(compatible, this.negotiatedMaxEnvelopeBytes);
      if (envelope.type === 'CHALLENGE') {
        await this.onChallenge(envelope as RelayV2Envelope<'CHALLENGE'>);
      } else if (envelope.type === 'PAIRED') {
        await this.onPaired(envelope as RelayV2Envelope<'PAIRED'>);
      } else if (envelope.type === 'READY') {
        await this.onReady(envelope as RelayV2Envelope<'READY'>);
      } else if (envelope.type === 'ERROR') {
        await this.onProtocolError(envelope as RelayV2Envelope<'ERROR'>);
      } else {
        await this.dispatcher.dispatch(envelope);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid relay message.';
      this.sendEnvelope(createRelayV2Envelope('ERROR', {
        connectionGeneration: this.connectionGeneration,
        attemptId: null,
        code: 'INVALID_RELAY_MESSAGE',
        message,
        retryable: false,
        details: null
      }));
    }
  }

  private async onChallenge(envelope: RelayV2Envelope<'CHALLENGE'>): Promise<void> {
    const payload = relayV2PayloadSchemas.CHALLENGE.parse(envelope.payload);
    const identity = await loadOrCreateIdentity();
    if (!identity.endpointId) {
      throw new Error('The broker challenged an extension that has not completed pairing.');
    }
    this.connectionGeneration = payload.connectionGeneration;
    this.negotiatedMaxEnvelopeBytes = Math.min(payload.brokerMaxEnvelopeBytes, MAX_RELAY_V2_ENVELOPE_BYTES);
    const signature = await signChallenge(identity.privateKeyJwk, payload.nonce);
    this.sendEnvelope(createRelayV2Envelope('AUTH', {
      endpointId: identity.endpointId,
      signature,
      connectionGeneration: payload.connectionGeneration,
      selectedProtocolVersion: RELAY_PROTOCOL_V2
    }, this.negotiatedMaxEnvelopeBytes));
  }

  private async onPaired(envelope: RelayV2Envelope<'PAIRED'>): Promise<void> {
    const payload = relayV2PayloadSchemas.PAIRED.parse(envelope.payload);
    await savePairing(payload.endpointId, payload.nickname);
    this.endpointId = payload.endpointId;
    this.connectionGeneration = payload.connectionGeneration;
    await chrome.storage.local.set({
      connectionStatus: 'authenticating',
      endpointNickname: payload.nickname,
      targetAlias: payload.nickname,
      connectionGeneration: payload.connectionGeneration,
      capabilityManifestId: payload.selectedCapabilityManifestId,
      lastError: null
    });
    // Pairing establishes identity; a second HELLO proves possession through CHALLENGE/AUTH.
    this.sendHello(await loadOrCreateIdentity());
  }

  private async onReady(envelope: RelayV2Envelope<'READY'>): Promise<void> {
    const payload = relayV2PayloadSchemas.READY.parse(envelope.payload);
    await rememberManagedAuthentication(this.managedClaim);
    const identity = await loadOrCreateIdentity();
    if (identity.endpointId !== payload.endpointId) {
      throw new Error('The ready endpoint does not match this profile identity.');
    }
    const currentVersion = chrome.runtime.getManifest().version;
    const reloadState = await chrome.storage.local.get('extensionReloadAttemptedForVersion');
    const attemptedVersion = typeof reloadState.extensionReloadAttemptedForVersion === 'string'
      ? reloadState.extensionReloadAttemptedForVersion
      : null;
    const reloadDecision = decideExtensionReload({
      currentVersion,
      requiredVersion: payload.requiredExtensionVersion,
      reloadRequested: payload.reloadExtension,
      attemptedVersion
    });
    if (reloadDecision.kind === 'reload') {
      await chrome.storage.local.set({
        connectionStatus: 'updating',
        brokerVersion: payload.brokerVersion,
        requiredExtensionVersion: reloadDecision.requiredVersion,
        extensionReloadAttemptedForVersion: reloadDecision.requiredVersion,
        lastError: null
      });
      this.disconnect();
      setTimeout(() => chrome.runtime.reload(), 50);
      return;
    }
    if (reloadDecision.kind === 'blocked') {
      this.lastProtocolError = reloadDecision.message;
      await chrome.storage.local.set({
        connectionStatus: 'error',
        brokerVersion: payload.brokerVersion,
        requiredExtensionVersion: payload.requiredExtensionVersion,
        lastError: reloadDecision.message
      });
      this.stopped = true;
      this.socket?.close(4000, 'Extension update requires operator action');
      return;
    }
    await chrome.storage.local.remove('extensionReloadAttemptedForVersion');
    this.endpointId = payload.endpointId;
    this.connectionGeneration = payload.connectionGeneration;
    await chrome.storage.local.set({
      connectionStatus: 'connected',
      endpointNickname: payload.nickname,
      targetAlias: payload.nickname,
      connectionGeneration: payload.connectionGeneration,
      capabilityManifestId: payload.selectedCapabilityManifestId,
      brokerVersion: payload.brokerVersion,
      requiredExtensionVersion: payload.requiredExtensionVersion,
      lastError: null
    });
    this.startHeartbeat();
    const snapshot = await this.dispatcher.initialInventory();
    this.sendEnvelope(createRelayV2Envelope('INVENTORY_SNAPSHOT', snapshot, this.negotiatedMaxEnvelopeBytes));
  }

  private async onProtocolError(envelope: RelayV2Envelope<'ERROR'>): Promise<void> {
    const payload = relayV2PayloadSchemas.ERROR.parse(envelope.payload);
    if (payload.code === 'ENDPOINT_NICKNAME_CONFLICT' && !this.endpointId) {
      if (this.managedClaim && this.managedNicknameRetries < 5) {
        this.managedNicknameRetries++;
        await regeneratePairingLabel();
        this.socket?.close(4009, 'Retry managed Profile nickname');
        return;
      }
      this.lastProtocolError = `${payload.code}: ${payload.message}`;
      await chrome.storage.local.set({ connectionStatus: 'error', lastError: this.lastProtocolError });
      this.stopped = true;
      this.socket?.close(4009, 'Pairing code must be changed by the user');
      return;
    }
    this.lastProtocolError = `${payload.code}: ${payload.message}`;
    await chrome.storage.local.set({ connectionStatus: 'error', lastError: this.lastProtocolError });
    if (!payload.retryable) {
      this.stopped = true;
      this.socket?.close(4000, 'Broker rejected relay session');
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const beat = () => {
      if (this.connectionGeneration && this.endpointId) {
        this.sendEnvelope(createRelayV2Envelope('HEARTBEAT', {
          endpointId: this.endpointId,
          connectionGeneration: this.connectionGeneration,
          inventoryGeneration: this.inventory.currentGeneration(),
          activeAttemptIds: this.dispatcher.activeAttemptIds().slice(0, 64)
        }, this.negotiatedMaxEnvelopeBytes));
      }
    };
    beat();
    this.heartbeatTimer = setInterval(beat, 20_000);
  }

  private scheduleInventoryPublish(): void {
    if (this.connectionGeneration === null || !this.socket) return;
    if (this.inventoryPublishTimer) clearTimeout(this.inventoryPublishTimer);
    this.inventoryPublishTimer = setTimeout(() => {
      this.inventoryPublishTimer = null;
      void (async () => {
        if (this.connectionGeneration === null || !this.socket) return;
        try {
          const snapshot = await this.dispatcher.initialInventory();
          this.sendEnvelope(createRelayV2Envelope('INVENTORY_SNAPSHOT', snapshot, this.negotiatedMaxEnvelopeBytes));
        } catch (error) {
          await chrome.storage.local.set({
            lastError: error instanceof Error ? error.message : 'Browser inventory publication failed.'
          });
        }
      })();
    }, 100);
  }

  private sendEnvelope<Type extends RelayV2MessageType>(envelope: RelayV2Envelope<Type>): void {
    const bytes = serializedBytes(envelope);
    if (bytes > this.negotiatedMaxEnvelopeBytes) {
      throw new Error(`Relay envelope is ${bytes} bytes; negotiated maximum is ${this.negotiatedMaxEnvelopeBytes}.`);
    }
    if (!this.socket) throw new Error('Relay transport is not connected.');
    this.socket.send(JSON.stringify(envelope));
  }

  private sendHello(identity: DeviceIdentity): void {
    if (!identity.endpointId && !identity.pairingCode) {
      throw new Error('An unpaired profile must have an extension-generated pairing code.');
    }
    this.sendEnvelope(createRelayV2Envelope('HELLO', {
      profileProxy: 1,
      ...(this.managedClaim ? { managedClaim: this.managedClaim } : {}),
      ...(identity.endpointId ? { endpointId: identity.endpointId } : {}),
      ...(identity.pairingCode ? { pairingCode: identity.pairingCode } : {}),
      publicKeyJwk: checkedPublicJwk(identity.publicKeyJwk),
      proposedNickname: identity.proposedNickname,
      extensionVersion: chrome.runtime.getManifest().version,
      browser: this.browser,
      supportedProtocolVersions: [RELAY_PROTOCOL_V2],
      capabilityManifestIds: [CAPABILITY_MANIFEST_ID],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    }));
  }

  private onClose(transport: RelayTransport, event: RelayTransportClose): void {
    if (this.socket !== transport) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.connectionGeneration = null;
    this.socket = null;
    if (this.lastProtocolError) {
      void chrome.storage.local.set({ connectionStatus: 'error', lastError: this.lastProtocolError });
    } else if (!this.stopped && event.code !== 1000) {
      void chrome.storage.local.set({
        connectionStatus: 'disconnected',
        lastError: event.reason || `Relay closed the connection (code ${event.code})`
      });
    } else {
      void chrome.storage.local.set({ connectionStatus: 'disconnected' });
    }
    if (this.stopped || this.lastProtocolError) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const base = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => void this.connect(), base + jitter(Math.max(1, Math.floor(base / 2))));
  }
}

// Keep the old class name available while service-worker and downstream imports migrate.
export { RelayClient as RelayWebSocketClient };
