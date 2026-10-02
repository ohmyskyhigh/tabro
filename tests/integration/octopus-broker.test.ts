import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeterministicReferenceFactory,
  OctopusBroker,
  type ExtensionOperationType,
  type ExtensionEventSink,
  type OctopusExtensionPort
} from '../../apps/broker/src/core/index.js';
import { parseMcpToolOutput, type RelayV2PayloadByType } from '../../apps/shared/protocol/src/index.js';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';

const observed = {
  connectionGeneration: 1,
  inventoryGeneration: 1,
  tabGeneration: 1,
  groupGeneration: 1,
  attachmentGeneration: 1
};

class FakeExtensionPort implements OctopusExtensionPort {
  private sink: ExtensionEventSink | null = null;
  private nextTabId = 10;
  private createFailuresRemaining = 0;
  private readonly endpointCreateFailures = new Map<string, number>();
  private lostCreateResultsRemaining = 0;
  private createCalls = 0;
  private cdpCalls = 0;
  private readonly createCallsByEndpoint = new Map<string, number>();
  private readonly connections = new Map<string, { connectionGeneration: number; connected: boolean }>();
  private readonly inventoryDisconnects = new Map<string, (connectionGeneration: number) => void>();
  private readonly inventoryGates = new Map<string, Promise<void>>();
  private readonly tabs = new Map<string, Map<number, {
    tabId: number; tabGeneration: number; windowId: number; groupId: number | null; title: string; url: string;
  }>>();
  private readonly groups = new Map<string, Map<number, { tabGroupId: number; groupGeneration: number; windowId: number; title: string }>>();
  private readonly inventoryGenerations = new Map<string, number>();
  private readonly attemptOutcomes = new Map<string, NonNullable<RelayV2PayloadByType['OPERATION_RESULT']['result']>>();
  private inventoryWindows: Array<{ windowId: number; windowGeneration: number; focused: boolean }> = [
    { windowId: 1, windowGeneration: 1, focused: true }
  ];

  failNextTabCreations(count: number): void { this.createFailuresRemaining = count; }
  failNextTabCreationsOn(endpointRef: string, count: number): void { this.endpointCreateFailures.set(endpointRef, count); }
  loseNextTabCreationResults(count: number): void { this.lostCreateResultsRemaining = count; }
  createTabCallCount(): number { return this.createCalls; }
  cdpCallCount(): number { return this.cdpCalls; }
  createTabCallCountOn(endpointRef: string): number { return this.createCallsByEndpoint.get(endpointRef) ?? 0; }
  disconnectDuringNextInventory(endpointRef: string, onDisconnect: (connectionGeneration: number) => void): void {
    this.inventoryDisconnects.set(endpointRef, onDisconnect);
  }
  holdNextInventory(endpointRef: string): () => void {
    let release!: () => void;
    this.inventoryGates.set(endpointRef, new Promise<void>((resolve) => { release = resolve; }));
    return release;
  }
  reconnect(endpointRef: string, connectionGeneration: number): void {
    this.connections.set(endpointRef, { connectionGeneration, connected: true });
  }
  setInventoryWindows(windows: Array<{ windowId: number; windowGeneration: number; focused: boolean }>): void {
    this.inventoryWindows = windows;
  }

  setEventSink(sink: ExtensionEventSink): void { this.sink = sink; }

  connection(endpointRef: string) {
    const connection = this.connections.get(endpointRef) ?? { connectionGeneration: 1, connected: true };
    return {
      endpointRef,
      connectionGeneration: connection.connectionGeneration,
      inventoryGeneration: this.inventoryGenerations.get(endpointRef) ?? 1,
      connected: connection.connected
    };
  }

  async requestInventory(endpointRef: string, _afterInventoryGeneration: number | null = null) {
    const gate = this.inventoryGates.get(endpointRef);
    if (gate) {
      this.inventoryGates.delete(endpointRef);
      await gate;
    }
    const disconnect = this.inventoryDisconnects.get(endpointRef);
    if (disconnect) {
      this.inventoryDisconnects.delete(endpointRef);
      const generation = this.connection(endpointRef).connectionGeneration;
      this.connections.set(endpointRef, { connectionGeneration: generation, connected: false });
      disconnect(generation);
      throw new Error('Synthetic extension disconnect during inventory.');
    }
    const connectionGeneration = this.connection(endpointRef).connectionGeneration;
    const tabs = [...(this.tabs.get(endpointRef)?.values() ?? [])];
    const groups = [...(this.groups.get(endpointRef)?.values() ?? [])];
    return {
      attemptId: crypto.randomUUID(),
      connectionGeneration,
      inventoryGeneration: this.inventoryGenerations.get(endpointRef) ?? 1,
      capturedAt: new Date().toISOString(),
      browser: { product: 'Chrome', version: '140', userAgent: null },
      windows: this.inventoryWindows.map((window) => ({
        ...window, incognito: false, type: 'normal' as const,
        state: 'normal' as const,
        groups: groups.filter((group) => group.windowId === window.windowId).map((group) => ({ ...group, color: 'blue' as const, collapsed: false })),
        tabs: tabs.filter((tab) => tab.windowId === window.windowId).map((tab) => ({
          ...tab,
          openerTabId: null,
          active: true,
          pinned: false,
          discarded: false,
          status: 'complete' as const,
          debugger: { attached: false, attachmentGeneration: null, protocolVersion: null }
        }))
      }))
    };
  }

