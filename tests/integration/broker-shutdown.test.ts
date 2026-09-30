import { afterEach, expect, it, vi } from 'vitest';
import { createRelayApplication } from '../../apps/broker/src/runtime/bootstrap.js';
import { loadConfig } from '../../apps/broker/src/runtime/config.js';

afterEach(() => vi.useRealTimers());

it('stops recovery timers and already queued pumps before closing SQLite', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const app = createRelayApplication(loadConfig({
    RELAY_DB_PATH: ':memory:', RELAY_MCP_PORT: '0', RELAY_WS_PORT: '0',
    RELAY_ADMIN_TOKEN: 'isolated-shutdown-test-token', RELAY_LOG_LEVEL: 'silent'
  }));
  await app.start();
  app.broker.recover();
  await app.stop();
  const scan = vi.spyOn(app.store.canonical.requests, 'scanRequestRecovery');
  await vi.advanceTimersByTimeAsync(10_000);
  app.broker.recover();
  app.broker.onDisconnected('ext_late', 1, 'late close');
  expect(scan).not.toHaveBeenCalled();
  await app.stop();
});
