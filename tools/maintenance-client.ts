import { maintenanceRequest } from '../apps/shared/protocol/src/maintenance-client.js';

const [root, url, action, transactionId, instanceRef] = process.argv.slice(2);
if (!root || !url || (action !== 'enter' && action !== 'resume' && action !== 'stop') || !transactionId || !instanceRef) {
  throw new Error('Invalid maintenance request.');
}
try {
  await maintenanceRequest(root, new URL(url), action, transactionId, instanceRef);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = (error as Error & { status?: number }).status === 409 ? 3 : 1;
}
