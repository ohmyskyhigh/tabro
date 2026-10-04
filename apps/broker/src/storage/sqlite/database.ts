import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type {
  AgentPrincipal,
  BrokerResult,
  CommandState,
  IdempotencyClass,
  RoutingDecision
} from '../../../../shared/protocol/src/index.js';
import type {
  CreateCommandInput,
  CanonicalRepositories,
  CanonicalRepositorySet,
  LeaseGrant,
  RelayRepositories,
  ResolvedSession,
  StoredBinding,
  StoredCommand,
  StoredLease,
  StoredTraceEvent,
  StoredTarget
} from '../repositories.js';
import { SqliteAuditRepository } from './audit-repository.js';
import { SqliteEventRepository } from './event-repository.js';
import { SqliteLogicalRepository } from './logical-repository.js';
import { SqliteRequestRepository } from './request-repository.js';
import { SqliteProxyRepository } from './proxy-repository.js';
import { SqliteProfileRepository } from './profile-repository.js';
import { NodeSqliteDatabase, type SqliteDatabase } from './runtime.js';

type Row = Record<string, unknown>;

const hashSecret = (value: string): string => createHash('sha256').update(value).digest('hex');
const nowIso = (): string => new Date().toISOString();

const jwkIdentity = (value: JsonWebKey): string => JSON.stringify({
  kty: value.kty,
  crv: value.crv,
  x: value.x,
  y: value.y,
  n: value.n,
  e: value.e
});

function parseJson<T>(value: unknown): T {
  if (typeof value !== 'string') throw new Error('Expected JSON string from database.');
  return JSON.parse(value) as T;
}

function toTarget(row: Row): StoredTarget {
  return {
    targetId: String(row.target_id),
    alias: String(row.alias),
    publicKeyJwk: parseJson<JsonWebKey>(row.public_key_jwk),
    capabilities: parseJson<string[]>(row.capabilities_json),
    revoked: Boolean(row.revoked),
    consecutiveFailures: Number(row.consecutive_failures),
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
    lastErrorAt: row.last_error_at === null ? null : String(row.last_error_at),
    statusVersion: Number(row.status_version)
  };
}

function toLease(row: Row): StoredLease {
  return {
    leaseId: String(row.lease_id),
    targetId: String(row.target_id),
    principalId: String(row.principal_id),
    fencingToken: Number(row.fencing_token),
    expiresAt: String(row.expires_at),
    releasedAt: row.released_at === null ? null : String(row.released_at)
  };
}

