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
import { TabGroupOperations, type BrowserMutationApi } from '../../apps/browser-extension/src/browser/tab-groups.js';
import type { BrowserPolicySnapshot } from '../../apps/shared/protocol/src/browser-interaction-policy.js';
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
  it('creates inactive tabs by default and preserves an explicit active request', async () => {
    const inventory = new BrowserInventory(browserApi);
    const snapshot = await inventory.snapshot();
    const create = vi.fn(async () => ({ ...tab }));
    const api: BrowserMutationApi = {
      tabs: { create, get: async () => ({ ...tab }), group: vi.fn(), move: vi.fn() },
      tabGroups: { get: vi.fn(), update: vi.fn() }
    };
    const operations = new TabGroupOperations(inventory, api);
    await operations.createTab({ window: snapshot.windows[0]! });
    expect(create).toHaveBeenLastCalledWith({ windowId: 1, url: 'about:blank', active: false });
    await operations.createTab({ window: snapshot.windows[0]!, active: true });
    expect(create).toHaveBeenLastCalledWith({ windowId: 1, url: 'about:blank', active: true });
  });

  const policy: BrowserPolicySnapshot = { revision: 'a'.repeat(64), generation: 1,
    configuration: { schemaVersion: 1, rules: [{ id: 'protected', domain: 'example.test', mode: 'input_only' }] } };
  async function policyFixture() {
    let url = 'https://example.test/a';
    const inventory = new BrowserInventory({ ...browserApi, tabs: { get: async () => ({ ...tab, url }) } });
    const snapshot = await inventory.snapshot();
    const privateTab = snapshot.tabs[0]!;
    const api = new FakeDebugger();
    const attachments = new DebuggerAttachmentManager(inventory, api);
    const storage = new MemoryStorage();
    const attempts = new RecentAttemptCache(storage);
    const executor = new CdpExecutor(attachments, attempts);
    const attachment = await attachments.attach(privateTab, null, '1.3');
    executor.applyPolicy(policy, 1);
    const input = { attemptId: crypto.randomUUID(), connectionGeneration: 1, inventoryGeneration: snapshot.inventoryGeneration,
      privateTab, attachmentGeneration: attachment.attachmentGeneration, policyRevision: policy.revision };
    return { api, storage, attempts, executor, input, navigate: (next: string) => { url = next; } };
  }

  it('uses the current top-level URL and enforces newly synchronized revisions', async () => {
    const f = await policyFixture();
    await expect(f.executor.execute({ ...f.input, method: 'DOM.focus', params: { nodeId: 1 } })).rejects.toMatchObject({ code: 'INPUT_ONLY_REQUIRED' });
    expect(f.api.sendCommand).not.toHaveBeenCalled();
    f.navigate('https://unlisted.test/');
    await f.executor.execute({ ...f.input, attemptId: crypto.randomUUID(), method: 'DOM.focus', params: { nodeId: 1 } });
    expect(f.api.sendCommand).toHaveBeenCalledTimes(1);
    f.navigate('https://child.example.test/new');
    await expect(f.executor.execute({ ...f.input, attemptId: crypto.randomUUID(), method: 'DOM.focus' })).rejects.toMatchObject({ code: 'INPUT_ONLY_REQUIRED' });
    f.executor.applyPolicy({ ...policy, revision: 'b'.repeat(64), generation: 2 }, 1);
    await expect(f.executor.execute({ ...f.input, method: 'DOM.getDocument' })).rejects.toMatchObject({ code: 'INPUT_POLICY_STALE' });
  });

  it('maps guarded JavaScript refusal into the same cached error and permits geometry fallback', async () => {
    const f = await policyFixture();
    f.api.sendCommand.mockResolvedValueOnce({ exceptionDetails: { exception: { description: 'EvalError: Possible side-effect in debug-evaluate' } } });
    await expect(f.executor.execute({ ...f.input, method: 'Runtime.evaluate', params: { expression: 'document.body.click()' } })).rejects.toMatchObject({ code: 'INPUT_ONLY_REQUIRED' });
    expect(f.api.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'Runtime.evaluate', expect.objectContaining({ throwOnSideEffect: true, timeout: 1000 }));
    expect(await f.attempts.getForReconciliation({ attemptId: f.input.attemptId })).toMatchObject({ ok: false, error: { code: 'INPUT_ONLY_REQUIRED' } });
    await f.executor.execute({ ...f.input, attemptId: crypto.randomUUID(), method: 'DOM.getBoxModel', params: { nodeId: 1 } });
    expect(f.api.sendCommand).toHaveBeenLastCalledWith({ tabId: 10 }, 'DOM.getBoxModel', { nodeId: 1 });
  });

  it('guards recovery observations even on an unlisted domain', async () => {
    const f = await policyFixture(); f.navigate('https://unlisted.test/');
    await f.executor.execute({ ...f.input, method: 'Runtime.callFunctionOn', recoveryObservation: true, params: { functionDeclaration: 'function(){return this.textContent}', objectId: 'node' } });
    expect(f.api.sendCommand).toHaveBeenCalledWith({ tabId: 10 }, 'Runtime.callFunctionOn', expect.objectContaining({ throwOnSideEffect: true }));
    await expect(f.executor.execute({ ...f.input, method: 'DOM.focus', recoveryObservation: true })).rejects.toMatchObject({ code: 'INPUT_RECOVERY_REQUIRED' });
  });

  it('does not turn a post-execution cache failure into a known failed input', async () => {
    const f = await policyFixture();
    vi.spyOn(f.storage, 'set').mockRejectedValue(new Error('storage unavailable'));
    await expect(f.executor.execute({ ...f.input, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', button: 'left', x: 10, y: 10 } }))
      .rejects.toMatchObject({ code: 'CDP_OUTCOME_UNCERTAIN' });
    expect(f.api.sendCommand).toHaveBeenCalledTimes(1);
    expect(await f.attempts.getForReconciliation({ attemptId: f.input.attemptId })).toBeNull();
  });

  it('preserves ordinary script exceptions instead of labelling them policy refusals', async () => {
    const f = await policyFixture();
    const rawResult = { exceptionDetails: { exception: { description: 'ReferenceError: missingName is not defined' } } };
    f.api.sendCommand.mockResolvedValueOnce(rawResult);
    expect(await f.executor.execute({ ...f.input, method: 'Runtime.evaluate', params: { expression: 'missingName' } })).toMatchObject({ rawResult });
  });

  it('bounds a guarded function observation without sending a mouse or key release', async () => {
    const f = await policyFixture();
    vi.useFakeTimers();
    try {
      let finishTermination!: (value: object) => void;
      const termination = new Promise<object>(resolve => { finishTermination = resolve; });
      f.api.sendCommand.mockImplementation(async (_target, method) => method === 'Runtime.callFunctionOn'
        ? await new Promise<object>(() => {}) : await termination);
      const pending = f.executor.execute({ ...f.input, method: 'Runtime.callFunctionOn', params: { functionDeclaration: 'function(){while(true){}}', objectId: 'node' } });
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const refusal = expect(pending).rejects.toMatchObject({ code: 'OBSERVATION_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);
      finishTermination({}); await refusal;
      expect(f.api.sendCommand.mock.calls.map(call => call[1])).toEqual(['Runtime.callFunctionOn', 'Runtime.terminateExecution']);
    } finally { vi.useRealTimers(); }
  });

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
