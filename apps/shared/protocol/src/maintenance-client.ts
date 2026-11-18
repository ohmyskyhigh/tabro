import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { readMachineSecret, sealCredential, verifyBrokerHealth } from './machine-auth.js';
import { readMachineRegistration, sameMachinePath } from './machine-registration.js';
import { readBrokerRuntime } from './runtime-discovery.js';

export async function maintenanceRequest(root: string, url: URL, action: 'enter' | 'resume' | 'stop', transactionId: string, instanceRef: string): Promise<void> {
  const registration = readMachineRegistration();
  if (!sameMachinePath(realpathSync(root), registration.installationRoot)) throw new Error('This installation does not own the machine registration.');
  const runtime = readBrokerRuntime(resolve(registration.dataRoot, 'runtime.json'));
  if (runtime.instanceRef !== instanceRef || runtime.mcpUrl !== url.href) throw new Error('The Broker instance changed during maintenance.');
  const secret = readMachineSecret(registration.dataRoot);
  await verifyBrokerHealth(url, instanceRef, secret);
  const path = `/maintenance/${action}`;
  const body = Buffer.from(JSON.stringify({ transactionId, instanceRef }));
  const token = readFileSync(resolve(registration.dataRoot, 'admin-token.txt'), 'utf8').trim();
  // Resume activates persisted Profiles and can perform bounded OS process inspection.
  // Allow that activation to complete; a lost response is still never retried.
  const timeoutMs = action === 'resume' ? 60_000 : 5_000;
  const result = await fetch(new URL(path, url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', 'x-tabro-auth': sealCredential(secret, token, instanceRef, 'POST', path, body) }, body });
  if (!result.ok) throw Object.assign(new Error(`Maintenance ${action} failed with status ${result.status}.`), { status: result.status });
}
