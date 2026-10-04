import { randomUUID } from 'node:crypto';
import type { BootstrapGrant, ManagedBrowserInstance, ManagedProfile, ProfileLease, ProfileRequest } from '../../profiles/types.js';
import { ProfileError } from '../../profiles/types.js';
import type { SqliteDatabase } from './runtime.js';
import { nullableString, type Row } from './shared.js';

const profile = (row: Row): ManagedProfile => ({
  profileRef: String(row.profile_ref), principalId: String(row.principal_id),
  dataDirKey: String(row.data_dir_key), runtimeRef: String(row.runtime_ref), endpointRef: nullableString(row.endpoint_ref),
  identityHash: nullableString(row.identity_hash), problemCode: nullableString(row.problem_code),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at)
});
const instance = (row: Row): ManagedBrowserInstance => ({
  instanceRef: String(row.instance_ref), profileRef: String(row.profile_ref), generation: Number(row.generation),
  browserState: String(row.browser_state) as ManagedBrowserInstance['browserState'],
  extensionState: String(row.extension_state) as ManagedBrowserInstance['extensionState'],
  pid: row.pid === null ? null : Number(row.pid), processCreatedAt: nullableString(row.process_created_at),
  executablePath: nullableString(row.executable_path), dataDir: nullableString(row.data_dir),
  managementUrl: nullableString(row.management_url), observedAt: String(row.observed_at), endedAt: nullableString(row.ended_at)
});

export class SqliteProfileRepository {
  constructor(private readonly db: SqliteDatabase) {}

  transaction<T>(work: () => T): T { return this.db.transaction(work)(); }

  reserveCreation(input: { principalId: string; key: string; bodyHash: string; runtimeRef: string },
    acceptTicket: (value: ManagedProfile) => string): { profile: ManagedProfile; requestRef: string; reused: boolean } {
    return this.transaction(() => {
      const existing = this.findCreation(input.principalId, input.key);
      if (existing) {
        const value = this.get(existing.profileRef)!;
        if (existing.bodyHash !== input.bodyHash) throw new ProfileError('IDEMPOTENCY_CONFLICT');
        return { profile: value, requestRef: existing.requestRef, reused: true };
      }
      const value = this.create(input.principalId, input.runtimeRef);
      const requestRef = acceptTicket(value);
      this.associateRequest({ requestRef, profileRef: value.profileRef, principalId: input.principalId });
      this.recordCreation(input.principalId, input.key, input.bodyHash, value.profileRef, requestRef);
      return { profile: value, requestRef, reused: false };
    });
  }

