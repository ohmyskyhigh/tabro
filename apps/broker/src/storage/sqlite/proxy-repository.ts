import type { ProxyBinding } from '../../proxy/types.js';
import type { SqliteDatabase } from './runtime.js';
export interface ProxyRequest { requestRef: string; profileRef: string; principalId: string; bodyHash: string; savedRevision: number | null }
export class SqliteProxyRepository {
  constructor(private readonly db: SqliteDatabase) {}
  transaction<T>(work: () => T): T { return this.db.transaction(work)(); }
  get(profileRef: string): ProxyBinding {
    const row = this.db.prepare('SELECT body_json FROM profile_proxies WHERE profile_ref=?').get(profileRef);
    return row ? JSON.parse(String(row.body_json)) as ProxyBinding : {
      profileRef, revision: 0, proxy: null, port: null, state: 'unmanaged', appliedRevision: null,
      connectionGeneration: null, observedAt: new Date().toISOString(), problemCode: null, exit: null, principalId: null
    };
  }
  all(): ProxyBinding[] { return this.db.prepare('SELECT body_json FROM profile_proxies').all().map(r => JSON.parse(String(r.body_json)) as ProxyBinding); }
  save(value: ProxyBinding): void {
    this.db.prepare('INSERT INTO profile_proxies(profile_ref,body_json,listener_port) VALUES(?,?,?) ON CONFLICT(profile_ref) DO UPDATE SET body_json=excluded.body_json,listener_port=excluded.listener_port')
      .run(value.profileRef, JSON.stringify(value), value.port);
  }
  associate(requestRef: string, profileRef: string, principalId: string, bodyHash: string, key: string | null): void {
    this.db.prepare('INSERT INTO profile_proxy_requests(request_ref,profile_ref,principal_id,body_hash,idempotency_key) VALUES(?,?,?,?,?)').run(requestRef, profileRef, principalId, bodyHash, key);
  }
  private decode(row: Record<string, unknown> | undefined): ProxyRequest | null {
    return row ? { requestRef: String(row.request_ref), profileRef: String(row.profile_ref), principalId: String(row.principal_id), bodyHash: String(row.body_hash), savedRevision: row.saved_revision === null ? null : Number(row.saved_revision) } : null;
  }
  request(ref: string): ProxyRequest | null { return this.decode(this.db.prepare('SELECT * FROM profile_proxy_requests WHERE request_ref=?').get(ref)); }
  reuse(principal: string, key: string): ProxyRequest | null { return this.decode(this.db.prepare('SELECT * FROM profile_proxy_requests WHERE principal_id=? AND idempotency_key=?').get(principal, key)); }
  markSaved(ref: string, revision: number): void { this.db.prepare('UPDATE profile_proxy_requests SET saved_revision=? WHERE request_ref=?').run(revision, ref); }
  busy(profileRef: string, except = '', includeChecks = false): boolean {
    return !!this.db.prepare("SELECT 1 FROM profile_proxy_requests p JOIN request_tickets t USING(request_ref) WHERE p.profile_ref=? AND p.request_ref<>? AND t.state IN ('queued','running') AND (?=1 OR t.tool_name<>'check_browser_proxy') LIMIT 1").get(profileRef, except, includeChecks ? 1 : 0);
  }
}
