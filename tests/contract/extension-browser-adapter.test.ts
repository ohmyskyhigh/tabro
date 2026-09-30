import { describe, expect, it } from 'vitest';
import {
  BrowserInventory,
  type BrowserInventoryApi
} from '../../apps/browser-extension/src/browser/inventory.js';
import {
  TabGroupOperations,
  type BrowserMutationApi
} from '../../apps/browser-extension/src/browser/tab-groups.js';
import {
  createNicknameFromPairingCode,
  createRandomPairingCode,
  normalizePairingCode,
  validatePairingCode
} from '../../apps/browser-extension/src/identity/device-identity.js';

const makeTab = (overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab => ({
  active: true,
  audible: false,
  autoDiscardable: true,
  discarded: false,
  groupId: 20,
  highlighted: true,
  id: 10,
  incognito: false,
  index: 0,
  pinned: false,
  selected: true,
  status: 'complete',
  title: 'Fixture',
  url: 'https://example.test/',
  windowId: 1,
  ...overrides
} as chrome.tabs.Tab);

const makeWindow = (tabs: chrome.tabs.Tab[]): chrome.windows.Window => ({
  alwaysOnTop: false,
  focused: true,
  id: 1,
  incognito: false,
  state: 'normal',
  tabs,
  type: 'normal'
});

const makeGroup = (): chrome.tabGroups.TabGroup => ({
  collapsed: false,
  color: 'blue',
  id: 20,
  shared: false,
  title: 'Agent work',
  windowId: 1
});

class FakeBrowserApi implements BrowserInventoryApi, BrowserMutationApi {
  readonly tabRecords = new Map<number, chrome.tabs.Tab>([[10, makeTab()]]);
  readonly windowRecord = makeWindow([...this.tabRecords.values()]);
  readonly groupRecord = makeGroup();
  nextTabId = 11;

  readonly windows: BrowserInventoryApi['windows'];
  readonly tabs: BrowserInventoryApi['tabs'] & BrowserMutationApi['tabs'];
  readonly tabGroups: BrowserInventoryApi['tabGroups'] & BrowserMutationApi['tabGroups'];

  constructor() {
    this.windows = {
      get: async (windowId) => {
        if (windowId !== this.windowRecord.id) throw new Error('window missing');
        return { ...this.windowRecord, tabs: undefined };
      },
      getAll: async () => [{ ...this.windowRecord, tabs: [...this.tabRecords.values()] }],
      getLastFocused: async () => ({ ...this.windowRecord, tabs: undefined })
    };
    this.tabs = {
      get: async (tabId) => {
        const tab = this.tabRecords.get(tabId);
        if (!tab) throw new Error('tab missing');
        return { ...tab };
      },
      create: async (properties) => {
        const tab = makeTab({
          id: this.nextTabId++,
          windowId: properties.windowId ?? 1,
          groupId: -1,
          active: properties.active ?? true,
          url: String(properties.url ?? 'about:blank'),
          title: ''
        });
        this.tabRecords.set(tab.id!, tab);
        return { ...tab };
      },
      group: async (options) => {
        const tabIds = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds!];
        for (const tabId of tabIds) {
          const tab = this.tabRecords.get(tabId);
          if (tab) tab.groupId = this.groupRecord.id;
        }
        return this.groupRecord.id;
      },
      move: async (tabIds, properties) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        const moved = ids.map((id) => {
          const tab = this.tabRecords.get(id)!;
          if (properties.windowId !== undefined) tab.windowId = properties.windowId;
          tab.index = properties.index;
          return { ...tab };
        });
        return Array.isArray(tabIds) ? moved : moved[0]!;
      }
    };
    this.tabGroups = {
      get: async (groupId) => {
        if (groupId !== this.groupRecord.id) throw new Error('group missing');
        return { ...this.groupRecord };
      },
      query: async () => [{ ...this.groupRecord }],
      update: async (groupId, properties) => {
        if (groupId !== this.groupRecord.id) return undefined;
        Object.assign(this.groupRecord, properties);
        return { ...this.groupRecord };
      }
    };
  }
}

describe('extension browser adapter', () => {
  it('creates a two-word code and a short combined nickname without digits', () => {
    const code = createRandomPairingCode();
    expect(code).toMatch(/^[A-Z]{3,8}-[A-Z]{3,8}$/);
    expect(code).not.toMatch(/\d/);
    expect(createRandomPairingCode(code)).not.toBe(code);
    expect(createNicknameFromPairingCode('MINT-WAVE')).toBe('mintwave');
  });

  it('normalizes a customized pairing code into one deterministic persistent alias', () => {
    expect(normalizePairingCode('  calm_reef  ')).toBe('CALM-REEF');
    expect(validatePairingCode('calm reef')).toBe('CALM-REEF');
    expect(createNicknameFromPairingCode(validatePairingCode('calm reef'))).toBe('calmreef');
    expect(() => validatePairingCode('no-short')).toThrow('two 3-8 letter words');
    expect(() => validatePairingCode('MINT-WAVE-EXTRA')).toThrow('two 3-8 letter words');
  });

  it('reconciles private locators and performs tab-group mutations without creating public IDs', async () => {
    const api = new FakeBrowserApi();
    const inventory = new BrowserInventory(api);
    const operations = new TabGroupOperations(inventory, api);

    const first = await inventory.snapshot();
    expect(first.inventoryGeneration).toBe(1);
    expect(first.windows).toHaveLength(1);
    expect(first.groups[0]).toMatchObject({ tabGroupId: 20, windowId: 1 });
    expect(first.tabs[0]).toMatchObject({ tabId: 10, windowId: 1, groupId: 20 });
    expect(JSON.stringify(first)).not.toMatch(/workspace_ref|tab_ref|window_ref|request_ref/);

    const created = await operations.createTab({
      window: first.windows[0]!,
      group: first.groups[0]!,
      url: 'https://example.test/created',
      active: false
    });
    expect(created.tab).toMatchObject({ tabId: 11, windowId: 1, groupId: 20 });
    expect(created.tab.tabGeneration).toBeGreaterThan(0);
    expect(inventory.currentGeneration()).toBe(2);

    const archived = await operations.archiveGroup(created.group!);
    expect(archived.title).toBe('Agent work archive');
    expect((await operations.archiveGroup(archived)).title).toBe('Agent work archive');

    const staleTab = first.tabs[0]!;
    api.tabRecords.get(staleTab.tabId)!.windowId = 99;
    await expect(inventory.assertTab(staleTab)).rejects.toMatchObject({ code: 'STALE_TAB_LOCATOR' });
  });
});
