import { appendFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DemoTraceConfig { root: string; runId: string }
export function createDemoTrace(config: DemoTraceConfig | undefined, session: string, secret: string) {
  if (!config) return null;
  if (!isAbsolute(config.root) || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(config.runId)) throw new Error('Invalid Demo trace configuration.');
  mkdirSync(config.root, { recursive: true });
  const path = resolve(config.root, `trace-${process.pid}-${randomUUID()}.jsonl`);
  appendFileSync(path, '', { encoding: 'utf8', mode: 0o600 });
  return (entry: Record<string, unknown>): void => {
    const line = JSON.stringify({ version: 1, runId: config.runId, session, at: new Date().toISOString(), ...entry }, (key, value: unknown) =>
      /^(authorization|bearerToken|token|secret|privateKeyJwk|cookie|set-cookie|cookies)$/iu.test(key) ? '[redacted]' : value);
    const redacted = secret ? line.replaceAll(secret, '[redacted]') : line;
    appendFileSync(path, `${redacted}\n`, { encoding: 'utf8', mode: 0o600 });
  };
}
