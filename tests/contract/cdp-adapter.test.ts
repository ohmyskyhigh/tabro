import { describe, expect, it, vi } from 'vitest';
import {
  createRelayV2Envelope,
  type RelayV2Envelope
} from '../../apps/shared/protocol/src/relay/v2-messages.js';
import {
  BrowserInventory,
  type BrowserInventoryApi
} from '../../apps/browser-extension/src/browser/inventory.js';
import {
  DebuggerAttachmentManager,
  type DebuggerApi
} from '../../apps/browser-extension/src/debugger/attachment-manager.js';
import { CdpExecutor } from '../../apps/browser-extension/src/debugger/cdp-executor.js';
import { CdpEventForwarder } from '../../apps/browser-extension/src/debugger/event-forwarder.js';
import {
  RelayDispatcher,
  type RelayDispatcherDependencies
} from '../../apps/browser-extension/src/protocol/dispatcher.js';
import {
  RecentAttemptCache,
  type LocalStorageArea
} from '../../apps/browser-extension/src/executor/recent-command-cache.js';

class MemoryStorage implements LocalStorageArea {
  readonly data: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return { ...this.data }; }
  async set(items: Record<string, unknown>): Promise<void> { Object.assign(this.data, items); }
}

class FakeDebugger implements DebuggerApi {
  readonly attach = vi.fn(async () => undefined);
  readonly detach = vi.fn(async () => undefined);
  readonly sendCommand = vi.fn(async (_target: chrome.debugger.DebuggerSession, method: string): Promise<object> => ({ method, value: 2 }));
  readonly getTargets = vi.fn(async () => []);
  private detachListener: ((source: chrome.debugger.Debuggee, reason: string) => void) | null = null;
  private eventListener: ((source: chrome.debugger.DebuggerSession, method: string, params?: object) => void) | null = null;
  readonly onDetach = {
    addListener: (listener: (source: chrome.debugger.Debuggee, reason: string) => void) => { this.detachListener = listener; },
    removeListener: () => { this.detachListener = null; }
  };
  readonly onEvent = {
    addListener: (listener: (source: chrome.debugger.DebuggerSession, method: string, params?: object) => void) => { this.eventListener = listener; },
    removeListener: () => { this.eventListener = null; }
  };
  emitEvent(source: chrome.debugger.DebuggerSession, method: string, params?: object): void {
    this.eventListener?.(source, method, params);
  }
  emitDetach(source: chrome.debugger.Debuggee, reason: string): void {
    this.detachListener?.(source, reason);
  }
}

const tab = {
  active: true,
  audible: false,
  autoDiscardable: true,
  discarded: false,
  groupId: -1,
  highlighted: true,
  id: 10,
  incognito: false,
  index: 0,
  pinned: false,
  selected: true,
  status: 'complete',
  title: 'CDP fixture',
  url: 'https://example.test/',
  windowId: 1
} as chrome.tabs.Tab;

const window = {
  alwaysOnTop: false,
  focused: true,
  id: 1,
  incognito: false,
  state: 'normal',
  tabs: [tab],
  type: 'normal'
} as chrome.windows.Window;

const browserApi: BrowserInventoryApi = {
  windows: {
    get: async () => ({ ...window, tabs: undefined }),
    getAll: async () => [{ ...window, tabs: [{ ...tab }] }],
    getLastFocused: async () => ({ ...window, tabs: undefined })
  },
  tabs: { get: async () => ({ ...tab }) },
  tabGroups: {
    get: async () => { throw new Error('group missing'); },
    query: async () => []
  }
};

