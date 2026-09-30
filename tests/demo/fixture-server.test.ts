import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDemoFixture } from './fixture-server.js';

let fixture: Awaited<ReturnType<typeof startDemoFixture>> | undefined;
let root: string | undefined;
afterEach(async () => {
  await fixture?.close(); fixture = undefined;
  if (root) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('octopus-fixture-')) throw new Error('Invalid cleanup path');
    rmSync(root, { recursive: true, force: true }); root = undefined;
  }
});
async function setup() {
  root = mkdtempSync(join(tmpdir(), 'octopus-fixture-'));
  fixture = await startDemoFixture({ runId: 'unit-demo', port: 0, outputRoot: root, durations: { Alice: 10, Bob: 30, Carol: 20 } });
  return fixture;
}
const post = (url: string, path: string, body: unknown, cookie = '') => fetch(new URL(path, url), {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body)
});
describe('same-origin isolated task fixture', () => {
  it('isolates accounts through persistent cookies and rejects cross-account writes', async () => {
    const app = await setup();
    expect((await post(app.url, '/api/complete', { taskId: 'alice-first', note: 'test' })).status).toBe(401);
    const alice = await post(app.url, '/api/login', { role: 'Alice' });
    const cookie = alice.headers.get('set-cookie')!.split(';')[0]!;
    expect(alice.headers.get('set-cookie')).toContain('Max-Age=86400');
    expect((await post(app.url, '/api/login', { role: 'Alice' })).status).toBe(409);
    expect((await post(app.url, '/api/login', { role: 'Bob' }, cookie)).status).toBe(409);
    expect((await post(app.url, '/api/complete', { taskId: 'bob-first', note: 'test' }, cookie)).status).toBe(400);
    expect((await post(app.url, '/api/complete', { taskId: 'alice-first', note: 'Reviewed by Alice' }, cookie)).status).toBe(200);
    expect((await post(app.url, '/api/complete', { taskId: 'alice-first', note: 'rewrite' }, cookie)).status).toBe(409);
    const state = await (await fetch(new URL('/api/state', app.url), { headers: { cookie } })).json() as { account: { role: string; tasks: Array<{note:string}> } };
    expect(state.account.role).toBe('Alice'); expect(state.account.tasks[1]?.note).toBe('Reviewed by Alice');
    expect(app.snapshot().accounts.find(a => a.role === 'Bob')?.tasks.every(t => !t.completed)).toBe(true);
  });
  it('deduplicates summary requests and records their actual start and completion', async () => {
    const app = await setup();
    const login = await post(app.url, '/api/login', { role: 'Bob' }); const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    await post(app.url, '/api/summary', {}, cookie); await post(app.url, '/api/summary', {}, cookie);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 80));
    expect(app.snapshot().events.filter(e => e.type === 'summary_started')).toHaveLength(1);
    expect(app.snapshot().events.filter(e => e.type === 'summary_finished')).toHaveLength(1);
  });
  it('refuses occupied ports and invalid run IDs without changing the running fixture', async () => {
    const app = await setup();
    await expect(startDemoFixture({ runId: '../escape', port: 0, outputRoot: root! })).rejects.toThrow();
    await expect(startDemoFixture({ runId: 'another-run', port: Number(new URL(app.url).port), outputRoot: join(root!, 'other') })).rejects.toThrow();
    expect((await fetch(new URL('/health', app.url))).status).toBe(200);
  });
});
