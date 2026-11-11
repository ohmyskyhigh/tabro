import {
  ExtensionAdapterError,
  type BrowserInventory,
  type PrivateTabLocator
} from '../browser/inventory.js';

export interface DebuggerEvent<T extends (...args: never[]) => void> {
  addListener(listener: T): void;
  removeListener?(listener: T): void;
}

export interface DebuggerApi {
  attach(target: chrome.debugger.Debuggee, requiredVersion: string): Promise<void>;
  detach(target: chrome.debugger.Debuggee): Promise<void>;
  sendCommand(
    target: chrome.debugger.DebuggerSession,
    method: string,
    commandParams?: Record<string, unknown>
  ): Promise<object | undefined>;
  getTargets(): Promise<chrome.debugger.TargetInfo[]>;
  onDetach: {
    addListener(listener: (source: chrome.debugger.Debuggee, reason: string) => void): void;
    removeListener?(listener: (source: chrome.debugger.Debuggee, reason: string) => void): void;
  };
  onEvent: {
    addListener(listener: (source: chrome.debugger.DebuggerSession, method: string, params?: object) => void): void;
    removeListener?(listener: (source: chrome.debugger.DebuggerSession, method: string, params?: object) => void): void;
  };
}

export interface AttachmentRecord {
  privateTab: PrivateTabLocator;
  attachmentGeneration: number;
  protocolVersion: string;
  attachedAt: string;
  childSessionIds: readonly string[];
}

export interface DebuggerDetachFact {
  privateTab: PrivateTabLocator;
  attachmentGeneration: number;
  reason: string;
  detachedAt: string;
}

interface MutableAttachmentRecord {
  privateTab: PrivateTabLocator;
  attachmentGeneration: number;
  protocolVersion: string;
  attachedAt: string;
  childSessionIds: Set<string>;
  eventSequence: number;
}

const copyRecord = (record: MutableAttachmentRecord): AttachmentRecord => ({
  privateTab: { ...record.privateTab },
  attachmentGeneration: record.attachmentGeneration,
  protocolVersion: record.protocolVersion,
  attachedAt: record.attachedAt,
  childSessionIds: [...record.childSessionIds]
});

export class DebuggerAttachmentManager {
  currentTab(locator: PrivateTabLocator): Promise<chrome.tabs.Tab> { return this.inventory.assertTab(locator); }
  private readonly attachments = new Map<number, MutableAttachmentRecord>();
  private readonly tabLocks = new Map<number, Promise<void>>();
  private readonly detachListeners = new Set<(fact: DebuggerDetachFact) => void>();
  private attachmentGeneration = 0;
  private readonly onChromeDetach = (source: chrome.debugger.Debuggee, reason: string): void => {
    if (source.tabId === undefined) return;
    const record = this.attachments.get(source.tabId);
    if (!record) return;
    this.attachments.delete(source.tabId);
    const fact: DebuggerDetachFact = {
      privateTab: { ...record.privateTab },
      attachmentGeneration: record.attachmentGeneration,
      reason,
      detachedAt: new Date().toISOString()
    };
    for (const listener of this.detachListeners) listener(fact);
  };

  constructor(
    private readonly inventory: BrowserInventory,
    readonly api: DebuggerApi = chrome.debugger,
    private readonly protocolVersion = '1.3'
  ) {
    api.onDetach.addListener(this.onChromeDetach);
  }

  async attach(
    privateTab: PrivateTabLocator,
    expectedAttachmentGeneration: number | null,
    protocolVersion = this.protocolVersion
  ): Promise<AttachmentRecord> {
    if (expectedAttachmentGeneration !== null
      && (!Number.isInteger(expectedAttachmentGeneration) || expectedAttachmentGeneration <= 0)) {
      throw new ExtensionAdapterError('INVALID_ATTACHMENT_GENERATION', 'The attachment generation is invalid.');
    }
    return this.withTabLock(privateTab.tabId, async () => {
      await this.inventory.assertTab(privateTab);
      const current = this.attachments.get(privateTab.tabId);
      if (current) {
        if (current.privateTab.tabGeneration !== privateTab.tabGeneration
          || current.attachmentGeneration !== expectedAttachmentGeneration) {
          throw new ExtensionAdapterError(
            'ATTACHMENT_GENERATION_CONFLICT',
            'The tab is already attached under another fenced generation.'
          );
        }
        return copyRecord(current);
      }
      if (expectedAttachmentGeneration !== null) {
        throw new ExtensionAdapterError('STALE_ATTACHMENT', 'The expected debugger attachment no longer exists.');
      }

      try {
        await this.api.attach({ tabId: privateTab.tabId }, protocolVersion);
      } catch (error) {
        throw new ExtensionAdapterError(
          'DEBUGGER_ATTACH_FAILED',
          error instanceof Error ? error.message : 'Chrome rejected the debugger attachment.',
          true
        );
      }

      try {
        await this.inventory.assertTab(privateTab);
      } catch (error) {
        await this.api.detach({ tabId: privateTab.tabId }).catch(() => undefined);
        throw error;
      }

      this.attachmentGeneration += 1;
      const record: MutableAttachmentRecord = {
        privateTab: { ...privateTab },
        attachmentGeneration: this.attachmentGeneration,
        protocolVersion,
        attachedAt: new Date().toISOString(),
        childSessionIds: new Set(),
        eventSequence: 0
      };
      this.attachments.set(privateTab.tabId, record);
      return copyRecord(record);
    });
  }

