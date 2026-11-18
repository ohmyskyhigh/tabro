import { resolve } from 'node:path';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { SqliteRelayStore } from '../apps/broker/src/storage/index.js';
import { readMachineRegistration } from '../apps/shared/protocol/src/machine-registration.js';

interface PairingArguments {
  nickname: string;
  expiresMinutes: number;
  databasePath: string;
}

const readValue = (arguments_: string[], name: string): string | undefined => {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
};

function parseArguments(arguments_: string[]): PairingArguments {
  const nickname = readValue(arguments_, '--nickname')?.trim();
  if (!nickname || nickname.length > 64) {
    throw new Error('Relay-v1 migration only. Usage: pnpm pair:legacy --nickname <profile-name> [--expires-minutes 10] [--db <relay.sqlite>]');
  }
  const expiresMinutes = Number(readValue(arguments_, '--expires-minutes') ?? '10');
  if (!Number.isInteger(expiresMinutes) || expiresMinutes < 1 || expiresMinutes > 1_440) {
    throw new Error('--expires-minutes must be an integer between 1 and 1440.');
  }
  const registration = readMachineRegistration();
  const databasePath = resolve(registration.dataRoot, 'relay.sqlite');
  for (const requested of [readValue(arguments_, '--db'), process.env.RELAY_DB_PATH]) {
    if (requested && resolve(requested) !== databasePath) throw new Error('Database path conflicts with the machine registration.');
  }
  return { nickname, expiresMinutes, databasePath };
}

const arguments_ = parseArguments(process.argv.slice(2));
const registration = readMachineRegistration();
const transaction = resolve(registration.installationRoot, 'installation.transaction');
mkdirSync(transaction, { mode: 0o700 });
let store: SqliteRelayStore | undefined;
try {
  if (existsSync(resolve(registration.dataRoot, 'maintenance-operation.json')) || existsSync(resolve(registration.dataRoot, 'maintenance.json'))) throw new Error('Maintenance must finish before creating a pairing code.');
  store = new SqliteRelayStore(arguments_.databasePath);
  const expiresAt = new Date(Date.now() + arguments_.expiresMinutes * 60_000).toISOString();
  const pairingCode = store.createPairingCode(arguments_.nickname, expiresAt);
  store.audit('target.pairing_code_created', {
    targetAlias: arguments_.nickname,
    expiresAt,
    source: 'local_cli'
  });
  process.stdout.write(`${JSON.stringify({
    endpoint_nickname: arguments_.nickname,
    pairing_code: pairingCode,
    expires_at: expiresAt,
    database_path: arguments_.databasePath
  }, null, 2)}\n`);
} finally {
  store?.close();
  rmdirSync(transaction);
}
