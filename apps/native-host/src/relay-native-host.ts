import { once } from 'node:events';
import { endianness } from 'node:os';
import { resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import WebSocket from 'ws';
import { readBrokerRuntime } from '../../shared/protocol/src/runtime-discovery.js';
import { MANAGED_EXTENSION_ID } from '../../broker/src/profiles/runtime-config.js';
import { newRelayProof, readMachineSecret, verifyBrokerHealth } from '../../shared/protocol/src/machine-auth.js';
import { readMachineRegistration } from '../../shared/protocol/src/machine-registration.js';

const maxMessage = 1024 * 1024;
const littleEndian = endianness() === 'LE';

function frame(message: Buffer): boolean {
  if (!message.length || message.length > maxMessage) throw new Error('Native Messaging payload is too large.');
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(message.length);
  else header.writeUInt32BE(message.length);
  return process.stdout.write(Buffer.concat([header, message]));
}

function control(type: 'READY' | 'ERROR' | 'CLOSED', message?: string, code?: number): void {
  frame(Buffer.from(JSON.stringify({ nativeControl: { type, message, code } })));
}

async function* messages(): AsyncGenerator<Buffer> {
  let buffered: Buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 4) {
      const length = littleEndian ? buffered.readUInt32LE() : buffered.readUInt32BE();
      if (!length || length > maxMessage) throw new Error('Invalid Native Messaging frame length.');
      if (buffered.length < length + 4) break;
      yield buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
    }
  }
  if (buffered.length) throw new Error('Incomplete Native Messaging frame.');
}

let socket: WebSocket | undefined;
process.stdout.on('error', () => {
  socket?.removeAllListeners('close');
  socket?.terminate();
  process.stdin.destroy();
  process.exitCode = 1;
});
try {
  const [runtimePath, origin] = process.argv.slice(2);
  if (origin !== `chrome-extension://${MANAGED_EXTENSION_ID}/`) throw new Error('Tabro extension origin is required.');
  const registration = readMachineRegistration();
  const stateFile = resolve(registration.installationRoot, 'installation.json');
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { schemaVersion?: unknown; runtimeDirectory?: unknown };
    if (state.schemaVersion !== 1 || typeof state.runtimeDirectory !== 'string') throw new Error('Invalid installation selection.');
    const runtimeDirectory = state.runtimeDirectory.replaceAll('\\', '/');
    if (!/^releases\/\d+\.\d+\.\d+-[a-f0-9]{12}$/u.test(runtimeDirectory) ||
        realpathSync(resolve(registration.installationRoot, runtimeDirectory, 'native-host/relay-native-host.js')) !== realpathSync(import.meta.filename)) {
      throw new Error('The native companion is not from the selected installation.');
    }
  }
  const expectedRuntime = resolve(registration.dataRoot, 'runtime.json');
  if (runtimePath && resolve(runtimePath) !== expectedRuntime) throw new Error('The native host runtime does not match the machine registration.');
  const input = messages();
  const first = await input.next();
  const hello = first.done ? undefined : JSON.parse(first.value.toString('utf8'));
  if (hello?.nativeControl?.type !== 'CONNECT') throw new Error('The first native message must request a connection.');

  const runtime = readBrokerRuntime(expectedRuntime);
  if (runtime.databasePath !== resolve(registration.dataRoot, 'relay.sqlite')) throw new Error('Broker discovery does not match the machine registration.');
  const secret = readMachineSecret(registration.dataRoot);
  await verifyBrokerHealth(new URL(runtime.mcpUrl), runtime.instanceRef, secret);
  const connected = socket = new WebSocket(runtime.relayUrl, { maxPayload: maxMessage, handshakeTimeout: 5000,
    headers: { 'x-tabro-relay-proof': newRelayProof(secret, runtime.instanceRef) } });
  await once(connected, 'open');
  control('READY');
  connected.on('error', () => { /* WebSocket reports the disconnect through close. */ });
  connected.on('close', (code, reason) => {
    control('CLOSED', reason.toString('utf8'), code);
    process.stdin.destroy();
  });
  connected.on('message', (data, binary) => {
    if (binary || !Buffer.isBuffer(data)) { connected.close(1003); return; }
    if (!frame(data)) {
      connected.pause();
      process.stdout.once('drain', () => connected.resume());
    }
  });

  for await (const message of input) {
    await new Promise<void>((ok, fail) => connected.send(message, { binary: false }, error => error ? fail(error) : ok()));
  }
} catch (error) {
  if (!process.stdin.destroyed || !socket) control('ERROR', error instanceof Error ? error.message : 'Native Messaging failed.');
  process.exitCode = 1;
} finally {
  socket?.removeAllListeners('close');
  socket?.terminate();
  process.stdin.destroy();
}
