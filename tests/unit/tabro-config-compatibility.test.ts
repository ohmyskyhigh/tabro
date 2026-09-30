import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStdioAdapterConfig, resolveAdapterIdentity } from '../../apps/mcp-stdio-adapter/src/config.js';

describe('Tabro configuration compatibility', () => {
  it('keeps old configurations working and prefers new names for the same setting', () => {
    const legacy = loadStdioAdapterConfig({
      OCTOPUS_BROKER_URL: 'http://127.0.0.1:7331/mcp',
      OCTOPUS_BROWSER_RELAY_TOKEN: 'legacy-token-long-enough',
      OCTOPUS_RUNTIME: 'hermes', OCTOPUS_RUNTIME_SESSION: 'old-session'
    });
    expect(legacy.bearerToken).toBe('legacy-token-long-enough');
    expect(legacy.identity.runtimeSessionKey).toBe('old-session');
    const renamed = loadStdioAdapterConfig({
      OCTOPUS_BROKER_URL: 'http://127.0.0.1:7331/mcp', TABRO_BROKER_URL: 'http://127.0.0.1:13618/mcp',
      OCTOPUS_BROWSER_RELAY_TOKEN: 'legacy-token-long-enough', TABRO_TOKEN: 'new-token-long-enough',
      TABRO_RUNTIME: 'hermes', OCTOPUS_RUNTIME_SESSION: 'old-session', TABRO_RUNTIME_SESSION: 'new-session',
      TABRO_DEMO_TRACE_ROOT: '/trace', TABRO_DEMO_RUN_ID: 'rename-check'
    });
    expect(renamed.brokerUrl.port).toBe('13618');
    expect(renamed.bearerToken).toBe('new-token-long-enough');
    expect(renamed.identity.runtimeSessionKey).toBe('new-session');
    expect(renamed.demoTrace).toEqual({ root: '/trace', runId: 'rename-check' });
  });

  it('retains file-token authority and host-supplied session isolation across the rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabro-config-'));
    try {
      const tokenFile = join(root, 'token.txt');
      writeFileSync(tokenFile, 'file-token-long-enough');
      expect(loadStdioAdapterConfig({ OCTOPUS_BROWSER_RELAY_TOKEN_FILE: tokenFile, TABRO_TOKEN: 'inherited-token-long-enough' }).bearerToken)
        .toBe('file-token-long-enough');
      expect(resolveAdapterIdentity({ TABRO_RUNTIME: 'hermes', CODEX_THREAD_ID: 'inherited-codex', HERMES_SESSION_ID: 'hermes-owner', TABRO_RUNTIME_SESSION: 'fallback' }))
        .toMatchObject({ runtimeName: 'hermes', runtimeSessionKey: 'hermes-owner', source: 'hermes-session' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
