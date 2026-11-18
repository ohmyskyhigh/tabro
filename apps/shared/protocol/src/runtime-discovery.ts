import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const loopbackUrl = (protocol: string, path: string) => z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === protocol && url.hostname === '127.0.0.1' && url.pathname === path
    && !url.username && !url.password && !url.search && !url.hash && Number(url.port) > 0;
});

export const BrokerRuntimeSchema = z.strictObject({
  schemaVersion: z.literal(2),
  authMode: z.literal('machine-v1'),
  instanceRef: z.string().uuid(),
  processId: z.number().int().positive(),
  startedAt: z.string().datetime(),
  mcpUrl: loopbackUrl('http:', '/mcp'),
  relayUrl: loopbackUrl('ws:', '/relay'),
  databasePath: z.string().min(1)
});
export type BrokerRuntime = z.infer<typeof BrokerRuntimeSchema>;

export function readBrokerRuntime(path: string): BrokerRuntime {
  const value = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown };
  if (value?.schemaVersion !== 2) throw new Error('Unsupported Broker discovery protocol. Update the Broker and all Tabro clients together.');
  const record = BrokerRuntimeSchema.parse(value);
  try { process.kill(record.processId, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') throw new Error('The discovered Tabro Broker is not running. Start the local Broker first.');
    throw new Error('The discovered Tabro Broker process could not be verified.', { cause: error });
  }
  return record;
}

export function publishBrokerRuntime(path: string, record: BrokerRuntime): void {
  BrokerRuntimeSchema.parse(record);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${record.instanceRef}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* Renamed or not created. */ }
  }
}

export function removeBrokerRuntime(path: string, instanceRef: string): void {
  try {
    const record = BrokerRuntimeSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    if (record.instanceRef === instanceRef) unlinkSync(path);
  } catch { /* A missing or replaced record is not owned by this process. */ }
}