  async execute<Type extends ExtensionOperationType>(
    endpointRef: string,
    type: Type,
    payload: RelayV2PayloadByType[Type]
  ): Promise<RelayV2PayloadByType['OPERATION_RESULT']> {
    const input = payload as RelayV2PayloadByType[ExtensionOperationType];
    const attemptId = input.attemptId;
    if (type === 'RECONCILE_ATTEMPT') {
      const reconcile = payload as RelayV2PayloadByType['RECONCILE_ATTEMPT'];
      const outcome = this.attemptOutcomes.get(reconcile.reconciledAttemptId) ?? null;
      return this.operationResult(type, attemptId, endpointRef, {
        found: outcome !== null,
        reconciledAttemptId: reconcile.reconciledAttemptId,
        ...(outcome === null ? {} : { outcome })
      });
    }
    const tabId = this.nextTabId;
    let result: RelayV2PayloadByType['OPERATION_RESULT']['result'] = {};
    if (type === 'CREATE_TAB') {
      this.createCalls += 1;
      this.createCallsByEndpoint.set(endpointRef, (this.createCallsByEndpoint.get(endpointRef) ?? 0) + 1);
      const create = payload as RelayV2PayloadByType['CREATE_TAB'];
      const connectionGeneration = this.connection(endpointRef).connectionGeneration;
      const endpointFailures = this.endpointCreateFailures.get(endpointRef) ?? 0;
      if (this.createFailuresRemaining > 0 || endpointFailures > 0) {
        if (this.createFailuresRemaining > 0) this.createFailuresRemaining -= 1;
        if (endpointFailures > 0) this.endpointCreateFailures.set(endpointRef, endpointFailures - 1);
        const error = { source: 'chrome_browser' as const, code: null, message: 'Synthetic tab creation failure.', data: null };
        this.attemptOutcomes.set(attemptId, {
          attemptId, connectionGeneration, inventoryGeneration: this.inventoryGenerations.get(endpointRef) ?? 1,
          windowId: create.window.windowId, windowGeneration: create.window.windowGeneration,
          operation: type, recordedAt: new Date().toISOString(), ok: false,
          error: { code: 'SYNTHETIC_CREATE_FAILURE', message: error.message }
        });
        return this.operationResult(type, attemptId, endpointRef, null, error);
      }
      this.nextTabId += 1;
      const tab = {
        tabId, tabGeneration: 1, windowId: 1,
        groupId: create.group?.tabGroupId ?? null,
        title: '', url: 'about:blank'
      };
      const endpointTabs = this.tabs.get(endpointRef) ?? new Map();
      endpointTabs.set(tabId, tab);
      this.tabs.set(endpointRef, endpointTabs);
      this.bumpInventory(endpointRef);
      result = { tab: { ...tab, windowGeneration: 1 }, group: create.group };
      this.attemptOutcomes.set(attemptId, {
        attemptId, connectionGeneration, inventoryGeneration: this.inventoryGenerations.get(endpointRef)!,
        windowId: create.window.windowId, windowGeneration: create.window.windowGeneration,
        operation: type, recordedAt: new Date().toISOString(), ok: true, output: result
      });
      if (this.lostCreateResultsRemaining > 0) {
        this.lostCreateResultsRemaining -= 1;
        throw new Error('Synthetic lost CREATE_TAB result.');
      }
    } else if (type === 'GROUP_TABS') {
      const groupInput = payload as RelayV2PayloadByType['GROUP_TABS'];
      const groupId = groupInput.group?.tabGroupId ?? 20;
      const endpointGroups = this.groups.get(endpointRef) ?? new Map();
      endpointGroups.set(groupId, { tabGroupId: groupId, groupGeneration: 1, windowId: 1, title: '' });
      this.groups.set(endpointRef, endpointGroups);
      for (const locator of groupInput.tabs) {
        const tab = this.tabs.get(endpointRef)?.get(locator.tabId);
        if (tab) tab.groupId = groupId;
      }
      this.bumpInventory(endpointRef);
      result = { group: { tabGroupId: groupId, groupGeneration: 1, windowId: 1, windowGeneration: 1 }, tabs: [] };
    } else if (type === 'RENAME_GROUP') {
      const rename = payload as RelayV2PayloadByType['RENAME_GROUP'];
      const group = this.groups.get(endpointRef)?.get(rename.group.tabGroupId);
      if (group) group.title = rename.title;
      this.bumpInventory(endpointRef);
      result = { group: { ...rename.group, title: rename.title } };
    } else if (type === 'ATTACH_DEBUGGER') {
      result = { attachmentGeneration: 1, protocolVersion: '1.3' };
    } else if (type === 'SEND_CDP') {
      this.cdpCalls += 1;
      result = { result: { result: { type: 'number', value: 4 } }, sessionId: null };
    }
    return this.operationResult(type, attemptId, endpointRef, result);
  }

