import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyDemoEvidence, type DemoEvidence } from '../tests/demo/evidence-verifier.js';
import { validateProbeRunId } from '../tests/helpers/managed-chrome-probe-fixture.js';
const runId = process.argv.find(a => a.startsWith('--run-id='))?.slice(9) ?? ''; validateProbeRunId(runId);
const root = resolve('artifacts/real-world', runId, 'single-agent-demo');
const hashes: Record<string,string> = {};
function read<T>(name: string): T {
  const raw = readFileSync(resolve(root, name),'utf8'); hashes[name] = createHash('sha256').update(raw).digest('hex'); return JSON.parse(raw) as T;
}
try {
  const traces = readdirSync(resolve(root,'trace')).filter(name => name.endsWith('.jsonl')).flatMap(name => {
    const raw = readFileSync(resolve(root,'trace',name),'utf8'); hashes[`trace/${name}`] = createHash('sha256').update(raw).digest('hex');
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string,unknown>);
  });
  const evidence: DemoEvidence = { runId, initial: read('initial.json'), fixture: read('fixture-evidence.json'),
    assignments: [...read<DemoEvidence['assignments']>('assignments.json'), ...(existsSync(resolve(root,'assignments-after-reopen.json')) ? read<DemoEvidence['assignments']>('assignments-after-reopen.json') : [])],
    traces, before: read('runtime-before.json'), after: read('runtime-after.json'), agentRecord: existsSync(resolve(root,'agent-run.json')) ? read('agent-run.json') : null };
  const report = { runId, verifiedAt: new Date().toISOString(), ...verifyDemoEvidence(evidence), sourceHashes: hashes };
  writeFileSync(resolve(root,'verification.json'), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
  if (report.status !== 'passed') process.exitCode = 1;
} catch (error) {
  const report = { runId, status: 'failed', error: error instanceof Error ? error.message : String(error) };
  writeFileSync(resolve(root,'verification.json'), JSON.stringify(report,null,2)); console.error(JSON.stringify(report)); process.exitCode = 1;
}
