import type {
  LogicalRecoverySnapshot,
  LogicalRepository,
  Page,
  PageQuery,
  StoredCallerSession,
  StoredCapabilitySelection,
  StoredControlRecord,
  StoredEndpoint,
  StoredEndpointConnection,
  StoredLineage,
  StoredLogicalWindow,
  StoredManagedTab,
  StoredStatusObservation,
  StoredWorkspace
} from '../repositories.js';
import type { SqliteDatabase } from './runtime.js';
import type { SQLInputValue } from 'node:sqlite';
import { nowIso, nullableString, pageLimit, parseJson, type Row } from './shared.js';

function toEndpoint(row: Row): StoredEndpoint {
  return {
    endpointRef: String(row.endpoint_ref),
    nickname: String(row.nickname),
    legacyTargetId: nullableString(row.legacy_target_id),
    pairingIdentityHash: nullableString(row.pairing_identity_hash),
    credential: row.credential_json === null ? null : parseJson(row.credential_json),
    lifecycle: String(row.lifecycle) as StoredEndpoint['lifecycle'],
    connectionGeneration: Number(row.connection_generation),
    statusVersion: Number(row.status_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toConnection(row: Row): StoredEndpointConnection {
  return {
    endpointRef: String(row.endpoint_ref),
    connectionGeneration: Number(row.connection_generation),
    connectionRef: String(row.connection_ref),
    transport: String(row.transport),
    protocolVersion: String(row.protocol_version),
    extensionVersion: nullableString(row.extension_version),
    browserProduct: nullableString(row.browser_product),
    browserVersion: nullableString(row.browser_version),
    connectedAt: String(row.connected_at),
    disconnectedAt: nullableString(row.disconnected_at),
    disconnectReason: nullableString(row.disconnect_reason)
  };
}

function toLineage(row: Row): StoredLineage {
  return { lineageRef: String(row.lineage_ref), runtimeName: String(row.runtime_name), createdAt: String(row.created_at) };
}

function toSession(row: Row): StoredCallerSession {
  return {
    sessionRef: String(row.session_ref),
    lineageRef: String(row.lineage_ref),
    parentSessionRef: nullableString(row.parent_session_ref),
    runtimeSessionKeyHash: String(row.runtime_session_key_hash),
    lifecycle: String(row.lifecycle) as StoredCallerSession['lifecycle'],
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    endedAt: nullableString(row.ended_at)
  };
}

function toWindow(row: Row): StoredLogicalWindow {
  return {
    windowRef: String(row.window_ref), endpointRef: String(row.endpoint_ref),
    privateWindowKey: String(row.private_window_key), locatorGeneration: Number(row.locator_generation),
    focused: Boolean(row.focused), eligible: Boolean(row.eligible), lastFocusedAt: nullableString(row.last_focused_at),
    lastObservedAt: String(row.last_observed_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function toWorkspace(row: Row, pauseCauses: string[] = []): StoredWorkspace {
  return {
    workspaceRef: String(row.workspace_ref), endpointRef: String(row.endpoint_ref), windowRef: String(row.window_ref),
    lineageRef: String(row.lineage_ref), ownerSessionRef: String(row.owner_session_ref),
    parentWorkspaceRef: nullableString(row.parent_workspace_ref), groupLabel: String(row.group_label),
    privateGroupKey: nullableString(row.private_group_key), locatorGeneration: Number(row.locator_generation),
    lifecycle: String(row.lifecycle) as StoredWorkspace['lifecycle'], ownerEpoch: Number(row.owner_epoch),
    controlEpoch: Number(row.control_epoch), pauseCauses, createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), endedAt: nullableString(row.ended_at)
  };
}

function toTab(row: Row): StoredManagedTab {
  return {
    tabRef: String(row.tab_ref), workspaceRef: String(row.workspace_ref), endpointRef: String(row.endpoint_ref),
    windowRef: String(row.window_ref), openerTabRef: nullableString(row.opener_tab_ref), privateTabKey: String(row.private_tab_key),
    locatorGeneration: Number(row.locator_generation), attachmentGeneration: Number(row.attachment_generation),
    lifecycle: String(row.lifecycle) as StoredManagedTab['lifecycle'], title: nullableString(row.title), url: nullableString(row.url),
    lastObservedAt: String(row.last_observed_at), replacedByTabRef: nullableString(row.replaced_by_tab_ref),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function toControl(row: Row): StoredControlRecord {
  return {
    controlRef: String(row.control_ref), requestRef: String(row.request_ref), kind: String(row.kind) as StoredControlRecord['kind'],
    scopeType: String(row.scope_type) as StoredControlRecord['scopeType'], scopeRef: String(row.scope_ref),
    controlEpoch: Number(row.control_epoch), state: String(row.state) as StoredControlRecord['state'],
    details: parseJson(row.details_json), createdAt: String(row.created_at), terminalAt: nullableString(row.terminal_at)
  };
}

function toCapability(row: Row): StoredCapabilitySelection {
  return {
    capabilitySelectionRef: String(row.capability_selection_ref), endpointRef: String(row.endpoint_ref),
    connectionGeneration: Number(row.connection_generation), profileVersion: String(row.profile_version),
    browserProduct: nullableString(row.browser_product), browserVersion: nullableString(row.browser_version),
    extensionVersion: nullableString(row.extension_version), methods: parseJson(row.methods_json),
    selectedAt: String(row.selected_at), retiredAt: nullableString(row.retired_at)
  };
}

export class SqliteLogicalRepository implements LogicalRepository {
  constructor(private readonly db: SqliteDatabase) {}

  createEndpoint(input: Parameters<LogicalRepository['createEndpoint']>[0]): StoredEndpoint {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO browser_endpoints(endpoint_ref,nickname,pairing_identity_hash,credential_json,legacy_target_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(input.endpointRef, input.nickname, input.pairingIdentityHash ?? null,
      input.credential === undefined ? null : JSON.stringify(input.credential), input.legacyTargetId ?? null, at, at);
    return this.getEndpoint(input.endpointRef)!;
  }

  getEndpoint(endpointRef: string): StoredEndpoint | null {
    const row = this.db.prepare('SELECT * FROM browser_endpoints WHERE endpoint_ref = ?').get(endpointRef) as Row | undefined;
    return row ? toEndpoint(row) : null;
  }

  getEndpointByNickname(nickname: string): StoredEndpoint | null {
    const row = this.db.prepare('SELECT * FROM browser_endpoints WHERE nickname = ?').get(nickname) as Row | undefined;
    return row ? toEndpoint(row) : null;
  }

  listEndpoints(query: PageQuery & { registeredOnly?: boolean }): Page<StoredEndpoint> {
    const limit = pageLimit(query.limit);
    const rows = this.db.prepare(`SELECT * FROM browser_endpoints WHERE endpoint_ref > ?
      AND (? = 0 OR (connection_generation > 0 AND lifecycle = 'paired')) ORDER BY endpoint_ref LIMIT ?`)
      .all(query.after ?? '', query.registeredOnly ? 1 : 0, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toEndpoint);
    return { items, next: hasMore ? items.at(-1)?.endpointRef ?? null : null };
  }

  getCurrentConnection(endpointRef: string): StoredEndpointConnection | null {
    const row = this.db.prepare(`SELECT * FROM endpoint_connections WHERE endpoint_ref = ? AND disconnected_at IS NULL
      ORDER BY connection_generation DESC LIMIT 1`).get(endpointRef) as Row | undefined;
    return row ? toConnection(row) : null;
  }

  openEndpointConnection(input: Parameters<LogicalRepository['openEndpointConnection']>[0]): StoredEndpointConnection {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const endpoint = this.getEndpoint(input.endpointRef);
      if (!endpoint || endpoint.lifecycle !== 'paired') throw new Error('ENDPOINT_NOT_FOUND');
      const generation = endpoint.connectionGeneration + 1;
      this.db.prepare(`UPDATE endpoint_connections SET disconnected_at = ?, disconnect_reason = 'replaced'
        WHERE endpoint_ref = ? AND disconnected_at IS NULL`).run(at, input.endpointRef);
      const changed = this.db.prepare(`UPDATE browser_endpoints SET connection_generation = ?, status_version = status_version + 1,
        updated_at = ? WHERE endpoint_ref = ? AND connection_generation = ?`).run(generation, at, input.endpointRef, endpoint.connectionGeneration);
      if (changed.changes !== 1) throw new Error('STALE_CONNECTION_GENERATION');
      this.db.prepare(`INSERT INTO endpoint_connections(endpoint_ref,connection_generation,connection_ref,transport,protocol_version,
        extension_version,browser_product,browser_version,connected_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        input.endpointRef, generation, input.connectionRef, input.transport, input.protocolVersion,
        input.extensionVersion ?? null, input.browserProduct ?? null, input.browserVersion ?? null, at);
      return toConnection(this.db.prepare(`SELECT * FROM endpoint_connections WHERE endpoint_ref = ? AND connection_generation = ?`)
        .get(input.endpointRef, generation) as Row);
    })();
  }

  disconnectEndpoint(input: Parameters<LogicalRepository['disconnectEndpoint']>[0]): boolean {
    const at = input.at ?? nowIso();
    return this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE endpoint_connections SET disconnected_at = ?, disconnect_reason = ?
        WHERE endpoint_ref = ? AND connection_generation = ? AND disconnected_at IS NULL`)
        .run(at, input.reason, input.endpointRef, input.connectionGeneration);
      if (result.changes === 1) {
        this.db.prepare(`UPDATE browser_endpoints SET status_version = status_version + 1, updated_at = ?
          WHERE endpoint_ref = ? AND connection_generation = ?`).run(at, input.endpointRef, input.connectionGeneration);
      }
      return result.changes === 1;
    })();
  }

  registerLineage(input: Parameters<LogicalRepository['registerLineage']>[0]): StoredLineage {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO caller_lineages(lineage_ref,runtime_name,created_at) VALUES(?,?,?)
      ON CONFLICT(lineage_ref) DO UPDATE SET runtime_name = excluded.runtime_name`).run(input.lineageRef, input.runtimeName, at);
    return toLineage(this.db.prepare('SELECT * FROM caller_lineages WHERE lineage_ref = ?').get(input.lineageRef) as Row);
  }

  registerSession(input: Parameters<LogicalRepository['registerSession']>[0]): StoredCallerSession {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO caller_sessions(session_ref,lineage_ref,parent_session_ref,runtime_session_key_hash,created_at,last_seen_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(session_ref) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
      .run(input.sessionRef, input.lineageRef, input.parentSessionRef ?? null, input.runtimeSessionKeyHash, at, at);
    return toSession(this.db.prepare('SELECT * FROM caller_sessions WHERE session_ref = ?').get(input.sessionRef) as Row);
  }

  touchSession(sessionRef: string, at = nowIso()): StoredCallerSession | null {
    const result = this.db.prepare(`UPDATE caller_sessions SET last_seen_at = ? WHERE session_ref = ? AND lifecycle = 'active'`).run(at, sessionRef);
    if (result.changes !== 1) return null;
    return toSession(this.db.prepare('SELECT * FROM caller_sessions WHERE session_ref = ?').get(sessionRef) as Row);
  }

  upsertWindow(input: Parameters<LogicalRepository['upsertWindow']>[0]): StoredLogicalWindow {
    const at = input.observedAt ?? nowIso();
    return this.db.transaction(() => {
      if (input.focused) this.db.prepare('UPDATE logical_windows SET focused = 0, updated_at = ? WHERE endpoint_ref = ?').run(at, input.endpointRef);
      this.db.prepare(`INSERT INTO logical_windows(window_ref,endpoint_ref,private_window_key,locator_generation,focused,eligible,last_focused_at,last_observed_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(window_ref) DO UPDATE SET private_window_key=excluded.private_window_key,
        locator_generation=excluded.locator_generation,focused=excluded.focused,eligible=excluded.eligible,
        last_focused_at=CASE WHEN excluded.focused = 1 THEN excluded.last_observed_at ELSE logical_windows.last_focused_at END,
        last_observed_at=excluded.last_observed_at,updated_at=excluded.updated_at`)
        .run(input.windowRef, input.endpointRef, input.privateWindowKey, input.locatorGeneration, Number(input.focused), Number(input.eligible), input.focused ? at : null, at, at, at);
      return toWindow(this.db.prepare('SELECT * FROM logical_windows WHERE window_ref = ?').get(input.windowRef) as Row);
    })();
  }

  markMissingWindows(input: Parameters<LogicalRepository['markMissingWindows']>[0]): void {
    const at = input.at ?? nowIso();
    const observed = [...new Set(input.observedWindowRefs)];
    const exclusion = observed.length === 0
      ? ''
      : ` AND window_ref NOT IN (${observed.map(() => '?').join(',')})`;
    this.db.prepare(`UPDATE logical_windows SET focused = 0, eligible = 0, updated_at = ?
      WHERE endpoint_ref = ?${exclusion}`).run(at, input.endpointRef, ...observed);
  }

  getWindow(windowRef: string): StoredLogicalWindow | null {
    const row = this.db.prepare('SELECT * FROM logical_windows WHERE window_ref = ?').get(windowRef) as Row | undefined;
    return row ? toWindow(row) : null;
  }

  listWindows(endpointRef: string): StoredLogicalWindow[] {
    return (this.db.prepare(`SELECT * FROM logical_windows WHERE endpoint_ref = ? ORDER BY focused DESC,last_focused_at DESC,last_observed_at DESC,window_ref`)
      .all(endpointRef) as Row[]).map(toWindow);
  }

  createWorkspace(input: Parameters<LogicalRepository['createWorkspace']>[0]): StoredWorkspace {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO browser_workspaces(workspace_ref,endpoint_ref,window_ref,lineage_ref,owner_session_ref,parent_workspace_ref,
      group_label,private_group_key,locator_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.workspaceRef, input.endpointRef, input.windowRef, input.lineageRef, input.ownerSessionRef, input.parentWorkspaceRef ?? null,
      input.groupLabel, input.privateGroupKey ?? null, input.locatorGeneration ?? 1, at, at);
    return this.getWorkspace(input.workspaceRef)!;
  }

  addTab(input: Parameters<LogicalRepository['addTab']>[0]): StoredManagedTab {
    const at = input.observedAt ?? nowIso();
    this.db.prepare(`INSERT INTO managed_tabs(tab_ref,workspace_ref,endpoint_ref,window_ref,opener_tab_ref,private_tab_key,
      locator_generation,attachment_generation,title,url,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.tabRef, input.workspaceRef, input.endpointRef, input.windowRef, input.openerTabRef ?? null, input.privateTabKey,
      input.locatorGeneration, input.attachmentGeneration ?? 0, input.title ?? null, input.url ?? null, at, at, at);
    return this.getTab(input.workspaceRef, input.tabRef)!;
  }

  getWorkspace(workspaceRef: string): StoredWorkspace | null {
    const row = this.db.prepare('SELECT * FROM browser_workspaces WHERE workspace_ref = ?').get(workspaceRef) as Row | undefined;
    if (!row) return null;
    const causes = (this.db.prepare(`SELECT cause FROM workspace_pause_causes WHERE workspace_ref = ? AND cleared_at IS NULL ORDER BY cause`)
      .all(workspaceRef) as Row[]).map((item) => String(item.cause));
    return toWorkspace(row, causes);
  }

  listActiveWorkspaces(input: { endpointRef?: string; ownerSessionRef?: string } = {}): StoredWorkspace[] {
    const clauses = [`lifecycle = 'active'`];
    const values: SQLInputValue[] = [];
    if (input.endpointRef) { clauses.push('endpoint_ref = ?'); values.push(input.endpointRef); }
    if (input.ownerSessionRef) { clauses.push('owner_session_ref = ?'); values.push(input.ownerSessionRef); }
    const rows = this.db.prepare(`SELECT * FROM browser_workspaces WHERE ${clauses.join(' AND ')} ORDER BY created_at,workspace_ref`)
      .all(...values) as Row[];
    return rows.map((row) => this.getWorkspace(String(row.workspace_ref))!);
  }

  getTab(workspaceRef: string, tabRef: string): StoredManagedTab | null {
    const row = this.db.prepare('SELECT * FROM managed_tabs WHERE workspace_ref = ? AND tab_ref = ?').get(workspaceRef, tabRef) as Row | undefined;
    return row ? toTab(row) : null;
  }

  listWorkspaceTabs(workspaceRef: string): StoredManagedTab[] {
    return (this.db.prepare('SELECT * FROM managed_tabs WHERE workspace_ref = ? ORDER BY created_at, tab_ref').all(workspaceRef) as Row[]).map(toTab);
  }

  updateWorkspaceLocator(input: Parameters<LogicalRepository['updateWorkspaceLocator']>[0]): StoredWorkspace | null {
    const at = input.at ?? nowIso();
    const result = this.db.prepare(`UPDATE browser_workspaces SET private_group_key = ?, locator_generation = ?, updated_at = ?
      WHERE workspace_ref = ? AND lifecycle = 'active' AND locator_generation = ?`).run(
      input.privateGroupKey, input.newLocatorGeneration, at, input.workspaceRef, input.expectedLocatorGeneration);
    return result.changes === 1 ? this.getWorkspace(input.workspaceRef) : null;
  }

  updateTab(input: Parameters<LogicalRepository['updateTab']>[0]): StoredManagedTab | null {
    const current = this.getTab(input.workspaceRef, input.tabRef);
    if (!current || current.locatorGeneration !== input.expectedLocatorGeneration) return null;
    const at = input.observedAt ?? nowIso();
    const result = this.db.prepare(`UPDATE managed_tabs SET private_tab_key = ?, locator_generation = ?, attachment_generation = ?,
      lifecycle = ?, title = ?, url = ?, replaced_by_tab_ref = ?, last_observed_at = ?, updated_at = ?
      WHERE workspace_ref = ? AND tab_ref = ? AND locator_generation = ?`).run(
      input.privateTabKey === undefined ? current.privateTabKey : input.privateTabKey,
      input.newLocatorGeneration ?? current.locatorGeneration,
      input.attachmentGeneration ?? current.attachmentGeneration,
      input.lifecycle ?? current.lifecycle,
      input.title === undefined ? current.title : input.title,
      input.url === undefined ? current.url : input.url,
      input.replacedByTabRef ?? current.replacedByTabRef,
      at, at, input.workspaceRef, input.tabRef, input.expectedLocatorGeneration);
    return result.changes === 1 ? this.getTab(input.workspaceRef, input.tabRef) : null;
  }

  setWorkspacePauseCause(input: Parameters<LogicalRepository['setWorkspacePauseCause']>[0]): StoredWorkspace {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO workspace_pause_causes(workspace_ref,cause,source_request_ref,recorded_at,cleared_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(workspace_ref,cause) DO UPDATE SET source_request_ref=excluded.source_request_ref,recorded_at=excluded.recorded_at,cleared_at=NULL`)
      .run(input.workspaceRef, input.cause, input.sourceRequestRef ?? null, at);
    this.db.prepare('UPDATE browser_workspaces SET updated_at = ? WHERE workspace_ref = ?').run(at, input.workspaceRef);
    const workspace = this.getWorkspace(input.workspaceRef);
    if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
    return workspace;
  }

  clearWorkspacePauseCause(input: Parameters<LogicalRepository['clearWorkspacePauseCause']>[0]): StoredWorkspace {
    const at = input.at ?? nowIso();
    this.db.prepare(`UPDATE workspace_pause_causes SET cleared_at = ? WHERE workspace_ref = ? AND cause = ? AND cleared_at IS NULL`)
      .run(at, input.workspaceRef, input.cause);
    this.db.prepare('UPDATE browser_workspaces SET updated_at = ? WHERE workspace_ref = ?').run(at, input.workspaceRef);
    const workspace = this.getWorkspace(input.workspaceRef);
    if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
    return workspace;
  }

  takeOverWorkspace(input: Parameters<LogicalRepository['takeOverWorkspace']>[0]): StoredWorkspace | null {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const updated = this.db.prepare(`UPDATE browser_workspaces SET owner_session_ref = ?, lineage_ref = ?, owner_epoch = owner_epoch + 1,
        control_epoch = control_epoch + 1, updated_at = ? WHERE workspace_ref = ? AND lifecycle = 'active'
        AND owner_session_ref = ? AND owner_epoch = ? AND control_epoch = ?`).run(
        input.newOwnerSessionRef, input.newLineageRef, at, input.workspaceRef, input.expectedOwnerSessionRef,
        input.expectedOwnerEpoch, input.expectedControlEpoch);
      if (updated.changes !== 1) return null;
      const current = this.getWorkspace(input.workspaceRef)!;
      this.db.prepare(`UPDATE request_tickets SET authority_session_ref = ?, authority_lineage_ref = ?, accepted_owner_epoch = ?, updated_at = ?
        WHERE workspace_ref = ? AND authority_scope = 'owner' AND closed_at IS NULL`).run(
        input.newOwnerSessionRef, input.newLineageRef, current.ownerEpoch, at, input.workspaceRef);
      return current;
    })();
  }

  claimWorkspaceControl(input: Parameters<LogicalRepository['claimWorkspaceControl']>[0]): StoredWorkspace | null {
    const at = input.at ?? nowIso();
    const updated = this.db.prepare(`UPDATE browser_workspaces SET control_epoch = control_epoch + 1, updated_at = ?
      WHERE workspace_ref = ? AND lifecycle = 'active' AND control_epoch = ?`).run(
      at, input.workspaceRef, input.expectedControlEpoch);
    return updated.changes === 1 ? this.getWorkspace(input.workspaceRef) : null;
  }

  finishWorkspaceTermination(input: Parameters<LogicalRepository['finishWorkspaceTermination']>[0]): StoredWorkspace | null {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const result = this.db.prepare(`UPDATE browser_workspaces SET lifecycle = ?, ended_at = ?, updated_at = ?
        WHERE workspace_ref = ? AND lifecycle = 'active' AND control_epoch = ?`).run(
        input.succeeded ? 'ended' : 'active', input.succeeded ? at : null, at, input.workspaceRef, input.expectedControlEpoch);
      if (result.changes !== 1) return null;
      if (!input.succeeded) this.setWorkspacePauseCause({ workspaceRef: input.workspaceRef, cause: 'termination_failed', at });
      return this.getWorkspace(input.workspaceRef);
    })();
  }

  recordControl(input: Parameters<LogicalRepository['recordControl']>[0]): StoredControlRecord {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO control_records(control_ref,request_ref,kind,scope_type,scope_ref,control_epoch,state,details_json,created_at)
      VALUES(?,?,?,?,?,?,'active',?,?)`).run(input.controlRef, input.requestRef, input.kind, input.scopeType, input.scopeRef,
      input.controlEpoch, JSON.stringify(input.details ?? {}), at);
    return toControl(this.db.prepare('SELECT * FROM control_records WHERE control_ref = ?').get(input.controlRef) as Row);
  }

  finishControl(input: Parameters<LogicalRepository['finishControl']>[0]): StoredControlRecord | null {
    const at = input.at ?? nowIso();
    const result = this.db.prepare(`UPDATE control_records SET state = ?, terminal_at = ? WHERE control_ref = ? AND state = 'active'`)
      .run(input.state, at, input.controlRef);
    if (result.changes !== 1) return null;
    return toControl(this.db.prepare('SELECT * FROM control_records WHERE control_ref = ?').get(input.controlRef) as Row);
  }

  recordCapabilitySelection(input: Parameters<LogicalRepository['recordCapabilitySelection']>[0]): StoredCapabilitySelection {
    const at = input.at ?? nowIso();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE capability_selections SET retired_at = ? WHERE endpoint_ref = ? AND retired_at IS NULL`).run(at, input.endpointRef);
      this.db.prepare(`INSERT INTO capability_selections(capability_selection_ref,endpoint_ref,connection_generation,profile_version,
        browser_product,browser_version,extension_version,methods_json,selected_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        input.capabilitySelectionRef, input.endpointRef, input.connectionGeneration, input.profileVersion,
        input.browserProduct ?? null, input.browserVersion ?? null, input.extensionVersion ?? null, JSON.stringify(input.methods), at);
    })();
    return toCapability(this.db.prepare('SELECT * FROM capability_selections WHERE capability_selection_ref = ?').get(input.capabilitySelectionRef) as Row);
  }

  getCurrentCapability(endpointRef: string): StoredCapabilitySelection | null {
    const row = this.db.prepare(`SELECT * FROM capability_selections WHERE endpoint_ref = ? AND retired_at IS NULL
      ORDER BY selected_at DESC LIMIT 1`).get(endpointRef) as Row | undefined;
    return row ? toCapability(row) : null;
  }

  getActiveEndpointControl(endpointRef: string): StoredControlRecord | null {
    const row = this.db.prepare(`SELECT * FROM control_records WHERE scope_type = 'endpoint' AND scope_ref = ? AND state = 'active'
      ORDER BY control_epoch DESC LIMIT 1`).get(endpointRef) as Row | undefined;
    return row ? toControl(row) : null;
  }

  getEndpointKillState(endpointRef: string): { killed: boolean; sourceRequestRefs: string[] } {
    const rows = this.db.prepare(`SELECT DISTINCT p.source_request_ref FROM workspace_pause_causes p
      JOIN browser_workspaces w ON w.workspace_ref = p.workspace_ref
      WHERE w.endpoint_ref = ? AND w.lifecycle = 'active' AND p.cause = 'endpoint_killed' AND p.cleared_at IS NULL
      ORDER BY p.source_request_ref`).all(endpointRef) as Row[];
    return {
      killed: rows.length > 0,
      sourceRequestRefs: rows.flatMap((row) => row.source_request_ref === null ? [] : [String(row.source_request_ref)])
    };
  }

  recordStatusObservation(input: Parameters<LogicalRepository['recordStatusObservation']>[0]): StoredStatusObservation {
    const at = input.observedAt ?? nowIso();
    const result = this.db.prepare(`INSERT INTO status_observations(subject_type,subject_ref,condition,facts_json,source,source_generation,observed_at)
      VALUES(?,?,?,?,?,?,?)`).run(input.subjectType, input.subjectRef, input.condition, JSON.stringify(input.facts ?? {}), input.source, input.sourceGeneration, at);
    return {
      observationId: Number(result.lastInsertRowid), subjectType: input.subjectType, subjectRef: input.subjectRef,
      condition: input.condition, facts: input.facts ?? {}, source: input.source, sourceGeneration: input.sourceGeneration, observedAt: at
    };
  }

  scanLogicalRecovery(): LogicalRecoverySnapshot {
    const endpoints = (this.db.prepare(`SELECT * FROM browser_endpoints WHERE lifecycle = 'paired' ORDER BY endpoint_ref`).all() as Row[]).map(toEndpoint);
    const liveConnections = (this.db.prepare(`SELECT * FROM endpoint_connections WHERE disconnected_at IS NULL ORDER BY endpoint_ref`).all() as Row[]).map(toConnection);
    const activeSessions = (this.db.prepare(`SELECT * FROM caller_sessions WHERE lifecycle = 'active' ORDER BY created_at`).all() as Row[]).map(toSession);
    const activeWorkspaces = (this.db.prepare(`SELECT * FROM browser_workspaces WHERE lifecycle = 'active' ORDER BY created_at`).all() as Row[])
      .map((row) => this.getWorkspace(String(row.workspace_ref))!);
    const activeTabs = (this.db.prepare(`SELECT * FROM managed_tabs WHERE lifecycle = 'active' ORDER BY created_at`).all() as Row[]).map(toTab);
    const activeControls = (this.db.prepare(`SELECT * FROM control_records WHERE state = 'active' ORDER BY created_at`).all() as Row[]).map(toControl);
    return { endpoints, liveConnections, activeSessions, activeWorkspaces, activeTabs, activeControls };
  }
}
