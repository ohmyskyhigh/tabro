import {
  createRelayV2Envelope,
  relayV2PayloadSchemas,
  type RelayV2Envelope,
  type RelayV2MessageType,
  type RelayV2PayloadByType
} from '../../../shared/protocol/src/relay/v2-messages.js';
import { ExtensionProxyController } from '../proxy/proxy-controller.js';
import { detectBrowserDescriptor, type BrowserDescriptor } from '../browser/browser-descriptor.js';
import {
  ExtensionAdapterError,
  type BrowserInventory,
  type BrowserInventorySnapshot,
  type PrivateGroupFact,
  type PrivateTabFact
} from '../browser/inventory.js';
import type { TabGroupOperations } from '../browser/tab-groups.js';
import type { AttachmentRecord, DebuggerAttachmentManager } from '../debugger/attachment-manager.js';
import type { CdpExecutor } from '../debugger/cdp-executor.js';
import { CdpEventForwarder } from '../debugger/event-forwarder.js';
import type {
  RecentAttemptCache,
  RecentAttemptOutcome
} from '../executor/recent-command-cache.js';

type MutationType =
  | 'PROFILE_PROXY'
  | 'CREATE_TAB'
  | 'GROUP_TABS'
  | 'MOVE_TAB'
  | 'RENAME_GROUP'
  | 'ATTACH_DEBUGGER'
  | 'SEND_CDP'
  | 'DETACH_DEBUGGER'
  | 'RECONCILE_ATTEMPT';

type Expected = RelayV2PayloadByType[MutationType]['expected'];
type RelayJson = string | number | boolean | null | RelayJson[] | { [key: string]: RelayJson };
type JsonObject = Record<string, RelayJson>;

export interface RelayDispatcherContext {
  connectionGeneration(): number | null;
  endpointId(): string | null;
  browser?: BrowserDescriptor;
}

export interface RelayDispatcherDependencies {
  inventory: BrowserInventory;
  tabGroups: TabGroupOperations;
  attachments: DebuggerAttachmentManager;
  cdp: CdpExecutor;
  attempts: RecentAttemptCache;
  context: RelayDispatcherContext;
  send<Type extends RelayV2MessageType>(envelope: RelayV2Envelope<Type>): void;
}

interface OperationObserved {
  connectionGeneration: number;
  inventoryGeneration: number;
  tabGeneration: number | null;
  groupGeneration: number | null;
  attachmentGeneration: number | null;
}

const mutationTypes = new Set<RelayV2MessageType>([
  'PROFILE_PROXY',
  'CREATE_TAB',
  'GROUP_TABS',
  'MOVE_TAB',
  'RENAME_GROUP',
  'ATTACH_DEBUGGER',
  'SEND_CDP',
  'DETACH_DEBUGGER',
  'RECONCILE_ATTEMPT'
]);

const asJsonObject = (value: unknown): JsonObject => {
  const normalized = JSON.parse(JSON.stringify(value ?? null)) as RelayJson;
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) return normalized;
  return { value: normalized };
};

export class RelayDispatcher {
  private proxy: ExtensionProxyController | null = null;
  private readonly activeAttempts = new Set<string>();
  private readonly browser: BrowserDescriptor;
  private readonly events: CdpEventForwarder;

  constructor(private readonly dependencies: RelayDispatcherDependencies) {
    this.browser = dependencies.context.browser ?? detectBrowserDescriptor();
    this.events = new CdpEventForwarder(dependencies.attachments, {
      onEvent: (event) => {
        const connectionGeneration = this.requireConnectionGeneration();
        dependencies.send(createRelayV2Envelope('CDP_EVENT', {
          connectionGeneration,
          inventoryGeneration: dependencies.inventory.currentGeneration(),
          tab: event.privateTab,
          attachmentGeneration: event.attachmentGeneration,
          eventSequence: event.eventSequence,
          method: event.method,
          params: asJsonObject(event.params),
          sessionId: event.childSessionId,
          emittedAt: event.receivedAt
        }));
      },
      onDetach: (fact) => {
        dependencies.inventory.markChanged();
        const connectionGeneration = this.requireConnectionGeneration();
        dependencies.send(createRelayV2Envelope('DEBUGGER_DETACHED', {
          connectionGeneration,
          inventoryGeneration: dependencies.inventory.currentGeneration(),
          tab: fact.privateTab,
          attachmentGeneration: fact.attachmentGeneration,
          reason: fact.reason,
          detachedAt: fact.detachedAt
        }));
      },
      onError: (error) => this.sendError(null, error)
    });
    this.events.start();
  }