describe('extension CDP adapter', () => {
  it.each([
    { nodeId: 42, files: ['C:\\uploads\\图片.png', 'C:\\uploads\\report.pdf'] },
    { backendNodeId: 42, files: ['C:\\uploads\\a file.txt'] },
    { objectId: 'input-object', files: [] }
  ])('passes file input parameters unchanged to Chrome: $files', async (params) => {
    const inventory = new BrowserInventory(browserApi);
    const snapshot = await inventory.snapshot();
    const privateTab = snapshot.tabs[0]!;
    const debuggerApi = new FakeDebugger();
    debuggerApi.sendCommand.mockResolvedValueOnce({});
    const attachments = new DebuggerAttachmentManager(inventory, debuggerApi);
    const attempts = new RecentAttemptCache(new MemoryStorage());
    const executor = new CdpExecutor(attachments, attempts);
    const attachment = await attachments.attach(privateTab, null, '1.3');
    const result = await executor.execute({
      attemptId: crypto.randomUUID(),
      connectionGeneration: 1,
      inventoryGeneration: snapshot.inventoryGeneration,
      privateTab,
      attachmentGeneration: attachment.attachmentGeneration,
      method: 'DOM.setFileInputFiles',
      params
    });
    expect(debuggerApi.sendCommand).toHaveBeenCalledExactlyOnceWith(
      { tabId: 10 }, 'DOM.setFileInputFiles', params
    );
    expect(result.rawResult).toEqual({});
  });

  it('fences attachments, forwards ordered events, and retains bounded attempt outcomes', async () => {
    const inventory = new BrowserInventory(browserApi);
    const snapshot = await inventory.snapshot();
    const privateTab = snapshot.tabs[0]!;
    const debuggerApi = new FakeDebugger();
    const attachments = new DebuggerAttachmentManager(inventory, debuggerApi);
    const storage = new MemoryStorage();
    const attempts = new RecentAttemptCache(storage, { maxAttempts: 2 });
    const executor = new CdpExecutor(attachments, attempts);
    const events: Array<{ method: string; eventSequence: number; childSessionId: string | null }> = [];
    const detaches: string[] = [];
    const forwarder = new CdpEventForwarder(attachments, {
      onEvent: (event) => {
        events.push({
          method: event.method,
          eventSequence: event.eventSequence,
          childSessionId: event.childSessionId
        });
      },
      onDetach: (fact) => { detaches.push(fact.reason); },
      onError: (error) => { throw error; }
    }, debuggerApi);
    forwarder.start();

    const attachment = await attachments.attach(privateTab, null, '1.3');
    expect(attachment.attachmentGeneration).toBe(1);
    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 10 }, '1.3');

    const attemptId = crypto.randomUUID();
    const result = await executor.execute({
      attemptId,
      connectionGeneration: 7,
      inventoryGeneration: snapshot.inventoryGeneration,
      privateTab,
      attachmentGeneration: attachment.attachmentGeneration,
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' }
    });
    expect(result.rawResult).toEqual({ method: 'Runtime.evaluate', value: 2 });
    expect(await attempts.get({
      attemptId,
      connectionGeneration: 7,
      tabGeneration: privateTab.tabGeneration,
      attachmentGeneration: attachment.attachmentGeneration
    })).toMatchObject({ ok: true, operation: 'Runtime.evaluate' });

    debuggerApi.emitEvent({ tabId: 10 }, 'Target.attachedToTarget', { sessionId: 'child-1' });
    debuggerApi.emitEvent({ tabId: 10, sessionId: 'child-1' }, 'Runtime.consoleAPICalled', { type: 'log' });
    expect(events).toEqual([
      { method: 'Target.attachedToTarget', eventSequence: 1, childSessionId: null },
      { method: 'Runtime.consoleAPICalled', eventSequence: 2, childSessionId: 'child-1' }
    ]);

    await executor.execute({
      attemptId: crypto.randomUUID(),
      connectionGeneration: 7,
      inventoryGeneration: snapshot.inventoryGeneration,
      privateTab,
      attachmentGeneration: attachment.attachmentGeneration,
      method: 'Runtime.evaluate',
      params: { expression: '2 + 2' },
      childSessionId: 'child-1'
    });
    expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith(
      { tabId: 10, sessionId: 'child-1' },
      'Runtime.evaluate',
      { expression: '2 + 2' }
    );

    debuggerApi.emitDetach({ tabId: 10 }, 'canceled_by_user');
    expect(detaches).toEqual(['canceled_by_user']);
    expect(() => attachments.assertAttached(privateTab, attachment.attachmentGeneration))
      .toThrowError(/No current debugger attachment/);
    forwarder.stop();
  });

  it('reconciles a dispatched attempt across a new authenticated connection generation', async () => {
    const inventory = new BrowserInventory(browserApi);
    const snapshot = await inventory.snapshot();
    const privateTab = snapshot.tabs[0]!;
    const privateTabLocator = {
      tabId: privateTab.tabId,
      tabGeneration: privateTab.tabGeneration,
      windowId: privateTab.windowId,
      windowGeneration: privateTab.windowGeneration
    };
    const debuggerApi = new FakeDebugger();
    const attachments = new DebuggerAttachmentManager(inventory, debuggerApi);
    const attempts = new RecentAttemptCache(new MemoryStorage());
    const executor = new CdpExecutor(attachments, attempts);
    const attachment = await attachments.attach(privateTab, null, '1.3');
    const dispatchedAttemptId = crypto.randomUUID();

    await executor.execute({
      attemptId: dispatchedAttemptId,
      connectionGeneration: 7,
      inventoryGeneration: snapshot.inventoryGeneration,
      privateTab,
      attachmentGeneration: attachment.attachmentGeneration,
      method: 'Runtime.evaluate',
      params: { expression: 'location.href' }
    });

    expect(await attempts.get({
      attemptId: dispatchedAttemptId,
      connectionGeneration: 8,
      tabId: privateTab.tabId,
      windowId: privateTab.windowId,
      windowGeneration: privateTab.windowGeneration,
      tabGeneration: privateTab.tabGeneration,
      attachmentGeneration: attachment.attachmentGeneration
    })).toBeNull();

    const sent: RelayV2Envelope[] = [];
    const send: RelayDispatcherDependencies['send'] = (envelope) => { sent.push(envelope); };
    const dispatcher = new RelayDispatcher({
      inventory,
      tabGroups: {} as RelayDispatcherDependencies['tabGroups'],
      attachments,
      cdp: executor,
      attempts,
      context: {
        connectionGeneration: () => 8,
        endpointId: () => 'endpoint-test',
        browser: { product: 'Chromium', version: 'test', userAgent: null }
      },
      send
    });
    const reconciliationAttemptId = crypto.randomUUID();
    await dispatcher.dispatch(createRelayV2Envelope('RECONCILE_ATTEMPT', {
      attemptId: reconciliationAttemptId,
      reconciledAttemptId: dispatchedAttemptId,
      expected: {
        connectionGeneration: 8,
        inventoryGeneration: snapshot.inventoryGeneration,
        tabGeneration: privateTab.tabGeneration,
        attachmentGeneration: attachment.attachmentGeneration
      },
      tab: privateTabLocator
    }));
    dispatcher.dispose();

    const result = sent.find((envelope) =>
      envelope.type === 'OPERATION_RESULT' && envelope.payload.attemptId === reconciliationAttemptId
    );
    if (result?.type !== 'OPERATION_RESULT') throw new Error('Reconciliation result was not emitted.');
    expect(result.payload).toMatchObject({
      operation: 'RECONCILE_ATTEMPT',
      outcome: 'succeeded',
      result: {
        found: true,
        reconciledAttemptId: dispatchedAttemptId,
        outcome: { connectionGeneration: 7, ok: true }
      }
    });
    expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('reconciles a created tab by its window identity without replaying CREATE_TAB', async () => {
    const inventory = new BrowserInventory(browserApi);
    const snapshot = await inventory.snapshot();
    const privateWindow = snapshot.windows[0]!;
    const debuggerApi = new FakeDebugger();
    const attachments = new DebuggerAttachmentManager(inventory, debuggerApi);
    const attempts = new RecentAttemptCache(new MemoryStorage());
    const createAttemptId = crypto.randomUUID();
    await attempts.remember({
      attemptId: createAttemptId,
      connectionGeneration: 7,
      inventoryGeneration: snapshot.inventoryGeneration,
      windowId: privateWindow.windowId,
      windowGeneration: privateWindow.windowGeneration,
      operation: 'CREATE_TAB',
      recordedAt: new Date().toISOString(),
      ok: true,
      output: {
        tab: {
          tabId: 11,
          tabGeneration: 1,
          windowId: privateWindow.windowId,
          windowGeneration: privateWindow.windowGeneration,
          title: '',
          url: 'about:blank'
        },
        group: null
      }
    });

    const sent: RelayV2Envelope[] = [];
    const dispatcher = new RelayDispatcher({
      inventory,
      tabGroups: {} as RelayDispatcherDependencies['tabGroups'],
      attachments,
      cdp: {} as RelayDispatcherDependencies['cdp'],
      attempts,
      context: {
        connectionGeneration: () => 8,
        endpointId: () => 'endpoint-test',
        browser: { product: 'Chromium', version: 'test', userAgent: null }
      },
      send: (envelope) => { sent.push(envelope); }
    });
    const reconciliationAttemptId = crypto.randomUUID();
    await dispatcher.dispatch(createRelayV2Envelope('RECONCILE_ATTEMPT', {
      attemptId: reconciliationAttemptId,
      reconciledAttemptId: createAttemptId,
      expected: {
        connectionGeneration: 8,
        inventoryGeneration: snapshot.inventoryGeneration
      },
      window: {
        windowId: privateWindow.windowId,
        windowGeneration: privateWindow.windowGeneration
      }
    }));
    dispatcher.dispose();

    const result = sent.find((envelope) =>
      envelope.type === 'OPERATION_RESULT' && envelope.payload.attemptId === reconciliationAttemptId
    );
    if (result?.type !== 'OPERATION_RESULT') throw new Error('Window reconciliation result was not emitted.');
    expect(result.payload).toMatchObject({
      operation: 'RECONCILE_ATTEMPT',
      outcome: 'succeeded',
      result: {
        found: true,
        reconciledAttemptId: createAttemptId,
        outcome: { operation: 'CREATE_TAB', connectionGeneration: 7, ok: true }
      }
    });
  });
});
