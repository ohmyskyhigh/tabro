import {
  ExtensionAdapterError,
  type BrowserInventory,
  type PrivateGroupFact,
  type PrivateGroupLocator,
  type PrivateTabFact,
  type PrivateTabLocator,
  type PrivateWindowLocator
} from './inventory.js';

export interface BrowserMutationApi {
  tabs: {
    create(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
    get(tabId: number): Promise<chrome.tabs.Tab>;
    group(options: chrome.tabs.GroupOptions): Promise<number>;
    move(tabIds: number | number[], moveProperties: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | chrome.tabs.Tab[]>;
  };
  tabGroups: {
    get(groupId: number): Promise<chrome.tabGroups.TabGroup>;
    update(groupId: number, updateProperties: chrome.tabGroups.UpdateProperties): Promise<chrome.tabGroups.TabGroup | undefined>;
  };
}

export interface CreateTabInput {
  window: PrivateWindowLocator;
  url?: string;
  active?: boolean;
  index?: number;
  group?: PrivateGroupLocator;
}

const safeUrl = (value: string | undefined): string => {
  if (value === undefined || value === '') return 'about:blank';
  if (value.length > 8_192) throw new ExtensionAdapterError('INVALID_URL', 'The requested URL is too long.');
  if (value === 'about:blank') return value;
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ExtensionAdapterError('BLOCKED_URL_SCHEME', 'Only HTTP, HTTPS, and about:blank tabs can be created.');
  }
  return url.href;
};

const validateTitle = (title: string): string => {
  const normalized = title.trim();
  if (normalized.length === 0 || normalized.length > 255) {
    throw new ExtensionAdapterError('INVALID_GROUP_TITLE', 'A tab-group title must contain between 1 and 255 characters.');
  }
  return normalized;
};

export class TabGroupOperations {
  constructor(
    private readonly inventory: BrowserInventory,
    private readonly api: BrowserMutationApi = chrome
  ) {}

  async createTab(input: CreateTabInput): Promise<{ tab: PrivateTabFact; group: PrivateGroupFact | null }> {
    await this.inventory.assertWindow(input.window);
    if (input.group) {
      const group = await this.inventory.assertGroup(input.group);
      if (group.windowId !== input.window.windowId) {
        throw new ExtensionAdapterError('GROUP_WINDOW_MISMATCH', 'The requested group does not belong to the selected window.');
      }
    }

    const tab = await this.api.tabs.create({
      windowId: input.window.windowId,
      url: safeUrl(input.url),
      active: input.active ?? true,
      ...(input.index === undefined ? {} : { index: input.index })
    });
    if (tab.id === undefined) throw new ExtensionAdapterError('TAB_ID_MISSING', 'Chrome created a tab without an identifier.');

    let groupFact: PrivateGroupFact | null = null;
    if (input.group) {
      const groupId = await this.api.tabs.group({ groupId: input.group.tabGroupId, tabIds: [tab.id] });
      const group = await this.api.tabGroups.get(groupId);
      groupFact = this.inventory.observeGroup(group);
    }
    const refreshed = await this.api.tabs.get(tab.id);
    this.inventory.markChanged();
    return { tab: this.inventory.observeTab(refreshed), group: groupFact };
  }