  create(principalId: string, runtimeRef: string): ManagedProfile {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const ref = `prf_${id}`;
    this.db.prepare(`INSERT INTO managed_profiles(profile_ref,principal_id,data_dir_key,runtime_ref,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).run(ref, principalId, id, runtimeRef, timestamp, timestamp);
    return this.get(ref)!;
  }

  get(ref: string): ManagedProfile | null {
    const row = this.db.prepare('SELECT * FROM managed_profiles WHERE profile_ref=?').get(ref) as Row | undefined;
    return row ? profile(row) : null;
  }

  getVisible(principalId: string, ref: string): ManagedProfile | null {
    const value = this.get(ref);
    return value?.principalId === principalId ? value : null;
  }

  forEndpoint(endpointRef: string): ManagedProfile | null {
    const row = this.db.prepare('SELECT * FROM managed_profiles WHERE endpoint_ref=?').get(endpointRef) as Row | undefined;
    return row ? profile(row) : null;
  }

  all(): ManagedProfile[] { return (this.db.prepare('SELECT * FROM managed_profiles').all() as Row[]).map(profile); }

  page(principalId: string, limit = 50, cursor?: string): { profiles: ManagedProfile[]; nextCursor: string | null } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProfileError('INVALID_ARGUMENT');
    let afterCreated = '';
    let afterRef = '';
    if (cursor) {
      const row = this.db.prepare('SELECT * FROM profile_list_cursors WHERE cursor_ref=? AND principal_id=? AND expires_at>?')
        .get(cursor, principalId, Date.now()) as Row | undefined;
      if (!row) throw new ProfileError('CURSOR_INVALID');
      afterCreated = String(row.after_created_at); afterRef = String(row.after_profile_ref);
    }
    const rows = this.db.prepare(`SELECT * FROM managed_profiles WHERE principal_id=?
      AND (created_at > ? OR (created_at = ? AND profile_ref > ?)) ORDER BY created_at, profile_ref LIMIT ?`)
      .all(principalId, afterCreated, afterCreated, afterRef, limit + 1) as Row[];
    const values = rows.slice(0, limit).map(profile);
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const last = values[values.length - 1]!;
      nextCursor = `cur_${randomUUID()}`;
      this.db.prepare('DELETE FROM profile_list_cursors WHERE expires_at <= ?').run(Date.now());
      this.db.prepare('INSERT INTO profile_list_cursors VALUES(?,?,?,?,?)')
        .run(nextCursor, principalId, last.createdAt, last.profileRef, Date.now() + 86_400_000);
    }
    return { profiles: values, nextCursor };
  }

  setProblem(profileRef: string, code: string | null): void {
    this.db.prepare('UPDATE managed_profiles SET problem_code=?,updated_at=? WHERE profile_ref=?')
      .run(code, new Date().toISOString(), profileRef);
  }

  bind(profileRef: string, endpointRef: string, identityHash: string): void {
    const value = this.get(profileRef);
    if (!value || (value.identityHash && value.identityHash !== identityHash) || (value.endpointRef && value.endpointRef !== endpointRef)) {
      throw new ProfileError('PROFILE_IDENTITY_MISMATCH');
    }
    this.db.prepare('UPDATE managed_profiles SET endpoint_ref=?,identity_hash=?,updated_at=? WHERE profile_ref=?')
      .run(endpointRef, identityHash, new Date().toISOString(), profileRef);
  }

  currentInstance(profileRef: string): ManagedBrowserInstance | null {
    const row = this.db.prepare('SELECT * FROM managed_browser_instances WHERE profile_ref=? AND ended_at IS NULL').get(profileRef) as Row | undefined;
    return row ? instance(row) : null;
  }

  getInstance(instanceRef: string): ManagedBrowserInstance | null {
    const row = this.db.prepare('SELECT * FROM managed_browser_instances WHERE instance_ref=?').get(instanceRef) as Row | undefined;
    return row ? instance(row) : null;
  }

  createInstance(profileRef: string): ManagedBrowserInstance {
    return this.transaction(() => {
      if (this.currentInstance(profileRef)) throw new ProfileError('PROFILE_IN_USE');
      const previous = this.db.prepare('SELECT COALESCE(MAX(generation),0) AS generation FROM managed_browser_instances WHERE profile_ref=?').get(profileRef) as Row;
      const instanceRef = `ins_${randomUUID()}`;
      this.db.prepare(`INSERT INTO managed_browser_instances(instance_ref,profile_ref,generation,browser_state,extension_state,observed_at)
        VALUES(?,?,?,'starting','unknown',?)`).run(instanceRef, profileRef, Number(previous.generation) + 1, new Date().toISOString());
      return this.getInstance(instanceRef)!;
    });
  }

  updateInstance(value: ManagedBrowserInstance): void {
    const result = this.db.prepare(`UPDATE managed_browser_instances SET browser_state=?,extension_state=?,pid=?,process_created_at=?,
      executable_path=?,data_dir=?,management_url=?,observed_at=?,ended_at=? WHERE instance_ref=? AND generation=? AND ended_at IS NULL`)
      .run(value.browserState, value.extensionState, value.pid, value.processCreatedAt, value.executablePath,
        value.dataDir, value.managementUrl, value.observedAt, value.endedAt, value.instanceRef, value.generation);
    if (Number(result.changes) !== 1) throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
  }

  associateRequest(value: ProfileRequest): void {
    this.db.prepare('INSERT INTO profile_requests VALUES(?,?,?)').run(value.requestRef, value.profileRef, value.principalId);
  }

  request(requestRef: string): ProfileRequest | null {
    const row = this.db.prepare('SELECT * FROM profile_requests WHERE request_ref=?').get(requestRef) as Row | undefined;
    return row ? { requestRef: String(row.request_ref), profileRef: String(row.profile_ref), principalId: String(row.principal_id) } : null;
  }

  renewRequest(requestRef: string, generation: number, ttlMs: number): boolean {
    const now = new Date().toISOString();
    return Number(this.db.prepare(`UPDATE request_tickets SET claim_expires_at=?
      WHERE request_ref=? AND claim_generation=? AND state='running' AND claim_expires_at>?`)
      .run(new Date(Date.now() + ttlMs).toISOString(), requestRef, generation, now).changes) === 1;
  }

  ownsRequest(requestRef: string, generation: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM request_tickets WHERE request_ref=? AND claim_generation=? AND state='running' AND claim_expires_at>?`)
      .get(requestRef, generation, new Date().toISOString());
  }