  async ensureAttached(
    privateTab: PrivateTabLocator,
    attachmentGeneration: number
  ): Promise<AttachmentRecord> {
    const current = this.assertAttached(privateTab, attachmentGeneration);
    return copyRecord(current);
  }

  async detach(privateTab: PrivateTabLocator, attachmentGeneration: number): Promise<void> {
    await this.withTabLock(privateTab.tabId, async () => {
      const record = this.assertAttached(privateTab, attachmentGeneration);
      try {
        await this.api.detach({ tabId: privateTab.tabId });
      } catch (error) {
        throw new ExtensionAdapterError(
          'DEBUGGER_DETACH_FAILED',
          error instanceof Error ? error.message : 'Chrome rejected the debugger detach.',
          true
        );
      }
      if (this.attachments.get(privateTab.tabId) === record) {
        this.attachments.delete(privateTab.tabId);
      }
    });
  }

  assertAttached(
    privateTab: PrivateTabLocator,
    attachmentGeneration: number,
    childSessionId?: string
  ): MutableAttachmentRecord {
    const record = this.attachments.get(privateTab.tabId);
    if (!record
      || record.privateTab.tabGeneration !== privateTab.tabGeneration
      || record.privateTab.windowId !== privateTab.windowId
      || record.attachmentGeneration !== attachmentGeneration) {
      throw new ExtensionAdapterError('STALE_ATTACHMENT', 'No current debugger attachment matches this request.');
    }
    if (childSessionId !== undefined && !record.childSessionIds.has(childSessionId)) {
      throw new ExtensionAdapterError('UNKNOWN_CHILD_SESSION', 'The child CDP session is outside the current attachment tree.');
    }
    return record;
  }

  lookup(source: chrome.debugger.DebuggerSession): AttachmentRecord | null {
    if (source.tabId === undefined) return null;
    const record = this.attachments.get(source.tabId);
    if (!record) return null;
    if (source.sessionId !== undefined && !record.childSessionIds.has(source.sessionId)) return null;
    return copyRecord(record);
  }

  registerChildSession(tabId: number, sessionId: string): boolean {
    const record = this.attachments.get(tabId);
    if (!record || sessionId.length === 0) return false;
    record.childSessionIds.add(sessionId);
    return true;
  }

  unregisterChildSession(tabId: number, sessionId: string): void {
    this.attachments.get(tabId)?.childSessionIds.delete(sessionId);
  }

  nextEventSequence(tabId: number): number {
    const record = this.attachments.get(tabId);
    if (!record) throw new ExtensionAdapterError('STALE_ATTACHMENT', 'The debugger attachment no longer exists.');
    record.eventSequence += 1;
    return record.eventSequence;
  }

  onDetach(listener: (fact: DebuggerDetachFact) => void): () => void {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  list(): AttachmentRecord[] {
    return [...this.attachments.values()].map(copyRecord);
  }

  async detachAll(): Promise<void> {
    const tabIds = [...this.attachments.keys()];
    await Promise.all(tabIds.map(async (tabId) => {
      try {
        await this.api.detach({ tabId });
      } catch {
        // Reset must discard the old endpoint attachment generation even if Chrome already detached it.
      } finally {
        this.attachments.delete(tabId);
      }
    }));
  }

  dispose(): void {
    this.api.onDetach.removeListener?.(this.onChromeDetach);
    this.detachListeners.clear();
  }

  private async withTabLock<T>(chromeTabId: number, work: () => Promise<T>): Promise<T> {
    const previous = this.tabLocks.get(chromeTabId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => current);
    this.tabLocks.set(chromeTabId, chained);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tabLocks.get(chromeTabId) === chained) this.tabLocks.delete(chromeTabId);
    }
  }
}
