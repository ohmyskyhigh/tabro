import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { SqliteRelayStore } from '../apps/broker/src/storage/index.js';
import { ProxyCredentialStore } from '../apps/broker/src/proxy/proxy-credential-store.js';
import { readMachineRegistration } from '../apps/shared/protocol/src/machine-registration.js';

// Input is JSON on stdin: {username,password}. Never put credentials in arguments.
// --db must identify the registered Broker database; --principal optionally selects an existing principal.
const args = process.argv.slice(2);
const option = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
let store: SqliteRelayStore | undefined;
let transaction: string | undefined;
try {
  const registration = readMachineRegistration();
  const lock = resolve(registration.installationRoot, 'installation.transaction');
  mkdirSync(lock, { mode: 0o700 });
  transaction = lock;
  if (existsSync(resolve(registration.dataRoot, 'maintenance-operation.json')) || existsSync(resolve(registration.dataRoot, 'maintenance.json'))) throw new Error('Maintenance must finish before provisioning credentials.');
  const db = resolve(registration.dataRoot, 'relay.sqlite');
  for (const requested of [option('--db'), process.env.RELAY_DB_PATH]) {
    if (requested && resolve(requested) !== db) throw new Error('Credential database conflicts with the machine registration.');
  }
  let input = '';
  for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 16384) throw new Error('Input too large'); }
  const secret = JSON.parse(input) as { username: string; password: string };
  store = new SqliteRelayStore(db);
  const principal = option('--principal') ?? store.authenticateAgent(readFileSync(resolve(dirname(db), 'admin-token.txt'), 'utf8').trim())?.principalId;
  if (!principal || !store.getAgentById(principal)) throw new Error('Unknown principal');
  const vault = new ProxyCredentialStore(resolve(dirname(db), 'proxy-credentials'));
  const credentialRef = await vault.provision(secret, principal);
  process.stdout.write(`${JSON.stringify({ credential_ref: credentialRef })}\n`);
} catch {
  process.stderr.write('Credential provisioning failed. Check stdin JSON, database, principal and OS credential vault access.\n'); process.exitCode = 1;
} finally {
  store?.close();
  if (transaction) {
    try { rmdirSync(transaction); } catch { /* Another transaction owns it, or recovery is required. */ }
  }
}
