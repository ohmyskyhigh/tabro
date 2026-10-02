import { createRelayApplication } from './bootstrap.js';
import { loadConfig } from './config.js';
import { dirname, resolve } from 'node:path';
import { readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { publishBrokerRuntime, removeBrokerRuntime } from '../../../shared/protocol/src/runtime-discovery.js';

const config = loadConfig();
const lockFile = resolve(dirname(config.dbPath), 'broker.lock');
mkdirSync(dirname(lockFile), { recursive: true });
try {
  writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  const owner = Number(readFileSync(lockFile, 'utf8').trim());
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Invalid Broker lock; inspect it before starting.');
  let alive = true;
  try { process.kill(owner, 0); }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw failure; }
  if (alive) throw new Error('A Tabro Broker already owns this database. Reuse its runtime.json.');
  unlinkSync(lockFile);
  writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
}
const releaseLock = (): void => {
  try { if (readFileSync(lockFile, 'utf8').trim() === String(process.pid)) unlinkSync(lockFile); } catch { /* Not owned. */ }
};
process.once('exit', releaseLock);
const application = createRelayApplication(config);
const runtimeFiles = [...new Set([
  resolve(process.env.TABRO_RUNTIME_FILE ?? resolve(dirname(config.dbPath), 'runtime.json')),
  resolve(process.env.TABRO_NATIVE_RUNTIME_FILE ?? 'dist/native-host/relay-runtime.json')
])];

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  application.logger.info({ signal }, 'Stopping relay');
  try {
    await application.stop();
    for (const path of runtimeFiles) removeBrokerRuntime(path, application.instanceRef);
    releaseLock();
    process.exitCode = 0;
  } catch (error) {
    application.logger.error({ error }, 'Relay shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

try {
  await application.start();
  for (const path of runtimeFiles) publishBrokerRuntime(path, {
    schemaVersion: 1,
    instanceRef: application.instanceRef,
    processId: process.pid,
    startedAt: new Date().toISOString(),
    mcpUrl: `http://127.0.0.1:${application.mcpGateway.address().port}/mcp`,
    relayUrl: `ws://127.0.0.1:${application.extensionGateway.address().port}/relay`,
    databasePath: resolve(config.dbPath)
  });
} catch (error) {
  application.logger.fatal({ error }, 'Relay startup failed');
  try {
    await application.stop();
    for (const path of runtimeFiles) removeBrokerRuntime(path, application.instanceRef);
  } catch {
    // Ignore close errors after failed startup.
  }
  process.exitCode = 1;
}
