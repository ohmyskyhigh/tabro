export class ExtensionAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'ExtensionAdapterError';
  }
}

export interface PrivateWindowLocator {
  windowId: number;
  windowGeneration: number;
}

export interface PrivateGroupLocator {
  tabGroupId: number;
  windowId: number;
  windowGeneration: number;
  groupGeneration: number;
}

export interface PrivateTabLocator {
  tabId: number;
  tabGeneration: number;
  windowId: number;
  windowGeneration: number;
}

export interface PrivateWindowFact extends PrivateWindowLocator {
  focused: boolean;
  incognito: boolean;
  state: string | null;
  type: string | null;
}

export interface PrivateGroupFact extends PrivateGroupLocator {
  title: string;
  color: string;
  collapsed: boolean;
}

export interface PrivateTabFact extends PrivateTabLocator {
  groupId: number | null;
  openerTabId: number | null;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  discarded: boolean;
  audible: boolean;
  title: string | null;
  url: string | null;
  pendingUrl: string | null;
  status: string | null;
}

export interface BrowserInventorySnapshot {
  inventoryGeneration: number;
  observedAt: string;
  focusedChromeWindowId: number | null;
  windows: PrivateWindowFact[];
  groups: PrivateGroupFact[];
  tabs: PrivateTabFact[];
}

export interface BrowserInventoryApi {
  windows: {
    get(windowId: number, getInfo?: chrome.windows.QueryOptions): Promise<chrome.windows.Window>;
    getAll(getInfo?: chrome.windows.QueryOptions): Promise<chrome.windows.Window[]>;
    getLastFocused(getInfo?: chrome.windows.QueryOptions): Promise<chrome.windows.Window>;
  };
  tabs: {
    get(tabId: number): Promise<chrome.tabs.Tab>;
  };
  tabGroups: {
    get(groupId: number): Promise<chrome.tabGroups.TabGroup>;
    query(queryInfo: chrome.tabGroups.QueryInfo): Promise<chrome.tabGroups.TabGroup[]>;
  };
}

interface LocatorRecord {
  generation: number;
  fingerprint: string;
}

const TAB_GROUP_ID_NONE = -1;

const groupIdOf = (tab: chrome.tabs.Tab): number | null =>
  Number.isInteger(tab.groupId) && tab.groupId !== TAB_GROUP_ID_NONE
    ? tab.groupId
    : null;

const windowFingerprint = (window: chrome.windows.Window): string =>
  `${window.id ?? 'missing'}:${window.incognito}:${window.type ?? ''}`;

const groupFingerprint = (group: chrome.tabGroups.TabGroup): string =>
  `${group.id}:${group.windowId}`;

const tabFingerprint = (tab: chrome.tabs.Tab): string =>
  `${tab.id ?? 'missing'}:${tab.windowId}`;

export class BrowserInventory {
  private inventoryGeneration = 0;
  private locatorGeneration = 0;
  private readonly windows = new Map<number, LocatorRecord>();
  private readonly groups = new Map<number, LocatorRecord>();
  private readonly tabs = new Map<number, LocatorRecord>();

  constructor(private readonly api: BrowserInventoryApi = chrome) {}

  async snapshot(): Promise<BrowserInventorySnapshot> {
    const [windows, groups, focused] = await Promise.all([
      this.api.windows.getAll({ populate: true, windowTypes: ['normal'] }),
      this.api.tabGroups.query({}),
      this.api.windows.getLastFocused({ populate: false }).catch(() => null)
    ]);
    this.inventoryGeneration += 1;

    const seenWindows = new Set<number>();
    const seenGroups = new Set<number>();
    const seenTabs = new Set<number>();

    const windowFacts = windows.flatMap((window) => {
      if (window.id === undefined) return [];
      seenWindows.add(window.id);
      return [this.observeWindow(window)];
    });
    const groupFacts = groups.flatMap((group) => {
      seenGroups.add(group.id);
      return [this.observeGroup(group)];
    });
    const tabFacts = windows.flatMap((window) => (window.tabs ?? []).flatMap((tab) => {
      if (tab.id === undefined) return [];
      seenTabs.add(tab.id);
      return [this.observeTab(tab)];
    }));

    this.removeMissing(this.windows, seenWindows);
    this.removeMissing(this.groups, seenGroups);
    this.removeMissing(this.tabs, seenTabs);

    return {
      inventoryGeneration: this.inventoryGeneration,
      observedAt: new Date().toISOString(),
      focusedChromeWindowId: focused?.id ?? null,
      windows: windowFacts,
      groups: groupFacts,
      tabs: tabFacts
    };
  }

  currentGeneration(): number {
    return this.inventoryGeneration;
  }

  /** Live window focus used to gate Human Simulation input. False when the window is gone. */
  async isWindowFocused(windowId: number): Promise<boolean> {
    const info = await this.api.windows.get(windowId, { populate: false }).catch(() => null);
    return info?.focused === true;
  }

  markChanged(): number {
    this.inventoryGeneration += 1;
    return this.inventoryGeneration;
  }

