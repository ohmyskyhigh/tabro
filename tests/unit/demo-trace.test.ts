import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDemoTrace } from '../../apps/mcp-stdio-adapter/src/demo-trace.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (!root.startsWith(resolve(tmpdir()) + sep) || !root.includes('octopus-trace-')) throw new Error('Invalid cleanup');
  rmSync(root, { recursive: true, force: true });
} });
function directory() { const root = mkdtempSync(join(tmpdir(), 'octopus-trace-')); roots.push(root); return root; }
it('redacts nested authentication, cookies and embedded bearer text without mutating results', () => {
  const root = directory(); const trace = createDemoTrace({ root, runId: 'trace-test' }, 'session', 'actual-bearer')!;
  const response = { cookie: 'session=private', nested: { secret: 'grant', privateKeyJwk: { d: 'private' }, authorization: 'private', cookies: ['private'] }, text: 'actual-bearer', safe: 42 };
  trace({ kind: 'result', result: response });
  const raw = readFileSync(join(root, readdirSync(root)[0]!), 'utf8');
  expect(raw).not.toContain(':"private"'); expect(raw).not.toContain('session=private'); expect(raw).not.toContain('actual-bearer'); expect(raw).not.toContain('grant');
  expect(JSON.parse(raw)).toMatchObject({ version: 1, runId: 'trace-test', session: 'session', result: { safe: 42, text: '[redacted]' } });
  expect(response.cookie).toBe('session=private');
});
it('uses separate append files for concurrent adapters and rejects an unwritable path before calls', () => {
  const root = directory();
  const first = createDemoTrace({ root, runId: 'trace-test' }, 'session', '')!;
  const second = createDemoTrace({ root, runId: 'trace-test' }, 'session', '')!;
  first({ kind: 'call', callId: 'a' }); second({ kind: 'call', callId: 'b' }); first({ kind: 'result', callId: 'a' });
  expect(readdirSync(root)).toHaveLength(2);
  const file = join(root, 'not-a-directory'); writeFileSync(file, 'x');
  expect(() => createDemoTrace({ root: file, runId: 'trace-test' }, 'session', '')).toThrow();
  expect(createDemoTrace(undefined, 'session', '')).toBeNull();
  expect(() => createDemoTrace({ root: '../relative', runId: 'bad' }, 'session', '')).toThrow();
});