  activeAttemptIds(): string[] {
    return [...this.activeAttempts];
  }

  async initialInventory(): Promise<RelayV2PayloadByType['INVENTORY_SNAPSHOT']> {
    const snapshot = await this.dependencies.inventory.snapshot();
    return this.toInventoryPayload(crypto.randomUUID(), snapshot);
  }

  async dispatch(envelope: RelayV2Envelope): Promise<void> {
    const attemptId = envelope.payload && typeof envelope.payload === 'object'
      && 'attemptId' in envelope.payload && typeof envelope.payload.attemptId === 'string'
      ? envelope.payload.attemptId
      : null;
    try {
      if (envelope.type === 'INVENTORY_REQUEST') {
        const payload = relayV2PayloadSchemas.INVENTORY_REQUEST.parse(envelope.payload);
        this.assertConnection(payload.expectedConnectionGeneration);
        const snapshot = await this.dependencies.inventory.snapshot();
        this.dependencies.send(createRelayV2Envelope(
          'INVENTORY_SNAPSHOT',
          this.toInventoryPayload(payload.attemptId, snapshot)
        ));
        return;
      }
      if (!mutationTypes.has(envelope.type)) {
        throw new ExtensionAdapterError('UNEXPECTED_RELAY_MESSAGE', `The extension cannot dispatch ${envelope.type}.`);
      }
      await this.dispatchMutation(envelope.type as MutationType, envelope.payload);
    } catch (error) {
      this.sendError(attemptId, this.normalizeError(error));
    }
  }

  dispose(): void {
    this.events.stop();
  }

  private async dispatchMutation(type: MutationType, rawPayload: unknown): Promise<void> {
    const payload = relayV2PayloadSchemas[type].parse(rawPayload) as RelayV2PayloadByType[MutationType];
    const { attemptId, expected } = payload;
    this.assertExpected(expected);
    this.sendAck(attemptId, type, expected);

    const cached = await this.dependencies.attempts.get({
      attemptId,
      connectionGeneration: expected.connectionGeneration,
      ...this.attemptIdentity(payload)
    });
    if (cached) {
      this.sendCached(type, expected, cached);
      return;
    }
    if (this.activeAttempts.has(attemptId)) {
      this.sendOperationResult(type, attemptId, expected, 'still_running', null, null);
      return;
    }

    this.activeAttempts.add(attemptId);
    try {
      const result = await this.execute(type, payload);
      const outcome: RecentAttemptOutcome = {
        attemptId,
        connectionGeneration: expected.connectionGeneration,
        inventoryGeneration: this.dependencies.inventory.currentGeneration(),
        ...this.attemptIdentity(payload),
        operation: type,
        recordedAt: new Date().toISOString(),
        ok: true,
        output: result
      };
      await this.dependencies.attempts.remember(outcome);
      this.sendOperationResult(type, attemptId, expected, 'succeeded', result, null);
    } catch (error) {
      const normalized = this.normalizeError(error);
      await this.dependencies.attempts.remember({
        attemptId,
        connectionGeneration: expected.connectionGeneration,
        inventoryGeneration: this.dependencies.inventory.currentGeneration(),
        ...this.attemptIdentity(payload),
        operation: type,
        recordedAt: new Date().toISOString(),
        ok: false,
        error: { code: normalized.code, message: normalized.message }
      });
      this.sendOperationResult(type, attemptId, expected, 'failed', null, normalized);
    } finally {
      this.activeAttempts.delete(attemptId);
    }
  }