  findCreation(principalId: string, key: string): { bodyHash: string; profileRef: string; requestRef: string } | null {
    const row = this.db.prepare('SELECT * FROM profile_create_keys WHERE principal_id=? AND idempotency_key=?').get(principalId, key) as Row | undefined;
    return row ? { bodyHash: String(row.body_hash), profileRef: String(row.profile_ref), requestRef: String(row.request_ref) } : null;
  }

  recordCreation(principalId: string, key: string, bodyHash: string, profileRef: string, requestRef: string): void {
    this.db.prepare('INSERT INTO profile_create_keys VALUES(?,?,?,?,?)').run(principalId, key, bodyHash, profileRef, requestRef);
  }

  acquire(profileRef: string, ownerRef: string, ttlMs: number, now = Date.now()): ProfileLease | null {
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM profile_operation_locks WHERE profile_ref=?').get(profileRef) as Row | undefined;
      if (old && Number(old.expires_at) > now) return null;
      const generation = Number(old?.generation ?? 0) + 1;
      const expiresAt = now + ttlMs;
      this.db.prepare(`INSERT INTO profile_operation_locks VALUES(?,?,?,?) ON CONFLICT(profile_ref)
        DO UPDATE SET owner_ref=excluded.owner_ref,generation=excluded.generation,expires_at=excluded.expires_at`)
        .run(profileRef, ownerRef, generation, expiresAt);
      return { profileRef, ownerRef, generation, expiresAt };
    });
  }

  renew(lease: ProfileLease, ttlMs: number, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE profile_operation_locks SET expires_at=?
      WHERE profile_ref=? AND owner_ref=? AND generation=? AND expires_at>?`)
      .run(now + ttlMs, lease.profileRef, lease.ownerRef, lease.generation, now);
    return Number(result.changes) === 1;
  }

  owns(lease: ProfileLease, now = Date.now()): boolean {
    return !!this.db.prepare('SELECT 1 FROM profile_operation_locks WHERE profile_ref=? AND owner_ref=? AND generation=? AND expires_at>?')
      .get(lease.profileRef, lease.ownerRef, lease.generation, now);
  }

  release(lease: ProfileLease): void {
    this.db.prepare('UPDATE profile_operation_locks SET expires_at=0 WHERE profile_ref=? AND owner_ref=? AND generation=?')
      .run(lease.profileRef, lease.ownerRef, lease.generation);
  }

  saveGrant(grant: BootstrapGrant): void {
    this.db.prepare('INSERT INTO managed_bootstrap_grants VALUES(?,?,?,?,?,?,?)')
      .run(grant.grantRef, grant.profileRef, grant.instanceRef, grant.generation, grant.secretHash, grant.expiresAt, grant.consumedAt);
  }

  grant(grantRef: string): BootstrapGrant | null {
    const row = this.db.prepare('SELECT * FROM managed_bootstrap_grants WHERE grant_ref=?').get(grantRef) as Row | undefined;
    return row ? {
      grantRef: String(row.grant_ref), profileRef: String(row.profile_ref), instanceRef: String(row.instance_ref),
      generation: Number(row.generation), secretHash: String(row.secret_hash), expiresAt: Number(row.expires_at),
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at)
    } : null;
  }

  consumeGrant(grantRef: string, now = Date.now()): boolean {
    return Number(this.db.prepare('UPDATE managed_bootstrap_grants SET consumed_at=? WHERE grant_ref=? AND consumed_at IS NULL AND expires_at>?')
      .run(now, grantRef, now).changes) === 1;
  }

  instanceAuthenticated(instanceRef: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM managed_browser_instances WHERE instance_ref=? AND ended_at IS NULL AND authenticated_at IS NOT NULL').get(instanceRef);
  }

  authenticateInstance(instanceRef: string): void {
    if (Number(this.db.prepare('UPDATE managed_browser_instances SET authenticated_at=? WHERE instance_ref=? AND ended_at IS NULL')
      .run(new Date().toISOString(), instanceRef).changes) !== 1) throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
  }
}
