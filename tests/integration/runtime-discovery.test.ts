import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
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
    schemaVersion: 2, authMode: 'machine-v1', instanceRef: randomUUID(), processId: process.pid, startedAt: new Date().toISOString(),
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
    const machineSecret = randomBytes(32);
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const start = async () => {
      app = createRelayApplication({ host: '127.0.0.1', mcpPort: 0, wsPort: 0, dbPath: join(root, 'relay.sqlite'),
        logLevel: 'silent', heartbeatTimeoutMs: 5_000, errorThreshold: 3, leaseTtlMs: 60_000, adminToken: TOKEN, machineSecret });
      await app.start();
      publishBrokerRuntime(path, { ...record(`http://127.0.0.1:${app.mcpGateway.address().port}/mcp`),
        instanceRef: app.instanceRef, relayUrl: `ws://127.0.0.1:${app.extensionGateway.address().port}/relay` });
    };
    try {
      await start();
      const first = readBrokerRuntime(path);
      client = new Client({ name: 'discovery-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'tests/helpers/stdio-adapter-fixture.ts'],
        cwd: process.cwd(), env: { ...getDefaultEnvironment(), TABRO_RUNTIME_FILE: path, TABRO_TOKEN: TOKEN,
          TABRO_TEST_MACHINE_SECRET: machineSecret.toString('hex'), TABRO_RUNTIME_SESSION: 'stable-runtime-test' }, stderr: 'pipe' }));
      expect((await client.listTools()).tools).toHaveLength(22);
      const before = await client.callTool({ name: 'get_browser_context', arguments: { view: { kind: 'broker' } } });
      await app!.stop(); app = undefined;
      await start();
      expect(readBrokerRuntime(path).instanceRef).not.toBe(first.instanceRef);
      const after = await client.callTool({ name: 'get_browser_context', arguments: { view: { kind: 'broker' } } });
      expect(after.isError).not.toBe(true);
      expect((after.structuredContent as { caller: unknown }).caller).toEqual((before.structuredContent as { caller: unknown }).caller);
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  }, 90_000);

  it('uses a fresh sealed credential on each SDK request and does not replay a lost mutation response', async () => {
    const machineSecret = randomBytes(32);
    app = createRelayApplication({ host: '127.0.0.1', mcpPort: 0, wsPort: 0, dbPath: join(root, 'replay.sqlite'),
      logLevel: 'silent', heartbeatTimeoutMs: 5_000, errorThreshold: 3, leaseTtlMs: 60_000, adminToken: TOKEN, machineSecret });
    await app.start();
    const targetPort = app.mcpGateway.address().port;
    const nonces: string[] = [];
    let mutations = 0;
    const proxy = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        const header = request.headers['x-tabro-auth'];
        if (typeof header === 'string') nonces.push(header.split('.')[1]!);
        let mutation = false;
        try {
          const message = JSON.parse(body.toString()) as { method?: string; params?: { name?: string } };
          mutation = message.method === 'tools/call' && message.params?.name === 'request_browser_workspace';
        } catch { /* Health and empty requests have no JSON body. */ }
        if (mutation) mutations++;
        const upstream = httpRequest({ host: '127.0.0.1', port: targetPort, path: request.url, method: request.method, headers: request.headers }, result => {
          if (mutation) { result.resume(); response.destroy(); return; }
          response.writeHead(result.statusCode ?? 500, result.headers); result.pipe(response);
        });
        upstream.on('error', () => response.destroy());
        upstream.end(body);
      });
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    publishBrokerRuntime(path, { ...record(`http://127.0.0.1:${proxyPort}/mcp`), instanceRef: app.instanceRef,
      relayUrl: `ws://127.0.0.1:${app.extensionGateway.address().port}/relay` });
    try {
      client = new Client({ name: 'lost-response-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'tests/helpers/stdio-adapter-fixture.ts'],
        cwd: process.cwd(), env: { ...getDefaultEnvironment(), TABRO_RUNTIME_FILE: path, TABRO_TOKEN: TOKEN,
          TABRO_TEST_MACHINE_SECRET: machineSecret.toString('hex'), TABRO_RUNTIME_SESSION: 'lost-response-test' }, stderr: 'pipe' }));
      await client.listTools();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          client.callTool({ name: 'request_browser_workspace', arguments: { required_workspace_count: 1,
            designated_endpoints: [{ endpoint_nickname: 'missing' }] } }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Timed out waiting for the lost response.')), 15_000); })
        ]);
        expect(result.isError).toBe(true);
      } finally { clearTimeout(timeout); }
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(mutations).toBe(1);
      expect(nonces.length).toBeGreaterThan(2);
      expect(new Set(nonces).size).toBe(nonces.length);
    } finally {
      await client?.close(); client = undefined;
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 45_000);
});