  private async execute(type: MutationType, payload: RelayV2PayloadByType[MutationType]): Promise<JsonObject> {
    switch (type) {
      case 'PROFILE_PROXY': return asJsonObject(await (this.proxy ??= new ExtensionProxyController()).execute(relayV2PayloadSchemas.PROFILE_PROXY.parse(payload)));
      case 'CREATE_TAB': {
        const input = relayV2PayloadSchemas.CREATE_TAB.parse(payload);
        const result = await this.dependencies.tabGroups.createTab({
          window: input.window,
          ...(input.url === null ? {} : { url: input.url }),
          active: input.active,
          ...(input.index === null ? {} : { index: input.index }),
          ...(input.group === null ? {} : { group: input.group })
        });
        return asJsonObject(result);
      }
      case 'GROUP_TABS': {
        const input = relayV2PayloadSchemas.GROUP_TABS.parse(payload);
        return asJsonObject(await this.dependencies.tabGroups.groupTabs({
          window: input.window,
          tabs: input.tabs,
          ...(input.group === null ? {} : { group: input.group })
        }));
      }
      case 'MOVE_TAB': {
        const input = relayV2PayloadSchemas.MOVE_TAB.parse(payload);
        return asJsonObject(await this.dependencies.tabGroups.moveTab({
          tab: input.tab,
          destinationWindow: input.destinationWindow,
          index: input.index
        }));
      }
      case 'RENAME_GROUP': {
        const input = relayV2PayloadSchemas.RENAME_GROUP.parse(payload);
        return asJsonObject({ group: await this.dependencies.tabGroups.renameGroup(input.group, input.title) });
      }
      case 'ATTACH_DEBUGGER': {
        const input = relayV2PayloadSchemas.ATTACH_DEBUGGER.parse(payload);
        const attachment = await this.dependencies.attachments.attach(
          input.tab,
          input.expected.attachmentGeneration,
          input.debuggerProtocolVersion
        );
        this.dependencies.inventory.markChanged();
        return asJsonObject({ attachment });
      }
      case 'SEND_CDP': {
        const input = relayV2PayloadSchemas.SEND_CDP.parse(payload);
        if (input.expected.attachmentGeneration === null) {
          throw new ExtensionAdapterError('STALE_ATTACHMENT', 'A CDP command requires a current attachment generation.');
        }
        return asJsonObject(await this.dependencies.cdp.execute({
          attemptId: input.attemptId,
          connectionGeneration: input.expected.connectionGeneration,
          inventoryGeneration: input.expected.inventoryGeneration,
          privateTab: input.tab,
          attachmentGeneration: input.expected.attachmentGeneration,
          method: input.method,
          params: input.params,
          ...(input.sessionId === null ? {} : { childSessionId: input.sessionId })
        }));
      }
      case 'DETACH_DEBUGGER': {
        const input = relayV2PayloadSchemas.DETACH_DEBUGGER.parse(payload);
        if (input.expected.attachmentGeneration === null) {
          throw new ExtensionAdapterError('STALE_ATTACHMENT', 'A detach request requires a current attachment generation.');
        }
        await this.dependencies.attachments.detach(input.tab, input.expected.attachmentGeneration);
        this.dependencies.inventory.markChanged();
        return { detached: true };
      }
      case 'RECONCILE_ATTEMPT': {
        const input = relayV2PayloadSchemas.RECONCILE_ATTEMPT.parse(payload);
        const identity = input.window !== undefined
          ? (await this.dependencies.inventory.assertWindow(input.window), {
              windowId: input.window.windowId,
              windowGeneration: input.window.windowGeneration
            })
          : input.tab !== undefined && 'tabGeneration' in input.expected
            ? (await this.dependencies.inventory.assertTab(input.tab), {
                tabId: input.tab.tabId,
                windowId: input.tab.windowId,
                windowGeneration: input.tab.windowGeneration,
                tabGeneration: input.expected.tabGeneration,
                attachmentGeneration: input.expected.attachmentGeneration
              })
            : null;
        if (identity === null) {
          throw new ExtensionAdapterError('INVALID_RECONCILIATION_IDENTITY', 'Attempt reconciliation has no valid window or tab identity.');
        }
        const outcome = await this.dependencies.attempts.getForReconciliation({
          attemptId: input.reconciledAttemptId,
          ...identity
        });
        if (!outcome) return { found: false, reconciledAttemptId: input.reconciledAttemptId };
        return asJsonObject({ found: true, reconciledAttemptId: input.reconciledAttemptId, outcome });
      }
    }
  }

