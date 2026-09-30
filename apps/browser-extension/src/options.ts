import { loadSettings, saveSettings } from './config.js';
import {
  createNicknameFromPairingCode,
  loadOrCreateIdentity,
  normalizePairingCode,
  resetIdentity,
  saveCustomPairingCode,
  validatePairingCode
} from './identity/device-identity.js';

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const brokerUrl = document.querySelector<HTMLInputElement>('#broker-url')!;
const transportMode = document.querySelector<HTMLSelectElement>('#transport-mode')!;
const pairingCode = document.querySelector<HTMLInputElement>('#pairing-code')!;
const profileNickname = document.querySelector<HTMLElement>('#profile-nickname')!;
const status = document.querySelector<HTMLElement>('#status')!;
const reset = document.querySelector<HTMLButtonElement>('#reset')!;

function statusText(value: unknown, alias: unknown, transport: unknown, lastError: unknown): string {
  const state = typeof value === 'string' ? value : 'not connected';
  return `Status: ${state}${typeof alias === 'string' ? ` · alias ${alias}` : ''}${typeof transport === 'string' ? ` · ${transport}` : ''}${typeof lastError === 'string' && lastError ? ` · ${lastError}` : ''}`;
}

async function refresh(): Promise<void> {
  const [settings, identity] = await Promise.all([loadSettings(), loadOrCreateIdentity()]);
  const stored = await chrome.storage.local.get([
    'connectionStatus',
    'endpointNickname',
    'targetAlias',
    'transportKind',
    'lastError'
  ]);
  brokerUrl.value = settings.brokerUrl;
  transportMode.value = settings.transportMode;
  if (document.activeElement !== pairingCode) pairingCode.value = identity.pairingCode ?? '';
  profileNickname.textContent = identity.proposedNickname;
  const connectedNickname = stored.endpointNickname ?? stored.targetAlias ?? identity.nickname;
  status.textContent = statusText(stored.connectionStatus, connectedNickname, stored.transportKind, stored.lastError);
}

function updateNicknamePreview(): void {
  try {
    const normalized = validatePairingCode(pairingCode.value);
    pairingCode.setCustomValidity('');
    profileNickname.textContent = createNicknameFromPairingCode(normalized);
  } catch (error) {
    pairingCode.setCustomValidity(error instanceof Error ? error.message : 'Invalid pairing code');
    profileNickname.textContent = 'invalid pairing code';
  }
}

pairingCode.addEventListener('input', updateNicknamePreview);
pairingCode.addEventListener('blur', () => {
  pairingCode.value = normalizePairingCode(pairingCode.value);
  updateNicknamePreview();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    try {
      const normalizedUrl = new URL(brokerUrl.value);
      if (normalizedUrl.protocol !== 'ws:' && normalizedUrl.protocol !== 'wss:') {
        throw new Error('Broker URL must start with ws:// or wss://');
      }
      const mode = transportMode.value;
      if (mode !== 'native' && mode !== 'websocket') throw new Error('Invalid transport mode');
      const customizedPairing = await saveCustomPairingCode(pairingCode.value);
      pairingCode.value = customizedPairing.pairingCode;
      await saveSettings({
        brokerUrl: normalizedUrl.toString(),
        transportMode: mode
      });
      await chrome.storage.local.set({ connectionStatus: 'connecting', transportKind: null, lastError: null });
      await chrome.runtime.sendMessage({ type: 'relay:reconnect' });
    } catch (error) {
      await chrome.storage.local.set({
        connectionStatus: 'error',
        lastError: error instanceof Error ? error.message : 'Connection failed'
      });
    }
  })();
});

reset.addEventListener('click', () => {
  void (async () => {
    await resetIdentity();
    await chrome.runtime.sendMessage({ type: 'relay:reset' });
    await refresh();
  })();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && [
    'connectionStatus',
    'endpointNickname',
    'targetAlias',
    'profilePairingCode',
    'proposedNickname',
    'transportKind',
    'lastError'
  ].some((key) => key in changes)) {
    void refresh();
  }
});

void refresh();
