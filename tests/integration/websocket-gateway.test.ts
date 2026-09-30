import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { BrokerCore, OctopusBroker, type ExtensionEventSink } from '../../apps/broker/src/core/index.js';
import { ExtensionGateway, type LiveExtensionConnection } from '../../apps/broker/src/extension-relay/index.js';
import {
  MAX_RELAY_V2_ENVELOPE_BYTES,
  createRelayEnvelope,
  createRelayV2Envelope,
  parseRelayEnvelope,
  parseRelayV2Envelope,
  type RelayEnvelope,
  type RelayV2Envelope,
  type RelayV2PayloadByType
} from '../../apps/shared/protocol/src/index.js';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';

function nextMessage(socket: WebSocket): Promise<RelayEnvelope> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      try { resolve(parseRelayEnvelope(JSON.parse(data.toString()) as unknown)); }
      catch (error) { reject(error); }
    };
    const onClose = () => { cleanup(); reject(new Error('Socket closed before message.')); };
    const cleanup = () => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.once('message', onMessage);
    socket.once('close', onClose);
  });
}

function nextV2Message(socket: WebSocket): Promise<RelayV2Envelope> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      try { resolve(parseRelayV2Envelope(JSON.parse(data.toString()) as unknown)); }
      catch (error) { reject(error); }
    };
    const onClose = () => { cleanup(); reject(new Error('Socket closed before relay-v2 message.')); };
    const cleanup = () => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.once('message', onMessage);
    socket.once('close', onClose);
  });
}