  private bumpInventory(endpointRef: string): void {
    this.inventoryGenerations.set(endpointRef, (this.inventoryGenerations.get(endpointRef) ?? 1) + 1);
  }

  private operationResult(
    operation: ExtensionOperationType,
    attemptId: string,
    endpointRef: string,
    result: RelayV2PayloadByType['OPERATION_RESULT']['result'],
    error: RelayV2PayloadByType['OPERATION_RESULT']['error'] = null
  ): RelayV2PayloadByType['OPERATION_RESULT'] {
    const inventoryGeneration = this.inventoryGenerations.get(endpointRef) ?? 1;
    const connectionGeneration = this.connection(endpointRef).connectionGeneration;
    return {
      attemptId,
      operation,
      expected: { connectionGeneration, inventoryGeneration },
      observed: { ...observed, connectionGeneration, inventoryGeneration },
      outcome: error === null ? 'succeeded' : 'failed',
      result,
      error,
      completedAt: new Date().toISOString()
    };
  }
}

const eventually = async (read: () => Record<string, unknown>): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    const facts = value.facts as { ticket?: { state?: string } } | null;
    if (facts?.ticket && !['queued', 'running'].includes(facts.ticket.state ?? '')) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Ticket did not become terminal.');
};

const eventuallyMatching = async (
  read: () => Record<string, unknown>,
  predicate: (value: Record<string, unknown>) => boolean,
  description: string
): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Ticket did not reach ${description}.`);
};

describe('canonical Tabro broker', () => {
  let store: SqliteRelayStore;
  let broker: OctopusBroker;
  let extension: FakeExtensionPort;
  const caller = { runtimeName: 'Codex', runtimeSessionKey: 'test-session' };

  beforeEach(() => {
    store = new SqliteRelayStore(':memory:');
    broker = new OctopusBroker(store.canonical, { referenceFactory: new DeterministicReferenceFactory() });
    extension = new FakeExtensionPort();
    broker.setExtensionPort(extension);
    const endpoint = broker.ensureEndpoint({ nickname: 'profile-a' });
    broker.openEndpointConnection({
      endpointRef: endpoint.endpointRef, connectionRef: 'connection-test', transport: 'test', protocolVersion: '2',
      extensionVersion: '0.3.0', browserProduct: 'Chrome', browserVersion: '140'
    });
  });

  afterEach(async () => {
    broker.beginShutdown();
    await broker.waitForIdle();
    store.close();
  });

  it.each([
    { method: 'Runtime.evaluate', params: { expression: '2 + 2' } },
    { method: 'DOM.setFileInputFiles', params: { nodeId: 42, files: ['C:\\uploads\\图片.png', 'C:\\uploads\\report.pdf'] } },
    { method: 'DOM.setFileInputFiles', params: { backendNodeId: 42, files: ['C:\\uploads\\a file.txt'] } },
    { method: 'DOM.setFileInputFiles', params: { objectId: 'input-object', files: [] } }
  ])('returns a ticket and relays $method by logical tab ref with $params', async ({ method, params }) => {
    const execute = vi.spyOn(extension, 'execute');
    const accepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, caller);
    parseMcpToolOutput('request_browser_workspace', accepted);
    const requestRef = ((accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref);
    expect(((accepted.facts as { ticket: { state: string } }).ticket.state)).toBe('queued');

    broker.confirmAcknowledgement(requestRef, true);
    const workspaceTicket = await eventually(() => broker.getBrowserRequest({ request_ref: requestRef }, caller));
    parseMcpToolOutput('get_browser_request', workspaceTicket);
    const success = (workspaceTicket.facts as { ticket: { result: { facts: { resolved: Array<{ workspace: { workspace_ref: string }; tabs: Array<{ tab_ref: string }> }> } } } }).ticket.result;
    const workspaceRef = success.facts.resolved[0]!.workspace.workspace_ref;
    const tabRef = success.facts.resolved[0]!.tabs[0]!.tab_ref;

    const commandAccepted = broker.submit('send_cdp_command', {
      workspace_ref: workspaceRef,
      target: { kind: 'tab', tab_ref: tabRef },
      method,
      params
    }, caller);
    parseMcpToolOutput('send_cdp_command', commandAccepted);
    const commandRef = (commandAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(commandRef, true);
    const commandTicket = await eventually(() => broker.getBrowserRequest({ request_ref: commandRef }, caller));
    parseMcpToolOutput('get_browser_request', commandTicket);
    expect((commandTicket.facts as { ticket: { state: string } }).ticket.state).toBe('succeeded');
    expect(execute).toHaveBeenCalledWith(expect.any(String), 'SEND_CDP', expect.objectContaining({ method, params }));
  });

  it('holds a newly accepted CDP request until reconnect inventory reconciles its logical tab', async () => {
    const workspaceAccepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, caller);
    const workspaceRequestRef = (workspaceAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(workspaceRequestRef, true);
    const workspaceTicket = await eventually(() => broker.getBrowserRequest({ request_ref: workspaceRequestRef }, caller));
    const resolved = (workspaceTicket.facts as {
      ticket: { result: { facts: { resolved: Array<{ workspace: { workspace_ref: string }; tabs: Array<{ tab_ref: string }> }> } } }
    }).ticket.result.facts.resolved[0]!;
    const endpoint = store.canonical.logical.getEndpointByNickname('profile-a')!;
    const originalConnection = store.canonical.logical.getCurrentConnection(endpoint.endpointRef)!;

    broker.closeEndpointConnection(endpoint.endpointRef, originalConnection.connectionGeneration, 'synthetic reconnect');
    const reconnectedGeneration = broker.openEndpointConnection({
      endpointRef: endpoint.endpointRef,
      connectionRef: 'connection-test-reconnected',
      transport: 'test',
      protocolVersion: '2',
      extensionVersion: '0.3.0',
      browserProduct: 'Chrome',
      browserVersion: '140'
    });
    extension.reconnect(endpoint.endpointRef, reconnectedGeneration);
    const releaseInventory = extension.holdNextInventory(endpoint.endpointRef);
    broker.onExtensionReady(endpoint.endpointRef, reconnectedGeneration);

    const accepted = broker.submit('send_cdp_command', {
      workspace_ref: resolved.workspace.workspace_ref,
      target: { kind: 'tab', tab_ref: resolved.tabs[0]!.tab_ref },
      method: 'Runtime.evaluate',
      params: { expression: 'document.title' }
    }, caller);
    const requestRef = (accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(requestRef, true);

    const paused = await eventuallyMatching(
      () => broker.getBrowserRequest({ request_ref: requestRef }, caller),
      (value) => (value.facts as { ticket?: { pause_condition?: { reason?: string } | null } } | null)
        ?.ticket?.pause_condition?.reason === 'extension_disconnected',
      'the reconnect reconciliation barrier'
    );
    expect(paused).toMatchObject({ facts: { ticket: { state: 'running' } } });
    expect(store.canonical.requests.scanRequestRecovery().attempts
      .filter((attempt) => attempt.requestRef === requestRef)).toHaveLength(0);
    expect(extension.cdpCallCount()).toBe(0);
    expect(broker.getBrowserContext({
      view: { kind: 'windows', endpoint_nickname: 'profile-a', eligible_only: true, page_size: 100 }
    }, caller)).toMatchObject({ facts: { windows: [] } });

    releaseInventory();

    const completed = await eventually(() => broker.getBrowserRequest({ request_ref: requestRef }, caller));
    expect(completed).toMatchObject({ facts: { ticket: { state: 'succeeded', pause_condition: null } } });
    expect(extension.cdpCallCount()).toBe(1);
  });

  it('removes inventory-absent windows from eligible browser context results', async () => {
    const endpoint = store.canonical.logical.getEndpointByNickname('profile-a')!;
    extension.setInventoryWindows([
      { windowId: 1, windowGeneration: 1, focused: true },
      { windowId: 2, windowGeneration: 1, focused: false }
    ]);
    broker.onInventory(endpoint.endpointRef, await extension.requestInventory(endpoint.endpointRef, null));
    const missingWindow = store.canonical.logical.listWindows(endpoint.endpointRef)
      .find((window) => Number(JSON.parse(window.privateWindowKey).windowId) === 2)!;
    const lastObservedAt = missingWindow.lastObservedAt;

    extension.setInventoryWindows([{ windowId: 1, windowGeneration: 1, focused: true }]);
    broker.onInventory(endpoint.endpointRef, await extension.requestInventory(endpoint.endpointRef, null));

    expect(store.canonical.logical.getWindow(missingWindow.windowRef)).toMatchObject({
      eligible: false,
      lastObservedAt
    });
    expect(broker.getBrowserContext({
      view: { kind: 'windows', endpoint_nickname: 'profile-a', eligible_only: true, page_size: 100 }
    }, caller)).toMatchObject({ facts: { windows: [{ eligible_for_workspace: true }] } });
  });

  it('requires an explicit window until a multi-window endpoint has durable focus history', async () => {
    extension.setInventoryWindows([
      { windowId: 1, windowGeneration: 1, focused: false },
      { windowId: 2, windowGeneration: 1, focused: false }
    ]);
    const ambiguous = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, caller);
    const ambiguousRef = (ambiguous.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(ambiguousRef, true);
    const failed = await eventually(() => broker.getBrowserRequest({ request_ref: ambiguousRef }, caller));
    expect(failed).toMatchObject({
      facts: { ticket: { state: 'failed', failure: { problem: { code: 'WINDOW_UNAVAILABLE' } } } }
    });
    expect(extension.createTabCallCount()).toBe(0);

    extension.setInventoryWindows([
      { windowId: 1, windowGeneration: 1, focused: true },
      { windowId: 2, windowGeneration: 1, focused: false }
    ]);
    const focused = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, caller);
    const focusedRef = (focused.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(focusedRef, true);
    const focusedTicket = await eventually(() => broker.getBrowserRequest({ request_ref: focusedRef }, caller));
    const focusedWindowRef = (focusedTicket.facts as {
      ticket: { result: { facts: { resolved: Array<{ workspace: { window_ref: string } }> } } }
    }).ticket.result.facts.resolved[0]!.workspace.window_ref;

    extension.setInventoryWindows([
      { windowId: 1, windowGeneration: 1, focused: false },
      { windowId: 2, windowGeneration: 1, focused: false }
    ]);
    const historical = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, caller);
    const historicalRef = (historical.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(historicalRef, true);
    const historicalTicket = await eventually(() => broker.getBrowserRequest({ request_ref: historicalRef }, caller));
    expect(historicalTicket).toMatchObject({ facts: { ticket: { state: 'succeeded' } } });
    expect((historicalTicket.facts as {
      ticket: { result: { facts: { resolved: Array<{ workspace: { window_ref: string } }> } } }
    }).ticket.result.facts.resolved[0]!.workspace.window_ref).toBe(focusedWindowRef);
  });

  it('reconciles a lost CREATE_TAB result without opening a duplicate tab', async () => {
    const workspaceAccepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, caller);
    const workspaceRequestRef = (workspaceAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(workspaceRequestRef, true);
    const workspaceTicket = await eventually(() => broker.getBrowserRequest({ request_ref: workspaceRequestRef }, caller));
    const workspaceRef = (workspaceTicket.facts as {
      ticket: { result: { facts: { resolved: Array<{ workspace: { workspace_ref: string } }> } } }
    }).ticket.result.facts.resolved[0]!.workspace.workspace_ref;

    const callsBefore = extension.createTabCallCount();
    extension.loseNextTabCreationResults(1);
    const accepted = broker.submit('create_browser_tab', { workspace_ref: workspaceRef }, caller);
    const requestRef = (accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(requestRef, true);
    const completed = await eventually(() => broker.getBrowserRequest({ request_ref: requestRef }, caller));
    parseMcpToolOutput('get_browser_request', completed);

    const ticket = (completed.facts as {
      ticket: { state: string; result: { facts: { creation_attempts: number; tab: { tab_ref: string } } } }
    }).ticket;
    expect(ticket.state).toBe('succeeded');
    expect(ticket.result.facts.creation_attempts).toBe(1);
    expect(ticket.result.facts.tab.tab_ref).toMatch(/^tab_/);
    expect(extension.createTabCallCount() - callsBefore).toBe(1);
  });

  it('returns schema-valid tab creation failure facts after the initial attempt and two retries', async () => {
    const workspaceAccepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, caller);
    const workspaceRequestRef = (workspaceAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(workspaceRequestRef, true);
    const workspaceTicket = await eventually(() => broker.getBrowserRequest({ request_ref: workspaceRequestRef }, caller));
    const workspaceRef = (workspaceTicket.facts as {
      ticket: { result: { facts: { resolved: Array<{ workspace: { workspace_ref: string } }> } } }
    }).ticket.result.facts.resolved[0]!.workspace.workspace_ref;

    extension.failNextTabCreations(3);
    const callsBefore = extension.createTabCallCount();
    const accepted = broker.submit('create_browser_tab', { workspace_ref: workspaceRef }, caller);
    const requestRef = (accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(requestRef, true);
    const failed = await eventually(() => broker.getBrowserRequest({ request_ref: requestRef }, caller));
    parseMcpToolOutput('get_browser_request', failed);

    const ticket = (failed.facts as {
      ticket: { state: string; failure: { known_facts: { creation_attempts: number; reconciled_before_each_retry: boolean; tabs: unknown[] } } }
    }).ticket;
    expect(ticket.state).toBe('failed');
    expect(ticket.failure.known_facts.creation_attempts).toBe(3);
    expect(ticket.failure.known_facts.reconciled_before_each_retry).toBe(true);
    expect(ticket.failure.known_facts.tabs).toHaveLength(1);
    expect(extension.createTabCallCount() - callsBefore).toBe(3);
  });

  it('preserves completed workspace references when a later profile cannot create its initial tab', async () => {
    const endpointB = broker.ensureEndpoint({ nickname: 'profile-b' });
    broker.openEndpointConnection({
      endpointRef: endpointB.endpointRef,
      connectionRef: 'connection-test-b',
      transport: 'test',
      protocolVersion: '2',
      extensionVersion: '0.3.0',
      browserProduct: 'Chrome',
      browserVersion: '140'
    });
    extension.failNextTabCreationsOn(endpointB.endpointRef, 3);
    const accepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 2,
      designated_endpoints: [
        { endpoint_nickname: 'profile-a' },
        { endpoint_nickname: 'profile-b' }
      ]
    }, caller);
    const requestRef = (accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(requestRef, true);
    const failed = await eventually(() => broker.getBrowserRequest({ request_ref: requestRef }, caller));
    parseMcpToolOutput('get_browser_request', failed);

    const ticket = (failed.facts as {
      ticket: { state: string; failure: { known_facts: { created_workspaces: Array<{ endpoint_nickname: string; workspace: { workspace_ref: string } }> } } }
    }).ticket;
    expect(ticket.state).toBe('failed');
    expect(ticket.failure.known_facts.created_workspaces).toHaveLength(1);
    expect(ticket.failure.known_facts.created_workspaces[0]!.endpoint_nickname).toBe('profile-a');
    expect(ticket.failure.known_facts.created_workspaces[0]!.workspace.workspace_ref).toMatch(/^wrk_/);
  });

  it('resumes a two-endpoint workspace request after the second extension reconnects without duplicating the first workspace', async () => {
    const endpointA = store.canonical.logical.getEndpointByNickname('profile-a')!;
    const endpointB = broker.ensureEndpoint({ nickname: 'profile-b' });
    broker.openEndpointConnection({
      endpointRef: endpointB.endpointRef,
      connectionRef: 'connection-test-b',
      transport: 'test',
      protocolVersion: '2',
      extensionVersion: '0.3.0',
      browserProduct: 'Chrome',
      browserVersion: '140'
    });
    extension.disconnectDuringNextInventory(endpointB.endpointRef, (connectionGeneration) => {
      broker.closeEndpointConnection(endpointB.endpointRef, connectionGeneration, 'synthetic mid-cycle disconnect');
    });

    const accepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 2,
      designated_endpoints: [
        { endpoint_nickname: 'profile-a' },
        { endpoint_nickname: 'profile-b' }
      ]
    }, caller);
    const requestRef = (accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(requestRef, true);

    const paused = await eventuallyMatching(
      () => broker.getBrowserRequest({ request_ref: requestRef }, caller),
      (value) => {
        const ticket = (value.facts as {
          ticket?: { state?: string; pause_condition?: { reason?: string } | null }
        } | null)?.ticket;
        return ticket?.state === 'running' && ticket.pause_condition?.reason === 'extension_disconnected';
      },
      'the extension_disconnected pause condition'
    );
    parseMcpToolOutput('get_browser_request', paused);
    expect(store.canonical.logical.listActiveWorkspaces({ endpointRef: endpointA.endpointRef })).toHaveLength(1);
    expect(store.canonical.logical.listActiveWorkspaces({ endpointRef: endpointB.endpointRef })).toHaveLength(0);
    expect(extension.createTabCallCountOn(endpointA.endpointRef)).toBe(1);
    expect(extension.createTabCallCountOn(endpointB.endpointRef)).toBe(0);

    const reconnectedGeneration = broker.openEndpointConnection({
      endpointRef: endpointB.endpointRef,
      connectionRef: 'connection-test-b-reconnected',
      transport: 'test',
      protocolVersion: '2',
      extensionVersion: '0.3.0',
      browserProduct: 'Chrome',
      browserVersion: '140'
    });
    extension.reconnect(endpointB.endpointRef, reconnectedGeneration);
    broker.onExtensionReady(endpointB.endpointRef, reconnectedGeneration);
    broker.onInventory(endpointB.endpointRef, await extension.requestInventory(endpointB.endpointRef, null));

    const completed = await eventually(() => broker.getBrowserRequest({ request_ref: requestRef }, caller));
    parseMcpToolOutput('get_browser_request', completed);
    const ticket = (completed.facts as {
      ticket: {
        state: string;
        result: { facts: { resolved: Array<{ endpoint_nickname: string; workspace: { workspace_ref: string } }> } };
      };
    }).ticket;
    expect(ticket.state).toBe('succeeded');
    expect(ticket.result.facts.resolved.map((entry) => entry.endpoint_nickname)).toEqual(['profile-a', 'profile-b']);
    expect(new Set(ticket.result.facts.resolved.map((entry) => entry.workspace.workspace_ref)).size).toBe(2);
    expect(store.canonical.logical.listActiveWorkspaces({ endpointRef: endpointA.endpointRef })).toHaveLength(1);
    expect(store.canonical.logical.listActiveWorkspaces({ endpointRef: endpointB.endpointRef })).toHaveLength(1);
    expect(extension.createTabCallCountOn(endpointA.endpointRef)).toBe(1);
    expect(extension.createTabCallCountOn(endpointB.endpointRef)).toBe(1);
  });

  it('replaces a human-confirmed failed tab, fails queued followers, and releases the lane atomically', async () => {
    const accepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, caller);
    const workspaceRequestRef = (accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(workspaceRequestRef, true);
    const workspaceTicket = await eventually(() => broker.getBrowserRequest({ request_ref: workspaceRequestRef }, caller));
    const resolved = (workspaceTicket.facts as { ticket: { result: { facts: { resolved: Array<{ workspace: { workspace_ref: string }; tabs: Array<{ tab_ref: string }> }> } } } }).ticket.result.facts.resolved[0]!;
    const workspaceRef = resolved.workspace.workspace_ref;
    const tabRef = resolved.tabs[0]!.tab_ref;

    const targetAccepted = broker.submit('send_cdp_command', {
      workspace_ref: workspaceRef, target: { kind: 'tab', tab_ref: tabRef },
      method: 'Runtime.evaluate', params: { expression: 'window.__octopus = true' }
    }, caller);
    const targetRef = (targetAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    store.canonical.requests.markAcknowledgementDelivered(targetRef);
    const targetClaim = store.canonical.requests.claimRequest({
      requestRef: targetRef, workerRef: 'synthetic-worker', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })!;
    store.canonical.requests.recordCheckpoint({
      requestRef: targetRef, expectedClaimGeneration: targetClaim.claimGeneration,
      phase: 'awaiting_human_confirmation', checkpoint: { name: 'extension_result_missing' },
      pauseCondition: 'user_confirmation_required'
    });

    const followerAccepted = broker.submit('send_cdp_command', {
      workspace_ref: workspaceRef, target: { kind: 'tab', tab_ref: tabRef },
      method: 'Runtime.evaluate', params: { expression: 'window.__follower = true' }
    }, caller);
    const followerRef = (followerAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(followerRef, true);

    const resolverAccepted = broker.submit('resolve_browser_request', {
      request_ref: targetRef, decision: 'restart_failed'
    }, caller);
    const resolverRef = (resolverAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(resolverRef, true);
    const resolverTicket = await eventually(() => broker.getBrowserRequest({ request_ref: resolverRef }, caller));
    parseMcpToolOutput('get_browser_request', resolverTicket);
    expect((resolverTicket.facts as { ticket: { state: string } }).ticket.state).toBe('succeeded');

    const targetTicket = broker.getBrowserRequest({ request_ref: targetRef }, caller);
    const followerTicket = broker.getBrowserRequest({ request_ref: followerRef }, caller);
    parseMcpToolOutput('get_browser_request', targetTicket);
    parseMcpToolOutput('get_browser_request', followerTicket);
    expect((targetTicket.facts as { ticket: { state: string } }).ticket.state).toBe('failed');
    expect((followerTicket.facts as { ticket: { state: string } }).ticket.state).toBe('failed');
    const resolverResult = (resolverTicket.facts as { ticket: { result: { facts: { replacement_tab: unknown; invalidated_request_refs: string[] } } } }).ticket.result;
    expect(resolverResult.facts.replacement_tab).not.toBeNull();
    expect(resolverResult.facts.invalidated_request_refs).toEqual([followerRef]);
  });

  it('fails both resolution tickets after three replacement attempts are exhausted', async () => {
    const accepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, caller);
    const workspaceRequestRef = (accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(workspaceRequestRef, true);
    const workspaceTicket = await eventually(() => broker.getBrowserRequest({ request_ref: workspaceRequestRef }, caller));
    const resolved = (workspaceTicket.facts as { ticket: { result: { facts: { resolved: Array<{ workspace: { workspace_ref: string }; tabs: Array<{ tab_ref: string }> }> } } } }).ticket.result.facts.resolved[0]!;
    const targetAccepted = broker.submit('send_cdp_command', {
      workspace_ref: resolved.workspace.workspace_ref, target: { kind: 'tab', tab_ref: resolved.tabs[0]!.tab_ref },
      method: 'Runtime.evaluate', params: { expression: 'window.__octopus = true' }
    }, caller);
    const targetRef = (targetAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    store.canonical.requests.markAcknowledgementDelivered(targetRef);
    const targetClaim = store.canonical.requests.claimRequest({
      requestRef: targetRef, workerRef: 'synthetic-worker', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    })!;
    store.canonical.requests.recordCheckpoint({
      requestRef: targetRef, expectedClaimGeneration: targetClaim.claimGeneration,
      phase: 'awaiting_human_confirmation', checkpoint: { name: 'extension_result_missing' },
      pauseCondition: 'user_confirmation_required'
    });
    extension.failNextTabCreations(3);
    const resolverAccepted = broker.submit('resolve_browser_request', { request_ref: targetRef, decision: 'restart_failed' }, caller);
    const resolverRef = (resolverAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(resolverRef, true);
    const resolverTicket = await eventually(() => broker.getBrowserRequest({ request_ref: resolverRef }, caller));
    parseMcpToolOutput('get_browser_request', resolverTicket);
    expect((resolverTicket.facts as { ticket: { state: string } }).ticket.state).toBe('failed');
    const result = (resolverTicket.facts as { ticket: { failure: { known_facts: { replacement_creation_attempts: number; replacement_tab: unknown } } } }).ticket.failure;
    expect(result.known_facts.replacement_creation_attempts).toBe(3);
    expect(result.known_facts.replacement_tab).toBeNull();
    expect((broker.getBrowserRequest({ request_ref: targetRef }, caller).facts as { ticket: { state: string } }).ticket.state).toBe('failed');
  });

  it('issues fresh tab event cursors on takeover and rejects the previous owner epoch cursor', async () => {
    const originalCaller = { runtimeName: 'Codex', runtimeSessionKey: 'takeover-original-session' };
    const replacementCaller = { runtimeName: 'Hermes', runtimeSessionKey: 'takeover-replacement-session' };
    const accepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, originalCaller);
    const originalOwnerSessionRef = (accepted.caller as { session_ref: string }).session_ref;
    const workspaceRequestRef = (accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(workspaceRequestRef, true);
    const workspaceTicket = await eventually(() => broker.getBrowserRequest({ request_ref: workspaceRequestRef }, originalCaller));
    const allocated = (workspaceTicket.facts as { ticket: { result: { facts: { resolved: Array<{
      workspace: { workspace_ref: string };
      tabs: Array<{ tab_ref: string; initial_event_cursor: string }>;
    }> } } } }).ticket.result.facts.resolved[0]!;
    const workspaceRef = allocated.workspace.workspace_ref;
    const tabRef = allocated.tabs[0]!.tab_ref;
    const oldCursor = allocated.tabs[0]!.initial_event_cursor;

    const takeoverAccepted = broker.submit('take_over_workspace', {
      workspace_ref: workspaceRef,
      endpoint_nickname: 'profile-a',
      previous_owner_session_ref: originalOwnerSessionRef
    }, replacementCaller);
    parseMcpToolOutput('take_over_workspace', takeoverAccepted);
    const takeoverRef = (takeoverAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(takeoverRef, true);
    const takeoverTicket = await eventually(() => broker.getBrowserRequest({ request_ref: takeoverRef }, replacementCaller));
    parseMcpToolOutput('get_browser_request', takeoverTicket);
    expect((takeoverTicket.facts as { ticket: { state: string } }).ticket.state).toBe('succeeded');
    const takeoverResult = (takeoverTicket.facts as { ticket: { result: { facts: {
      tabs: Array<{ tab_ref: string; initial_event_cursor: string }>;
    } } } }).ticket.result;
    const newTab = takeoverResult.facts.tabs.find((tab) => tab.tab_ref === tabRef)!;
    expect(newTab.initial_event_cursor).not.toBe(oldCursor);

    const staleRead = broker.readCdpEvents({
      workspace_ref: workspaceRef,
      target: { kind: 'tab', tab_ref: tabRef },
      cursor: oldCursor,
      page_size: 10
    }, replacementCaller);
    parseMcpToolOutput('read_cdp_events', staleRead);
    expect(staleRead).toMatchObject({ disposition: 'rejected', problem: { code: 'CURSOR_INVALID' } });

    const freshRead = broker.readCdpEvents({
      workspace_ref: workspaceRef,
      target: { kind: 'tab', tab_ref: tabRef },
      cursor: newTab.initial_event_cursor,
      page_size: 10
    }, replacementCaller);
    parseMcpToolOutput('read_cdp_events', freshRead);
    expect(freshRead).toMatchObject({
      disposition: 'complete',
      facts: { workspace_ref: workspaceRef, target: { kind: 'tab', tab_ref: tabRef } }
    });
  });

  it('freezes workspace takeover while an endpoint control is nonterminal', async () => {
    const ownerCaller = { runtimeName: 'Codex', runtimeSessionKey: 'endpoint-control-owner' };
    const takeoverCaller = { runtimeName: 'Hermes', runtimeSessionKey: 'endpoint-control-takeover' };
    const accepted = broker.submit('request_browser_workspace', {
      required_workspace_count: 1,
      designated_endpoints: [{ endpoint_nickname: 'profile-a' }]
    }, ownerCaller);
    const ownerSessionRef = (accepted.caller as { session_ref: string }).session_ref;
    const workspaceRequestRef = (accepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(workspaceRequestRef, true);
    const workspaceTicket = await eventually(() => broker.getBrowserRequest({ request_ref: workspaceRequestRef }, ownerCaller));
    const workspaceRef = (workspaceTicket.facts as { ticket: { result: { facts: { resolved: Array<{
      workspace: { workspace_ref: string };
    }> } } } }).ticket.result.facts.resolved[0]!.workspace.workspace_ref;

    const killAccepted = broker.submit('kill_browser_endpoint', { endpoint_nickname: 'profile-a' }, ownerCaller);
    parseMcpToolOutput('kill_browser_endpoint', killAccepted);
    const killRequestRef = (killAccepted.facts as { ticket: { request_ref: string } }).ticket.request_ref;
    broker.confirmAcknowledgement(killRequestRef, true);

    const blockedTakeover = broker.submit('take_over_workspace', {
      workspace_ref: workspaceRef,
      endpoint_nickname: 'profile-a',
      previous_owner_session_ref: ownerSessionRef
    }, takeoverCaller);
    parseMcpToolOutput('take_over_workspace', blockedTakeover);
    expect(blockedTakeover).toMatchObject({
      disposition: 'rejected',
      problem: { code: 'ENDPOINT_OWNERSHIP_FROZEN' }
    });

    const killTicket = await eventually(() => broker.getBrowserRequest({ request_ref: killRequestRef }, ownerCaller));
    parseMcpToolOutput('get_browser_request', killTicket);
    expect((killTicket.facts as { ticket: { state: string } }).ticket.state).toBe('succeeded');
    expect(store.canonical.logical.getActiveEndpointControl(
      store.canonical.logical.getEndpointByNickname('profile-a')!.endpointRef
    )).toBeNull();
  });
});
