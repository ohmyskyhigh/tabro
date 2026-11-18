import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { OctopusBroker } from '../../apps/broker/src/core/index.js';
import { McpGateway } from '../../apps/broker/src/mcp/server.js';
import { MaintenanceFence } from '../../apps/broker/src/runtime/maintenance.js';
import { startStdioAdapter } from '../../apps/mcp-stdio-adapter/src/server.js';
import type { RelayRepositories } from '../../apps/broker/src/storage/index.js';
import { MCP_CONTRACT_VERSION } from '../../apps/shared/protocol/src/index.js';
import { machineProof, openCredential, sealCredential, verifyBrokerHealth } from '../../apps/shared/protocol/src/machine-auth.js';
import { publishBrokerRuntime } from '../../apps/shared/protocol/src/runtime-discovery.js';

const secret = randomBytes(32);
const token = 'machine-auth-adversarial-test-token';
const instance = randomUUID();
const body = Buffer.from('{"message":"original"}');
const store = { authenticateAgent: (value: string) => value === token
  ? { principalId: 'test', displayName: 'test', scopes: ['broker:admin'] } : null } as unknown as RelayRepositories;
let gateway: McpGateway | undefined;
afterEach(async () => { await gateway?.stop(); gateway = undefined; });

it('binds sealed credentials to instance, method, path, body, nonce, time and ciphertext', () => {
  const sealed = sealCredential(secret, token, instance, 'POST', '/mcp', body);
  expect(openCredential(secret, sealed, instance, 'POST', '/mcp', body)?.token).toBe(token);
  expect(openCredential(secret, sealed, randomUUID(), 'POST', '/mcp', body)).toBeNull();
  expect(openCredential(secret, sealed, instance, 'GET', '/mcp', body)).toBeNull();
  expect(openCredential(secret, sealed, instance, 'POST', '/other', body)).toBeNull();
  expect(openCredential(secret, sealed, instance, 'POST', '/mcp', Buffer.from('{}'))).toBeNull();
  const parts = sealed.split('.');
  for (const index of [0, 1, 2, 3]) {
    const modified = [...parts];
    modified[index] = index === 0 ? String(Date.now() - 31_000) : `${modified[index]![0] === '0' ? '1' : '0'}${modified[index]!.slice(1)}`;
    expect(openCredential(secret, modified.join('.'), instance, 'POST', '/mcp', body)).toBeNull();
  }
  expect(openCredential(randomBytes(32), sealed, instance, 'POST', '/mcp', body)).toBeNull();
  expect(sealCredential(secret, token, instance, 'POST', '/mcp', body)).not.toBe(sealed);
});

