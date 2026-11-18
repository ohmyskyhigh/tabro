import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { createRelayApplication } from './bootstrap.js';
import { loadConfig } from './config.js';
import { readMachineSecret } from '../../../shared/protocol/src/machine-auth.js';
import { machineNative, readMachineRegistration, sameMachinePath } from '../../../shared/protocol/src/machine-registration.js';
import { publishBrokerRuntime, removeBrokerRuntime } from '../../../shared/protocol/src/runtime-discovery.js';

if (!isMainThread) throw new Error('The Tabro Broker must run on the Node main thread.');
const registration = readMachineRegistration();
machineNative().acquire();
const lockedRegistration = readMachineRegistration();
if (JSON.stringify(registration) !== JSON.stringify(lockedRegistration)) throw new Error('Machine registration changed while acquiring the Broker lock.');
const entry = realpathSync(import.meta.filename);
const stateFile = resolve(registration.installationRoot, 'installation.json');
const allowedEntries: string[] = [];
if (existsSync(stateFile)) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { schemaVersion?: unknown; runtimeDirectory?: unknown };
  if (state.schemaVersion !== 1 || typeof state.runtimeDirectory !== 'string') throw new Error('Invalid installation selection.');
  const runtimeDirectory = state.runtimeDirectory.replaceAll('\\', '/');
  if (!/^releases\/\d+\.\d+\.\d+-[a-f0-9]{12}$/u.test(runtimeDirectory)) throw new Error('Invalid installation selection.');
  allowedEntries.push(resolve(registration.installationRoot, runtimeDirectory, 'broker/main.js'));
} else {
  allowedEntries.push(resolve(registration.installationRoot, 'apps/broker/src/runtime/main.ts'),
    resolve(registration.installationRoot, 'dist/broker/src/runtime/main.js'));
}
if (!allowedEntries.some(path => existsSync(path) && sameMachinePath(realpathSync(path), entry))) throw new Error('This Broker is not the selected machine installation.');
const dbPath = resolve(registration.dataRoot, 'relay.sqlite');
const runtimeFile = resolve(registration.dataRoot, 'runtime.json');
if ((process.env.RELAY_DB_PATH && !sameMachinePath(resolve(process.env.RELAY_DB_PATH), dbPath)) ||
    (process.env.TABRO_RUNTIME_FILE && !sameMachinePath(resolve(process.env.TABRO_RUNTIME_FILE), runtimeFile)) ||
    (process.env.TABRO_NATIVE_RUNTIME_FILE && !sameMachinePath(resolve(process.env.TABRO_NATIVE_RUNTIME_FILE), runtimeFile))) {
  throw new Error('Broker paths do not match the machine registration.');
}
if (process.env.RELAY_HOST && process.env.RELAY_HOST !== '127.0.0.1') throw new Error('The machine Broker must listen on 127.0.0.1.');
const profileConfig = resolve(registration.dataRoot, 'managed-profiles.json');
const rulesFile = resolve(registration.dataRoot, 'browser-rules.json');
if ((process.env.RELAY_PROFILES_CONFIG && !sameMachinePath(resolve(process.env.RELAY_PROFILES_CONFIG), profileConfig)) ||
    (process.env.TABRO_BROWSER_RULES_PATH && !sameMachinePath(resolve(process.env.TABRO_BROWSER_RULES_PATH), rulesFile))) {
  throw new Error('Broker configuration paths do not match the machine registration.');
}
const directory = lstatSync(registration.dataRoot);
machineNative().verifyPrivate(registration.dataRoot);
if (!directory.isDirectory() || (process.platform !== 'win32' && (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0))) {
  throw new Error('The designated data directory is not private to the installation owner.');
}
const secretPath = resolve(registration.dataRoot, 'native-secret');
if (!existsSync(secretPath)) writeFileSync(secretPath, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
const secret = readMachineSecret(registration.dataRoot);
const tokenPath = resolve(registration.dataRoot, 'admin-token.txt');
const verifyToken = (): void => {
  machineNative().verifyPrivate(tokenPath);
  const file = lstatSync(tokenPath);
  if (!file.isFile() || file.nlink !== 1 || file.size > 4096 ||
      (process.platform !== 'win32' && (file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0))) {
    throw new Error('The installation token file is not private.');
  }
};
if (existsSync(tokenPath)) verifyToken();
const config = { ...loadConfig({ ...process.env, RELAY_DB_PATH: dbPath, RELAY_ADMIN_TOKEN: undefined,
  RELAY_PROFILES_CONFIG: existsSync(profileConfig) ? profileConfig : undefined, TABRO_BROWSER_RULES_PATH: rulesFile }),
  machineSecret: secret, maintenancePath: resolve(registration.dataRoot, 'maintenance.json') };
verifyToken();
const application = createRelayApplication(config);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  application.logger.info({ signal }, 'Stopping relay');
  try {
    await application.stop();
    removeBrokerRuntime(runtimeFile, application.instanceRef);
    process.exitCode = 0;
  } catch (error) {
    application.logger.error({ error }, 'Relay shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
application.mcpGateway.setMaintenanceStopHandler(() => void stop('maintenance'));

try {
  await application.start();
  publishBrokerRuntime(runtimeFile, {
    schemaVersion: 2,
    authMode: 'machine-v1',
    instanceRef: application.instanceRef,
    processId: process.pid,
    startedAt: new Date().toISOString(),
    mcpUrl: `http://127.0.0.1:${application.mcpGateway.address().port}/mcp`,
    relayUrl: `ws://127.0.0.1:${application.extensionGateway.address().port}/relay`,
    databasePath: dbPath
  });
} catch (error) {
  application.logger.fatal({ error }, 'Relay startup failed');
  try {
    await application.stop();
    removeBrokerRuntime(runtimeFile, application.instanceRef);
  } catch { /* Ignore close errors after failed startup. */ }
  process.exitCode = 1;
}
