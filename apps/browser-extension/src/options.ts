import { loadSettings, saveSettings } from './config.js';
import { createNicknameFromPairingCode, loadOrCreateIdentity, normalizePairingCode, resetIdentity, saveCustomPairingCode, validatePairingCode } from './identity/device-identity.js';
import { BrowserRulesSchema, normalizeRuleDomain, type BrowserRules } from '../../shared/protocol/src/browser-interaction-policy.js';
import { DashboardSnapshotSchema, type DashboardCommand, type DashboardSnapshot } from '../../shared/protocol/src/dashboard.js';
import { profileStatus } from './profile-status.js';

const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const form = element<HTMLFormElement>('settings-form');
const pairingCode = element<HTMLInputElement>('pairing-code');
const brokerUrl = element<HTMLInputElement>('broker-url');
const transportMode = element<HTMLSelectElement>('transport-mode');
const ruleDialog = element<HTMLDialogElement>('rule-dialog');
const confirmDialog = element<HTMLDialogElement>('confirm-dialog');
const domainInput = element<HTMLInputElement>('rule-domain');
let connected = false;
let dirty = false;
let settingsBusy = false;
let brokerBusy = false;
let stale = true;
let connectionRefresh = 0;
let snapshot: DashboardSnapshot | null = null;
let editor: { id: string | null; revision: string; configuration: BrowserRules } | null = null;
let confirmAction: (() => Promise<void>) | null = null;

function notice(message: string, error = false): void {
  const node = element('notice'); node.textContent = message; node.hidden = !message; node.className = `notice${error ? ' error' : ''}`;
}
function message(id: string, value: string | null): void { const node = element(id); node.textContent = value; node.hidden = !value; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'This action could not be completed.'; }
function badge(node: HTMLElement, text: string, tone = ''): void { node.textContent = text; node.className = `badge ${tone}`; }
function transportFields(): void {
  const direct = transportMode.value === 'websocket';
  element('broker-url-field').hidden = !direct; brokerUrl.required = direct;
  element('transport-summary').textContent = direct ? 'Direct WebSocket' : 'Native companion';
}
function controls(): void {
  const editable = connected && !brokerBusy && !stale && !!snapshot?.rules.revision && !snapshot.rules.diagnostic;
  for (const id of ['add-rule', 'add-first-rule', 'save-rule']) element<HTMLButtonElement>(id).disabled = !editable;
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#rule-rows button'))) button.disabled = !editable;
  element<HTMLButtonElement>('refresh-broker').disabled = !connected || brokerBusy;
  element<HTMLButtonElement>('accept-confirm').disabled = brokerBusy || settingsBusy || (confirmDialog.dataset.kind === 'rule' && !editable);
  element<HTMLButtonElement>('save-settings').disabled = settingsBusy;
  element<HTMLButtonElement>('reconnect').disabled = settingsBusy;
  element<HTMLButtonElement>('reset').disabled = settingsBusy;
  element<HTMLButtonElement>('cancel-rule').disabled = brokerBusy;
  element<HTMLButtonElement>('cancel-confirm').disabled = brokerBusy || settingsBusy;
}
function updateNicknamePreview(): void {
  try {
    const normalized = validatePairingCode(pairingCode.value); pairingCode.setCustomValidity('');
    element('profile-nickname').textContent = createNicknameFromPairingCode(normalized);
    element('alias-hint').textContent = dirty ? 'Preview. The alias updates after saving and reconnecting.' : 'Agents use this name to find your browser.';
  } catch (error) { pairingCode.setCustomValidity(errorText(error)); element('alias-hint').textContent = 'Use two words of 3–8 letters, separated by a hyphen.'; }
}
async function refreshConnection(): Promise<void> {
  const refresh = ++connectionRefresh;
  const [settings, identity, stored] = await Promise.all([loadSettings(), loadOrCreateIdentity(), chrome.storage.local.get([
    'connectionStatus', 'endpointNickname', 'targetAlias', 'transportKind', 'lastError', 'brokerVersion'
  ])]);
  if (refresh !== connectionRefresh) return;
  if (!dirty) {
    brokerUrl.value = settings.brokerUrl; transportMode.value = settings.transportMode;
    pairingCode.value = identity.pairingCode ?? '';
    element('profile-nickname').textContent = String(stored.endpointNickname ?? stored.targetAlias ?? identity.proposedNickname);
    element('alias-hint').textContent = 'Agents use this name to find your browser.';
    transportFields();
  }
  const state = typeof stored.connectionStatus === 'string' ? stored.connectionStatus : 'disconnected';
  const previouslyConnected = connected; connected = state === 'connected';
  if (connected && !dirty) element('saved-state').textContent = 'Settings saved on this computer.';
  const label = state.charAt(0).toUpperCase() + state.slice(1).replaceAll('_', ' ');
  const tone = connected ? 'good' : state === 'error' ? 'error' : ['connecting', 'authenticating', 'updating'].includes(state) ? 'warning' : '';
  badge(element('status'), label, tone); badge(element('header-status'), label, tone);
  message('connection-error', typeof stored.lastError === 'string' ? stored.lastError : null);
  element('footer-status').textContent = connected ? `Connected through ${stored.transportKind === 'websocket' ? 'Direct WebSocket' : 'Native companion'}` : 'Broker connection unavailable';
  if (!connected) {
    stale = true;
    element('broker-summary').textContent = snapshot ? 'Disconnected. Displayed data may be out of date.' : 'Connect to load profiles and website rules.';
  }
  controls();
  if (connected && !previouslyConnected && location.hash === '#broker') await refreshBroker();
}