describe('extension WebSocket gateway', () => {
  let store: SqliteRelayStore;
  let broker: BrokerCore;
  let octopus: OctopusBroker;
  let gateway: ExtensionGateway;
  let socket: WebSocket | null;

  beforeEach(() => {
    store = new SqliteRelayStore(':memory:');
    broker = new BrokerCore(store);
    octopus = new OctopusBroker(store.canonical);
    gateway = new ExtensionGateway(
      broker,
      store,
      { host: '127.0.0.1', port: 0, serviceVersion: '0.3.0-test' },
      octopus
    );
    broker.setTransport(gateway);
    socket = null;
  });

  afterEach(async () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => { socket!.once('close', () => resolve()); socket!.close(); });
    }
    await gateway.stop();
    store.close();
  });

  it('pairs, authenticates, delivers, and correlates a command', async () => {
    const admin = store.createAgent('admin', ['broker:admin', 'browser:read', 'browser:write', 'sessions:write']);
    const pairing = broker.createPairingCode(admin.principal, 'profile-a', 60_000);
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await gateway.start();
    const { port } = gateway.address();
    socket = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await new Promise<void>((resolve, reject) => { socket!.once('open', () => resolve()); socket!.once('error', reject); });
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(async (response) => response.json()) as {
      websocketUpgrades: { attempts: number; accepted: number; rejected: number; lastResult: string };
    };
    expect(health.websocketUpgrades).toMatchObject({ attempts: 1, accepted: 1, rejected: 0, lastResult: 'accepted' });
    const pairedMessage = nextMessage(socket);
    socket.send(JSON.stringify(createRelayEnvelope('HELLO', {
      publicKeyJwk: keys.publicKey.export({ format: 'jwk' }),
      pairingCode: pairing.pairingCode,
      capabilities: ['list_tabs'],
      extensionVersion: '0.1.0'
    })));
    const paired = await pairedMessage;
    expect(paired.type).toBe('PAIRED');
    const payload = paired.payload as { targetId: string; connectionEpoch: number };
    const bindingRef = broker.bindAgent(admin.principal, admin.principal.principalId, 'profile-a').bindingRef;
    expect(broker.getTarget(admin.principal, bindingRef).status).toBe('available');

    const commandMessage = nextMessage(socket);
    const receipt = broker.dispatch({
      principal: admin.principal,
      bindingRef,
      operation: 'list_tabs',
      parameters: {},
      idempotencyClass: 'read',
      waitMs: 0,
      deadlineMs: 10_000
    });
    const command = await commandMessage;
    expect(command.type).toBe('COMMAND');
    socket.send(JSON.stringify(createRelayEnvelope('ACK', { commandId: receipt.commandId, connectionEpoch: payload.connectionEpoch })));
    socket.send(JSON.stringify(createRelayEnvelope('RESULT', {
      commandId: receipt.commandId,
      connectionEpoch: payload.connectionEpoch,
      ok: true,
      output: { tabs: [{ title: 'fixture-a' }] }
    })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(broker.getCommand(admin.principal, bindingRef, receipt.commandId).state).toBe('SUCCEEDED');

    const reconnect = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await new Promise<void>((resolve, reject) => { reconnect.once('open', () => resolve()); reconnect.once('error', reject); });
    const challengeMessage = nextMessage(reconnect);
    reconnect.send(JSON.stringify(createRelayEnvelope('HELLO', {
      targetId: payload.targetId,
      publicKeyJwk: keys.publicKey.export({ format: 'jwk' }),
      capabilities: ['list_tabs'],
      extensionVersion: '0.1.0'
    })));
    const challenge = await challengeMessage;
    expect(challenge.type).toBe('CHALLENGE');
    const challengePayload = challenge.payload as { nonce: string; connectionEpoch: number };
    const signature = sign('sha256', Buffer.from(challengePayload.nonce), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const readyMessage = nextMessage(reconnect);
    reconnect.send(JSON.stringify(createRelayEnvelope('AUTH', {
      targetId: payload.targetId,
      signature,
      connectionEpoch: challengePayload.connectionEpoch
    })));
    expect((await readyMessage).type).toBe('READY');
    await new Promise<void>((resolve) => { reconnect.once('close', () => resolve()); reconnect.close(); });
  });

  it.each([false, true])('pairs through relay v2 and correlates operations (pre-dispatch inventory rejection: %s)', async (rejectStaleInventory) => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKeyJwk = keys.publicKey.export({ format: 'jwk' }) as RelayV2PayloadByType['HELLO']['publicKeyJwk'];
    await gateway.start();
    const { port } = gateway.address();
    socket = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });

    const pairedMessage = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('HELLO', {
      publicKeyJwk,
      pairingCode: 'MINT-WAVE',
      proposedNickname: 'mintwave',
      extensionVersion: '0.3.0-test',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    })));
    const paired = await pairedMessage as RelayV2Envelope<'PAIRED'>;
    expect(paired.type).toBe('PAIRED');

    const challengeMessage = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('HELLO', {
      endpointId: paired.payload.endpointId,
      publicKeyJwk,
      pairingCode: 'CALM-REEF',
      proposedNickname: 'calmreef',
      extensionVersion: '0.3.0-test',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    })));
    const challenge = await challengeMessage as RelayV2Envelope<'CHALLENGE'>;
    expect(challenge.type).toBe('CHALLENGE');
    const signature = sign(
      'sha256',
      Buffer.from(challenge.payload.nonce),
      { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }
    ).toString('base64url');
    const readyMessage = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('AUTH', {
      endpointId: paired.payload.endpointId,
      signature,
      connectionGeneration: challenge.payload.connectionGeneration,
      selectedProtocolVersion: 2
    })));
    const ready = await readyMessage as RelayV2Envelope<'READY'>;
    expect(ready.type).toBe('READY');
    expect(ready.payload).toMatchObject({
      nickname: 'calmreef',
      brokerVersion: '0.3.0-test',
      requiredExtensionVersion: '0.3.0-test',
      reloadExtension: false
    });

    expect(store.getTargetById(paired.payload.endpointId)?.alias).toBe('calmreef');
    expect(store.canonical.logical.getEndpointByNickname('mintwave')).toBeNull();
    const endpoint = store.canonical.logical.getEndpointByNickname('calmreef');
    expect(endpoint).not.toBeNull();
    expect(gateway.connection(endpoint!.endpointRef)).toMatchObject({
      connected: true,
      connectionGeneration: challenge.payload.connectionGeneration
    });

    const live = (gateway as unknown as {
      registry: { values(): LiveExtensionConnection[] };
    }).registry.values()[0]!;
    live.lastHeartbeatAt = Date.now() - 5_000;
    live.lastProbeAt = 0;
    const pingReceived = new Promise<void>((resolve) => socket!.once('ping', () => resolve()));
    gateway.sweepHeartbeat(10_000);
    await pingReceived;
    for (let attempt = 0; attempt < 20 && live.lastHeartbeatAt < Date.now() - 1_000; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(live.lastHeartbeatAt).toBeGreaterThan(Date.now() - 1_000);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.send(JSON.stringify(createRelayV2Envelope('INVENTORY_SNAPSHOT', {
      attemptId: crypto.randomUUID(),
      connectionGeneration: challenge.payload.connectionGeneration,
      inventoryGeneration: 3,
      capturedAt: new Date().toISOString(),
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      windows: [{
        windowId: 5,
        windowGeneration: 1,
        focused: true,
        incognito: false,
        type: 'normal',
        state: 'normal',
        groups: [],
        tabs: []
      }]
    })));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.canonical.logical.listWindows(endpoint!.endpointRef)).toHaveLength(1);
    expect(gateway.connection(endpoint!.endpointRef)?.inventoryGeneration).toBe(3);

    const inventoryPromise = gateway.requestInventory(endpoint!.endpointRef, 3);
    const inventoryRequest = await nextV2Message(socket) as RelayV2Envelope<'INVENTORY_REQUEST'>;
    expect(inventoryRequest.type).toBe('INVENTORY_REQUEST');
    socket.send(JSON.stringify(createRelayV2Envelope('INVENTORY_SNAPSHOT', {
      attemptId: inventoryRequest.payload.attemptId,
      connectionGeneration: challenge.payload.connectionGeneration,
      inventoryGeneration: 4,
      capturedAt: new Date().toISOString(),
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      windows: []
    })));
    await expect(inventoryPromise).resolves.toMatchObject({ inventoryGeneration: 4 });

    const attemptId = crypto.randomUUID();
    const operationPromise = gateway.execute(endpoint!.endpointRef, 'CREATE_TAB', {
      attemptId,
      expected: { connectionGeneration: challenge.payload.connectionGeneration, inventoryGeneration: 4 },
      window: { windowId: 5, windowGeneration: 1 },
      group: null,
      url: null,
      active: true,
      index: null
    });
    let operation = await nextV2Message(socket) as RelayV2Envelope<'CREATE_TAB'>;
    expect(operation.payload.attemptId).toBe(attemptId);
    if (rejectStaleInventory) {
      const refreshNext = nextV2Message(socket);
      socket.send(JSON.stringify(createRelayV2Envelope('ERROR', {
        connectionGeneration: challenge.payload.connectionGeneration,
        attemptId, code: 'STALE_INVENTORY_GENERATION', message: 'Inventory changed before dispatch.', retryable: true, details: null
      })));
      const refresh = await refreshNext as RelayV2Envelope<'INVENTORY_REQUEST'>;
      expect(refresh.type).toBe('INVENTORY_REQUEST');
      const retriedNext = nextV2Message(socket);
      socket.send(JSON.stringify(createRelayV2Envelope('INVENTORY_SNAPSHOT', {
        attemptId: refresh.payload.attemptId,
        connectionGeneration: challenge.payload.connectionGeneration,
        inventoryGeneration: 5, capturedAt: new Date().toISOString(),
        browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null }, windows: []
      })));
      operation = await retriedNext as RelayV2Envelope<'CREATE_TAB'>;
      expect(operation.type).toBe('CREATE_TAB');
      expect(operation.payload.attemptId).toBe(attemptId);
      expect(operation.payload.expected.inventoryGeneration).toBe(5);
    }
    socket.send(JSON.stringify(createRelayV2Envelope('ACK', {
      attemptId,
      operation: 'CREATE_TAB',
      expected: operation.payload.expected,
      connectionGeneration: challenge.payload.connectionGeneration,
      acceptedAt: new Date().toISOString()
    })));
    socket.send(JSON.stringify(createRelayV2Envelope('OPERATION_RESULT', {
      attemptId,
      operation: 'CREATE_TAB',
      expected: operation.payload.expected,
      observed: {
        connectionGeneration: challenge.payload.connectionGeneration,
        inventoryGeneration: 5,
        tabGeneration: 1,
        groupGeneration: null,
        attachmentGeneration: null
      },
      outcome: 'succeeded',
      result: { tab: { tabId: 20, tabGeneration: 1, windowId: 5, windowGeneration: 1 } },
      error: null,
      completedAt: new Date().toISOString()
    })));
    await expect(operationPromise).resolves.toMatchObject({ outcome: 'succeeded' });

    const acknowledgedAttempt = crypto.randomUUID();
    const acknowledgedFailure = gateway.execute(endpoint!.endpointRef, 'CREATE_TAB', {
      ...operation.payload, attemptId: acknowledgedAttempt
    });
    const rejection = expect(acknowledgedFailure).rejects.toThrow('STALE_INVENTORY_GENERATION');
    const acknowledgedOperation = await nextV2Message(socket) as RelayV2Envelope<'CREATE_TAB'>;
    socket.send(JSON.stringify(createRelayV2Envelope('ACK', {
      attemptId: acknowledgedAttempt, operation: 'CREATE_TAB', expected: acknowledgedOperation.payload.expected,
      connectionGeneration: challenge.payload.connectionGeneration, acceptedAt: new Date().toISOString()
    })));
    socket.send(JSON.stringify(createRelayV2Envelope('ERROR', {
      attemptId: acknowledgedAttempt, connectionGeneration: challenge.payload.connectionGeneration,
      code: 'STALE_INVENTORY_GENERATION', message: 'Cannot prove no effect after ACK.', retryable: true, details: null
    })));
    await rejection;

    const firstSocket = socket;
    const firstSocketClosed = new Promise<void>((resolve) => firstSocket!.once('close', resolve));
    const replacement = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await new Promise<void>((resolve, reject) => { replacement.once('open', resolve); replacement.once('error', reject); });
    const replacementChallengeNext = nextV2Message(replacement);
    replacement.send(JSON.stringify(createRelayV2Envelope('HELLO', {
      endpointId: paired.payload.endpointId,
      publicKeyJwk,
      proposedNickname: 'octopus-test',
      extensionVersion: '0.3.0-test',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    })));
    const replacementChallenge = await replacementChallengeNext as RelayV2Envelope<'CHALLENGE'>;
    await firstSocketClosed;
    expect(replacementChallenge.payload.connectionGeneration).toBeGreaterThan(challenge.payload.connectionGeneration);
    const replacementReadyNext = nextV2Message(replacement);
    replacement.send(JSON.stringify(createRelayV2Envelope('AUTH', {
      endpointId: paired.payload.endpointId,
      signature: sign('sha256', Buffer.from(replacementChallenge.payload.nonce), {
        key: keys.privateKey,
        dsaEncoding: 'ieee-p1363'
      }).toString('base64url'),
      connectionGeneration: replacementChallenge.payload.connectionGeneration,
      selectedProtocolVersion: 2
    })));
    expect((await replacementReadyNext).type).toBe('READY');
    socket = replacement;
    expect(gateway.connection(endpoint!.endpointRef)?.connectionGeneration)
      .toBe(replacementChallenge.payload.connectionGeneration);
  });

  it.each(['0.2.0', '0.3.1', '99.0.0'])('accepts protocol-compatible extension %s without requesting a reload', async (extensionVersion) => {
    const readySpy = vi.spyOn(octopus, 'onExtensionReady');
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKeyJwk = keys.publicKey.export({ format: 'jwk' }) as RelayV2PayloadByType['HELLO']['publicKeyJwk'];
    await gateway.start();
    const { port } = gateway.address();
    socket = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });

    const pairedNext = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('HELLO', {
      publicKeyJwk,
      pairingCode: 'SOFT-CLOUD',
      proposedNickname: 'softcloud',
      extensionVersion,
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    })));
    const paired = await pairedNext as RelayV2Envelope<'PAIRED'>;

    const challengeNext = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('HELLO', {
      endpointId: paired.payload.endpointId,
      publicKeyJwk,
      proposedNickname: 'softcloud',
      extensionVersion,
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    })));
    const challenge = await challengeNext as RelayV2Envelope<'CHALLENGE'>;
    const readyNext = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('AUTH', {
      endpointId: paired.payload.endpointId,
      signature: sign('sha256', Buffer.from(challenge.payload.nonce), {
        key: keys.privateKey,
        dsaEncoding: 'ieee-p1363'
      }).toString('base64url'),
      connectionGeneration: challenge.payload.connectionGeneration,
      selectedProtocolVersion: 2
    })));
    const ready = await readyNext as RelayV2Envelope<'READY'>;
    expect(ready.payload).toMatchObject({
      brokerVersion: '0.3.0-test',
      requiredExtensionVersion: extensionVersion,
      reloadExtension: false
    });
    expect(readySpy).toHaveBeenCalledOnce();
  });

  it('returns a retryable conflict so an unpaired extension can generate another two-word nickname', async () => {
    store.registerExtension(
      'mintwave',
      { kty: 'EC', crv: 'P-256', x: 'existing-x', y: 'existing-y' },
      ['octopus-extension-baseline-v1']
    );
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKeyJwk = keys.publicKey.export({ format: 'jwk' }) as RelayV2PayloadByType['HELLO']['publicKeyJwk'];
    await gateway.start();
    const { port } = gateway.address();
    socket = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });

    const errorMessage = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('HELLO', {
      publicKeyJwk,
      pairingCode: 'MINT-WAVE',
      proposedNickname: 'mintwave',
      extensionVersion: '0.3.0-test',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    })));

    const error = await errorMessage as RelayV2Envelope<'ERROR'>;
    expect(error.type).toBe('ERROR');
    expect(error.payload).toMatchObject({ code: 'ENDPOINT_NICKNAME_CONFLICT', retryable: true });
  });

  it('forwards relay-v2 CDP events and disconnect only from the current generation', async () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKeyJwk = keys.publicKey.export({ format: 'jwk' }) as RelayV2PayloadByType['HELLO']['publicKeyJwk'];
    const seen = { cdp: 0, detached: 0, disconnected: 0 };
    const forwardingSink: ExtensionEventSink = {
      onInventory: (endpointRef, payload) => octopus.onInventory(endpointRef, payload),
      onCdpEvent: () => { seen.cdp += 1; },
      onDebuggerDetached: () => { seen.detached += 1; },
      onDisconnected: (endpointRef, generation, reason) => {
        seen.disconnected += 1;
        octopus.onDisconnected(endpointRef, generation, reason);
      }
    };
    gateway.setEventSink(forwardingSink);
    await gateway.start();
    const { port } = gateway.address();
    socket = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });

    const pairedNext = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('HELLO', {
      publicKeyJwk,
      pairingCode: 'CALM-REEF',
      proposedNickname: 'calmreef',
      extensionVersion: '0.3.0-test',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    })));
    const paired = await pairedNext as RelayV2Envelope<'PAIRED'>;
    const challengeNext = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('HELLO', {
      endpointId: paired.payload.endpointId,
      publicKeyJwk,
      proposedNickname: 'calmreef',
      extensionVersion: '0.3.0-test',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    })));
    const challenge = await challengeNext as RelayV2Envelope<'CHALLENGE'>;
    const readyNext = nextV2Message(socket);
    socket.send(JSON.stringify(createRelayV2Envelope('AUTH', {
      endpointId: paired.payload.endpointId,
      signature: sign('sha256', Buffer.from(challenge.payload.nonce), {
        key: keys.privateKey,
        dsaEncoding: 'ieee-p1363'
      }).toString('base64url'),
      connectionGeneration: challenge.payload.connectionGeneration,
      selectedProtocolVersion: 2
    })));
    await readyNext;

    const tab = { tabId: 8, tabGeneration: 1, windowId: 2, windowGeneration: 1 };
    socket.send(JSON.stringify(createRelayV2Envelope('CDP_EVENT', {
      connectionGeneration: challenge.payload.connectionGeneration + 1,
      inventoryGeneration: 99,
      tab,
      attachmentGeneration: 1,
      eventSequence: 1,
      method: 'Page.loadEventFired',
      params: { stale: true },
      sessionId: null,
      emittedAt: new Date().toISOString()
    })));
    socket.send(JSON.stringify(createRelayV2Envelope('CDP_EVENT', {
      connectionGeneration: challenge.payload.connectionGeneration,
      inventoryGeneration: 1,
      tab,
      attachmentGeneration: 1,
      eventSequence: 1,
      method: 'Page.loadEventFired',
      params: {},
      sessionId: null,
      emittedAt: new Date().toISOString()
    })));
    socket.send(JSON.stringify(createRelayV2Envelope('DEBUGGER_DETACHED', {
      connectionGeneration: challenge.payload.connectionGeneration,
      inventoryGeneration: 2,
      tab,
      attachmentGeneration: 1,
      reason: 'canceled_by_user',
      detachedAt: new Date().toISOString()
    })));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toMatchObject({ cdp: 1, detached: 1 });

    await new Promise<void>((resolve) => { socket!.once('close', resolve); socket!.close(1000, 'test complete'); });
    socket = null;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen.disconnected).toBe(1);
    expect(store.canonical.logical.getCurrentConnection(
      store.canonical.logical.getEndpointByNickname('calmreef')!.endpointRef
    )).toBeNull();
  });
});