  private attemptIdentity(payload: RelayV2PayloadByType[MutationType]): {
    tabId?: number;
    windowId?: number;
    windowGeneration?: number;
    tabGeneration?: number;
    attachmentGeneration?: number;
  } {
    if ('tab' in payload && payload.tab !== undefined) {
      return {
        tabId: payload.tab.tabId,
        windowId: payload.tab.windowId,
        windowGeneration: payload.tab.windowGeneration,
        tabGeneration: payload.tab.tabGeneration,
        ...('attachmentGeneration' in payload.expected && payload.expected.attachmentGeneration !== null
          ? { attachmentGeneration: payload.expected.attachmentGeneration }
          : {})
      };
    }
    if ('window' in payload && payload.window !== undefined) {
      return {
        windowId: payload.window.windowId,
        windowGeneration: payload.window.windowGeneration
      };
    }
    return {};
  }

  private assertExpected(expected: Expected): void {
    this.assertConnection(expected.connectionGeneration);
    if (expected.inventoryGeneration !== this.dependencies.inventory.currentGeneration()) {
      throw new ExtensionAdapterError('STALE_INVENTORY_GENERATION', 'The browser inventory changed before dispatch.');
    }
  }

  private assertConnection(expected: number): void {
    if (expected !== this.requireConnectionGeneration()) {
      throw new ExtensionAdapterError('STALE_CONNECTION_GENERATION', 'The relay connection generation is stale.');
    }
  }

  private requireConnectionGeneration(): number {
    const generation = this.dependencies.context.connectionGeneration();
    if (generation === null) {
      throw new ExtensionAdapterError('RELAY_NOT_READY', 'The relay connection is not authenticated.', true);
    }
    return generation;
  }

  private sendAck(attemptId: string, operation: MutationType, expected: Expected): void {
    this.dependencies.send(createRelayV2Envelope('ACK', {
      attemptId,
      operation,
      expected,
      connectionGeneration: this.requireConnectionGeneration(),
      acceptedAt: new Date().toISOString()
    }));
  }

  private sendCached(type: MutationType, expected: Expected, cached: RecentAttemptOutcome): void {
    this.sendOperationResult(
      type,
      cached.attemptId,
      expected,
      cached.ok ? 'succeeded' : 'failed',
      cached.ok ? asJsonObject(cached.output) : null,
      cached.ok ? null : new ExtensionAdapterError(
        cached.error?.code ?? 'EXTENSION_OPERATION_FAILED',
        cached.error?.message ?? 'The cached extension operation failed.'
      )
    );
  }

  private sendOperationResult(
    operation: MutationType,
    attemptId: string,
    expected: Expected,
    outcome: 'succeeded' | 'failed' | 'not_found' | 'still_running' | 'unknown',
    result: JsonObject | null,
    error: ExtensionAdapterError | null
  ): void {
    this.dependencies.send(createRelayV2Envelope('OPERATION_RESULT', {
      attemptId,
      operation,
      expected,
      observed: this.observed(result),
      outcome,
      result,
      error: error === null ? null : {
        source: operation === 'CREATE_TAB' || operation === 'GROUP_TABS'
          || operation === 'MOVE_TAB' || operation === 'RENAME_GROUP'
          ? 'chrome_browser'
          : operation === 'RECONCILE_ATTEMPT' ? 'extension' : 'chrome_debugger',
        code: null,
        message: `${error.code}: ${error.message}`,
        data: { retryable: error.retryable }
      },
      completedAt: new Date().toISOString()
    }));
  }

