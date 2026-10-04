import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { createRelayApplication, type RelayApplication } from '../../apps/broker/src/runtime/bootstrap.js';
import { loadStdioAdapterConfig } from '../../apps/mcp-stdio-adapter/src/config.js';
import { publishBrokerRuntime, readBrokerRuntime, removeBrokerRuntime, type BrokerRuntime } from '../../apps/shared/protocol/src/runtime-discovery.js';

const TOKEN = 'dynamic-runtime-test-token-long-enough';
describe('shared Broker runtime discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'tabro-discovery-'));
  const path = join(root, 'runtime.json');
  let app: RelayApplication | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close(); client = undefined;
    await app?.stop(); app = undefined;
    rmSync(path, { force: true });
  });
  const record = (url = 'http://127.0.0.1:12345/mcp'): BrokerRuntime => ({
    schemaVersion: 1, instanceRef: randomUUID(), processId: process.pid, startedAt: new Date().toISOString(),
    mcpUrl: url, relayUrl: 'ws://127.0.0.1:12346/relay', databasePath: join(root, 'relay.sqlite')
  });

  it('prefers shared discovery over an inherited fixed URL without changing credentials', () => {
    publishBrokerRuntime(path, record());
    const config = loadStdioAdapterConfig({ TABRO_RUNTIME_FILE: path, TABRO_BROKER_URL: 'http://127.0.0.1:7331/mcp', TABRO_TOKEN: TOKEN });
    expect(config.brokerUrl.href).toBe('http://127.0.0.1:12345/mcp');
    expect(config.bearerToken).toBe(TOKEN);
    expect(config.runtimeFile).toBe(path);
  });

  it('rejects malformed, remote and dead discovery instead of falling back to another Broker', () => {
    for (const value of [{}, { ...record(), mcpUrl: 'http://example.com:12345/mcp' }, { ...record(), processId: 2_000_000_000 }]) {
      writeFileSync(path, JSON.stringify(value));
      expect(() => loadStdioAdapterConfig({ TABRO_RUNTIME_FILE: path, TABRO_TOKEN: TOKEN })).toThrow();
    }
  });

  it('does not remove a discovery record owned by a replacement process', () => {
    const first = record(); const second = record();
    publishBrokerRuntime(path, first); publishBrokerRuntime(path, second);
    removeBrokerRuntime(path, first.instanceRef);
    expect(readBrokerRuntime(path).instanceRef).toBe(second.instanceRef);
    removeBrokerRuntime(path, second.instanceRef);
    expect(() => readFileSync(path)).toThrow();
  });

  it('allocates free ports and keeps a running stdio client working after Broker restart', async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const start = async () => {
      app = createRelayApplication({ host: '127.0.0.1', mcpPort: 0, wsPort: 0, dbPath: join(root, 'relay.sqlite'),
        logLevel: 'silent', heartbeatTimeoutMs: 5_000, errorThreshold: 3, leaseTtlMs: 60_000, adminToken: TOKEN });
      await app.start();
      publishBrokerRuntime(path, { ...record(`http://127.0.0.1:${app.mcpGateway.address().port}/mcp`),
        instanceRef: app.instanceRef, relayUrl: `ws://127.0.0.1:${app.extensionGateway.address().port}/relay` });
    };
    try {
      await start();
      const first = readBrokerRuntime(path);
      client = new Client({ name: 'discovery-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'apps/mcp-stdio-adapter/src/main.ts'],
        cwd: process.cwd(), env: { ...getDefaultEnvironment(), TABRO_RUNTIME_FILE: path, TABRO_TOKEN: TOKEN, TABRO_RUNTIME_SESSION: 'stable-runtime-test' }, stderr: 'pipe' }));
      expect((await client.listTools()).tools).toHaveLength(22);
      const before = await client.callTool({ name: 'get_browser_context', arguments: { view: { kind: 'broker' } } });
      await app!.stop(); app = undefined;
      await start();
      expect(readBrokerRuntime(path).instanceRef).not.toBe(first.instanceRef);
      const after = await client.callTool({ name: 'get_browser_context', arguments: { view: { kind: 'broker' } } });
      expect(after.isError).not.toBe(true);
      expect((after.structuredContent as { caller: unknown }).caller).toEqual((before.structuredContent as { caller: unknown }).caller);
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  }, 30_000);
});
