import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';

const binary = resolve('dist/native-host/relay-native-host-dynamic.exe');
it.skipIf(process.platform !== 'win32' || !existsSync(binary))('native companion discovers the dynamic relay and rejects malformed records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tabro-native-discovery-'));
  const executable = join(root, 'relay-native-host.exe');
  copyFileSync(binary, executable);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/relay' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local port.');
  const control = async () => {
    const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const first = new Promise<{ nativeControl: { type: string } }>((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      child.on('error', reject);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) {
          resolve(JSON.parse(bytes.subarray(4, bytes.readUInt32LE(0) + 4).toString()) as { nativeControl: { type: string } });
        }
      });
    });
    const body = Buffer.from(JSON.stringify({ url: 'ws://127.0.0.1:1/relay' }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
    try { return await first; }
    finally { child.stdin.end(); await exited; }
  };
  try {
    writeFileSync(join(root, 'relay-runtime.json'), JSON.stringify({ schemaVersion: 1, instanceRef: randomUUID(), processId: process.pid,
      startedAt: new Date().toISOString(), mcpUrl: 'http://127.0.0.1:12345/mcp', relayUrl: `ws://127.0.0.1:${address.port}/relay`, databasePath: 'test' }));
    expect((await control()).nativeControl.type).toBe('READY');
    writeFileSync(join(root, 'relay-runtime.json'), '{}');
    expect((await control()).nativeControl.type).toBe('ERROR');
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
