import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteRelayStore } from '../apps/broker/src/storage/index.js';
import { chromeProcesses, matchesInstance } from '../apps/broker/src/profiles/chrome-launcher.js';
import { validateProbeRunId } from '../tests/helpers/managed-chrome-probe-fixture.js';
const runId = process.argv[2] ?? ''; validateProbeRunId(runId);
const label = process.argv[3]; if (!['before','after'].includes(label ?? '')) throw new Error('Expected before or after snapshot.');
const root = resolve('artifacts/real-world', runId, 'single-agent-demo');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as { runId: string };
if (manifest.runId !== runId) throw new Error('Run mismatch');
const store = new SqliteRelayStore(resolve(root, 'broker.sqlite'));
try {
  const processes = await chromeProcesses();
  const profiles = store.profiles.all().map(p => {
    const instance = store.profiles.currentInstance(p.profileRef);
    return { profile_ref: p.profileRef, display_name: p.displayName, identity_hash: p.identityHash,
      instance_ref: instance?.instanceRef ?? null, generation: instance?.generation ?? null, pid: instance?.pid ?? null,
      process_verified: !!instance && processes.some(process => matchesInstance(process, instance)),
      authenticated: !!instance && store.profiles.instanceAuthenticated(instance.instanceRef) };
  });
  writeFileSync(resolve(root, `runtime-${label}.json`), JSON.stringify({ runId, at: new Date().toISOString(), profiles }, null, 2));
  console.log(JSON.stringify({ runId, label, profiles: profiles.map(p => ({ name: p.display_name, verified: p.process_verified, generation: p.generation })) }));
} finally { store.close(); }