async function dashboard(command: DashboardCommand): Promise<DashboardSnapshot> {
  const response = await chrome.runtime.sendMessage({ type: 'dashboard:request', command }) as { ok?: boolean; result?: unknown; message?: string } | undefined;
  if (!response?.ok) throw new Error(response?.message ?? 'The extension could not reach the Broker. Reconnect and try refreshing.');
  return DashboardSnapshotSchema.parse(response.result);
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result;
}
function renderBroker(data: DashboardSnapshot): void {
  snapshot = data; stale = false;
  element('broker-unavailable').hidden = true; element('broker-content').hidden = false;
  element('broker-summary').textContent = `Broker v${data.brokerVersion} · Shared across your connected profiles`;
  element('profile-count').textContent = String(data.profiles.length);
  const rows = element('profile-rows'); rows.replaceChildren();
  for (const profile of data.profiles) {
    const tr = node('tr'); const nameCell = node('td'); const identity = node('div', undefined, 'profile-name');
    identity.append(node('span', profile.endpoint_nickname.slice(0, 1).toUpperCase(), 'profile-avatar'));
    const name = node('div'); name.append(node('strong', profile.endpoint_nickname));
    if (profile.profile_ref === data.currentProfileRef) name.append(node('small', 'This profile'));
    identity.append(name); nameCell.append(identity);
    const status = node('td'); const statusBadge = node('span');
    const presentation = profileStatus(profile);
    badge(statusBadge, presentation.connection.label, presentation.connection.tone);
    statusBadge.title = presentation.connection.detail;
    status.append(statusBadge);
    if (presentation.connection.tone === 'error') status.append(node('small', presentation.connection.detail, 'status-detail'));
    const automation = node('td'); const automationBadge = node('span');
    badge(automationBadge, presentation.automation.label, presentation.automation.tone);
    automationBadge.title = presentation.automation.detail;
    automation.append(automationBadge);
    if (profile.automation_paused) automation.append(node('small', 'Stopped or recovery required', 'status-detail'));
    const date = new Date(profile.observed_at); const observed = node('td', Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), 'table-muted');
    tr.append(nameCell, node('td', profile.ownership === 'broker' ? 'Tabro' : 'You', 'table-muted'), status, automation, observed); rows.append(tr);
  }
  element('profiles-empty').hidden = data.profiles.length > 0;
  const rules = data.rules.configuration?.rules ?? [];
  element('rule-count').textContent = String(rules.length); element('rules-empty').hidden = rules.length > 0;
  element('rules-table').hidden = rules.length === 0; message('rules-diagnostic', data.rules.diagnostic);
  const ruleRows = element('rule-rows'); ruleRows.replaceChildren();
  for (const rule of rules) {
    const tr = node('tr'); const mode = node('td'); mode.append(node('span', 'Input only', 'mode-label'));
    const actions = node('td'); const buttons = node('div', undefined, 'row-actions');
    const edit = node('button', 'Edit'); edit.type = 'button'; edit.setAttribute('aria-label', `Edit rule for ${rule.domain}`); edit.onclick = () => openRule(rule.id);
    const remove = node('button', 'Remove', 'remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove rule for ${rule.domain}`);
    remove.onclick = () => {
      if (!snapshot?.rules.revision || !snapshot.rules.configuration) return;
      const base = structuredClone(snapshot.rules);
      confirm('Remove this rule?', `${rule.domain} and its subdomains will return to standard behavior unless a broader parent-domain rule still applies.`, 'Remove rule', 'rule', async () => {
        await saveRules({ ...base.configuration!, rules: base.configuration!.rules.filter(item => item.id !== rule.id) }, base.revision!);
        notice(`Rule removed for ${rule.domain}.`);
      });
    };
    buttons.append(edit, remove); actions.append(buttons);
    tr.append(node('td', rule.domain, 'domain-name'), mode, actions); ruleRows.append(tr);
  }
  controls();
}
async function refreshBroker(): Promise<void> {
  if (!connected || brokerBusy) return;
  brokerBusy = true; controls(); element('panel-broker').setAttribute('aria-busy', 'true');
  element('broker-summary').textContent = 'Loading your Broker…';
  try { renderBroker(await dashboard({ action: 'snapshot' })); notice(''); }
  catch (error) { stale = true; notice(errorText(error), true); element('broker-summary').textContent = 'Could not refresh. Check the connection and try again.'; }
  finally { brokerBusy = false; controls(); element('panel-broker').removeAttribute('aria-busy'); }
}
async function saveRules(configuration: BrowserRules, expectedRevision: string): Promise<void> {
  if (!connected) throw new Error('Reconnect before saving. Your domain edit has been kept.');
  brokerBusy = true; controls();
  try { renderBroker(await dashboard({ action: 'rules.save', expectedRevision, configuration: BrowserRulesSchema.parse(configuration) })); }
  catch (error) { stale = true; throw error; }
  finally { brokerBusy = false; controls(); }
}
function openRule(id: string | null = null): void {
  if (!snapshot?.rules.revision || !snapshot.rules.configuration || stale || !connected) return;
  editor = { id, revision: snapshot.rules.revision, configuration: structuredClone(snapshot.rules.configuration) };
  domainInput.value = id ? editor.configuration.rules.find(rule => rule.id === id)!.domain : '';
  element('rule-dialog-title').textContent = id ? 'Edit website rule' : 'Add a website rule';
  domainInput.setCustomValidity(''); message('rule-error', null); ruleDialog.showModal(); domainInput.focus();
}
function confirm(title: string, description: string, button: string, kind: string, action: () => Promise<void>): void {
  element('confirm-title').textContent = title; element('confirm-description').textContent = description;
  element('accept-confirm').textContent = button; confirmDialog.dataset.kind = kind; confirmAction = action;
  message('confirm-error', null); confirmDialog.showModal(); controls(); element('cancel-confirm').focus();
}
function selectTab(name: 'connection' | 'broker', focus = false): void {
  for (const tab of ['connection', 'broker']) {
    const selected = name === tab; const button = element<HTMLButtonElement>(`tab-${tab}`);
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    element(`panel-${tab}`).hidden = !selected; if (selected && focus) button.focus();
  }
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'broker') void refreshBroker();
}
for (const name of ['connection', 'broker'] as const) {
  element(`tab-${name}`).addEventListener('click', () => selectTab(name));
  element(`tab-${name}`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); selectTab(event.key === 'Home' ? 'connection' : event.key === 'End' ? 'broker' : name === 'broker' ? 'connection' : 'broker', true);
    }
  });
}
window.addEventListener('hashchange', () => selectTab(location.hash === '#broker' ? 'broker' : 'connection'));
form.addEventListener('input', () => { dirty = true; element('saved-state').textContent = 'Unsaved changes'; });
pairingCode.addEventListener('input', updateNicknamePreview);
pairingCode.addEventListener('blur', () => { pairingCode.value = normalizePairingCode(pairingCode.value); if (dirty) updateNicknamePreview(); });
transportMode.addEventListener('change', () => { dirty = true; transportFields(); });
form.addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    settingsBusy = true; controls();
    try {
      const url = new URL(brokerUrl.value); if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Broker URL must start with ws:// or wss://.');
      const mode = transportMode.value; if (mode !== 'native' && mode !== 'websocket') throw new Error('Choose a connection method.');
      const identity = await saveCustomPairingCode(pairingCode.value); pairingCode.value = identity.pairingCode;
      await saveSettings({ brokerUrl: url.toString(), transportMode: mode }); dirty = false;
      await chrome.storage.local.set({ connectionStatus: 'connecting', transportKind: null, lastError: null });
      await chrome.runtime.sendMessage({ type: 'relay:reconnect' });
      element('saved-state').textContent = 'Saved. Reconnecting…'; notice('Connection settings saved.');
    } catch (error) { notice(errorText(error), true); }
    finally { settingsBusy = false; controls(); }
  })();
});
element('reconnect').addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'relay:reconnect' }).then(() => notice('Reconnecting with your saved settings.')).catch(error => notice(errorText(error), true));
});
element('copy-code').addEventListener('click', () => {
  void navigator.clipboard.writeText(pairingCode.value).then(() => notice('Pairing code copied.')).catch(() => notice('Could not copy. Select the pairing code and copy it manually.', true));
});
element('reset').addEventListener('click', () => confirm('Reset this profile’s pairing?', 'This creates a new extension identity and pairing code. Finish active browser work first. Your shared website rules stay in place.', 'Reset pairing', 'pairing', async () => {
  settingsBusy = true; controls();
  try { await resetIdentity(); dirty = false; await chrome.runtime.sendMessage({ type: 'relay:reset' }); await refreshConnection(); notice('Pairing reset. Connecting with a new identity.'); }
  finally { settingsBusy = false; controls(); }
}));
element('refresh-broker').addEventListener('click', () => void refreshBroker());
for (const id of ['add-rule', 'add-first-rule']) element(id).addEventListener('click', () => openRule());
element('cancel-rule').addEventListener('click', () => ruleDialog.close());
domainInput.addEventListener('input', () => { domainInput.setCustomValidity(''); message('rule-error', null); });
element<HTMLFormElement>('rule-form').addEventListener('submit', event => {
  event.preventDefault(); if (!editor || brokerBusy) return;
  void (async () => {
    try {
      const domain = normalizeRuleDomain(domainInput.value.trim());
      const id = editor!.id ?? `rule-${crypto.randomUUID()}`;
      const rules = editor!.configuration.rules.filter(rule => rule.id !== id);
      if (rules.some(rule => rule.domain === domain)) throw new Error('A rule for this domain already exists.');
      rules.push({ id, domain, mode: 'input_only' });
      await saveRules({ schemaVersion: 1, rules }, editor!.revision); ruleDialog.close(); notice(`Input-only rule saved for ${domain}.`);
    } catch (error) { message('rule-error', `${errorText(error)}${stale ? ' Close this editor and refresh before saving again.' : ''}`); }
  })();
});
element('cancel-confirm').addEventListener('click', () => confirmDialog.close());
element('accept-confirm').addEventListener('click', () => {
  if (!confirmAction || brokerBusy || settingsBusy) return;
  void confirmAction().then(() => confirmDialog.close()).catch(error => message('confirm-error', errorText(error)));
});
for (const dialog of [ruleDialog, confirmDialog]) dialog.addEventListener('cancel', event => { if (brokerBusy || settingsBusy) event.preventDefault(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['connectionStatus', 'endpointNickname', 'targetAlias', 'transportKind', 'lastError',
    'profilePairingCode', 'proposedNickname', 'brokerVersion', 'brokerUrl', 'transportMode'].some(key => key in changes)) {
    void refreshConnection().catch(error => notice(errorText(error), true));
  }
});
setInterval(() => { if (!document.hidden && location.hash === '#broker' && !ruleDialog.open && !confirmDialog.open) void refreshBroker(); }, 10000);
element('extension-version').textContent = `v${chrome.runtime.getManifest().version}`;
selectTab(location.hash === '#broker' ? 'broker' : 'connection');
void refreshConnection().catch(error => notice(errorText(error), true));
