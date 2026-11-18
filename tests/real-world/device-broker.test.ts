import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { sealCredential } from '../../apps/shared/protocol/src/machine-auth.js';
import { MCP_CONTRACT_VERSION } from '../../apps/shared/protocol/src/index.js';

interface Runtime { processId: number; instanceRef: string; relayUrl: string; mcpUrl: string }
interface Installation { runtimeDirectory: string; nativeHostEntry: string }

it.runIf(process.env.TABRO_QUALIFY_DEVICE === '1')('enforces one production Broker and recovers after a crash', async () => {
  if (!process.env.TABRO_QUALIFY_INSTALL_ROOT) throw new Error('TABRO_QUALIFY_INSTALL_ROOT is required on a provisioned, isolated host.');
  const root = realpathSync(process.env.TABRO_QUALIFY_INSTALL_ROOT);
  const data = resolve(root, 'data');
  const registrationPath = process.platform === 'win32'
    ? resolve(process.env.ProgramData ?? 'C:\\ProgramData', 'Tabro/registration.json')
    : process.platform === 'darwin' ? '/var/db/tabro/registration.json' : '/var/lib/tabro/registration.json';
  const registration = JSON.parse(readFileSync(registrationPath, 'utf8')) as { installationRoot: string; dataRoot: string };
  expect(realpathSync(registration.installationRoot)).toBe(root);
  expect(realpathSync(registration.dataRoot)).toBe(realpathSync(data));
  const runtimePath = resolve(data, 'runtime.json');
  const state = JSON.parse(readFileSync(resolve(root, 'installation.json'), 'utf8')) as Installation;
  const entry = resolve(root, state.runtimeDirectory, 'broker/main.js');
  if (!existsSync(entry)) throw new Error(`Packaged Broker is missing: ${entry}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_') && !key.startsWith('TABRO_')));
  env.RELAY_DB_PATH = resolve(data, 'relay.sqlite');
  env.RELAY_LOG_LEVEL = 'silent';
  const children: ChildProcess[] = [];
  const ownedInstances = new Map<number, string>();
  let ownedTransaction: string | undefined;
  const checks: string[] = [];
  const report: { status: string; platform: string; arch: string; checks: string[]; error?: string } = {
    status: 'running', platform: process.platform, arch: process.arch, checks
  };
  const launch = (path = entry, overrides: NodeJS.ProcessEnv = {}) => {
    const child = spawn(process.execPath, [path], { env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.push(child);
    return child;
  };
  const readRuntime = (): Runtime | undefined => {
    try { return JSON.parse(readFileSync(runtimePath, 'utf8')) as Runtime; } catch { return undefined; }
  };
  const exited = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('error', reject); child.once('exit', () => resolve());
  });
  const stop = async (child: ChildProcess) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited(child);
  };
  const connectRelay = (url: string, proof?: string) => new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: proof ? { 'x-tabro-relay-proof': proof } : {} });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
  const otherRoot = mkdtempSync(join(tmpdir(), 'tabro-wrong-install-'));
  try {
    if (readRuntime()) throw new Error('Qualification requires a stopped Broker and no published runtime.');
    const first = launch(); const second = launch();
    await expect.poll(() => readRuntime()?.processId, { timeout: 30_000 }).toSatisfy((pid: number | undefined) => pid === first.pid || pid === second.pid);
    const owner = readRuntime()!;
    ownedInstances.set(owner.processId, owner.instanceRef);
    const winner = first.pid === owner.processId ? first : second;
    const loser = winner === first ? second : first;
    await expect.poll(() => loser.exitCode !== null || loser.signalCode !== null, { timeout: 15_000 }).toBe(true);
    expect(loser.exitCode).not.toBe(0);
    expect(winner.exitCode).toBeNull();
    checks.push('concurrent production starts leave exactly one owner');

    await stop(winner);
    const wrongData = resolve(otherRoot, 'data/relay.sqlite');
    const wrong = launch(entry, { RELAY_DB_PATH: wrongData });
    await expect.poll(() => wrong.exitCode !== null || wrong.signalCode !== null, { timeout: 15_000 }).toBe(true);
    expect(wrong.exitCode).not.toBe(0);
    expect(existsSync(wrongData)).toBe(false);
    const copy = resolve(otherRoot, 'runtime');
    cpSync(resolve(root, state.runtimeDirectory), copy, { recursive: true });
    const copied = launch(resolve(copy, 'broker/main.js'));
    await expect.poll(() => copied.exitCode !== null || copied.signalCode !== null, { timeout: 15_000 }).toBe(true);
    expect(copied.exitCode).not.toBe(0);
    expect(readRuntime()).toEqual(owner);
    checks.push('wrong data and installation roots fail after the owner exits');

    let restarted: ChildProcess | undefined;
    for (const stale of ['{"partial":', JSON.stringify({ ...owner, processId: process.pid })]) {
      // A partial record or a live unrelated PID must not defeat the OS lock.
      writeFileSync(runtimePath, stale);
      restarted = launch();
      await expect.poll(() => readRuntime()?.processId, { timeout: 30_000 }).toBe(restarted.pid);
      const recovered = readRuntime()!;
      ownedInstances.set(recovered.processId, recovered.instanceRef);
      expect(recovered.instanceRef).not.toBe(owner.instanceRef);
      if (stale.startsWith('{"partial"')) await stop(restarted);
    }
    checks.push('crash recovery replaces partial and live-PID stale records');

    const current = readRuntime()!;
    const secret = Buffer.from(readFileSync(resolve(data, 'native-secret'), 'utf8').trim(), 'hex');
    const challenge = randomBytes(32).toString('hex');
    const health = new URL('/health', current.mcpUrl); health.searchParams.set('challenge', challenge);
    const healthBody = await (await fetch(health)).json() as { proof: string };
    expect(healthBody.proof).toBe(createHmac('sha256', secret).update(`health:${current.instanceRef}:${challenge}`).digest('hex'));
    await expect(connectRelay(current.relayUrl)).rejects.toThrow();
    await expect(connectRelay(current.relayUrl, `${Date.now()}.${randomBytes(16).toString('hex')}.${'0'.repeat(64)}`)).rejects.toThrow();
    const timestamp = Date.now(); const nonce = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', secret).update(`relay:${current.instanceRef}:${timestamp}:${nonce}`).digest('hex');
    const proof = `${timestamp}.${nonce}.${signature}`;
    const authenticated = await connectRelay(current.relayUrl, proof);
    authenticated.terminate();
    await expect(connectRelay(current.relayUrl, proof)).rejects.toThrow();
    checks.push('health proof verifies and relay rejects missing, forged, and replayed proofs');

    const token = readFileSync(resolve(data, 'admin-token.txt'), 'utf8').trim();
    const origin = 'chrome-extension://caekiojlchhifdomfghejkbfpmaklafe/';
    const nativePath = process.platform === 'win32' ? resolve(root, 'bootstrap/relay-native-host.exe')
      : resolve(root, state.runtimeDirectory, state.nativeHostEntry);
    if (!existsSync(nativePath)) throw new Error(`Installed native host is missing: ${nativePath}`);
    const native = spawn(process.platform === 'win32' ? nativePath : process.execPath,
      process.platform === 'win32' ? [origin] : [nativePath, runtimePath, origin],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.push(native); native.stderr?.resume();
    const nativeReply = new Promise<string>((resolveReply, reject) => {
      let bytes = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('Native host did not reply.')), 15_000);
      native.once('error', error => { clearTimeout(timer); reject(error); });
      native.once('exit', () => { clearTimeout(timer); reject(new Error('Native host exited before replying.')); });
      native.stdout!.on('data', (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 4 || bytes.length < bytes.readUInt32LE(0) + 4) return;
        clearTimeout(timer); resolveReply(bytes.subarray(4, bytes.readUInt32LE(0) + 4).toString('utf8'));
      });
    });
    const hello = Buffer.from(JSON.stringify({ nativeControl: { type: 'CONNECT' } }));
    const header = Buffer.alloc(4); header.writeUInt32LE(hello.length);
    native.stdin!.write(Buffer.concat([header, hello]));
    const nativeOutput = await nativeReply;
    expect(JSON.parse(nativeOutput)).toMatchObject({ nativeControl: { type: 'READY' } });
    expect(nativeOutput).not.toContain(secret.toString('hex'));
    expect(nativeOutput).not.toContain(token);
    await stop(native);
    checks.push('installed native host authenticates without emitting machine secret or admin token');

    await expect.poll(async () => {
      const healthState = await (await fetch(new URL('/health', current.mcpUrl))).json() as {
        relayQuiescent: boolean; profileQuiescent: boolean; proxyQuiescent: boolean;
      };
      return healthState.relayQuiescent && healthState.profileQuiescent && healthState.proxyQuiescent;
    }, { timeout: 15_000 }).toBe(true);
    const transactionId = randomUUID();
    const fencedMcp = (runtime: Runtime) => {
      const body = '{}';
      return fetch(runtime.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json',
        'x-octopus-contract-version': MCP_CONTRACT_VERSION,
        'x-tabro-auth': sealCredential(secret, token, runtime.instanceRef, 'POST', '/mcp', Buffer.from(body)) }, body });
    };
    const post = (runtime: Runtime, action: string, id: string, authenticatedRequest = true) => {
      const path = `/maintenance/${action}`;
      const body = JSON.stringify({ transactionId: id, instanceRef: runtime.instanceRef });
      return fetch(new URL(path, runtime.mcpUrl), { method: 'POST', headers: { 'content-type': 'application/json',
        ...(authenticatedRequest ? { 'x-tabro-auth': sealCredential(secret, token, runtime.instanceRef, 'POST', path, Buffer.from(body)) } : {}) }, body });
    };
    expect((await post(current, 'enter', transactionId, false)).status).toBe(401);
    ownedTransaction = transactionId;
    expect((await post(current, 'enter', transactionId)).status).toBe(200);
    expect(existsSync(resolve(data, 'maintenance.json'))).toBe(true);
    expect((await fencedMcp(current)).status).toBe(503);
    await stop(restarted!);
    const fenced = launch();
    await expect.poll(() => readRuntime()?.processId, { timeout: 30_000 }).toBe(fenced.pid);
    const fencedRuntime = readRuntime()!;
    ownedInstances.set(fencedRuntime.processId, fencedRuntime.instanceRef);
    expect((await fencedMcp(fencedRuntime)).status).toBe(503);
    expect((await post(fencedRuntime, 'resume', randomUUID())).status).toBe(409);
    expect((await post(fencedRuntime, 'resume', transactionId)).status).toBe(200);
    ownedTransaction = undefined;
    expect(existsSync(resolve(data, 'maintenance.json'))).toBe(false);
    expect((await fetch(fencedRuntime.mcpUrl, { method: 'POST', headers: { 'x-octopus-contract-version': MCP_CONTRACT_VERSION } })).status).toBe(401);
    await stop(fenced);
    checks.push('maintenance fence survives a crash and only its transaction can resume admission');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    for (const child of children) await stop(child);
    const remaining = readRuntime();
    if (remaining && ownedInstances.get(remaining.processId) === remaining.instanceRef) rmSync(runtimePath, { force: true });
    const markerPath = resolve(data, 'maintenance.json');
    if (ownedTransaction && existsSync(markerPath) && !existsSync(resolve(data, 'maintenance-operation.json'))) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { transactionId?: string; instanceRef?: string };
      if (marker.transactionId === ownedTransaction && [...ownedInstances.values()].includes(marker.instanceRef ?? '')) rmSync(markerPath);
    }
    rmSync(otherRoot, { recursive: true, force: true });
    const evidence = resolve('artifacts/qualification');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(resolve(evidence, `${process.platform}-${process.arch}-device-broker.json`), JSON.stringify(report, null, 2));
  }
}, 120_000);