  observeWindow(window: chrome.windows.Window): PrivateWindowFact {
    if (window.id === undefined) {
      throw new ExtensionAdapterError('WINDOW_ID_MISSING', 'Chrome returned a window without an identifier.');
    }
    const generation = this.upsert(this.windows, window.id, windowFingerprint(window));
    return {
      windowId: window.id,
      windowGeneration: generation,
      focused: window.focused,
      incognito: window.incognito,
      state: window.state ?? null,
      type: window.type ?? null
    };
  }

  observeGroup(group: chrome.tabGroups.TabGroup): PrivateGroupFact {
    const generation = this.upsert(this.groups, group.id, groupFingerprint(group));
    const windowGeneration = this.windows.get(group.windowId)?.generation;
    if (windowGeneration === undefined) {
      throw new ExtensionAdapterError('WINDOW_LOCATOR_MISSING', 'The group parent window has not been reconciled.');
    }
    return {
      tabGroupId: group.id,
      windowId: group.windowId,
      windowGeneration,
      groupGeneration: generation,
      title: group.title ?? '',
      color: group.color,
      collapsed: group.collapsed
    };
  }

  observeTab(tab: chrome.tabs.Tab): PrivateTabFact {
    if (tab.id === undefined) {
      throw new ExtensionAdapterError('TAB_ID_MISSING', 'Chrome returned a tab without an identifier.');
    }
    const generation = this.upsert(this.tabs, tab.id, tabFingerprint(tab));
    const windowGeneration = this.windows.get(tab.windowId)?.generation;
    if (windowGeneration === undefined) {
      throw new ExtensionAdapterError('WINDOW_LOCATOR_MISSING', 'The tab parent window has not been reconciled.');
    }
    return {
      tabId: tab.id,
      tabGeneration: generation,
      windowId: tab.windowId,
      windowGeneration,
      groupId: groupIdOf(tab),
      openerTabId: tab.openerTabId ?? null,
      active: tab.active,
      highlighted: tab.highlighted,
      pinned: tab.pinned,
      discarded: tab.discarded,
      audible: tab.audible ?? false,
      title: tab.title ?? null,
      url: tab.url ?? null,
      pendingUrl: tab.pendingUrl ?? null,
      status: tab.status ?? null
    };
  }

  async assertWindow(locator: PrivateWindowLocator): Promise<chrome.windows.Window> {
    const record = this.windows.get(locator.windowId);
    if (!record || record.generation !== locator.windowGeneration) {
      throw new ExtensionAdapterError('STALE_WINDOW_LOCATOR', 'The broker window locator is no longer current.');
    }
    const window = await this.api.windows.get(locator.windowId, { populate: false })
      .catch(() => null);
    if (!window || window.id === undefined || windowFingerprint(window) !== record.fingerprint) {
      this.windows.delete(locator.windowId);
      throw new ExtensionAdapterError('STALE_WINDOW_LOCATOR', 'The Chrome window no longer matches the broker locator.');
    }
    return window;
  }

  async assertGroup(locator: PrivateGroupLocator): Promise<chrome.tabGroups.TabGroup> {
    const record = this.groups.get(locator.tabGroupId);
    if (!record || record.generation !== locator.groupGeneration) {
      throw new ExtensionAdapterError('STALE_GROUP_LOCATOR', 'The broker tab-group locator is no longer current.');
    }
    const group = await this.api.tabGroups.get(locator.tabGroupId).catch(() => null);
    if (!group || group.windowId !== locator.windowId || groupFingerprint(group) !== record.fingerprint
      || this.windows.get(group.windowId)?.generation !== locator.windowGeneration) {
      this.groups.delete(locator.tabGroupId);
      throw new ExtensionAdapterError('STALE_GROUP_LOCATOR', 'The Chrome tab group no longer matches the broker locator.');
    }
    return group;
  }

  async assertTab(locator: PrivateTabLocator): Promise<chrome.tabs.Tab> {
    const record = this.tabs.get(locator.tabId);
    if (!record || record.generation !== locator.tabGeneration) {
      throw new ExtensionAdapterError('STALE_TAB_LOCATOR', 'The broker tab locator is no longer current.');
    }
    const tab = await this.api.tabs.get(locator.tabId).catch(() => null);
    if (!tab || tab.windowId !== locator.windowId || tabFingerprint(tab) !== record.fingerprint
      || this.windows.get(tab.windowId)?.generation !== locator.windowGeneration) {
      this.tabs.delete(locator.tabId);
      throw new ExtensionAdapterError('STALE_TAB_LOCATOR', 'The Chrome tab no longer matches the broker locator.');
    }
    return tab;
  }

  forgetTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  private upsert(records: Map<number, LocatorRecord>, id: number, fingerprint: string): number {
    const current = records.get(id);
    if (current?.fingerprint === fingerprint) return current.generation;
    this.locatorGeneration += 1;
    const generation = this.locatorGeneration;
    records.set(id, { generation, fingerprint });
    return generation;
  }

  private removeMissing(records: Map<number, LocatorRecord>, seen: Set<number>): void {
    for (const id of records.keys()) {
      if (!seen.has(id)) records.delete(id);
    }
  }
}