function toBinding(row: Row): StoredBinding {
  return {
    bindingId: String(row.binding_id),
    bindingRef: String(row.binding_ref),
    principalId: String(row.principal_id),
    targetId: String(row.target_id),
    targetAlias: String(row.target_alias),
    mode: 'dedicated',
    createdAt: String(row.created_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}

function toCommand(row: Row): StoredCommand {
  const command: StoredCommand = {
    commandId: String(row.command_id),
    requestId: String(row.request_id),
    principalId: String(row.principal_id),
    ...(row.run_id === null || row.run_id === undefined ? {} : { runId: String(row.run_id) }),
    bindingRef: String(row.binding_ref),
    targetId: String(row.target_id),
    targetAlias: String(row.target_alias),
    operation: String(row.operation),
    parameters: parseJson(row.parameters_json),
    idempotencyClass: String(row.idempotency_class) as IdempotencyClass,
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    state: String(row.state) as CommandState,
    decision: parseJson<RoutingDecision>(row.decision_json),
    deadlineAt: String(row.deadline_at),
    deliveredEpoch: row.delivered_epoch === null ? null : Number(row.delivered_epoch),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
  if (row.lease_id !== null) command.leaseId = String(row.lease_id);
  if (row.fencing_token !== null) command.fencingToken = Number(row.fencing_token);
  if (row.result_state !== null) {
    const result: BrokerResult = {
      commandId: command.commandId,
      state: String(row.result_state) as BrokerResult['state']
    };
    if (row.output_json !== null) result.output = parseJson(row.output_json);
    if (row.error_code !== null) result.errorCode = String(row.error_code);
    command.result = result;
  }
  return command;
}

export class SqliteRelayStore implements RelayRepositories {
  private readonly db: SqliteDatabase;
  readonly canonical: CanonicalRepositories;
  readonly profiles: SqliteProfileRepository;
  readonly proxies: SqliteProxyRepository;

  constructor(databasePath: string) {
    const existingDatabase = databasePath !== ':memory:' && existsSync(databasePath);
    if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.db = new NodeSqliteDatabase(databasePath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    try { this.migrate(existingDatabase ? databasePath : null); } catch (error) { this.db.close(); throw error; }
    this.profiles = new SqliteProfileRepository(this.db);
    this.proxies = new SqliteProxyRepository(this.db);
    const repositories: CanonicalRepositorySet = {
      profiles: this.profiles,
      logical: new SqliteLogicalRepository(this.db),
      requests: new SqliteRequestRepository(this.db),
      events: new SqliteEventRepository(this.db),
      audit: new SqliteAuditRepository(this.db)
    };
    this.canonical = {
      ...repositories,
      transaction: <T>(work: (set: CanonicalRepositorySet) => T): T => this.db.transaction(() => work(repositories))()
    };
  }

  private migrate(backupSource: string | null): void {
    const migrations = [
      { version: 1, sql: readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8') },
      { version: 2, sql: readFileSync(new URL('./migrations/002-real-world-trace.sql', import.meta.url), 'utf8') },
      { version: 3, sql: readFileSync(new URL('./migrations/003-agent-target-bindings.sql', import.meta.url), 'utf8') },
      { version: 4, sql: readFileSync(new URL('./migrations/004-workspaces-requests.sql', import.meta.url), 'utf8') },
      { version: 5, sql: readFileSync(new URL('./migrations/005-window-focus-history.sql', import.meta.url), 'utf8') },
      { version: 6, sql: readFileSync(new URL('./migrations/006-managed-profiles.sql', import.meta.url), 'utf8') },
      { version: 7, sql: readFileSync(new URL('./migrations/007-profile-alias-only.sql', import.meta.url), 'utf8') },
      { version: 8, sql: readFileSync(new URL('./migrations/008-profile-proxy.sql', import.meta.url), 'utf8') }
    ];
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    if (backupSource && !this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=6').get()) {
      this.db.prepare('VACUUM INTO ?').run(`${resolve(backupSource)}.before-profiles-${randomUUID()}.sqlite`);
    }
    for (const migration of migrations) {
      const applied = this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version);
      if (applied) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        if (migration.version === 7) {
          const update = this.db.prepare('UPDATE profile_create_keys SET body_hash=? WHERE principal_id=? AND idempotency_key=?');
          for (const row of this.db.prepare('SELECT principal_id,idempotency_key FROM profile_create_keys').all()) {
            const key = String(row.idempotency_key);
            update.run(hashSecret(JSON.stringify({ idempotency_key: key })), String(row.principal_id), key);
          }
        }
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(migration.version, nowIso());
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  sqliteDiagnostics(): { journalMode: string; foreignKeys: boolean; migrationVersion: number } {
    const journal = this.db.prepare('PRAGMA journal_mode').get() as Row;
    const foreignKeys = this.db.prepare('PRAGMA foreign_keys').get() as Row;
    const migration = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS value FROM schema_migrations').get() as Row;
    return {
      journalMode: String(journal.journal_mode),
      foreignKeys: Number(foreignKeys.foreign_keys) === 1,
      migrationVersion: Number(migration.value)
    };
  }

  createAgent(displayName: string, scopes: string[], token = randomBytes(32).toString('base64url')): { principal: AgentPrincipal; token: string } {
    const principalId = randomUUID();
    const createdAt = nowIso();
    this.db.prepare('INSERT INTO agents(principal_id, display_name, token_hash, scopes_json, created_at) VALUES(?,?,?,?,?)')
      .run(principalId, displayName, hashSecret(token), JSON.stringify(scopes), createdAt);
    return { principal: { principalId, displayName, scopes }, token };
  }

  authenticateAgent(token: string): AgentPrincipal | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE token_hash = ? AND enabled = 1').get(hashSecret(token)) as Row | undefined;
    if (!row) return null;
    return {
      principalId: String(row.principal_id),
      displayName: String(row.display_name),
      scopes: parseJson<string[]>(row.scopes_json)
    };
  }

  getAgentById(principalId: string): AgentPrincipal | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE principal_id = ? AND enabled = 1').get(principalId) as Row | undefined;
    if (!row) return null;
    return {
      principalId: String(row.principal_id),
      displayName: String(row.display_name),
      scopes: parseJson<string[]>(row.scopes_json)
    };
  }

  updateAgentScopes(principalId: string, scopes: string[]): AgentPrincipal | null {
    this.db.prepare('UPDATE agents SET scopes_json=? WHERE principal_id=? AND enabled=1')
      .run(JSON.stringify([...new Set(scopes)]), principalId);
    return this.getAgentById(principalId);
  }

  rotateAgentToken(principalId: string, token: string): boolean {
    return Number(this.db.prepare('UPDATE agents SET token_hash=? WHERE principal_id=? AND enabled=1')
      .run(hashSecret(token), principalId).changes) === 1;
  }

  createPairingCode(alias: string, expiresAt: string): string {
    if (this.getTargetByAlias(alias)) throw new Error(`Target alias already exists: ${alias}`);
    const code = randomBytes(6).toString('base64url').replace(/[-_]/g, 'A').slice(0, 8).toUpperCase();
    this.db.prepare('INSERT INTO pairing_codes(code_hash, alias, expires_at, created_at) VALUES(?,?,?,?)')
      .run(hashSecret(code), alias, expiresAt, nowIso());
    return code;
  }

  consumePairingCode(code: string, publicKeyJwk: JsonWebKey, capabilities: string[]): StoredTarget {
    return this.db.transaction(() => {
      const current = nowIso();
      const row = this.db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?')
        .get(hashSecret(code), current) as Row | undefined;
      if (!row) throw new Error('PAIRING_CODE_INVALID');
      const alias = String(row.alias);
      const existing = this.db.prepare('SELECT target_id, revoked FROM targets WHERE alias = ?').get(alias) as Row | undefined;
      const targetId = existing ? String(existing.target_id) : randomUUID();
      if (existing) {
        if (Number(existing.revoked) === 0) throw new Error(`Target alias already exists: ${alias}`);
        this.db.prepare(`UPDATE targets SET public_key_jwk = ?, capabilities_json = ?, revoked = 0,
          consecutive_failures = 0, last_seen_at = NULL, last_error_at = NULL,
          status_version = status_version + 1, updated_at = ? WHERE target_id = ?`)
          .run(JSON.stringify(publicKeyJwk), JSON.stringify(capabilities), current, targetId);
      } else {
        this.db.prepare(`INSERT INTO targets(target_id, alias, public_key_jwk, capabilities_json, created_at, updated_at)
          VALUES(?,?,?,?,?,?)`).run(targetId, alias, JSON.stringify(publicKeyJwk), JSON.stringify(capabilities), current, current);
      }
      this.db.prepare('UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ?').run(current, hashSecret(code));
      const target = this.getTargetById(targetId);
      if (!target) throw new Error('Failed to create target.');
      return target;
    })();
  }

  registerExtension(alias: string, publicKeyJwk: JsonWebKey, capabilities: string[]): StoredTarget {
    return this.db.transaction(() => {
      const current = nowIso();
      const existingRow = this.db.prepare('SELECT * FROM targets WHERE alias = ?').get(alias) as Row | undefined;
      const existing = existingRow ? toTarget(existingRow) : null;
      if (existing) {
        if (existing.revoked || jwkIdentity(existing.publicKeyJwk) !== jwkIdentity(publicKeyJwk)) {
          throw new Error('ENDPOINT_NICKNAME_CONFLICT');
        }
        this.db.prepare('UPDATE targets SET capabilities_json = ?, updated_at = ? WHERE target_id = ?')
          .run(JSON.stringify(capabilities), current, existing.targetId);
        return this.getTargetById(existing.targetId)!;
      }
      const targetId = randomUUID();
      this.db.prepare(`INSERT INTO targets(target_id, alias, public_key_jwk, capabilities_json, created_at, updated_at)
        VALUES(?,?,?,?,?,?)`).run(targetId, alias, JSON.stringify(publicKeyJwk), JSON.stringify(capabilities), current, current);
      return this.getTargetById(targetId)!;
    })();
  }

  listTargets(): StoredTarget[] {
    return (this.db.prepare('SELECT * FROM targets WHERE revoked = 0 ORDER BY alias').all() as Row[]).map(toTarget);
  }

  getTargetByAlias(alias: string): StoredTarget | null {
    const row = this.db.prepare('SELECT * FROM targets WHERE alias = ? AND revoked = 0').get(alias) as Row | undefined;
    return row ? toTarget(row) : null;
  }

  getTargetById(targetId: string): StoredTarget | null {
    const row = this.db.prepare('SELECT * FROM targets WHERE target_id = ? AND revoked = 0').get(targetId) as Row | undefined;
    return row ? toTarget(row) : null;
  }

  renameTarget(alias: string, newAlias: string): void {
    this.db.transaction(() => {
      const target = this.getTargetByAlias(alias);
      if (!target) throw new Error(`Target not found: ${alias}`);
      const conflictingTarget = this.db.prepare('SELECT target_id FROM targets WHERE alias = ?')
        .get(newAlias) as Row | undefined;
      const conflictingEndpoint = this.db.prepare('SELECT legacy_target_id FROM browser_endpoints WHERE nickname = ?')
        .get(newAlias) as Row | undefined;
      if ((conflictingTarget && conflictingTarget.target_id !== target.targetId)
        || (conflictingEndpoint && conflictingEndpoint.legacy_target_id !== target.targetId)) {
        throw new Error('ENDPOINT_NICKNAME_CONFLICT');
      }
      const current = nowIso();
      this.db.prepare('UPDATE targets SET alias = ?, status_version = status_version + 1, updated_at = ? WHERE target_id = ?')
        .run(newAlias, current, target.targetId);
      this.db.prepare(`UPDATE browser_endpoints
        SET nickname = ?, status_version = status_version + 1, updated_at = ?
        WHERE legacy_target_id = ?`).run(newAlias, current, target.targetId);
    })();
  }

  revokeTarget(alias: string): void {
    const current = nowIso();
    this.db.transaction(() => {
      const target = this.getTargetByAlias(alias);
      if (!target) throw new Error(`Target not found: ${alias}`);
      this.db.prepare('UPDATE targets SET revoked = 1, status_version = status_version + 1, updated_at = ? WHERE target_id = ?').run(current, target.targetId);
      this.db.prepare('UPDATE leases SET released_at = ? WHERE target_id = ? AND released_at IS NULL').run(current, target.targetId);
      this.db.prepare('UPDATE agent_target_bindings SET revoked_at = ? WHERE target_id = ? AND revoked_at IS NULL').run(current, target.targetId);
    })();
  }

  createBinding(principalId: string, targetId: string): StoredBinding {
    return this.db.transaction(() => {
      const principal = this.getAgentById(principalId);
      if (!principal) throw new Error('AGENT_NOT_FOUND');
      const target = this.getTargetById(targetId);
      if (!target) throw new Error('TARGET_NOT_FOUND');
      const byPrincipal = this.getActiveBindingForPrincipal(principalId);
      if (byPrincipal) {
        if (byPrincipal.targetId === targetId) return byPrincipal;
        throw new Error('BINDING_CONFLICT');
      }
      const byTargetRow = this.db.prepare(`SELECT b.*, t.alias AS target_alias FROM agent_target_bindings b
        JOIN targets t ON t.target_id = b.target_id WHERE b.target_id = ? AND b.revoked_at IS NULL`)
        .get(targetId) as Row | undefined;
      if (byTargetRow) throw new Error('BINDING_CONFLICT');
      const bindingId = randomUUID();
      const bindingRef = `br_${randomBytes(24).toString('base64url')}`;
      const createdAt = nowIso();
      this.db.prepare(`INSERT INTO agent_target_bindings(binding_id,binding_ref,principal_id,target_id,mode,created_at)
        VALUES(?,?,?,?,?,?)`).run(bindingId, bindingRef, principalId, targetId, 'dedicated', createdAt);
      const binding = this.getBindingByRef(bindingRef);
      if (!binding) throw new Error('Failed to create binding.');
      return binding;
    })();
  }

  getBindingByRef(bindingRef: string): StoredBinding | null {
    const row = this.db.prepare(`SELECT b.*, t.alias AS target_alias FROM agent_target_bindings b
      JOIN targets t ON t.target_id = b.target_id WHERE b.binding_ref = ?`).get(bindingRef) as Row | undefined;
    return row ? toBinding(row) : null;
  }

  getActiveBindingForPrincipal(principalId: string): StoredBinding | null {
    const row = this.db.prepare(`SELECT b.*, t.alias AS target_alias FROM agent_target_bindings b
      JOIN targets t ON t.target_id = b.target_id
      WHERE b.principal_id = ? AND b.revoked_at IS NULL AND t.revoked = 0`).get(principalId) as Row | undefined;
    return row ? toBinding(row) : null;
  }

  listBindings(): StoredBinding[] {
    const rows = this.db.prepare(`SELECT b.*, t.alias AS target_alias FROM agent_target_bindings b
      JOIN targets t ON t.target_id = b.target_id
      WHERE b.revoked_at IS NULL AND t.revoked = 0 ORDER BY b.created_at`).all() as Row[];
    return rows.map(toBinding);
  }

  revokeBindingForPrincipal(principalId: string): boolean {
    return this.db.transaction(() => {
      const binding = this.getActiveBindingForPrincipal(principalId);
      if (!binding) return false;
      const current = nowIso();
      const changed = this.db.prepare('UPDATE agent_target_bindings SET revoked_at = ? WHERE binding_id = ? AND revoked_at IS NULL')
        .run(current, binding.bindingId).changes === 1;
      if (changed) {
        this.db.prepare('UPDATE leases SET released_at = ? WHERE target_id = ? AND principal_id = ? AND released_at IS NULL')
          .run(current, binding.targetId, principalId);
      }
      return changed;
    })();
  }

  revokeBindingsForTarget(targetId: string): number {
    return Number(this.db.prepare('UPDATE agent_target_bindings SET revoked_at = ? WHERE target_id = ? AND revoked_at IS NULL')
      .run(nowIso(), targetId).changes);
  }

  updateTargetObservation(targetId: string, observation: 'heartbeat' | 'success' | 'failure', capabilities?: string[]): StoredTarget {
    const current = nowIso();
    if (observation === 'failure') {
      this.db.prepare(`UPDATE targets SET consecutive_failures = consecutive_failures + 1, last_error_at = ?, last_seen_at = ?,
        status_version = status_version + 1, updated_at = ? WHERE target_id = ?`).run(current, current, current, targetId);
    } else if (observation === 'success') {
      this.db.prepare(`UPDATE targets SET consecutive_failures = 0, last_seen_at = ?, status_version = status_version + 1,
        updated_at = ? WHERE target_id = ?`).run(current, current, targetId);
    } else {
      this.db.prepare(`UPDATE targets SET last_seen_at = ?, capabilities_json = COALESCE(?, capabilities_json),
        updated_at = ? WHERE target_id = ?`).run(current, capabilities ? JSON.stringify(capabilities) : null, current, targetId);
    }
    const target = this.getTargetById(targetId);
    if (!target) throw new Error(`Target not found: ${targetId}`);
    return target;
  }

  bumpStatusVersion(targetId: string): number {
    this.db.prepare('UPDATE targets SET status_version = status_version + 1, updated_at = ? WHERE target_id = ?').run(nowIso(), targetId);
    const target = this.getTargetById(targetId);
    if (!target) throw new Error(`Target not found: ${targetId}`);
    return target.statusVersion;
  }

  getActiveLease(targetId: string, at: string): StoredLease | null {
    const row = this.db.prepare(`SELECT * FROM leases WHERE target_id = ? AND released_at IS NULL AND expires_at > ?
      ORDER BY fencing_token DESC LIMIT 1`).get(targetId, at) as Row | undefined;
    return row ? toLease(row) : null;
  }

  acquireLease(targetId: string, principalId: string, expiresAt: string): LeaseGrant | null {
    return this.db.transaction(() => {
      const current = nowIso();
      this.db.prepare('UPDATE leases SET released_at = ? WHERE target_id = ? AND released_at IS NULL AND expires_at <= ?')
        .run(current, targetId, current);
      const existing = this.getActiveLease(targetId, current);
      if (existing) return null;
      const maxRow = this.db.prepare('SELECT COALESCE(MAX(fencing_token), 0) AS value FROM leases WHERE target_id = ?').get(targetId) as Row;
      const fencingToken = Number(maxRow.value) + 1;
      const leaseId = randomUUID();
      const lease: StoredLease = { leaseId, targetId, principalId, fencingToken, expiresAt, releasedAt: null };
      this.db.prepare('INSERT INTO leases(lease_id,target_id,principal_id,fencing_token,expires_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(leaseId, targetId, principalId, fencingToken, expiresAt, current);
      const sessionHandle = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO sessions(session_id,handle_hash,lease_id,principal_id,expires_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), hashSecret(sessionHandle), leaseId, principalId, expiresAt, current);
      return { lease, sessionHandle };
    })();
  }

  resolveSession(handle: string, principalId: string, at: string): ResolvedSession | null {
    const row = this.db.prepare(`SELECT l.*, t.alias, s.expires_at AS session_expires_at FROM sessions s
      JOIN leases l ON l.lease_id = s.lease_id JOIN targets t ON t.target_id = l.target_id
      WHERE s.handle_hash = ? AND s.principal_id = ? AND s.expires_at > ? AND l.released_at IS NULL AND l.expires_at > ? AND t.revoked = 0`)
      .get(hashSecret(handle), principalId, at, at) as Row | undefined;
    if (!row) return null;
    return { ...toLease(row), alias: String(row.alias), sessionExpiresAt: String(row.session_expires_at) };
  }

  releaseSession(handle: string, principalId: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT lease_id FROM sessions WHERE handle_hash = ? AND principal_id = ?')
        .get(hashSecret(handle), principalId) as Row | undefined;
      if (!row) return false;
      const result = this.db.prepare('UPDATE leases SET released_at = ? WHERE lease_id = ? AND released_at IS NULL')
        .run(nowIso(), String(row.lease_id));
      return result.changes === 1;
    })();
  }

  expireLeases(at: string): number {
    return Number(this.db.prepare('UPDATE leases SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?').run(at, at).changes);
  }

  createCommand(input: CreateCommandInput): StoredCommand {
    const current = nowIso();
    const { command, decision } = input;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO commands(command_id,request_id,principal_id,run_id,binding_ref,target_id,lease_id,fencing_token,operation,
        parameters_json,idempotency_class,idempotency_key,state,decision_json,deadline_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        command.commandId,
        command.requestId,
        command.principalId,
        command.runId ?? null,
        command.bindingRef,
        command.targetId,
        command.leaseId ?? null,
        command.fencingToken ?? null,
        command.operation,
        JSON.stringify(command.parameters),
        command.idempotencyClass,
        input.idempotencyKey ?? null,
        input.initialState,
        JSON.stringify(decision),
        command.deadlineAt,
        current,
        current
      );
      this.db.prepare('INSERT INTO command_events(command_id,state,reason_code,observed_at) VALUES(?,?,?,?)')
        .run(command.commandId, input.initialState, decision.reasonCode, current);
    })();
    const created = this.getCommand(command.commandId);
    if (!created) throw new Error('Failed to create command.');
    return created;
  }

  findCommandByIdempotency(principalId: string, idempotencyKey: string): StoredCommand | null {
    const row = this.queryCommand('WHERE c.principal_id = ? AND c.idempotency_key = ?', [principalId, idempotencyKey]);
    return row ? toCommand(row) : null;
  }

  getCommand(commandId: string): StoredCommand | null {
    const row = this.queryCommand('WHERE c.command_id = ?', [commandId]);
    return row ? toCommand(row) : null;
  }

  private queryCommand(where: string, params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(`SELECT c.*, t.alias AS target_alias, r.state AS result_state, r.output_json, r.error_code
      FROM commands c JOIN targets t ON t.target_id = c.target_id LEFT JOIN results r ON r.command_id = c.command_id ${where}`)
      .get(...params) as Row | undefined;
  }

  transitionCommand(commandId: string, state: CommandState, reasonCode?: string, connectionEpoch?: number, result?: BrokerResult): StoredCommand {
    const current = nowIso();
    this.db.transaction(() => {
      const update = this.db.prepare('UPDATE commands SET state = ?, delivered_epoch = COALESCE(?, delivered_epoch), updated_at = ? WHERE command_id = ?')
        .run(state, connectionEpoch ?? null, current, commandId);
      if (update.changes !== 1) throw new Error(`Command not found: ${commandId}`);
      this.db.prepare('INSERT INTO command_events(command_id,state,reason_code,connection_epoch,observed_at) VALUES(?,?,?,?,?)')
        .run(commandId, state, reasonCode ?? null, connectionEpoch ?? null, current);
      if (result) {
        this.db.prepare(`INSERT INTO results(command_id,state,output_json,error_code,created_at) VALUES(?,?,?,?,?)
          ON CONFLICT(command_id) DO UPDATE SET state=excluded.state, output_json=excluded.output_json, error_code=excluded.error_code`)
          .run(commandId, result.state, result.output === undefined ? null : JSON.stringify(result.output), result.errorCode ?? null, current);
      }
    })();
    const updated = this.getCommand(commandId);
    if (!updated) throw new Error(`Command not found: ${commandId}`);
    return updated;
  }

  listRecoverableCommands(at: string): StoredCommand[] {
    const rows = this.db.prepare(`SELECT c.*, t.alias AS target_alias, r.state AS result_state, r.output_json, r.error_code
      FROM commands c JOIN targets t ON t.target_id = c.target_id LEFT JOIN results r ON r.command_id = c.command_id
      WHERE c.state IN ('QUEUED','DELIVERED','ACKED','RUNNING') AND c.deadline_at > ? ORDER BY c.created_at`).all(at) as Row[];
    return rows.map(toCommand);
  }

  countQueuedForTarget(targetId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS value FROM commands WHERE target_id = ? AND state = 'QUEUED'").get(targetId) as Row;
    return Number(row.value);
  }

  hasInFlightForTarget(targetId: string, excludingCommandId?: string): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS value FROM commands
      WHERE target_id = ? AND state IN ('DELIVERED','ACKED','RUNNING') AND (? IS NULL OR command_id <> ?)`)
      .get(targetId, excludingCommandId ?? null, excludingCommandId ?? null) as Row;
    return Number(row.value) > 0;
  }

  trace(event: Omit<StoredTraceEvent, 'observedAt'> & { observedAt?: string }): void {
    this.db.prepare(`INSERT INTO trace_events(run_id,request_id,command_id,target_alias,binding_ref,principal_id,stage,connection_epoch,outcome_code,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      event.runId,
      event.requestId,
      event.commandId,
      event.targetAlias,
      event.bindingRef,
      event.principalId,
      event.stage,
      event.connectionEpoch,
      event.outcomeCode,
      event.observedAt ?? nowIso()
    );
  }

  listTrace(runId: string): StoredTraceEvent[] {
    const rows = this.db.prepare('SELECT * FROM trace_events WHERE run_id = ? ORDER BY trace_id').all(runId) as Row[];
    return rows.map((row) => ({
      runId: String(row.run_id),
      requestId: String(row.request_id),
      commandId: row.command_id === null ? null : String(row.command_id),
      targetAlias: row.target_alias === null ? null : String(row.target_alias),
      bindingRef: row.binding_ref === null ? null : String(row.binding_ref),
      principalId: String(row.principal_id),
      stage: String(row.stage) as StoredTraceEvent['stage'],
      connectionEpoch: row.connection_epoch === null ? null : Number(row.connection_epoch),
      outcomeCode: row.outcome_code === null ? null : String(row.outcome_code),
      observedAt: String(row.observed_at)
    }));
  }

  listCommandsByRunId(runId: string): StoredCommand[] {
    const rows = this.db.prepare(`SELECT c.*, t.alias AS target_alias, r.state AS result_state, r.output_json, r.error_code
      FROM commands c JOIN targets t ON t.target_id = c.target_id LEFT JOIN results r ON r.command_id = c.command_id
      WHERE c.run_id = ? ORDER BY c.created_at`).all(runId) as Row[];
    return rows.map(toCommand);
  }

  audit(eventType: string, context: { principalId?: string; targetAlias?: string; [key: string]: unknown }): void {
    const { principalId, targetAlias, ...safeContext } = context;
    this.db.prepare('INSERT INTO audit_events(event_type,principal_id,target_alias,context_json,observed_at) VALUES(?,?,?,?,?)')
      .run(eventType, principalId ?? null, targetAlias ?? null, JSON.stringify(safeContext), nowIso());
  }
}
