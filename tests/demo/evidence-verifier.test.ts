import { describe, expect, it } from 'vitest';
import { verifyDemoEvidence, type DemoEvidence } from './evidence-verifier.js';
import type { DemoRole } from './types.js';

// Synthetic records exercise the verifier; they are never a physical-browser report.
function evidence(): DemoEvidence {
  const e: DemoEvidence = { runId: 'unit-test', initial: { accounts: [] }, fixture: { runId: 'unit-test', accounts: [], events: [] }, assignments: [], traces: [], before: { profiles: [] }, after: { profiles: [] }, agentRecord: { actor: 'current-codex-conversation', delegatedAgents: 0, taskDecisionsFromAgent: true } };
  let sequence = 0;
  const time = (n: number) => new Date(1_000_000 + n * 1000).toISOString();
  const record = (tool: string, input: unknown, facts: unknown, n = 1) => {
    const id = String(++sequence);
    e.traces.push({ version: 1, runId: e.runId, session: 'runtime', kind: 'call', tool, callId: id, input },
      { version: 1, runId: e.runId, session: 'runtime', kind: 'result', tool, callId: id, result: { caller: { session_ref: 'session' }, facts } });
    return { request_ref: id, state: 'succeeded', request: { tool }, submitted_at: time(n), finished_at: time(n + 1), result: { facts } };
  };
  const ticket = (tool: string, facts: unknown, n = 1, input: unknown = {}) => {
    const t = record(tool, input, facts, n);
    const last = e.traces.at(-1)!;
    last.result = { caller: { session_ref: 'session' }, facts: { ticket: t } };
    return t;
  };
  const page = (role: string, workspace: string, tab: string, n: number) => ticket('send_cdp_command', { command: { workspace_ref: workspace, target: { tab_ref: tab }, result: { result: { value: `Signed in as ${role}; Reviewed by ${role}; Summary ready; localStorage=${role}` } } } }, n, { workspace_ref: workspace, target: { tab_ref: tab } });
  const allocation = (role: string, workspace: string, tab: string) => ({ endpoint_nickname: role, workspace: { workspace_ref: workspace, owner_session_ref: 'session' }, tabs: [{ tab_ref: tab }] });
  const roles: DemoRole[] = ['Alice', 'Bob', 'Carol'];
  for (const role of roles) {
    const initial = { role, tasks: [{ id: 'first', title: 'First', due: '2026-09-27', completed: false, note: '' }, { id: 'later', title: 'Later', due: '2026-09-28', completed: false, note: '' }], summary: { state: 'idle' as const, requestedAt: null, completedAt: null, text: null } };
    e.initial.accounts.push(initial);
    const after = structuredClone(initial); after.tasks[0]!.completed = true; after.tasks[0]!.note = `Reviewed by ${role}`;
    e.fixture.accounts.push({ ...after, summary: { ...after.summary, state: 'ready' } });
    e.fixture.events.push({ runId: e.runId, role, type: 'login', at: time(1) }, { runId: e.runId, role, type: 'summary_started', at: time(10) }, { runId: e.runId, role, type: 'summary_finished', at: time(role === 'Bob' ? 30 : 20) });
    ticket('create_browser_profile', { profile: { profile_ref: role, endpoint_nickname: role, ready: true } });
    e.assignments.push({ role, profile_ref: role, workspace_ref: role, tab_ref: role, owner_session_ref: 'session' });
    e.before.profiles.push({ profile_ref: role, endpoint_nickname: role, identity_hash: role, instance_ref: role, generation: 1, pid: roles.indexOf(role) + 1, process_verified: true, authenticated: true });
    page(role, role, role, 32);
  }
  ticket('request_browser_workspace', { resolved: roles.map(role => allocation(role, role, role)) });
  e.after.profiles = structuredClone(e.before.profiles);
  Object.assign(e.after.profiles[1]!, { instance_ref: 'Bob2', generation: 2 });
  ticket('stop_browser_profile', { profile: { profile_ref: 'Bob' } }, 40);
  record('list_browser_profiles', {}, { profiles: roles.map(role => ({ profile_ref: role, browser_state: role === 'Bob' ? 'stopped' : 'running' })) });
  for (let i = 0; i < 2; i++) ticket('open_browser_profile', { profile: { profile_ref: 'Bob', instance_ref: 'Bob2' } }, 42 + i * 2);
  e.assignments.push({ role: 'Bob', profile_ref: 'Bob', workspace_ref: 'Bob2', tab_ref: 'Bob2', owner_session_ref: 'session' });
  ticket('request_browser_workspace', { resolved: [allocation('Bob', 'Bob2', 'Bob2')] }); page('Bob', 'Bob2', 'Bob2', 50);
  record('list_browser_profiles', {}, { profiles: roles.map(role => ({ profile_ref: role, browser_state: 'stopped' })) });
  const admitted = e.traces.find(t => t.kind === 'result')!;
  (admitted.result as Record<string, unknown>).disposition = 'accepted';
  return e;
}
describe('Demo evidence validation', () => {
  it('accepts a complete internally consistent synthetic record', () => { expect(verifyDemoEvidence(evidence()).status).toBe('passed'); });
  const mutations: Array<[string, (e: DemoEvidence) => void]> = [
    ['missing trace result', e => { e.traces.pop(); }],
    ['accepted without terminal success', e => { const first = e.traces.find(t => t.kind === 'result')!; ((first.result as {facts:{ticket:{state:string}}}).facts.ticket).state = 'running'; }],
    ['mixed sessions', e => { e.traces[0]!.session = 'other'; }],
    ['duplicate identity', e => { e.before.profiles[1]!.identity_hash = 'Alice'; }],
    ['unverified process', e => { e.before.profiles[1]!.process_verified = false; }],
    ['wrong note', e => { e.fixture.accounts[0]!.tasks[0]!.note = 'wrong'; }],
    ['unrelated task changed', e => { e.fixture.accounts[0]!.tasks[1]!.note = 'changed'; }],
    ['serial summary', e => { e.fixture.events.find(v => v.role === 'Bob' && v.type === 'summary_started')!.at = '2100-01-01T00:00:00Z'; }],
    ['routing mismatch', e => { e.assignments[0]!.tab_ref = 'Bob'; }],
    ['new identity after reopen', e => { e.after.profiles[1]!.identity_hash = 'new'; }],
    ['missing actor record', e => { e.agentRecord = null; }],
    ['foreign run', e => { e.fixture.runId = 'other'; }],
    ['no browser readback', e => { e.traces = e.traces.filter(t => t.tool !== 'send_cdp_command'); }]
  ];
  it.each(mutations)('rejects %s', (_name, mutate) => { const e = evidence(); mutate(e); expect(verifyDemoEvidence(e).status).toBe('failed'); });
});
