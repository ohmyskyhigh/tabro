import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { expect } from 'vitest';
import WebSocket from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  MAX_RELAY_V2_ENVELOPE_BYTES,
  createRelayV2Envelope,
  parseRelayV2Envelope,
  type RelayV2Envelope,
  type RelayV2MessageType,
  type RelayV2PayloadByType
} from '../../apps/shared/protocol/src/index.js';

export const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface SimulatedTab {
  tabId: number;
  groupId: number | null;
  attached: boolean;
}

export class SimulatedV2Extension {
  private socket: WebSocket | null = null;
  private endpointId = '';
  private connectionGeneration = 0;
  private inventoryGeneration = 1;
  private nextTabId: number;
  private readonly tabs = new Map<number, SimulatedTab>();
  private groupTitle = '';
  readonly executedCdp: string[] = [];
  cdpDelayMs = 0;
  disconnectBeforeNextTab = false;
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private readonly droppedAttempts = new Set<string>();

  constructor(
    readonly marker: string,
    private readonly windowId: number,
    private readonly groupId: number,
    firstTabId: number
  ) {
    this.nextTabId = firstTabId;
  }

  async pair(url: string, proposedNickname: string, pairingCode: string): Promise<void> {
    const keys = this.keys;
    const publicKeyJwk = keys.publicKey.export({ format: 'jwk' }) as RelayV2PayloadByType['HELLO']['publicKeyJwk'];
    this.socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('open', resolve);
      this.socket!.once('error', reject);
    });

    if (!this.endpointId) {
    const pairedNext = this.nextMessage();
    this.send('HELLO', {
      publicKeyJwk,
      pairingCode,
      proposedNickname,
      extensionVersion: '0.3.0-test',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    });
    const paired = await pairedNext as RelayV2Envelope<'PAIRED'>;
    expect(paired.type).toBe('PAIRED');
    this.endpointId = paired.payload.endpointId;
    }

    const challengeNext = this.nextMessage();
    this.send('HELLO', {
      endpointId: this.endpointId,
      publicKeyJwk,
      proposedNickname,
      extensionVersion: '0.3.0-test',
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      supportedProtocolVersions: [2],
      capabilityManifestIds: ['octopus-extension-baseline-v1'],
      maxEnvelopeBytes: MAX_RELAY_V2_ENVELOPE_BYTES
    });
    const challenge = await challengeNext as RelayV2Envelope<'CHALLENGE'>;
    this.connectionGeneration = challenge.payload.connectionGeneration;
    const readyNext = this.nextMessage();
    this.send('AUTH', {
      endpointId: this.endpointId,
      signature: sign('sha256', Buffer.from(challenge.payload.nonce), {
        key: keys.privateKey,
        dsaEncoding: 'ieee-p1363'
      }).toString('base64url'),
      connectionGeneration: this.connectionGeneration,
      selectedProtocolVersion: 2
    });
    const ready = await readyNext;
    expect(ready.type).toBe('READY');

    this.socket.on('message', (data) => this.onMessage(data));
    this.sendInventory(randomUUID());
  }

  async close(): Promise<void> {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket!.once('close', resolve);
      this.socket!.close(1000, 'fixture complete');
    });
  }

  private nextMessage(): Promise<RelayV2Envelope> {
    return new Promise((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData): void => {
        cleanup();
        try { resolve(parseRelayV2Envelope(JSON.parse(data.toString()) as unknown)); }
        catch (error) { reject(error); }
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error('Socket closed before relay-v2 message.'));
      };
      const cleanup = (): void => {
        this.socket!.off('message', onMessage);
        this.socket!.off('close', onClose);
      };
      this.socket!.once('message', onMessage);
      this.socket!.once('close', onClose);
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const message = parseRelayV2Envelope(JSON.parse(data.toString()) as unknown);
    if (message.type === 'RECONCILE_ATTEMPT' && this.droppedAttempts.has(message.payload.reconciledAttemptId)) {
      this.succeed(message, { found: false, reconciledAttemptId: message.payload.reconciledAttemptId });
      return;
    }
    if (message.type === 'INVENTORY_REQUEST') {
      this.sendInventory(message.payload.attemptId);
      return;
    }
    if (message.type === 'CREATE_TAB') {
      if (this.disconnectBeforeNextTab) {
        this.disconnectBeforeNextTab = false;
        this.droppedAttempts.add(message.payload.attemptId);
        this.socket!.close(1000, 'Injected disconnect before effect');
        return;
      }
      const tabId = this.nextTabId++;
      this.tabs.set(tabId, { tabId, groupId: message.payload.group?.tabGroupId ?? null, attached: false });
      this.succeed(message, {
        tab: {
          tabId,
          tabGeneration: 1,
          windowId: this.windowId,
          windowGeneration: 1,
          title: `${this.marker} managed tab`,
          url: 'about:blank'
        },
        group: message.payload.group
      }, { tabGeneration: 1, groupGeneration: message.payload.group?.groupGeneration ?? null });
      return;
    }
    if (message.type === 'GROUP_TABS') {
      for (const locator of message.payload.tabs) {
        const tab = this.tabs.get(locator.tabId);
        if (tab) tab.groupId = this.groupId;
      }
      const group = {
        tabGroupId: this.groupId,
        groupGeneration: 1,
        windowId: this.windowId,
        windowGeneration: 1
      };
      this.succeed(message, { group, tabs: message.payload.tabs }, { groupGeneration: 1 });
      return;
    }
    if (message.type === 'RENAME_GROUP') {
      this.groupTitle = message.payload.title;
      this.succeed(message, { group: { ...message.payload.group, title: this.groupTitle } }, { groupGeneration: 1 });
      return;
    }
    if (message.type === 'ATTACH_DEBUGGER') {
      const tab = this.tabs.get(message.payload.tab.tabId);
      if (tab) tab.attached = true;
      this.succeed(message, { attachmentGeneration: 1, protocolVersion: '1.3' }, {
        tabGeneration: message.payload.tab.tabGeneration,
        attachmentGeneration: 1
      });
      return;
    }
    if (message.type === 'SEND_CDP') {
      this.executedCdp.push(message.payload.method);
      const respond = () => this.succeed(message, {
        rawResult: { marker: this.marker, sequence: this.executedCdp.length },
        sessionId: null
      }, {
        tabGeneration: message.payload.tab.tabGeneration,
        attachmentGeneration: message.payload.expected.attachmentGeneration ?? 1
      });
      if (this.cdpDelayMs) setTimeout(respond, this.cdpDelayMs); else respond();
    }
  }

  private sendInventory(attemptId: string): void {
    this.send('INVENTORY_SNAPSHOT', {
      attemptId,
      connectionGeneration: this.connectionGeneration,
      inventoryGeneration: this.inventoryGeneration,
      capturedAt: new Date().toISOString(),
      browser: { product: 'Chrome', version: '140.0.0.0', userAgent: null },
      windows: [{
        windowId: this.windowId,
        windowGeneration: 1,
        focused: true,
        incognito: false,
        type: 'normal',
        state: 'normal',
        groups: this.groupTitle.length === 0 ? [] : [{
          tabGroupId: this.groupId,
          groupGeneration: 1,
          windowId: this.windowId,
          title: this.groupTitle,
          color: 'blue',
          collapsed: false
        }],
        tabs: [...this.tabs.values()].map((tab) => ({
          tabId: tab.tabId,
          tabGeneration: 1,
          windowId: this.windowId,
          groupId: tab.groupId,
          openerTabId: null,
          active: true,
          pinned: false,
          discarded: false,
          status: 'complete',
          url: 'about:blank',
          title: `${this.marker} managed tab`,
          debugger: {
            attached: tab.attached,
            attachmentGeneration: tab.attached ? 1 : null,
            protocolVersion: tab.attached ? '1.3' : null
          }
        }))
      }]
    });
  }

  private succeed<Type extends Exclude<RelayV2MessageType,
    'HELLO' | 'CHALLENGE' | 'AUTH' | 'PAIRED' | 'READY' | 'HEARTBEAT' | 'INVENTORY_REQUEST'
    | 'INVENTORY_SNAPSHOT' | 'ACK' | 'OPERATION_RESULT' | 'CDP_EVENT' | 'DEBUGGER_DETACHED' | 'ERROR'>>(
    message: RelayV2Envelope<Type>,
    result: NonNullable<RelayV2PayloadByType['OPERATION_RESULT']['result']>,
    generations: {
      tabGeneration?: number | null;
      groupGeneration?: number | null;
      attachmentGeneration?: number | null;
    } = {}
  ): void {
    this.inventoryGeneration += 1;
    this.send('ACK', {
      attemptId: message.payload.attemptId,
      operation: message.type,
      expected: message.payload.expected,
      connectionGeneration: this.connectionGeneration,
      acceptedAt: new Date().toISOString()
    });
    this.send('OPERATION_RESULT', {
      attemptId: message.payload.attemptId,
      operation: message.type,
      expected: message.payload.expected,
      observed: {
        connectionGeneration: this.connectionGeneration,
        inventoryGeneration: this.inventoryGeneration,
        tabGeneration: generations.tabGeneration ?? null,
        groupGeneration: generations.groupGeneration ?? null,
        attachmentGeneration: generations.attachmentGeneration ?? null
      },
      outcome: 'succeeded',
      result,
      error: null,
      completedAt: new Date().toISOString()
    });
  }

  private send<Type extends RelayV2MessageType>(type: Type, payload: RelayV2PayloadByType[Type]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Fixture socket is not open.');
    this.socket.send(JSON.stringify(createRelayV2Envelope(type, payload)));
  }
}

export async function connectAgent(port: number, token: string, session: string): Promise<Client> {
  const client = new Client({ name: session, version: '0.3.0-test' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: {
      headers: {
        'x-octopus-contract-version': '5', Authorization: `Bearer ${token}`,
        'x-octopus-runtime': 'codex',
        'x-octopus-runtime-session': session
      }
    }
  }));
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
  return result.structuredContent as Record<string, unknown>;
}

export const ticketRef = (output: Record<string, unknown>): string =>
  String(((output.facts as { ticket: { request_ref: string } }).ticket).request_ref);

export async function waitTicket(client: Client, requestRef: string): Promise<Record<string, unknown>> {
  let ticket: Record<string, unknown> = {};
  await waitFor(async () => {
    const response = await call(client, 'get_browser_request', { request_ref: requestRef });
    ticket = (response.facts as { ticket: Record<string, unknown> }).ticket;
    return ['succeeded', 'failed', 'cancelled'].includes(String(ticket.state));
  });
  return ticket;
}
