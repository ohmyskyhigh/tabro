import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DemoAccount, DemoConfig, DemoEvent, DemoRole } from './types.js';
import { validateProbeRunId } from '../helpers/managed-chrome-probe-fixture.js';

const roles: DemoRole[] = ['Alice', 'Bob', 'Carol'];
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
export async function startDemoFixture(config: DemoConfig) {
  validateProbeRunId(config.runId);
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('INVALID_PORT');
  const durations = Object.freeze({ ...(config.durations ?? { Alice: 45_000, Bob: 90_000, Carol: 60_000 }) });
  if (Object.values(durations).some(value => !Number.isInteger(value) || value < 1 || value > 600_000)) throw new Error('INVALID_DURATION');
  const accounts = new Map<DemoRole, DemoAccount>(roles.map((role, i) => [role, { role, tasks: [
    { id: `${role.toLowerCase()}-later`, title: ['Review design notes','Review access requests','Review release checklist'][i]!, due: '2026-09-29', note: '', completed: false },
    { id: `${role.toLowerCase()}-first`, title: ['Send project update','Confirm test results','Prepare handoff notes'][i]!, due: '2026-09-27', note: '', completed: false },
    { id: `${role.toLowerCase()}-middle`, title: ['Update task labels','Check project links','Archive old notes'][i]!, due: '2026-09-28', note: '', completed: false }
  ], summary: { state: 'idle', requestedAt: null, completedAt: null, text: null } }]));
  const sessions = new Map<string, DemoRole>();
  const events: DemoEvent[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  mkdirSync(config.outputRoot, { recursive: true });
  const snapshot = () => ({ runId: config.runId, date: '2026-09-27', durations, accounts: [...accounts.values()], events });
  writeFileSync(resolve(config.outputRoot, 'initial.json'), JSON.stringify(snapshot(), null, 2), { flag: 'wx' });
  const save = () => writeFileSync(resolve(config.outputRoot, 'fixture-evidence.json'), JSON.stringify(snapshot(), null, 2));
  const event = (role: DemoRole, type: DemoEvent['type'], taskId?: string) => {
    events.push({ runId: config.runId, at: new Date().toISOString(), role, type, ...(taskId ? { taskId } : {}) }); save();
  };
  const accountFor = (request: IncomingMessage) => {
    const cookie = request.headers.cookie?.split('; ').find(value => value.startsWith('octopus_demo='))?.slice(13);
    const role = cookie ? sessions.get(cookie) : undefined;
    return role ? accounts.get(role)! : null;
  };
  const server = createServer(async (request, response) => {
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (!/^127\.0\.0\.1:\d+$/u.test(request.headers.host ?? '')) { json(403, { error: 'HOST_NOT_ALLOWED' }); return; }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && pathname === '/health') { json(200, { status: 'ok', runId: config.runId }); return; }
    if (request.method === 'GET' && pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" }); response.end(html); return;
    }
    const account = accountFor(request);
    if (request.method === 'GET' && pathname === '/api/state') { json(200, { runId: config.runId, date: '2026-09-27', account }); return; }
    if (request.method !== 'POST') { json(404, { error: 'NOT_FOUND' }); return; }
    const expectedOrigin = `http://${request.headers.host}`;
    if (request.headers.origin && request.headers.origin !== expectedOrigin) { json(403, { error: 'ORIGIN_NOT_ALLOWED' }); return; }
    if (!request.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'JSON_REQUIRED' }); return; }
    try {
      let body = '';
      for await (const chunk of request) { body += String(chunk); if (body.length > 4096) throw new Error('BODY_TOO_LARGE'); }
      const data = JSON.parse(body) as Record<string, unknown>;
      if (pathname === '/api/login') {
        if (account || !roles.includes(data.role as DemoRole)) { json(409, { error: 'ACCOUNT_ALREADY_SET_OR_INVALID' }); return; }
        const role = data.role as DemoRole;
        if ([...sessions.values()].includes(role)) { json(409, { error: 'ACCOUNT_ALREADY_CLAIMED' }); return; }
        const token = randomBytes(24).toString('hex'); sessions.set(token, role);
        response.setHeader('set-cookie', `octopus_demo=${token}; HttpOnly; SameSite=Strict; Max-Age=86400; Path=/`);
        event(role, 'login'); json(200, { role }); return;
      }
      if (!account) { json(401, { error: 'SIGN_IN_REQUIRED' }); return; }
      if (pathname === '/api/complete') {
        const task = account.tasks.find(t => t.id === data.taskId);
        if (!task || typeof data.note !== 'string' || !data.note.trim() || data.note.length > 200) { json(400, { error: 'INVALID_TASK_OR_NOTE' }); return; }
        if (task.completed) { json(409, { error: 'ALREADY_COMPLETED' }); return; }
        task.note = data.note.trim(); task.completed = true; event(account.role, 'complete', task.id); json(200, { task }); return;
      }
      if (pathname === '/api/summary') {
        if (account.summary.state === 'idle') {
          account.summary = { state: 'pending', requestedAt: new Date().toISOString(), completedAt: null, text: null };
          event(account.role, 'summary_started');
          const timer = setTimeout(() => {
            timers.delete(timer); account.summary.state = 'ready'; account.summary.completedAt = new Date().toISOString();
            account.summary.text = `${account.role}: ${account.tasks.filter(t => t.completed).map(t => `${t.title} — ${t.note}`).join('; ')}`;
            event(account.role, 'summary_finished');
          }, durations[account.role]); timers.add(timer);
        }
        json(200, { summary: account.summary }); return;
      }
      json(404, { error: 'NOT_FOUND' });
    } catch { json(400, { error: 'INVALID_REQUEST' }); }
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(config.port, '127.0.0.1', ok); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_NOT_LISTENING');
  save();
  return { url: `http://127.0.0.1:${address.port}/`, snapshot, async close() { for (const timer of timers) clearTimeout(timer); save(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); } };
}
