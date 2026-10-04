import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (!root.startsWith(resolve(tmpdir()) + sep) || !root.includes('octopus-upgrade-')) throw new Error('Invalid cleanup');
  rmSync(root, { recursive: true, force: true });
} });
it('blocks upgrades with a managed instance and snapshots inactive data with Profile metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'octopus-upgrade-')); roots.push(root);
  const path = join(root, 'relay.sqlite'); const backup = join(root, 'backup.sqlite');
  const store = new SqliteRelayStore(path);
  try {
    const principal = store.createAgent('Owner', ['profiles:manage']).principal;
    const p = store.profiles.create(principal.principalId, 'chrome');
    const instance = store.profiles.createInstance(p.profileRef);
    const run = (...args: string[]) => spawnSync(process.execPath, ['tools/managed-upgrade-snapshot.mjs', path, backup, ...args], { encoding: 'utf8', windowsHide: true });
    expect(run('--check-only').status).not.toBe(0); expect(existsSync(backup)).toBe(false);
    store.profiles.updateInstance({ ...instance, browserState: 'stopped', endedAt: new Date().toISOString() });
    expect(run('--check-only').status).toBe(0); expect(existsSync(backup)).toBe(false);
    expect(run().status).toBe(0); expect(existsSync(`${backup}.profiles.json`)).toBe(true);
    const db = new DatabaseSync(backup, { readOnly: true });
    expect(db.prepare('SELECT profile_ref FROM managed_profiles').get()?.profile_ref).toBe(p.profileRef);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); db.close();
    expect(run().status).not.toBe(0); // A previous recovery snapshot must never be overwritten.
  } finally { store.close(); }
});
it('refuses active workspace and unfinished ticket snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'octopus-upgrade-')); roots.push(root);
  const path = join(root, 'relay.sqlite'); const store = new SqliteRelayStore(path);
  try {
    const logical = store.canonical.logical;
    logical.registerLineage({ lineageRef: 'lin', runtimeName: 'test' });
    logical.registerSession({ sessionRef: 'ses', lineageRef: 'lin', runtimeSessionKeyHash: 'test' });
    store.canonical.requests.acceptRequest({ requestRef: 'req', toolName: 'request_browser_workspace', requesterSessionRef: 'ses', authorityScope: 'requester', authoritySessionRef: 'ses', authorityLineageRef: 'lin', normalizedBody: {}, phase: 'queued', checkpoint: {} });
    const result = spawnSync(process.execPath, ['tools/managed-upgrade-snapshot.mjs', path, join(root, 'backup.sqlite')], { encoding: 'utf8', windowsHide: true });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Finish pending browser requests');
  } finally { store.close(); }
});
