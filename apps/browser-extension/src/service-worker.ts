import { RelayWebSocketClient } from './transport/websocket-client.js';
import { installReconnectAlarm, type RelayAlarmApi } from './reconnect-alarm.js';
import { DashboardCommandSchema } from '../../shared/protocol/src/dashboard.js';

const relay = new RelayWebSocketClient();
const RECONNECT_ALARM = 'relay:ensure-connected';
const alarms = (chrome as unknown as { alarms?: RelayAlarmApi }).alarms;
const reconnectAlarm = installReconnectAlarm(alarms, RECONNECT_ALARM, () => void relay.connect());

async function ensureReconnectAlarm(): Promise<void> {
  await reconnectAlarm.ensure();
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureReconnectAlarm();
  void relay.connect();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureReconnectAlarm();
  void relay.connect();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL('options.html')) return;
  const type = (message as { type?: string }).type;
  if (type === 'dashboard:request') {
    void (async () => {
      try { sendResponse({ ok: true, result: await relay.dashboard(DashboardCommandSchema.parse((message as { command?: unknown }).command)) }); }
      catch (error) { sendResponse({ ok: false, message: error instanceof Error ? error.message : 'Dashboard action failed.' }); }
    })();
    return true;
  } else if (type === 'relay:reset') {
    void relay.resetRuntime();
  } else if (type === 'relay:reconnect') {
    relay.disconnect();
    setTimeout(() => void relay.connect(), 50);
  }
});

const action = (chrome as unknown as { action?: typeof chrome.action }).action;
action?.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

void relay.connect();
void ensureReconnectAlarm();
