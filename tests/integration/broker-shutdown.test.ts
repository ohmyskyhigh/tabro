import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayApplication } from '../../apps/broker/src/runtime/bootstrap.js';
import { loadConfig } from '../../apps/broker/src/runtime/config.js';

let rulesRoot: string | undefined;
afterEach(() => { vi.useRealTimers(); if (rulesRoot) rmSync(rulesRoot, { recursive: true, force: true }); });

it('stops recovery timers and already queued pumps before closing SQLite', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const app = createRelayApplication(loadConfig({
    RELAY_DB_PATH: ':memory:', RELAY_MCP_PORT: '0', RELAY_WS_PORT: '0',
    TABRO_BROWSER_RULES_PATH: join(rulesRoot = mkdtempSync(join(tmpdir(), 'tabro-shutdown-rules-')), 'browser-rules.json'),
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
