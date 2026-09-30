import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { NodeSqliteDatabase } from '../../apps/broker/src/storage/sqlite/runtime.js';
import { SqliteProfileRepository } from '../../apps/broker/src/storage/sqlite/profile-repository.js';

describe('managed Profile persistence', () => {
  let store: SqliteRelayStore;
  let root: string;
  let principal: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'octopus-profile-test-'));
    store = new SqliteRelayStore(join(root, 'relay.sqlite'));
    principal = store.createAgent('A', ['profiles:read', 'profiles:manage'], 'original-token').principal.principalId;
    store.canonical.logical.registerLineage({ lineageRef: 'lin_test', runtimeName: 'test' });
    store.canonical.logical.registerSession({ sessionRef: 'ses_test', lineageRef: 'lin_test', runtimeSessionKeyHash: 'test' });
  });
  afterEach(() => {
    store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('octopus-profile-test-')) throw new Error('Invalid cleanup path');
    rmSync(root, { recursive: true, force: true });
  });
  const accept = (store: SqliteRelayStore, ref: string) => {
    store.canonical.requests.acceptRequest({ requestRef: ref, toolName: 'create_browser_profile', requesterSessionRef: 'ses_test',
      authorityScope: 'requester', authoritySessionRef: 'ses_test', authorityLineageRef: 'lin_test',
      normalizedBody: {}, phase: 'reserved', checkpoint: {} });
    return ref;
  };

  it('persists offline resources, principal identity and request associations across reopen', () => {
    const input = { principalId: principal, key: 'create-one', bodyHash: 'hash', displayName: 'Alice', runtimeRef: 'chrome' };
    const result = store.profiles.reserveCreation(input, () => accept(store, 'req_one'));
    store.updateAgentScopes(principal, ['profiles:read']);
    expect(store.rotateAgentToken(principal, 'replacement-token')).toBe(true);
    store.close(); store = new SqliteRelayStore(join(root, 'relay.sqlite'));
    expect(store.authenticateAgent('original-token')).toBeNull();
    expect(store.authenticateAgent('replacement-token')).toMatchObject({ principalId: principal, scopes: ['profiles:read'] });
    expect(store.profiles.page(principal).profiles).toEqual([result.profile]);
    expect(store.profiles.currentInstance(result.profile.profileRef)).toBeNull();
    expect(store.profiles.request('req_one')?.principalId).toBe(principal);
    expect(store.profiles.reserveCreation(input, () => { throw new Error('must not repeat'); }).reused).toBe(true);
    expect(() => store.profiles.reserveCreation({ ...input, bodyHash: 'other' }, () => '')).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('rolls back the Profile, nested ticket and idempotency key together', () => {
    expect(() => store.profiles.reserveCreation({ principalId: principal, key: 'rollback', bodyHash: 'h', displayName: 'A', runtimeRef: 'c' }, () => {
      accept(store, 'req_rollback'); throw new Error('interrupted');
    })).toThrow('interrupted');
    expect(store.profiles.all()).toEqual([]);
    expect(store.canonical.requests.getRequest('req_rollback')).toBeNull();
    expect(store.profiles.findCreation(principal, 'rollback')).toBeNull();
  });

  it('binds stable pagination to a principal without leaking other profiles', () => {
    const other = store.createAgent('B', []).principal.principalId;
    const refs = Array.from({ length: 4 }, () => store.profiles.create(principal, 'same name', 'chrome').profileRef);
    store.profiles.create(other, 'private', 'chrome');
    const first = store.profiles.page(principal, 2);
    expect(first.nextCursor).toBeTruthy();
    expect(() => store.profiles.page(other, 2, first.nextCursor!)).toThrow('CURSOR_INVALID');
    const second = store.profiles.page(principal, 2, first.nextCursor!);
    expect([...first.profiles, ...second.profiles].map(p => p.profileRef).sort()).toEqual(refs.sort());
    expect(second.nextCursor).toBeNull();
    expect(store.profiles.getVisible(other, refs[0]!)).toBeNull();
  });

  it('allows one live instance and rejects writes from a retired generation', () => {
    const p = store.profiles.create(principal, 'A', 'chrome');
    const first = store.profiles.createInstance(p.profileRef);
    expect(() => store.profiles.createInstance(p.profileRef)).toThrow('PROFILE_IN_USE');
    store.profiles.updateInstance({ ...first, browserState: 'stopped', endedAt: new Date().toISOString() });
    expect(store.profiles.createInstance(p.profileRef).generation).toBe(2);
    expect(() => store.profiles.updateInstance({ ...first, browserState: 'running' })).toThrow('PROFILE_INSTANCE_UNVERIFIED');
  });

  it('fences expired lease owners even when an owner name is reused', () => {
    const p = store.profiles.create(principal, 'A', 'chrome');
    const first = store.profiles.acquire(p.profileRef, 'worker', 100, 1000)!;
    expect(store.profiles.acquire(p.profileRef, 'other', 100, 1050)).toBeNull();
    const next = store.profiles.acquire(p.profileRef, 'worker', 100, 1100)!;
    expect(next.generation).toBe(first.generation + 1);
    expect(store.profiles.renew(first, 100, 1110)).toBe(false);
    store.profiles.release(first);
    expect(store.profiles.owns(next, 1110)).toBe(true);
    expect(store.profiles.renew(next, 100, 1110)).toBe(true);
  });

  it('consumes valid bootstrap grants once and rejects expired grants', () => {
    const p = store.profiles.create(principal, 'A', 'chrome');
    const instance = store.profiles.createInstance(p.profileRef);
    const grant = { grantRef: 'g1', profileRef: p.profileRef, instanceRef: instance.instanceRef, generation: 1,
      secretHash: 'hash-only', expiresAt: 2000, consumedAt: null };
    store.profiles.saveGrant(grant);
    expect(store.profiles.consumeGrant('g1', 1999)).toBe(true);
    expect(store.profiles.consumeGrant('g1', 1999)).toBe(false);
    store.profiles.saveGrant({ ...grant, grantRef: 'g2' });
    expect(store.profiles.consumeGrant('g2', 2000)).toBe(false);
  });

  it('never rebinds an established Profile identity or adopts a foreign endpoint', () => {
    const p = store.profiles.create(principal, 'A', 'chrome');
    store.canonical.logical.createEndpoint({ endpointRef: 'ep_test', nickname: 'test' });
    store.profiles.bind(p.profileRef, 'ep_test', 'identity');
    expect(() => store.profiles.bind(p.profileRef, 'ep_test', 'changed')).toThrow('PROFILE_IDENTITY_MISMATCH');
    expect(() => store.profiles.bind(p.profileRef, 'ep_elsewhere', 'identity')).toThrow('PROFILE_IDENTITY_MISMATCH');
    expect(store.profiles.get(p.profileRef)?.identityHash).toBe('identity');
  });

  it('backs up schema five consistently and preserves historical session, workspace and request rows', () => {
    const logical = store.canonical.logical;
    logical.createEndpoint({ endpointRef: 'ep_old', nickname: 'old' });
    logical.upsertWindow({ windowRef: 'win_old', endpointRef: 'ep_old', privateWindowKey: 'window', locatorGeneration: 1, focused: true, eligible: true });
    logical.createWorkspace({ workspaceRef: 'wrk_old', endpointRef: 'ep_old', windowRef: 'win_old', lineageRef: 'lin_test', ownerSessionRef: 'ses_test', groupLabel: 'Old work' });
    store.canonical.requests.acceptRequest({ requestRef: 'req_old', toolName: 'request_browser_workspace', requesterSessionRef: 'ses_test', authorityScope: 'requester', authoritySessionRef: 'ses_test', authorityLineageRef: 'lin_test', normalizedBody: {}, phase: 'queued', checkpoint: {} });
    const before = store.canonical.requests.getRequest('req_old');
    store.close();
    const raw = new DatabaseSync(join(root, 'relay.sqlite'));
    // Migration 006 adds only these tables, so removal restores the exact v5 schema with real historical rows.
    for (const table of ['profile_list_cursors', 'managed_bootstrap_grants', 'profile_operation_locks', 'profile_create_keys', 'profile_requests', 'managed_browser_instances', 'managed_profiles']) raw.exec(`DROP TABLE ${table}`);
    raw.exec('DELETE FROM schema_migrations WHERE version=6'); raw.close();
    store = new SqliteRelayStore(join(root, 'relay.sqlite'));
    expect(store.sqliteDiagnostics().migrationVersion).toBe(6);
    expect(store.canonical.requests.getRequest('req_old')).toEqual(before);
    expect(store.canonical.logical.getWorkspace('wrk_old')?.ownerSessionRef).toBe('ses_test');
    expect(store.authenticateAgent('original-token')?.principalId).toBe(principal);
    const backups = readdirSync(root).filter(name => name.includes('.before-profiles-'));
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(root, backups[0]!), { readOnly: true });
    expect(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version).toBe(5);
    expect(backup.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); backup.close();
    store.close(); store = new SqliteRelayStore(join(root, 'relay.sqlite'));
    expect(readdirSync(root).filter(name => name.includes('.before-profiles-'))).toHaveLength(1);
  });
  it('rolls back an interrupted migration and can apply it after the conflicting artifact is removed', () => {
    const path = join(root, 'v5.sqlite'); const db = new DatabaseSync(path);
    const migrations = ['001-initial.sql','002-real-world-trace.sql','003-agent-target-bindings.sql','004-workspaces-requests.sql','005-window-focus-history.sql'];
    migrations.forEach((name, index) => { db.exec(readFileSync(new URL(`../../apps/broker/src/storage/sqlite/migrations/${name}`, import.meta.url), 'utf8')); db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index + 1, 'test'); });
    db.exec('CREATE INDEX managed_profiles_owner ON agents(principal_id)'); db.close();
    expect(() => new SqliteRelayStore(path)).toThrow();
    const inspect = new DatabaseSync(path);
    expect(inspect.prepare("SELECT 1 FROM sqlite_master WHERE name='managed_profiles'").get()).toBeUndefined();
    expect(inspect.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v).toBe(5);
    inspect.exec('DROP INDEX managed_profiles_owner'); inspect.close();
    const recovered = new SqliteRelayStore(path); expect(recovered.sqliteDiagnostics().migrationVersion).toBe(6); recovered.close();
  });
  it('serializes same-key reservations and rejects duplicate directory keys and read-only writes', async () => {
    const input = { principalId: principal, key: 'concurrent-key', bodyHash: 'same', displayName: 'Same', runtimeRef: 'chrome' };
    const results = await Promise.all(Array.from({ length: 3 }, () => Promise.resolve().then(() => store.profiles.reserveCreation(input, () => accept(store, 'req_once')))));
    expect(new Set(results.map(r => r.profile.profileRef)).size).toBe(1);
    expect(results.filter(r => !r.reused)).toHaveLength(1);
    const second = store.profiles.create(principal, 'Same', 'chrome');
    const raw = new DatabaseSync(join(root, 'relay.sqlite'));
    expect(() => raw.prepare('UPDATE managed_profiles SET data_dir_key=? WHERE profile_ref=?').run(results[0]!.profile.dataDirKey, second.profileRef)).toThrow();
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]); raw.close();
    const readonly = new NodeSqliteDatabase(join(root, 'relay.sqlite')); readonly.pragma('query_only=ON');
    try { expect(() => new SqliteProfileRepository(readonly).create(principal, 'Cannot write', 'chrome')).toThrow(); }
    finally { readonly.close(); }
    expect(store.profiles.all()).toHaveLength(2);
  });
});
