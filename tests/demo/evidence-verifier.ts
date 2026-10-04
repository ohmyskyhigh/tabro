import type { DemoAccount, DemoEvent } from './types.js';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export interface DemoEvidence {
  runId: string;
  initial: { accounts: DemoAccount[] };
  fixture: { runId: string; accounts: DemoAccount[]; events: DemoEvent[] };
  assignments: Array<{ role: string; profile_ref: string; workspace_ref: string; tab_ref: string; owner_session_ref: string }>;
  traces: ObjectValue[];
  before: { profiles: ObjectValue[] };
  after: { profiles: ObjectValue[] };
  agentRecord: { actor: string; delegatedAgents: number; taskDecisionsFromAgent: boolean } | null;
}
export interface EvidenceCheck { name: string; status: 'passed' | 'failed' | 'unverified'; detail: string }

export function verifyDemoEvidence(e: DemoEvidence): { status: 'passed' | 'failed'; checks: EvidenceCheck[] } {
  const checks: EvidenceCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, status: ok ? 'passed' : 'failed', detail });
  const calls = e.traces.filter(t => t.kind === 'call'); const results = e.traces.filter(t => t.kind === 'result');
  const sessions = new Set(e.traces.map(t => t.session));
  const callerSessions = new Set(results.map(t => object(object(t.result).caller).session_ref).filter(Boolean));
  check('trace-completeness', calls.length > 0 && calls.length === results.length && new Set(calls.map(t => t.callId)).size === calls.length
    && calls.every(call => results.filter(result => result.callId === call.callId && result.tool === call.tool).length === 1)
    && e.traces.every(t => t.version === 1 && t.runId === e.runId), 'Each recorded invocation has exactly one corresponding raw result in this run.');
  check('single-recorded-session', sessions.size === 1 && callerSessions.size === 1, 'All recorded MCP calls use one runtime session and one Broker caller session.');
  checks.push({ name: 'agent-execution-record', status: e.agentRecord?.actor === 'current-codex-conversation' && e.agentRecord.delegatedAgents === 0 && e.agentRecord.taskDecisionsFromAgent ? 'passed' : 'unverified',
    detail: 'Agent execution is attested by this conversation record; MCP logs alone cannot prove the absence of unrecorded actors.' });
  const tickets = results.map(t => object(object(object(t.result).facts).ticket)).filter(t => typeof t.request_ref === 'string');
  const succeeded = tickets.filter(t => t.state === 'succeeded').sort((a, b) => Date.parse(String(a.submitted_at)) - Date.parse(String(b.submitted_at)));
  const successfulTool = (tool: string) => succeeded.filter(t => object(t.request).tool === tool);
  const accepted = results.filter(t => object(t.result).disposition === 'accepted').map(t => object(object(object(t.result).facts).ticket).request_ref);
  check('all-admitted-requests-completed', accepted.length > 0 && accepted.every(ref => succeeded.some(t => t.request_ref === ref)), 'Every admitted operation has an observed successful terminal ticket.');
  const create = successfulTool('create_browser_profile').map(t => object(object(object(t.result).facts).profile));
  const uniqueCreates = new Map(create.map(p => [p.profile_ref, p]));
  const allocations = successfulTool('request_browser_workspace').flatMap(t => list(object(object(t.result).facts).resolved).map(object));
  check('three-mcp-created-profiles', uniqueCreates.size === 3 && [...uniqueCreates.values()].every(p => p.ready === true && typeof p.endpoint_nickname === 'string')
    && new Set([...uniqueCreates.values()].map(p => p.endpoint_nickname)).size === 3, 'Three distinct Profile creations reached ready through real MCP tickets.');
  check('three-verified-processes', e.before.profiles.length === 3 && e.before.profiles.every(p => uniqueCreates.has(p.profile_ref) && p.process_verified === true && p.authenticated === true)
    && new Set(e.before.profiles.map(p => p.pid)).size === 3 && new Set(e.before.profiles.map(p => p.identity_hash)).size === 3,
    'The runtime snapshot independently matches three live Chrome processes and three extension identities.');
  check('workspace-routing', new Set(e.assignments.map(a => a.profile_ref)).size === 3 && new Set(e.assignments.map(a => a.owner_session_ref)).size === 1
    && e.assignments.every(a => uniqueCreates.has(a.profile_ref) && allocations.some(r => r.endpoint_nickname === uniqueCreates.get(a.profile_ref)?.endpoint_nickname
      && object(r.workspace).workspace_ref === a.workspace_ref && object(r.workspace).owner_session_ref === a.owner_session_ref
      && list(r.tabs).some(tab => object(tab).tab_ref === a.tab_ref))) && calls.filter(c => c.tool === 'send_cdp_command').every(c => {
      const args = object(c.input); return e.assignments.some(a => a.workspace_ref === args.workspace_ref && a.tab_ref === object(args.target).tab_ref);
    }), 'Every recorded page command targets an assigned workspace/tab pair.');
  for (const role of ['Alice','Bob','Carol']) {
    const before = e.initial.accounts.find(a => a.role === role); const after = e.fixture.accounts.find(a => a.role === role);
    const earliest = before?.tasks.filter(t => !t.completed).sort((a,b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id))[0];
    const completed = after?.tasks.filter(t => t.completed) ?? [];
    check(`${role}-task`, !!earliest && completed.length === 1 && completed[0]?.id === earliest.id && completed[0].note === `Reviewed by ${role}`
      && after?.tasks.filter(t => t.id !== earliest.id).every(t => JSON.stringify(t) === JSON.stringify(before?.tasks.find(b => b.id === t.id))) === true,
      'Only the independently computed earliest task changed, with the required note.');
    const roleEvents = e.fixture.events.filter(event => event.role === role);
    check(`${role}-summary`, after?.summary.state === 'ready' && roleEvents.filter(event => event.type === 'login').length === 1
      && roleEvents.filter(event => event.type === 'summary_started').length === 1 && roleEvents.filter(event => event.type === 'summary_finished').length === 1,
      'Exactly one login and one completed summary are present.');
    const texts = successfulTool('send_cdp_command').filter(t => {
      const cmd = object(object(object(t.result).facts).command);
      return e.assignments.some(a => a.role === role && a.workspace_ref === cmd.workspace_ref && a.tab_ref === object(cmd.target).tab_ref);
    }).map(t => object(object(object(object(object(t.result).facts).command).result).result).value);
    check(`${role}-page-readback`, texts.some(text => typeof text === 'string' && text.includes(`Signed in as ${role}`) && text.includes(`Reviewed by ${role}`) && text.includes('Summary ready')),
      'A real browser readback confirmed account, note and completed summary.');
  }
  const starts = e.fixture.events.filter(v => v.type === 'summary_started').map(v => Date.parse(v.at));
  const ends = e.fixture.events.filter(v => v.type === 'summary_finished').map(v => Date.parse(v.at));
  const bobEnd = e.fixture.events.find(v => v.role === 'Bob' && v.type === 'summary_finished');
  check('overlapping-summary-work', starts.length === 3 && ends.length === 3 && Math.max(...starts) < Math.min(...ends)
    && !!bobEnd && e.fixture.events.filter(v => v.role !== 'Bob' && v.type === 'summary_finished').every(v => Date.parse(v.at) < Date.parse(bobEnd.at)),
    'All summary intervals overlap and both Alice and Carol finish before Bob.');
  const bobProfileRef = e.assignments.find(a => a.role === 'Bob')?.profile_ref;
  const bobBefore = e.before.profiles.find(p => p.profile_ref === bobProfileRef); const bobAfter = e.after.profiles.find(p => p.profile_ref === bobProfileRef);
  check('bob-reopen-identity', !!bobBefore && !!bobAfter && bobBefore.profile_ref === bobAfter.profile_ref && bobBefore.identity_hash === bobAfter.identity_hash
    && bobBefore.instance_ref !== bobAfter.instance_ref && Number(bobAfter.generation) === Number(bobBefore.generation) + 1 && bobAfter.process_verified === true,
    'Bob reopened the same persistent Profile with a new verified process generation and the same key.');
  const stopped = successfulTool('stop_browser_profile').find(t => object(object(object(t.result).facts).profile).profile_ref === bobBefore?.profile_ref);
  const opened = successfulTool('open_browser_profile').find(t => object(object(object(t.result).facts).profile).profile_ref === bobBefore?.profile_ref);
  check('bob-stop-open-tickets', !!stopped && !!opened && Date.parse(String(opened.submitted_at)) >= Date.parse(String(stopped.finished_at)), 'Bob stop and reopen completed in order.');
  const lists = results.filter(r => r.tool === 'list_browser_profiles').map(r => list(object(object(r.result).facts).profiles));
  check('closed-profile-discovery', lists.some(profiles => profiles.some(p => object(p).profile_ref === bobBefore?.profile_ref && object(p).browser_state === 'stopped')), 'Bob remained in the persistent list while closed.');
  check('mixed-profile-discovery', lists.some(profiles => profiles.length === 3 && profiles.every(p => object(p).browser_state === (object(p).profile_ref === bobBefore?.profile_ref ? 'stopped' : 'running'))), 'A list observed Bob closed while Alice and Carol remained running.');
  const bobOpens = successfulTool('open_browser_profile').map(t => object(object(object(t.result).facts).profile)).filter(p => p.profile_ref === bobBefore?.profile_ref);
  check('repeated-open-reuses-instance', bobOpens.length >= 2 && bobOpens.every(p => p.instance_ref === bobAfter?.instance_ref), 'Repeated open reused the authenticated Bob instance.');
  check('final-profiles-retained', lists.some(profiles => profiles.length === 3 && profiles.every(p => uniqueCreates.has(object(p).profile_ref) && object(p).browser_state === 'stopped')), 'All three managed browsers were stopped and their Profiles remained discoverable.');
  const reopenedRead = successfulTool('send_cdp_command').find(t => {
    if (!opened || Date.parse(String(t.submitted_at)) < Date.parse(String(opened.finished_at))) return false;
    const value = object(object(object(object(object(t.result).facts).command).result).result).value;
    return typeof value === 'string' && value.includes('Signed in as Bob') && value.includes('Reviewed by Bob') && value.includes('Summary ready') && value.includes('localStorage=Bob');
  });
  check('bob-restored-browser-state', !!reopenedRead, 'Post-reopen page readback confirms persistent login, localStorage, completed task, note and summary.');
  check('run-isolation', e.fixture.runId === e.runId && e.fixture.events.every(v => v.runId === e.runId), 'All fixture records belong to this run.');
  return { status: checks.every(c => c.status === 'passed') ? 'passed' : 'failed', checks };
}