  async groupTabs(input: {
    window: PrivateWindowLocator;
    tabs: PrivateTabLocator[];
    group?: PrivateGroupLocator;
    title?: string;
  }): Promise<{ group: PrivateGroupFact; tabs: PrivateTabFact[] }> {
    await this.inventory.assertWindow(input.window);
    if (input.tabs.length === 0) throw new ExtensionAdapterError('EMPTY_TAB_SET', 'At least one tab is required.');
    const tabs = await Promise.all(input.tabs.map((tab) => this.inventory.assertTab(tab)));
    if (tabs.some((tab) => tab.windowId !== input.window.windowId)) {
      throw new ExtensionAdapterError('TAB_WINDOW_MISMATCH', 'Every tab must belong to the selected window.');
    }

    if (input.group) await this.inventory.assertGroup(input.group);
    const tabIds = tabs.map((tab) => tab.id!) as [number, ...number[]];
    const groupId = await this.api.tabs.group(input.group
      ? { groupId: input.group.tabGroupId, tabIds }
      : { createProperties: { windowId: input.window.windowId }, tabIds });
    if (input.title !== undefined) {
      const updated = await this.api.tabGroups.update(groupId, { title: validateTitle(input.title) });
      if (!updated) throw new ExtensionAdapterError('GROUP_NOT_FOUND', 'Chrome did not return the updated tab group.');
    }
    const [group, refreshedTabs] = await Promise.all([
      this.api.tabGroups.get(groupId),
      Promise.all(tabs.map((tab) => this.api.tabs.get(tab.id!)))
    ]);
    this.inventory.markChanged();
    return {
      group: this.inventory.observeGroup(group),
      tabs: refreshedTabs.map((tab) => this.inventory.observeTab(tab))
    };
  }

  async moveTab(input: {
    tab: PrivateTabLocator;
    destinationWindow: PrivateWindowLocator;
    index: number;
    destinationGroup?: PrivateGroupLocator;
  }): Promise<{ tab: PrivateTabFact; group: PrivateGroupFact | null }> {
    const [, destination] = await Promise.all([
      this.inventory.assertTab(input.tab),
      this.inventory.assertWindow(input.destinationWindow)
    ]);
    if (destination.id === undefined) throw new ExtensionAdapterError('WINDOW_ID_MISSING', 'Chrome returned a window without an identifier.');
    if (input.destinationGroup) {
      const group = await this.inventory.assertGroup(input.destinationGroup);
      if (group.windowId !== destination.id) {
        throw new ExtensionAdapterError('GROUP_WINDOW_MISMATCH', 'The destination group belongs to another window.');
      }
    }

    await this.api.tabs.move(input.tab.tabId, { windowId: destination.id, index: input.index });
    let groupFact: PrivateGroupFact | null = null;
    if (input.destinationGroup) {
      const groupId = await this.api.tabs.group({
        groupId: input.destinationGroup.tabGroupId,
        tabIds: [input.tab.tabId]
      });
      groupFact = this.inventory.observeGroup(await this.api.tabGroups.get(groupId));
    }
    this.inventory.markChanged();
    return {
      tab: this.inventory.observeTab(await this.api.tabs.get(input.tab.tabId)),
      group: groupFact
    };
  }

  async renameGroup(groupLocator: PrivateGroupLocator, title: string): Promise<PrivateGroupFact> {
    await this.inventory.assertGroup(groupLocator);
    const group = await this.api.tabGroups.update(groupLocator.tabGroupId, { title: validateTitle(title) });
    if (!group) throw new ExtensionAdapterError('GROUP_NOT_FOUND', 'Chrome did not return the updated tab group.');
    this.inventory.markChanged();
    return this.inventory.observeGroup(group);
  }

  async archiveGroup(groupLocator: PrivateGroupLocator): Promise<PrivateGroupFact> {
    const current = await this.inventory.assertGroup(groupLocator);
    const base = current.title?.trim() || 'Tabro';
    const title = /(?:^|\s)archive$/i.test(base) ? base : `${base} archive`;
    const updated = await this.api.tabGroups.update(groupLocator.tabGroupId, { title });
    if (!updated) throw new ExtensionAdapterError('GROUP_NOT_FOUND', 'Chrome did not return the archived tab group.');
    const confirmed = await this.api.tabGroups.get(updated.id);
    if (confirmed.title !== title) {
      throw new ExtensionAdapterError('ARCHIVE_CONFIRMATION_FAILED', 'Chrome did not confirm the archived group title.');
    }
    this.inventory.markChanged();
    return this.inventory.observeGroup(confirmed);
  }
}