  private observed(result: JsonObject | null): OperationObserved {
    const tab = this.findTabFact(result);
    const group = this.findGroupFact(result);
    const attachment = this.findAttachment(result);
    return {
      connectionGeneration: this.requireConnectionGeneration(),
      inventoryGeneration: this.dependencies.inventory.currentGeneration(),
      tabGeneration: tab?.tabGeneration ?? null,
      groupGeneration: group?.groupGeneration ?? null,
      attachmentGeneration: attachment?.attachmentGeneration ?? null
    };
  }

  private findTabFact(result: JsonObject | null): PrivateTabFact | null {
    const candidate = result?.tab;
    return candidate && typeof candidate === 'object' && 'tabGeneration' in candidate
      ? candidate as unknown as PrivateTabFact
      : null;
  }

  private findGroupFact(result: JsonObject | null): PrivateGroupFact | null {
    const candidate = result?.group;
    return candidate && typeof candidate === 'object' && 'groupGeneration' in candidate
      ? candidate as unknown as PrivateGroupFact
      : null;
  }

  private findAttachment(result: JsonObject | null): AttachmentRecord | null {
    const candidate = result?.attachment;
    return candidate && typeof candidate === 'object' && 'attachmentGeneration' in candidate
      ? candidate as unknown as AttachmentRecord
      : null;
  }

  private toInventoryPayload(
    attemptId: string,
    snapshot: BrowserInventorySnapshot
  ): RelayV2PayloadByType['INVENTORY_SNAPSHOT'] {
    const attachments = new Map(this.dependencies.attachments.list().map((attachment) => [
      attachment.privateTab.tabId,
      attachment
    ]));
    return {
      attemptId,
      connectionGeneration: this.requireConnectionGeneration(),
      inventoryGeneration: snapshot.inventoryGeneration,
      capturedAt: snapshot.observedAt,
      browser: this.browser,
      windows: snapshot.windows.map((window) => ({
        windowId: window.windowId,
        windowGeneration: window.windowGeneration,
        focused: window.focused,
        incognito: window.incognito,
        type: (window.type ?? 'normal') as 'normal',
        state: (window.state ?? 'normal') as 'normal',
        groups: snapshot.groups.filter((group) => group.windowId === window.windowId).map((group) => ({
          tabGroupId: group.tabGroupId,
          groupGeneration: group.groupGeneration,
          windowId: group.windowId,
          title: group.title,
          color: group.color as 'grey',
          collapsed: group.collapsed
        })),
        tabs: snapshot.tabs.filter((tab) => tab.windowId === window.windowId).map((tab) => {
          const attachment = attachments.get(tab.tabId);
          return {
            tabId: tab.tabId,
            tabGeneration: tab.tabGeneration,
            windowId: tab.windowId,
            groupId: tab.groupId,
            openerTabId: tab.openerTabId,
            active: tab.active,
            pinned: tab.pinned,
            discarded: tab.discarded,
            status: tab.status as 'unloaded' | 'loading' | 'complete' | null,
            url: tab.url,
            title: tab.title,
            debugger: {
              attached: attachment !== undefined,
              attachmentGeneration: attachment?.attachmentGeneration ?? null,
              protocolVersion: attachment?.protocolVersion ?? null
            }
          };
        })
      }))
    };
  }

  private sendError(attemptId: string | null, error: ExtensionAdapterError): void {
    this.dependencies.send(createRelayV2Envelope('ERROR', {
      connectionGeneration: this.dependencies.context.connectionGeneration(),
      attemptId,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: null
    }));
  }

  private normalizeError(error: unknown): ExtensionAdapterError {
    if (error instanceof ExtensionAdapterError) return error;
    if (error instanceof Error) return new ExtensionAdapterError('EXTENSION_OPERATION_FAILED', error.message);
    return new ExtensionAdapterError('EXTENSION_OPERATION_FAILED', 'The extension operation failed.');
  }
}