it('rejects forged, stale, wrong-instance and redirected health responses without sending credentials', async () => {
  let mode = 'valid'; let previousChallenge = ''; let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-tabro-auth']).toBeUndefined();
    const challenge = new URL(request.url!, 'http://localhost').searchParams.get('challenge')!;
    const proof = machineProof(secret, 'health', instance, mode === 'stale' ? previousChallenge : challenge);
    previousChallenge = challenge;
    if (mode === 'redirect') { response.writeHead(302, { location: '/other' }).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      instanceRef: mode === 'instance' ? randomUUID() : instance, proof: mode === 'forged' ? '0'.repeat(64) : proof
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
  try {
    await expect(verifyBrokerHealth(url, instance, secret)).resolves.toBeUndefined();
    for (mode of ['stale', 'forged', 'instance', 'redirect']) {
      await expect(verifyBrokerHealth(url, instance, secret)).rejects.toThrow();
    }
    expect(requests).toBe(5);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('does not dispatch a token to an impostor advertising a forged health proof', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tabro-impostor-test-'));
  const seen: Array<{ path: string; authorization: string | undefined; sealed: string | string[] | undefined }> = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url!, authorization: request.headers.authorization, sealed: request.headers['x-tabro-auth'] });
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ instanceRef: instance,
      mcpContractVersion: MCP_CONTRACT_VERSION, proof: '0'.repeat(64) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const mcpUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const runtimeFile = join(root, 'runtime.json');
  publishBrokerRuntime(runtimeFile, { schemaVersion: 2, authMode: 'machine-v1', instanceRef: instance, processId: process.pid,
    startedAt: new Date().toISOString(), mcpUrl, relayUrl: 'ws://127.0.0.1:1/relay', databasePath: join(root, 'relay.sqlite') });
  try {
    await expect(startStdioAdapter({ runtimeFile, brokerUrl: new URL(mcpUrl), bearerToken: token, machineSecret: secret,
      serviceVersion: 'test', identity: { runtimeName: 'test', runtimeSessionKey: 'impostor', source: 'explicit' } })).rejects.toThrow(/authentication/i);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ authorization: undefined, sealed: undefined });
    expect(seen[0]!.path).toMatch(/^\/health\?challenge=/u);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects plaintext bearer, forged and replayed credentials and survives a malformed URL', async () => {
  gateway = new McpGateway({} as OctopusBroker, store, { host: '127.0.0.1', port: 0, serviceVersion: 'test',
    health: () => ({}), machineSecret: secret, instanceRef: instance });
  await gateway.start();
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const headers = { 'content-type': 'application/json', 'x-octopus-contract-version': MCP_CONTRACT_VERSION };
  const payload = '{}';
  expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body: payload })).status).toBe(401);
  const sealed = sealCredential(secret, token, instance, 'POST', '/mcp', Buffer.from(payload));
  expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'x-tabro-auth': sealed }, body: '{"changed":true}' })).status).toBe(401);
  expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'x-tabro-auth': sealed }, body: payload })).status).not.toBe(401);
  expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'x-tabro-auth': sealed }, body: payload })).status).toBe(401);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(gateway!.address().port, '127.0.0.1');
    socket.once('connect', () => socket.write('GET http://[bad HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
    socket.on('data', () => {}); socket.once('end', resolve); socket.once('error', reject);
  });
  expect((await fetch(`${base}/health`)).status).toBe(200);
});

it('rejects maintenance while busy and persists its fence across restart until the matching resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tabro-maintenance-test-'));
  const marker = join(root, 'maintenance.json');
  let active = 1;
  const quiet = { relayQuiescent: true, profileQuiescent: true, proxyQuiescent: true };
  const fence = new MaintenanceFence(marker);
  gateway = new McpGateway({} as OctopusBroker, store, { host: '127.0.0.1', port: 0, serviceVersion: 'test',
    health: () => ({ activeWorkspaceCount: active, openRequestCount: 0, ...quiet }), machineSecret: secret, instanceRef: instance, maintenance: fence });
  try {
    await gateway.start();
    const base = `http://127.0.0.1:${gateway.address().port}`;
    const post = (action: string, id: string) => {
      const path = `/maintenance/${action}`;
      const data = JSON.stringify({ transactionId: id, instanceRef: instance });
      return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json',
        'x-tabro-auth': sealCredential(secret, token, instance, 'POST', path, Buffer.from(data)) }, body: data });
    };
    const id = randomUUID();
    expect((await post('enter', id)).status).toBe(409);
    expect(existsSync(marker)).toBe(false);
    active = 0;
    for (const key of Object.keys(quiet) as Array<keyof typeof quiet>) {
      quiet[key] = false;
      expect((await post('enter', id)).status).toBe(409);
      expect(existsSync(marker)).toBe(false);
      quiet[key] = true;
    }
    expect((await post('enter', id)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(401);
    const fencedBody = '{}';
    expect((await fetch(`${base}/mcp`, { method: 'POST', body: fencedBody, headers: {
      'content-type': 'application/json', 'x-octopus-contract-version': MCP_CONTRACT_VERSION,
      'x-tabro-auth': sealCredential(secret, token, instance, 'POST', '/mcp', Buffer.from(fencedBody))
    } })).status).toBe(503);
    expect(new MaintenanceFence(marker).fenced).toBe(true);
    expect((await post('resume', randomUUID())).status).toBe(409);
    expect((await post('resume', id)).status).toBe(200);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
