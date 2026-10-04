import { createRequire as __tabroCreateRequire } from 'node:module'; const require = __tabroCreateRequire(import.meta.url);

// tools/provision-proxy-credential.ts
import { dirname as dirname2, resolve as resolve3 } from "node:path";
import { readFileSync as readFileSync2 } from "node:fs";

// apps/broker/src/storage/sqlite/database.ts
import { createHash, randomBytes, randomUUID as randomUUID2 } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// apps/broker/src/storage/sqlite/shared.ts
var nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
function parseJson(value) {
  if (typeof value !== "string") throw new Error("Expected JSON string from database.");
  return JSON.parse(value);
}
function nullableString(value) {
  return value === null || value === void 0 ? null : String(value);
}
function nullableNumber(value) {
  return value === null || value === void 0 ? null : Number(value);
}
function pageLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("INVALID_PAGE_LIMIT");
  return limit;
}

// apps/broker/src/storage/sqlite/audit-repository.ts
function toAudit(row) {
  return {
    auditRef: String(row.audit_ref),
    eventType: String(row.event_type),
    actorSessionRef: nullableString(row.actor_session_ref),
    endpointRef: nullableString(row.endpoint_ref),
    workspaceRef: nullableString(row.workspace_ref),
    tabRef: nullableString(row.tab_ref),
    requestRef: nullableString(row.request_ref),
    context: parseJson(row.context_json),
    observedAt: String(row.observed_at)
  };
}
var SqliteAuditRepository = class {
  constructor(db2) {
    this.db = db2;
  }
  db;
  append(input) {
    const at = input.observedAt ?? nowIso();
    this.db.prepare(`INSERT INTO canonical_audit_events(audit_ref,event_type,actor_session_ref,endpoint_ref,workspace_ref,tab_ref,request_ref,context_json,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      input.auditRef,
      input.eventType,
      input.actorSessionRef ?? null,
      input.endpointRef ?? null,
      input.workspaceRef ?? null,
      input.tabRef ?? null,
      input.requestRef ?? null,
      JSON.stringify(input.context ?? {}),
      at
    );
    return toAudit(this.db.prepare("SELECT * FROM canonical_audit_events WHERE audit_ref = ?").get(input.auditRef));
  }
  list(input) {
    const limit = pageLimit(input.page.limit);
    const clauses = ["audit_ref > ?"];
    const values = [input.page.after ?? ""];
    if (input.requestRef) {
      clauses.push("request_ref = ?");
      values.push(input.requestRef);
    }
    if (input.workspaceRef) {
      clauses.push("workspace_ref = ?");
      values.push(input.workspaceRef);
    }
    values.push(limit + 1);
    const rows = this.db.prepare(`SELECT * FROM canonical_audit_events WHERE ${clauses.join(" AND ")} ORDER BY audit_ref LIMIT ?`).all(...values);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toAudit);
    return { items, next: hasMore ? items.at(-1)?.auditRef ?? null : null };
  }
};

// apps/broker/src/storage/sqlite/event-repository.ts
function toStream(row) {
  return {
    streamRef: String(row.stream_ref),
    tabRef: String(row.tab_ref),
    streamGeneration: Number(row.stream_generation),
    initialCursorRef: String(row.initial_cursor_ref),
    baseline: parseJson(row.baseline_json),
    nextSequence: Number(row.next_sequence),
    state: String(row.state),
    createdAt: String(row.created_at),
    endedAt: nullableString(row.ended_at)
  };
}
function toCursor(row) {
  return {
    cursorRef: String(row.cursor_ref),
    streamRef: String(row.stream_ref),
    sequence: Number(row.sequence),
    queryHash: String(row.query_hash),
    ownerEpoch: Number(row.owner_epoch),
    issuedAt: String(row.issued_at),
    expiresAt: nullableString(row.expires_at)
  };
}
function toEvent(row) {
  return {
    streamRef: String(row.stream_ref),
    sequence: Number(row.sequence),
    method: String(row.method),
    params: parseJson(row.params_json),
    connectionGeneration: Number(row.connection_generation),
    observedAt: String(row.observed_at)
  };
}
var SqliteEventRepository = class {
  constructor(db2) {
    this.db = db2;
  }
  db;
  createStream(input) {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const generationRow = this.db.prepare("SELECT COALESCE(MAX(stream_generation),0) AS value FROM event_streams WHERE tab_ref = ?").get(input.tabRef);
      const streamGeneration = Number(generationRow.value) + 1;
      this.db.prepare(`INSERT INTO event_streams(stream_ref,tab_ref,stream_generation,initial_cursor_ref,baseline_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(input.streamRef, input.tabRef, streamGeneration, input.initialCursorRef, JSON.stringify(input.baseline), at);
      this.db.prepare(`INSERT INTO event_cursors(cursor_ref,stream_ref,sequence,query_hash,owner_epoch,issued_at,expires_at)
        VALUES(?,?,0,?,?,?,?)`).run(input.initialCursorRef, input.streamRef, input.queryHash, input.ownerEpoch, at, input.cursorExpiresAt ?? null);
      return this.getStreamAndCursor(input.streamRef, input.initialCursorRef);
    })();
  }
  getStreamAndCursor(streamRef, cursorRef) {
    const stream = this.db.prepare("SELECT * FROM event_streams WHERE stream_ref = ?").get(streamRef);
    const cursor = this.db.prepare("SELECT * FROM event_cursors WHERE cursor_ref = ?").get(cursorRef);
    if (!stream || !cursor) throw new Error("EVENT_STREAM_NOT_FOUND");
    return { stream: toStream(stream), cursor: toCursor(cursor) };
  }
  appendEvent(input) {
    return this.db.transaction(() => {
      const at = input.observedAt ?? nowIso();
      const row = this.db.prepare(`SELECT * FROM event_streams WHERE stream_ref = ? AND state = 'active'`).get(input.streamRef);
      if (!row) throw new Error("EVENT_STREAM_NOT_ACTIVE");
      const sequence = Number(row.next_sequence);
      this.db.prepare(`INSERT INTO cdp_events(stream_ref,sequence,method,params_json,connection_generation,observed_at)
        VALUES(?,?,?,?,?,?)`).run(input.streamRef, sequence, input.method, JSON.stringify(input.params), input.connectionGeneration, at);
      this.db.prepare(`INSERT INTO event_cursors(cursor_ref,stream_ref,sequence,query_hash,owner_epoch,issued_at,expires_at)
        VALUES(?,?,?,?,?,?,?)`).run(input.cursorRef, input.streamRef, sequence, input.queryHash, input.ownerEpoch, at, input.cursorExpiresAt ?? null);
      this.db.prepare("UPDATE event_streams SET next_sequence = next_sequence + 1 WHERE stream_ref = ?").run(input.streamRef);
      const event = toEvent(this.db.prepare("SELECT * FROM cdp_events WHERE stream_ref = ? AND sequence = ?").get(input.streamRef, sequence));
      const cursor = toCursor(this.db.prepare("SELECT * FROM event_cursors WHERE cursor_ref = ?").get(input.cursorRef));
      return { event, cursor };
    })();
  }
  readEvents(input) {
    const at = input.at ?? nowIso();
    const cursorRow = this.db.prepare(`SELECT * FROM event_cursors WHERE cursor_ref = ? AND query_hash = ? AND owner_epoch = ?
      AND (expires_at IS NULL OR expires_at > ?)`).get(input.cursorRef, input.queryHash, input.ownerEpoch, at);
    if (!cursorRow) return null;
    const cursor = toCursor(cursorRow);
    const streamRow = this.db.prepare("SELECT * FROM event_streams WHERE stream_ref = ?").get(cursor.streamRef);
    if (!streamRow) return null;
    const limit = pageLimit(input.limit);
    const events = this.db.prepare(`SELECT * FROM cdp_events WHERE stream_ref = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(cursor.streamRef, cursor.sequence, limit).map(toEvent);
    let nextCursor = cursor;
    const last = events.at(-1);
    if (last) {
      const nextRow = this.db.prepare(`SELECT * FROM event_cursors WHERE stream_ref = ? AND sequence = ? AND query_hash = ? AND owner_epoch = ?`).get(cursor.streamRef, last.sequence, input.queryHash, input.ownerEpoch);
      if (!nextRow) throw new Error("EVENT_CURSOR_MISSING");
      nextCursor = toCursor(nextRow);
    }
    return { events, cursor: nextCursor, stream: toStream(streamRow) };
  }
  replaceStreamBaseline(input) {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      this.db.prepare(`UPDATE event_streams SET state = 'replaced', ended_at = ? WHERE tab_ref = ? AND state = 'active'`).run(at, input.tabRef);
      return this.createStream(input);
    })();
  }
  scanEventRecovery() {
    const streams = this.db.prepare(`SELECT * FROM event_streams WHERE state = 'active' ORDER BY tab_ref`).all().map(toStream);
    return { streams };
  }
};

// apps/broker/src/storage/sqlite/logical-repository.ts
function toEndpoint(row) {
  return {
    endpointRef: String(row.endpoint_ref),
    nickname: String(row.nickname),
    legacyTargetId: nullableString(row.legacy_target_id),
    pairingIdentityHash: nullableString(row.pairing_identity_hash),
    credential: row.credential_json === null ? null : parseJson(row.credential_json),
    lifecycle: String(row.lifecycle),
    connectionGeneration: Number(row.connection_generation),
    statusVersion: Number(row.status_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
function toConnection(row) {
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
function toLineage(row) {
  return { lineageRef: String(row.lineage_ref), runtimeName: String(row.runtime_name), createdAt: String(row.created_at) };
}
function toSession(row) {
  return {
    sessionRef: String(row.session_ref),
    lineageRef: String(row.lineage_ref),
    parentSessionRef: nullableString(row.parent_session_ref),
    runtimeSessionKeyHash: String(row.runtime_session_key_hash),
    lifecycle: String(row.lifecycle),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    endedAt: nullableString(row.ended_at)
  };
}
function toWindow(row) {
  return {
    windowRef: String(row.window_ref),
    endpointRef: String(row.endpoint_ref),
    privateWindowKey: String(row.private_window_key),
    locatorGeneration: Number(row.locator_generation),
    focused: Boolean(row.focused),
    eligible: Boolean(row.eligible),
    lastFocusedAt: nullableString(row.last_focused_at),
    lastObservedAt: String(row.last_observed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
function toWorkspace(row, pauseCauses = []) {
  return {
    workspaceRef: String(row.workspace_ref),
    endpointRef: String(row.endpoint_ref),
    windowRef: String(row.window_ref),
    lineageRef: String(row.lineage_ref),
    ownerSessionRef: String(row.owner_session_ref),
    parentWorkspaceRef: nullableString(row.parent_workspace_ref),
    groupLabel: String(row.group_label),
    privateGroupKey: nullableString(row.private_group_key),
    locatorGeneration: Number(row.locator_generation),
    lifecycle: String(row.lifecycle),
    ownerEpoch: Number(row.owner_epoch),
    controlEpoch: Number(row.control_epoch),
    pauseCauses,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    endedAt: nullableString(row.ended_at)
  };
}
function toTab(row) {
  return {
    tabRef: String(row.tab_ref),
    workspaceRef: String(row.workspace_ref),
    endpointRef: String(row.endpoint_ref),
    windowRef: String(row.window_ref),
    openerTabRef: nullableString(row.opener_tab_ref),
    privateTabKey: String(row.private_tab_key),
    locatorGeneration: Number(row.locator_generation),
    attachmentGeneration: Number(row.attachment_generation),
    lifecycle: String(row.lifecycle),
    title: nullableString(row.title),
    url: nullableString(row.url),
    lastObservedAt: String(row.last_observed_at),
    replacedByTabRef: nullableString(row.replaced_by_tab_ref),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
function toControl(row) {
  return {
    controlRef: String(row.control_ref),
    requestRef: String(row.request_ref),
    kind: String(row.kind),
    scopeType: String(row.scope_type),
    scopeRef: String(row.scope_ref),
    controlEpoch: Number(row.control_epoch),
    state: String(row.state),
    details: parseJson(row.details_json),
    createdAt: String(row.created_at),
    terminalAt: nullableString(row.terminal_at)
  };
}
function toCapability(row) {
  return {
    capabilitySelectionRef: String(row.capability_selection_ref),
    endpointRef: String(row.endpoint_ref),
    connectionGeneration: Number(row.connection_generation),
    profileVersion: String(row.profile_version),
    browserProduct: nullableString(row.browser_product),
    browserVersion: nullableString(row.browser_version),
    extensionVersion: nullableString(row.extension_version),
    methods: parseJson(row.methods_json),
    selectedAt: String(row.selected_at),
    retiredAt: nullableString(row.retired_at)
  };
}
var SqliteLogicalRepository = class {
  constructor(db2) {
    this.db = db2;
  }
  db;
  createEndpoint(input) {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO browser_endpoints(endpoint_ref,nickname,pairing_identity_hash,credential_json,legacy_target_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(
      input.endpointRef,
      input.nickname,
      input.pairingIdentityHash ?? null,
      input.credential === void 0 ? null : JSON.stringify(input.credential),
      input.legacyTargetId ?? null,
      at,
      at
    );
    return this.getEndpoint(input.endpointRef);
  }
  getEndpoint(endpointRef) {
    const row = this.db.prepare("SELECT * FROM browser_endpoints WHERE endpoint_ref = ?").get(endpointRef);
    return row ? toEndpoint(row) : null;
  }
  getEndpointByNickname(nickname) {
    const row = this.db.prepare("SELECT * FROM browser_endpoints WHERE nickname = ?").get(nickname);
    return row ? toEndpoint(row) : null;
  }
  listEndpoints(query) {
    const limit = pageLimit(query.limit);
    const rows = this.db.prepare(`SELECT * FROM browser_endpoints WHERE endpoint_ref > ?
      AND (? = 0 OR (connection_generation > 0 AND lifecycle = 'paired')) ORDER BY endpoint_ref LIMIT ?`).all(query.after ?? "", query.registeredOnly ? 1 : 0, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toEndpoint);
    return { items, next: hasMore ? items.at(-1)?.endpointRef ?? null : null };
  }
  getCurrentConnection(endpointRef) {
    const row = this.db.prepare(`SELECT * FROM endpoint_connections WHERE endpoint_ref = ? AND disconnected_at IS NULL
      ORDER BY connection_generation DESC LIMIT 1`).get(endpointRef);
    return row ? toConnection(row) : null;
  }
  openEndpointConnection(input) {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const endpoint = this.getEndpoint(input.endpointRef);
      if (!endpoint || endpoint.lifecycle !== "paired") throw new Error("ENDPOINT_NOT_FOUND");
      const generation = endpoint.connectionGeneration + 1;
      this.db.prepare(`UPDATE endpoint_connections SET disconnected_at = ?, disconnect_reason = 'replaced'
        WHERE endpoint_ref = ? AND disconnected_at IS NULL`).run(at, input.endpointRef);
      const changed = this.db.prepare(`UPDATE browser_endpoints SET connection_generation = ?, status_version = status_version + 1,
        updated_at = ? WHERE endpoint_ref = ? AND connection_generation = ?`).run(generation, at, input.endpointRef, endpoint.connectionGeneration);
      if (changed.changes !== 1) throw new Error("STALE_CONNECTION_GENERATION");
      this.db.prepare(`INSERT INTO endpoint_connections(endpoint_ref,connection_generation,connection_ref,transport,protocol_version,
        extension_version,browser_product,browser_version,connected_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        input.endpointRef,
        generation,
        input.connectionRef,
        input.transport,
        input.protocolVersion,
        input.extensionVersion ?? null,
        input.browserProduct ?? null,
        input.browserVersion ?? null,
        at
      );
      return toConnection(this.db.prepare(`SELECT * FROM endpoint_connections WHERE endpoint_ref = ? AND connection_generation = ?`).get(input.endpointRef, generation));
    })();
  }
  disconnectEndpoint(input) {
    const at = input.at ?? nowIso();
    return this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE endpoint_connections SET disconnected_at = ?, disconnect_reason = ?
        WHERE endpoint_ref = ? AND connection_generation = ? AND disconnected_at IS NULL`).run(at, input.reason, input.endpointRef, input.connectionGeneration);
      if (result.changes === 1) {
        this.db.prepare(`UPDATE browser_endpoints SET status_version = status_version + 1, updated_at = ?
          WHERE endpoint_ref = ? AND connection_generation = ?`).run(at, input.endpointRef, input.connectionGeneration);
      }
      return result.changes === 1;
    })();
  }
  registerLineage(input) {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO caller_lineages(lineage_ref,runtime_name,created_at) VALUES(?,?,?)
      ON CONFLICT(lineage_ref) DO UPDATE SET runtime_name = excluded.runtime_name`).run(input.lineageRef, input.runtimeName, at);
    return toLineage(this.db.prepare("SELECT * FROM caller_lineages WHERE lineage_ref = ?").get(input.lineageRef));
  }
  registerSession(input) {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO caller_sessions(session_ref,lineage_ref,parent_session_ref,runtime_session_key_hash,created_at,last_seen_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(session_ref) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(input.sessionRef, input.lineageRef, input.parentSessionRef ?? null, input.runtimeSessionKeyHash, at, at);
    return toSession(this.db.prepare("SELECT * FROM caller_sessions WHERE session_ref = ?").get(input.sessionRef));
  }
  touchSession(sessionRef, at = nowIso()) {
    const result = this.db.prepare(`UPDATE caller_sessions SET last_seen_at = ? WHERE session_ref = ? AND lifecycle = 'active'`).run(at, sessionRef);
    if (result.changes !== 1) return null;
    return toSession(this.db.prepare("SELECT * FROM caller_sessions WHERE session_ref = ?").get(sessionRef));
  }
  upsertWindow(input) {
    const at = input.observedAt ?? nowIso();
    return this.db.transaction(() => {
      if (input.focused) this.db.prepare("UPDATE logical_windows SET focused = 0, updated_at = ? WHERE endpoint_ref = ?").run(at, input.endpointRef);
      this.db.prepare(`INSERT INTO logical_windows(window_ref,endpoint_ref,private_window_key,locator_generation,focused,eligible,last_focused_at,last_observed_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(window_ref) DO UPDATE SET private_window_key=excluded.private_window_key,
        locator_generation=excluded.locator_generation,focused=excluded.focused,eligible=excluded.eligible,
        last_focused_at=CASE WHEN excluded.focused = 1 THEN excluded.last_observed_at ELSE logical_windows.last_focused_at END,
        last_observed_at=excluded.last_observed_at,updated_at=excluded.updated_at`).run(input.windowRef, input.endpointRef, input.privateWindowKey, input.locatorGeneration, Number(input.focused), Number(input.eligible), input.focused ? at : null, at, at, at);
      return toWindow(this.db.prepare("SELECT * FROM logical_windows WHERE window_ref = ?").get(input.windowRef));
    })();
  }
  markMissingWindows(input) {
    const at = input.at ?? nowIso();
    const observed = [...new Set(input.observedWindowRefs)];
    const exclusion = observed.length === 0 ? "" : ` AND window_ref NOT IN (${observed.map(() => "?").join(",")})`;
    this.db.prepare(`UPDATE logical_windows SET focused = 0, eligible = 0, updated_at = ?
      WHERE endpoint_ref = ?${exclusion}`).run(at, input.endpointRef, ...observed);
  }
  getWindow(windowRef) {
    const row = this.db.prepare("SELECT * FROM logical_windows WHERE window_ref = ?").get(windowRef);
    return row ? toWindow(row) : null;
  }
  listWindows(endpointRef) {
    return this.db.prepare(`SELECT * FROM logical_windows WHERE endpoint_ref = ? ORDER BY focused DESC,last_focused_at DESC,last_observed_at DESC,window_ref`).all(endpointRef).map(toWindow);
  }
  createWorkspace(input) {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO browser_workspaces(workspace_ref,endpoint_ref,window_ref,lineage_ref,owner_session_ref,parent_workspace_ref,
      group_label,private_group_key,locator_generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.workspaceRef,
      input.endpointRef,
      input.windowRef,
      input.lineageRef,
      input.ownerSessionRef,
      input.parentWorkspaceRef ?? null,
      input.groupLabel,
      input.privateGroupKey ?? null,
      input.locatorGeneration ?? 1,
      at,
      at
    );
    return this.getWorkspace(input.workspaceRef);
  }
  addTab(input) {
    const at = input.observedAt ?? nowIso();
    this.db.prepare(`INSERT INTO managed_tabs(tab_ref,workspace_ref,endpoint_ref,window_ref,opener_tab_ref,private_tab_key,
      locator_generation,attachment_generation,title,url,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.tabRef,
      input.workspaceRef,
      input.endpointRef,
      input.windowRef,
      input.openerTabRef ?? null,
      input.privateTabKey,
      input.locatorGeneration,
      input.attachmentGeneration ?? 0,
      input.title ?? null,
      input.url ?? null,
      at,
      at,
      at
    );
    return this.getTab(input.workspaceRef, input.tabRef);
  }
  getWorkspace(workspaceRef) {
    const row = this.db.prepare("SELECT * FROM browser_workspaces WHERE workspace_ref = ?").get(workspaceRef);
    if (!row) return null;
    const causes = this.db.prepare(`SELECT cause FROM workspace_pause_causes WHERE workspace_ref = ? AND cleared_at IS NULL ORDER BY cause`).all(workspaceRef).map((item) => String(item.cause));
    return toWorkspace(row, causes);
  }
  listActiveWorkspaces(input = {}) {
    const clauses = [`lifecycle = 'active'`];
    const values = [];
    if (input.endpointRef) {
      clauses.push("endpoint_ref = ?");
      values.push(input.endpointRef);
    }
    if (input.ownerSessionRef) {
      clauses.push("owner_session_ref = ?");
      values.push(input.ownerSessionRef);
    }
    const rows = this.db.prepare(`SELECT * FROM browser_workspaces WHERE ${clauses.join(" AND ")} ORDER BY created_at,workspace_ref`).all(...values);
    return rows.map((row) => this.getWorkspace(String(row.workspace_ref)));
  }
  getTab(workspaceRef, tabRef) {
    const row = this.db.prepare("SELECT * FROM managed_tabs WHERE workspace_ref = ? AND tab_ref = ?").get(workspaceRef, tabRef);
    return row ? toTab(row) : null;
  }
  listWorkspaceTabs(workspaceRef) {
    return this.db.prepare("SELECT * FROM managed_tabs WHERE workspace_ref = ? ORDER BY created_at, tab_ref").all(workspaceRef).map(toTab);
  }
  updateWorkspaceLocator(input) {
    const at = input.at ?? nowIso();
    const result = this.db.prepare(`UPDATE browser_workspaces SET private_group_key = ?, locator_generation = ?, updated_at = ?
      WHERE workspace_ref = ? AND lifecycle = 'active' AND locator_generation = ?`).run(
      input.privateGroupKey,
      input.newLocatorGeneration,
      at,
      input.workspaceRef,
      input.expectedLocatorGeneration
    );
    return result.changes === 1 ? this.getWorkspace(input.workspaceRef) : null;
  }
  updateTab(input) {
    const current = this.getTab(input.workspaceRef, input.tabRef);
    if (!current || current.locatorGeneration !== input.expectedLocatorGeneration) return null;
    const at = input.observedAt ?? nowIso();
    const result = this.db.prepare(`UPDATE managed_tabs SET private_tab_key = ?, locator_generation = ?, attachment_generation = ?,
      lifecycle = ?, title = ?, url = ?, replaced_by_tab_ref = ?, last_observed_at = ?, updated_at = ?
      WHERE workspace_ref = ? AND tab_ref = ? AND locator_generation = ?`).run(
      input.privateTabKey === void 0 ? current.privateTabKey : input.privateTabKey,
      input.newLocatorGeneration ?? current.locatorGeneration,
      input.attachmentGeneration ?? current.attachmentGeneration,
      input.lifecycle ?? current.lifecycle,
      input.title === void 0 ? current.title : input.title,
      input.url === void 0 ? current.url : input.url,
      input.replacedByTabRef ?? current.replacedByTabRef,
      at,
      at,
      input.workspaceRef,
      input.tabRef,
      input.expectedLocatorGeneration
    );
    return result.changes === 1 ? this.getTab(input.workspaceRef, input.tabRef) : null;
  }
  setWorkspacePauseCause(input) {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO workspace_pause_causes(workspace_ref,cause,source_request_ref,recorded_at,cleared_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(workspace_ref,cause) DO UPDATE SET source_request_ref=excluded.source_request_ref,recorded_at=excluded.recorded_at,cleared_at=NULL`).run(input.workspaceRef, input.cause, input.sourceRequestRef ?? null, at);
    this.db.prepare("UPDATE browser_workspaces SET updated_at = ? WHERE workspace_ref = ?").run(at, input.workspaceRef);
    const workspace = this.getWorkspace(input.workspaceRef);
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
    return workspace;
  }
  clearWorkspacePauseCause(input) {
    const at = input.at ?? nowIso();
    this.db.prepare(`UPDATE workspace_pause_causes SET cleared_at = ? WHERE workspace_ref = ? AND cause = ? AND cleared_at IS NULL`).run(at, input.workspaceRef, input.cause);
    this.db.prepare("UPDATE browser_workspaces SET updated_at = ? WHERE workspace_ref = ?").run(at, input.workspaceRef);
    const workspace = this.getWorkspace(input.workspaceRef);
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
    return workspace;
  }
  takeOverWorkspace(input) {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const updated = this.db.prepare(`UPDATE browser_workspaces SET owner_session_ref = ?, lineage_ref = ?, owner_epoch = owner_epoch + 1,
        control_epoch = control_epoch + 1, updated_at = ? WHERE workspace_ref = ? AND lifecycle = 'active'
        AND owner_session_ref = ? AND owner_epoch = ? AND control_epoch = ?`).run(
        input.newOwnerSessionRef,
        input.newLineageRef,
        at,
        input.workspaceRef,
        input.expectedOwnerSessionRef,
        input.expectedOwnerEpoch,
        input.expectedControlEpoch
      );
      if (updated.changes !== 1) return null;
      const current = this.getWorkspace(input.workspaceRef);
      this.db.prepare(`UPDATE request_tickets SET authority_session_ref = ?, authority_lineage_ref = ?, accepted_owner_epoch = ?, updated_at = ?
        WHERE workspace_ref = ? AND authority_scope = 'owner' AND closed_at IS NULL`).run(
        input.newOwnerSessionRef,
        input.newLineageRef,
        current.ownerEpoch,
        at,
        input.workspaceRef
      );
      return current;
    })();
  }
  claimWorkspaceControl(input) {
    const at = input.at ?? nowIso();
    const updated = this.db.prepare(`UPDATE browser_workspaces SET control_epoch = control_epoch + 1, updated_at = ?
      WHERE workspace_ref = ? AND lifecycle = 'active' AND control_epoch = ?`).run(
      at,
      input.workspaceRef,
      input.expectedControlEpoch
    );
    return updated.changes === 1 ? this.getWorkspace(input.workspaceRef) : null;
  }
  finishWorkspaceTermination(input) {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const result = this.db.prepare(`UPDATE browser_workspaces SET lifecycle = ?, ended_at = ?, updated_at = ?
        WHERE workspace_ref = ? AND lifecycle = 'active' AND control_epoch = ?`).run(
        input.succeeded ? "ended" : "active",
        input.succeeded ? at : null,
        at,
        input.workspaceRef,
        input.expectedControlEpoch
      );
      if (result.changes !== 1) return null;
      if (!input.succeeded) this.setWorkspacePauseCause({ workspaceRef: input.workspaceRef, cause: "termination_failed", at });
      return this.getWorkspace(input.workspaceRef);
    })();
  }
  recordControl(input) {
    const at = input.at ?? nowIso();
    this.db.prepare(`INSERT INTO control_records(control_ref,request_ref,kind,scope_type,scope_ref,control_epoch,state,details_json,created_at)
      VALUES(?,?,?,?,?,?,'active',?,?)`).run(
      input.controlRef,
      input.requestRef,
      input.kind,
      input.scopeType,
      input.scopeRef,
      input.controlEpoch,
      JSON.stringify(input.details ?? {}),
      at
    );
    return toControl(this.db.prepare("SELECT * FROM control_records WHERE control_ref = ?").get(input.controlRef));
  }
  finishControl(input) {
    const at = input.at ?? nowIso();
    const result = this.db.prepare(`UPDATE control_records SET state = ?, terminal_at = ? WHERE control_ref = ? AND state = 'active'`).run(input.state, at, input.controlRef);
    if (result.changes !== 1) return null;
    return toControl(this.db.prepare("SELECT * FROM control_records WHERE control_ref = ?").get(input.controlRef));
  }
  recordCapabilitySelection(input) {
    const at = input.at ?? nowIso();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE capability_selections SET retired_at = ? WHERE endpoint_ref = ? AND retired_at IS NULL`).run(at, input.endpointRef);
      this.db.prepare(`INSERT INTO capability_selections(capability_selection_ref,endpoint_ref,connection_generation,profile_version,
        browser_product,browser_version,extension_version,methods_json,selected_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        input.capabilitySelectionRef,
        input.endpointRef,
        input.connectionGeneration,
        input.profileVersion,
        input.browserProduct ?? null,
        input.browserVersion ?? null,
        input.extensionVersion ?? null,
        JSON.stringify(input.methods),
        at
      );
    })();
    return toCapability(this.db.prepare("SELECT * FROM capability_selections WHERE capability_selection_ref = ?").get(input.capabilitySelectionRef));
  }
  getCurrentCapability(endpointRef) {
    const row = this.db.prepare(`SELECT * FROM capability_selections WHERE endpoint_ref = ? AND retired_at IS NULL
      ORDER BY selected_at DESC LIMIT 1`).get(endpointRef);
    return row ? toCapability(row) : null;
  }
  getActiveEndpointControl(endpointRef) {
    const row = this.db.prepare(`SELECT * FROM control_records WHERE scope_type = 'endpoint' AND scope_ref = ? AND state = 'active'
      ORDER BY control_epoch DESC LIMIT 1`).get(endpointRef);
    return row ? toControl(row) : null;
  }
  getEndpointKillState(endpointRef) {
    const rows = this.db.prepare(`SELECT DISTINCT p.source_request_ref FROM workspace_pause_causes p
      JOIN browser_workspaces w ON w.workspace_ref = p.workspace_ref
      WHERE w.endpoint_ref = ? AND w.lifecycle = 'active' AND p.cause = 'endpoint_killed' AND p.cleared_at IS NULL
      ORDER BY p.source_request_ref`).all(endpointRef);
    return {
      killed: rows.length > 0,
      sourceRequestRefs: rows.flatMap((row) => row.source_request_ref === null ? [] : [String(row.source_request_ref)])
    };
  }
  recordStatusObservation(input) {
    const at = input.observedAt ?? nowIso();
    const result = this.db.prepare(`INSERT INTO status_observations(subject_type,subject_ref,condition,facts_json,source,source_generation,observed_at)
      VALUES(?,?,?,?,?,?,?)`).run(input.subjectType, input.subjectRef, input.condition, JSON.stringify(input.facts ?? {}), input.source, input.sourceGeneration, at);
    return {
      observationId: Number(result.lastInsertRowid),
      subjectType: input.subjectType,
      subjectRef: input.subjectRef,
      condition: input.condition,
      facts: input.facts ?? {},
      source: input.source,
      sourceGeneration: input.sourceGeneration,
      observedAt: at
    };
  }
  scanLogicalRecovery() {
    const endpoints = this.db.prepare(`SELECT * FROM browser_endpoints WHERE lifecycle = 'paired' ORDER BY endpoint_ref`).all().map(toEndpoint);
    const liveConnections = this.db.prepare(`SELECT * FROM endpoint_connections WHERE disconnected_at IS NULL ORDER BY endpoint_ref`).all().map(toConnection);
    const activeSessions = this.db.prepare(`SELECT * FROM caller_sessions WHERE lifecycle = 'active' ORDER BY created_at`).all().map(toSession);
    const activeWorkspaces = this.db.prepare(`SELECT * FROM browser_workspaces WHERE lifecycle = 'active' ORDER BY created_at`).all().map((row) => this.getWorkspace(String(row.workspace_ref)));
    const activeTabs = this.db.prepare(`SELECT * FROM managed_tabs WHERE lifecycle = 'active' ORDER BY created_at`).all().map(toTab);
    const activeControls = this.db.prepare(`SELECT * FROM control_records WHERE state = 'active' ORDER BY created_at`).all().map(toControl);
    return { endpoints, liveConnections, activeSessions, activeWorkspaces, activeTabs, activeControls };
  }
};

// apps/broker/src/storage/sqlite/request-repository.ts
function toRequest(row) {
  return {
    requestRef: String(row.request_ref),
    toolName: String(row.tool_name),
    requesterSessionRef: String(row.requester_session_ref),
    authorityScope: String(row.authority_scope),
    authoritySessionRef: String(row.authority_session_ref),
    authorityLineageRef: String(row.authority_lineage_ref),
    endpointRef: nullableString(row.endpoint_ref),
    workspaceRef: nullableString(row.workspace_ref),
    tabRef: nullableString(row.tab_ref),
    acceptedOwnerEpoch: nullableNumber(row.accepted_owner_epoch),
    normalizedBody: parseJson(row.normalized_body_json),
    state: String(row.state),
    phase: String(row.phase),
    checkpoint: parseJson(row.checkpoint_json),
    pauseCondition: nullableString(row.pause_condition),
    problem: row.problem_json === null ? null : parseJson(row.problem_json),
    result: row.result_json === null ? null : parseJson(row.result_json),
    effectMayHaveOccurred: Boolean(row.effect_may_have_occurred),
    acknowledgementState: String(row.acknowledgement_state),
    acknowledgedAt: nullableString(row.acknowledged_at),
    publiclyVisible: Boolean(row.publicly_visible),
    lanePosition: nullableNumber(row.lane_position),
    claimGeneration: Number(row.claim_generation),
    claimedBy: nullableString(row.claimed_by),
    claimExpiresAt: nullableString(row.claim_expires_at),
    acceptedAt: String(row.accepted_at),
    updatedAt: String(row.updated_at),
    terminalAt: nullableString(row.terminal_at),
    closedAt: nullableString(row.closed_at),
    resolutionOfRequestRef: nullableString(row.resolution_of_request_ref)
  };
}
function toAttempt(row) {
  return {
    attemptRef: String(row.attempt_ref),
    requestRef: String(row.request_ref),
    attemptNumber: Number(row.attempt_number),
    endpointRef: String(row.endpoint_ref),
    connectionGeneration: Number(row.connection_generation),
    locatorGeneration: nullableNumber(row.locator_generation),
    attachmentGeneration: nullableNumber(row.attachment_generation),
    privateMessageRef: nullableString(row.private_message_ref),
    state: String(row.state),
    outcome: row.outcome_json === null ? null : parseJson(row.outcome_json),
    effectClassification: nullableString(row.effect_classification),
    preparedAt: String(row.prepared_at),
    dispatchedAt: nullableString(row.dispatched_at),
    completedAt: nullableString(row.completed_at)
  };
}
function toLane(row) {
  return {
    workspaceRef: String(row.workspace_ref),
    tabRef: String(row.tab_ref),
    nextPosition: Number(row.next_position),
    headRequestRef: nullableString(row.head_request_ref),
    laneGeneration: Number(row.lane_generation),
    updatedAt: String(row.updated_at)
  };
}
var SqliteRequestRepository = class {
  constructor(db2) {
    this.db = db2;
  }
  db;
  insertTransition(request, reasonCode, at) {
    this.db.prepare(`INSERT INTO request_transitions(request_ref,state,phase,checkpoint_json,pause_condition,reason_code,claim_generation,observed_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      request.requestRef,
      request.state,
      request.phase,
      JSON.stringify(request.checkpoint),
      request.pauseCondition,
      reasonCode,
      request.claimGeneration,
      at
    );
  }
  advanceLane(request, at) {
    if (!request.workspaceRef || !request.tabRef || request.lanePosition === null) return;
    const lane = this.db.prepare(`SELECT * FROM tab_lanes WHERE workspace_ref = ? AND tab_ref = ? AND head_request_ref = ?`).get(request.workspaceRef, request.tabRef, request.requestRef);
    if (!lane) return;
    const next = this.db.prepare(`SELECT request_ref FROM request_tickets
      WHERE workspace_ref = ? AND tab_ref = ? AND lane_position > ? AND state IN ('queued','running') AND publicly_visible = 1
      ORDER BY lane_position LIMIT 1`).get(request.workspaceRef, request.tabRef, request.lanePosition);
    this.db.prepare(`UPDATE tab_lanes SET head_request_ref = ?, lane_generation = lane_generation + 1, updated_at = ?
      WHERE workspace_ref = ? AND tab_ref = ? AND head_request_ref = ?`).run(
      next ? String(next.request_ref) : null,
      at,
      request.workspaceRef,
      request.tabRef,
      request.requestRef
    );
  }
  acceptRequest(input) {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      let lanePosition = null;
      if (input.tabRef !== void 0) {
        if (!input.workspaceRef) throw new Error("WORKSPACE_REQUIRED_FOR_TAB");
        this.db.prepare(`INSERT INTO tab_lanes(workspace_ref,tab_ref,next_position,updated_at) VALUES(?,?,1,?)
          ON CONFLICT(workspace_ref,tab_ref) DO NOTHING`).run(input.workspaceRef, input.tabRef, at);
        const lane = this.db.prepare("SELECT * FROM tab_lanes WHERE workspace_ref = ? AND tab_ref = ?").get(input.workspaceRef, input.tabRef);
        lanePosition = Number(lane.next_position);
      }
      this.db.prepare(`INSERT INTO request_tickets(request_ref,tool_name,requester_session_ref,authority_scope,authority_session_ref,
        authority_lineage_ref,endpoint_ref,workspace_ref,tab_ref,accepted_owner_epoch,normalized_body_json,state,phase,
        checkpoint_json,lane_position,accepted_at,updated_at,resolution_of_request_ref)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?)`).run(
        input.requestRef,
        input.toolName,
        input.requesterSessionRef,
        input.authorityScope,
        input.authoritySessionRef,
        input.authorityLineageRef,
        input.endpointRef ?? null,
        input.workspaceRef ?? null,
        input.tabRef ?? null,
        input.acceptedOwnerEpoch ?? null,
        JSON.stringify(input.normalizedBody),
        input.phase,
        JSON.stringify(input.checkpoint),
        lanePosition,
        at,
        at,
        input.resolutionOfRequestRef ?? null
      );
      if (input.tabRef !== void 0 && input.workspaceRef && lanePosition !== null) {
        this.db.prepare(`UPDATE tab_lanes SET next_position = next_position + 1,
          head_request_ref = COALESCE(head_request_ref, ?), updated_at = ? WHERE workspace_ref = ? AND tab_ref = ?`).run(input.requestRef, at, input.workspaceRef, input.tabRef);
      }
      const request = this.getRequest(input.requestRef);
      this.insertTransition(request, "accepted", at);
      return request;
    })();
  }
  getRequest(requestRef) {
    const row = this.db.prepare("SELECT * FROM request_tickets WHERE request_ref = ?").get(requestRef);
    return row ? toRequest(row) : null;
  }
  listVisibleRequests(input) {
    const limit = pageLimit(input.page.limit);
    const clauses = [`authority_lineage_ref = ?`, `publicly_visible = 1`, `closed_at IS NULL`, `request_ref > ?`];
    const values = [input.authorityLineageRef, input.page.after ?? ""];
    if (input.authoritySessionRef) {
      clauses.push(`(authority_scope = 'owner' OR authority_session_ref = ?)`);
      values.push(input.authoritySessionRef);
    } else {
      clauses.push(`authority_scope = 'owner'`);
    }
    if (input.workspaceRef) {
      clauses.push("workspace_ref = ?");
      values.push(input.workspaceRef);
    }
    if (!input.includeTerminal) clauses.push(`state IN ('queued','running')`);
    values.push(limit + 1);
    const rows = this.db.prepare(`SELECT * FROM request_tickets WHERE ${clauses.join(" AND ")} ORDER BY request_ref LIMIT ?`).all(...values);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toRequest);
    return { items, next: hasMore ? items.at(-1)?.requestRef ?? null : null };
  }
  markAcknowledgementDelivered(requestRef, at = nowIso()) {
    const result = this.db.prepare(`UPDATE request_tickets SET acknowledgement_state = 'delivered', acknowledged_at = ?, updated_at = ?
      WHERE request_ref = ? AND acknowledgement_state = 'pending' AND state = 'queued'`).run(at, at, requestRef);
    if (result.changes !== 1) return null;
    const request = this.getRequest(requestRef);
    this.insertTransition(request, "acknowledgement_delivered", at);
    return request;
  }
  failAcknowledgement(requestRef, reasonCode, at = nowIso()) {
    return this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE request_tickets SET acknowledgement_state = 'failed', publicly_visible = 0, state = 'failed',
        phase = 'acknowledgement_failed', problem_json = ?, terminal_at = ?, updated_at = ?
        WHERE request_ref = ? AND acknowledgement_state = 'pending' AND state = 'queued'`).run(JSON.stringify({ code: reasonCode }), at, at, requestRef);
      if (result.changes !== 1) return null;
      const request = this.getRequest(requestRef);
      this.insertTransition(request, reasonCode, at);
      this.advanceLane(request, at);
      return request;
    })();
  }
  claimRequest(input) {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const current = this.getRequest(input.requestRef);
      if (!current || current.acknowledgementState !== "delivered" || !current.publiclyVisible || !["queued", "running"].includes(current.state)) return null;
      if (current.workspaceRef && current.tabRef) {
        const lane = this.db.prepare("SELECT head_request_ref FROM tab_lanes WHERE workspace_ref = ? AND tab_ref = ?").get(current.workspaceRef, current.tabRef);
        if (!lane || String(lane.head_request_ref) !== current.requestRef) return null;
      }
      const result = this.db.prepare(`UPDATE request_tickets SET state = 'running', claimed_by = ?, claim_expires_at = ?,
        claim_generation = claim_generation + 1, updated_at = ? WHERE request_ref = ? AND state IN ('queued','running')
        AND (claimed_by IS NULL OR claim_expires_at <= ? OR claimed_by = ?)`).run(input.workerRef, input.leaseExpiresAt, at, input.requestRef, at, input.workerRef);
      if (result.changes !== 1) return null;
      const request = this.getRequest(input.requestRef);
      this.insertTransition(request, "worker_claimed", at);
      return request;
    })();
  }
  recordCheckpoint(input) {
    const at = input.at ?? nowIso();
    const result = this.db.prepare(`UPDATE request_tickets SET phase = ?, checkpoint_json = ?, pause_condition = ?, updated_at = ?
      WHERE request_ref = ? AND state IN ('queued','running') AND claim_generation = ?`).run(
      input.phase,
      JSON.stringify(input.checkpoint),
      input.pauseCondition === void 0 ? null : input.pauseCondition,
      at,
      input.requestRef,
      input.expectedClaimGeneration
    );
    if (result.changes !== 1) return null;
    const request = this.getRequest(input.requestRef);
    this.insertTransition(request, input.reasonCode ?? null, at);
    return request;
  }
  startAttempt(input) {
    const at = input.at ?? nowIso();
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT COALESCE(MAX(attempt_number),0) AS value FROM request_attempts WHERE request_ref = ?").get(input.requestRef);
      const attemptNumber = Number(row.value) + 1;
      this.db.prepare(`INSERT INTO request_attempts(attempt_ref,request_ref,attempt_number,endpoint_ref,connection_generation,
        locator_generation,attachment_generation,private_message_ref,state,prepared_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?)`).run(
        input.attemptRef,
        input.requestRef,
        attemptNumber,
        input.endpointRef,
        input.connectionGeneration,
        input.locatorGeneration ?? null,
        input.attachmentGeneration ?? null,
        input.privateMessageRef ?? null,
        at
      );
      return this.getAttempt(input.attemptRef);
    })();
  }
  getAttempt(attemptRef) {
    const row = this.db.prepare("SELECT * FROM request_attempts WHERE attempt_ref = ?").get(attemptRef);
    return row ? toAttempt(row) : null;
  }
  markAttemptDispatched(attemptRef, at = nowIso()) {
    const result = this.db.prepare(`UPDATE request_attempts SET state = 'dispatched', dispatched_at = ?
      WHERE attempt_ref = ? AND state = 'prepared'`).run(at, attemptRef);
    return result.changes === 1 ? this.getAttempt(attemptRef) : null;
  }
  finishAttempt(input) {
    const at = input.at ?? nowIso();
    const result = this.db.prepare(`UPDATE request_attempts SET state = ?, outcome_json = ?, effect_classification = ?, completed_at = ?
      WHERE attempt_ref = ? AND state IN ('prepared','dispatched')`).run(
      input.state,
      input.outcome === void 0 ? null : JSON.stringify(input.outcome),
      input.effectClassification ?? null,
      at,
      input.attemptRef
    );
    return result.changes === 1 ? this.getAttempt(input.attemptRef) : null;
  }
  terminalizeRequest(input) {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const values = [
        input.state,
        input.phase,
        JSON.stringify(input.checkpoint),
        input.problem === void 0 ? null : JSON.stringify(input.problem),
        input.result === void 0 ? null : JSON.stringify(input.result),
        Number(input.effectMayHaveOccurred ?? false),
        at,
        at,
        input.requestRef
      ];
      let claimClause = "";
      if (input.expectedClaimGeneration !== void 0) {
        claimClause = " AND claim_generation = ?";
        values.push(input.expectedClaimGeneration);
      }
      const result = this.db.prepare(`UPDATE request_tickets SET state = ?, phase = ?, checkpoint_json = ?, pause_condition = NULL,
        problem_json = ?, result_json = ?, effect_may_have_occurred = ?, terminal_at = ?, updated_at = ?,
        claimed_by = NULL, claim_expires_at = NULL WHERE request_ref = ? AND state IN ('queued','running')${claimClause}`).run(...values);
      if (result.changes !== 1) return null;
      const request = this.getRequest(input.requestRef);
      this.insertTransition(request, input.reasonCode ?? null, at);
      this.advanceLane(request, at);
      return request;
    })();
  }
  closeRequest(input) {
    const at = input.at ?? nowIso();
    const values = [at, at, input.requestRef, input.authoritySessionRef, input.authoritySessionRef];
    let ownerClause = "";
    if (input.expectedOwnerEpoch !== void 0) {
      ownerClause = " AND (authority_scope = 'requester' OR accepted_owner_epoch = ?)";
      values.push(input.expectedOwnerEpoch);
    }
    const result = this.db.prepare(`UPDATE request_tickets SET closed_at = ?, publicly_visible = 0, updated_at = ?
      WHERE request_ref = ? AND closed_at IS NULL AND publicly_visible = 1 AND state IN ('succeeded','failed','uncertain')
      AND ((authority_scope = 'requester' AND requester_session_ref = ?) OR (authority_scope = 'owner' AND authority_session_ref = ?))${ownerClause}`).run(...values);
    return result.changes === 1;
  }
  resolveRequest(input) {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const target = this.getRequest(input.targetRequestRef);
      const resolver = this.getRequest(input.resolverRequestRef);
      if (!target || target.state !== "running" || target.pauseCondition !== "user_confirmation_required" || !resolver || !["queued", "running"].includes(resolver.state)) return false;
      const targetResult = this.db.prepare(`UPDATE request_tickets SET state = ?, phase = 'human_resolved', checkpoint_json = ?,
        pause_condition = NULL, problem_json = ?, result_json = ?, effect_may_have_occurred = ?, terminal_at = ?, updated_at = ?, claimed_by = NULL, claim_expires_at = NULL
        WHERE request_ref = ? AND state = 'running' AND pause_condition = 'user_confirmation_required'`).run(
        input.targetState,
        JSON.stringify({ name: "human_resolved", recorded_at: at }),
        input.targetProblem === void 0 ? null : JSON.stringify(input.targetProblem),
        input.targetResult === void 0 ? null : JSON.stringify(input.targetResult),
        Number(input.targetEffectMayHaveOccurred ?? false),
        at,
        at,
        input.targetRequestRef
      );
      if (targetResult.changes !== 1) return false;
      const resolverState = input.resolverState ?? "succeeded";
      const resolverResult = this.db.prepare(`UPDATE request_tickets SET state = ?, phase = 'resolved', checkpoint_json = ?,
        result_json = ?, terminal_at = ?, updated_at = ? WHERE request_ref = ? AND state IN ('queued','running')`).run(
        resolverState,
        JSON.stringify({ name: "resolved", recorded_at: at, details: {} }),
        JSON.stringify(input.resolverResult ?? { target_request_ref: input.targetRequestRef, target_state: input.targetState }),
        at,
        at,
        input.resolverRequestRef
      );
      if (resolverResult.changes !== 1) throw new Error("STALE_RESOLVER_REQUEST");
      const updatedTarget = this.getRequest(input.targetRequestRef);
      const updatedResolver = this.getRequest(input.resolverRequestRef);
      this.insertTransition(updatedTarget, "human_resolution", at);
      this.insertTransition(updatedResolver, "resolution_completed", at);
      this.advanceLane(updatedTarget, at);
      this.advanceLane(updatedResolver, at);
      return true;
    })();
  }
  scanRequestRecovery(_at = nowIso()) {
    const requests = this.db.prepare(`SELECT * FROM request_tickets WHERE state IN ('queued','running','uncertain')
      AND publicly_visible = 1 ORDER BY accepted_at, request_ref`).all().map(toRequest);
    const attempts = this.db.prepare(`SELECT request_attempts.* FROM request_attempts
      JOIN request_tickets ON request_tickets.request_ref = request_attempts.request_ref
      WHERE request_tickets.state IN ('queued','running','uncertain') ORDER BY request_attempts.prepared_at`).all().map(toAttempt);
    const lanes = this.db.prepare(`SELECT * FROM tab_lanes WHERE head_request_ref IS NOT NULL ORDER BY workspace_ref,tab_ref`).all().map(toLane);
    return { requests, attempts, lanes };
  }
};

// apps/broker/src/storage/sqlite/proxy-repository.ts
var SqliteProxyRepository = class {
  constructor(db2) {
    this.db = db2;
  }
  db;
  transaction(work) {
    return this.db.transaction(work)();
  }
  get(profileRef) {
    const row = this.db.prepare("SELECT body_json FROM profile_proxies WHERE profile_ref=?").get(profileRef);
    return row ? JSON.parse(String(row.body_json)) : {
      profileRef,
      revision: 0,
      proxy: null,
      port: null,
      state: "unmanaged",
      appliedRevision: null,
      connectionGeneration: null,
      observedAt: (/* @__PURE__ */ new Date()).toISOString(),
      problemCode: null,
      exit: null,
      principalId: null
    };
  }
  all() {
    return this.db.prepare("SELECT body_json FROM profile_proxies").all().map((r) => JSON.parse(String(r.body_json)));
  }
  save(value) {
    this.db.prepare("INSERT INTO profile_proxies(profile_ref,body_json,listener_port) VALUES(?,?,?) ON CONFLICT(profile_ref) DO UPDATE SET body_json=excluded.body_json,listener_port=excluded.listener_port").run(value.profileRef, JSON.stringify(value), value.port);
  }
  associate(requestRef, profileRef, principalId, bodyHash, key) {
    this.db.prepare("INSERT INTO profile_proxy_requests(request_ref,profile_ref,principal_id,body_hash,idempotency_key) VALUES(?,?,?,?,?)").run(requestRef, profileRef, principalId, bodyHash, key);
  }
  decode(row) {
    return row ? { requestRef: String(row.request_ref), profileRef: String(row.profile_ref), principalId: String(row.principal_id), bodyHash: String(row.body_hash), savedRevision: row.saved_revision === null ? null : Number(row.saved_revision) } : null;
  }
  request(ref) {
    return this.decode(this.db.prepare("SELECT * FROM profile_proxy_requests WHERE request_ref=?").get(ref));
  }
  reuse(principal, key) {
    return this.decode(this.db.prepare("SELECT * FROM profile_proxy_requests WHERE principal_id=? AND idempotency_key=?").get(principal, key));
  }
  markSaved(ref, revision) {
    this.db.prepare("UPDATE profile_proxy_requests SET saved_revision=? WHERE request_ref=?").run(revision, ref);
  }
  busy(profileRef, except = "", includeChecks = false) {
    return !!this.db.prepare("SELECT 1 FROM profile_proxy_requests p JOIN request_tickets t USING(request_ref) WHERE p.profile_ref=? AND p.request_ref<>? AND t.state IN ('queued','running') AND (?=1 OR t.tool_name<>'check_browser_proxy') LIMIT 1").get(profileRef, except, includeChecks ? 1 : 0);
  }
};

// apps/broker/src/storage/sqlite/profile-repository.ts
import { randomUUID } from "node:crypto";

// apps/broker/src/profiles/types.ts
var ProfileError = class extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
  code;
};

// apps/broker/src/storage/sqlite/profile-repository.ts
var profile = (row) => ({
  profileRef: String(row.profile_ref),
  principalId: String(row.principal_id),
  dataDirKey: String(row.data_dir_key),
  runtimeRef: String(row.runtime_ref),
  endpointRef: nullableString(row.endpoint_ref),
  identityHash: nullableString(row.identity_hash),
  problemCode: nullableString(row.problem_code),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});
var instance = (row) => ({
  instanceRef: String(row.instance_ref),
  profileRef: String(row.profile_ref),
  generation: Number(row.generation),
  browserState: String(row.browser_state),
  extensionState: String(row.extension_state),
  pid: row.pid === null ? null : Number(row.pid),
  processCreatedAt: nullableString(row.process_created_at),
  executablePath: nullableString(row.executable_path),
  dataDir: nullableString(row.data_dir),
  managementUrl: nullableString(row.management_url),
  observedAt: String(row.observed_at),
  endedAt: nullableString(row.ended_at)
});
var SqliteProfileRepository = class {
  constructor(db2) {
    this.db = db2;
  }
  db;
  transaction(work) {
    return this.db.transaction(work)();
  }
  reserveCreation(input, acceptTicket) {
    return this.transaction(() => {
      const existing = this.findCreation(input.principalId, input.key);
      if (existing) {
        const value2 = this.get(existing.profileRef);
        if (existing.bodyHash !== input.bodyHash) throw new ProfileError("IDEMPOTENCY_CONFLICT");
        return { profile: value2, requestRef: existing.requestRef, reused: true };
      }
      const value = this.create(input.principalId, input.runtimeRef);
      const requestRef = acceptTicket(value);
      this.associateRequest({ requestRef, profileRef: value.profileRef, principalId: input.principalId });
      this.recordCreation(input.principalId, input.key, input.bodyHash, value.profileRef, requestRef);
      return { profile: value, requestRef, reused: false };
    });
  }
  create(principalId, runtimeRef) {
    const id = randomUUID();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const ref = `prf_${id}`;
    this.db.prepare(`INSERT INTO managed_profiles(profile_ref,principal_id,data_dir_key,runtime_ref,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).run(ref, principalId, id, runtimeRef, timestamp, timestamp);
    return this.get(ref);
  }
  get(ref) {
    const row = this.db.prepare("SELECT * FROM managed_profiles WHERE profile_ref=?").get(ref);
    return row ? profile(row) : null;
  }
  getVisible(principalId, ref) {
    const value = this.get(ref);
    return value?.principalId === principalId ? value : null;
  }
  forEndpoint(endpointRef) {
    const row = this.db.prepare("SELECT * FROM managed_profiles WHERE endpoint_ref=?").get(endpointRef);
    return row ? profile(row) : null;
  }
  all() {
    return this.db.prepare("SELECT * FROM managed_profiles").all().map(profile);
  }
  page(principalId, limit = 50, cursor) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProfileError("INVALID_ARGUMENT");
    let afterCreated = "";
    let afterRef = "";
    if (cursor) {
      const row = this.db.prepare("SELECT * FROM profile_list_cursors WHERE cursor_ref=? AND principal_id=? AND expires_at>?").get(cursor, principalId, Date.now());
      if (!row) throw new ProfileError("CURSOR_INVALID");
      afterCreated = String(row.after_created_at);
      afterRef = String(row.after_profile_ref);
    }
    const rows = this.db.prepare(`SELECT * FROM managed_profiles WHERE principal_id=?
      AND (created_at > ? OR (created_at = ? AND profile_ref > ?)) ORDER BY created_at, profile_ref LIMIT ?`).all(principalId, afterCreated, afterCreated, afterRef, limit + 1);
    const values = rows.slice(0, limit).map(profile);
    let nextCursor = null;
    if (rows.length > limit) {
      const last = values[values.length - 1];
      nextCursor = `cur_${randomUUID()}`;
      this.db.prepare("DELETE FROM profile_list_cursors WHERE expires_at <= ?").run(Date.now());
      this.db.prepare("INSERT INTO profile_list_cursors VALUES(?,?,?,?,?)").run(nextCursor, principalId, last.createdAt, last.profileRef, Date.now() + 864e5);
    }
    return { profiles: values, nextCursor };
  }
  setProblem(profileRef, code) {
    this.db.prepare("UPDATE managed_profiles SET problem_code=?,updated_at=? WHERE profile_ref=?").run(code, (/* @__PURE__ */ new Date()).toISOString(), profileRef);
  }
  bind(profileRef, endpointRef, identityHash) {
    const value = this.get(profileRef);
    if (!value || value.identityHash && value.identityHash !== identityHash || value.endpointRef && value.endpointRef !== endpointRef) {
      throw new ProfileError("PROFILE_IDENTITY_MISMATCH");
    }
    this.db.prepare("UPDATE managed_profiles SET endpoint_ref=?,identity_hash=?,updated_at=? WHERE profile_ref=?").run(endpointRef, identityHash, (/* @__PURE__ */ new Date()).toISOString(), profileRef);
  }
  currentInstance(profileRef) {
    const row = this.db.prepare("SELECT * FROM managed_browser_instances WHERE profile_ref=? AND ended_at IS NULL").get(profileRef);
    return row ? instance(row) : null;
  }
  getInstance(instanceRef) {
    const row = this.db.prepare("SELECT * FROM managed_browser_instances WHERE instance_ref=?").get(instanceRef);
    return row ? instance(row) : null;
  }
  createInstance(profileRef) {
    return this.transaction(() => {
      if (this.currentInstance(profileRef)) throw new ProfileError("PROFILE_IN_USE");
      const previous = this.db.prepare("SELECT COALESCE(MAX(generation),0) AS generation FROM managed_browser_instances WHERE profile_ref=?").get(profileRef);
      const instanceRef = `ins_${randomUUID()}`;
      this.db.prepare(`INSERT INTO managed_browser_instances(instance_ref,profile_ref,generation,browser_state,extension_state,observed_at)
        VALUES(?,?,?,'starting','unknown',?)`).run(instanceRef, profileRef, Number(previous.generation) + 1, (/* @__PURE__ */ new Date()).toISOString());
      return this.getInstance(instanceRef);
    });
  }
  updateInstance(value) {
    const result = this.db.prepare(`UPDATE managed_browser_instances SET browser_state=?,extension_state=?,pid=?,process_created_at=?,
      executable_path=?,data_dir=?,management_url=?,observed_at=?,ended_at=? WHERE instance_ref=? AND generation=? AND ended_at IS NULL`).run(
      value.browserState,
      value.extensionState,
      value.pid,
      value.processCreatedAt,
      value.executablePath,
      value.dataDir,
      value.managementUrl,
      value.observedAt,
      value.endedAt,
      value.instanceRef,
      value.generation
    );
    if (Number(result.changes) !== 1) throw new ProfileError("PROFILE_INSTANCE_UNVERIFIED");
  }
  associateRequest(value) {
    this.db.prepare("INSERT INTO profile_requests VALUES(?,?,?)").run(value.requestRef, value.profileRef, value.principalId);
  }
  request(requestRef) {
    const row = this.db.prepare("SELECT * FROM profile_requests WHERE request_ref=?").get(requestRef);
    return row ? { requestRef: String(row.request_ref), profileRef: String(row.profile_ref), principalId: String(row.principal_id) } : null;
  }
  renewRequest(requestRef, generation, ttlMs) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return Number(this.db.prepare(`UPDATE request_tickets SET claim_expires_at=?
      WHERE request_ref=? AND claim_generation=? AND state='running' AND claim_expires_at>?`).run(new Date(Date.now() + ttlMs).toISOString(), requestRef, generation, now).changes) === 1;
  }
  ownsRequest(requestRef, generation) {
    return !!this.db.prepare(`SELECT 1 FROM request_tickets WHERE request_ref=? AND claim_generation=? AND state='running' AND claim_expires_at>?`).get(requestRef, generation, (/* @__PURE__ */ new Date()).toISOString());
  }
  findCreation(principalId, key) {
    const row = this.db.prepare("SELECT * FROM profile_create_keys WHERE principal_id=? AND idempotency_key=?").get(principalId, key);
    return row ? { bodyHash: String(row.body_hash), profileRef: String(row.profile_ref), requestRef: String(row.request_ref) } : null;
  }
  recordCreation(principalId, key, bodyHash, profileRef, requestRef) {
    this.db.prepare("INSERT INTO profile_create_keys VALUES(?,?,?,?,?)").run(principalId, key, bodyHash, profileRef, requestRef);
  }
  acquire(profileRef, ownerRef, ttlMs, now = Date.now()) {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT * FROM profile_operation_locks WHERE profile_ref=?").get(profileRef);
      if (old && Number(old.expires_at) > now) return null;
      const generation = Number(old?.generation ?? 0) + 1;
      const expiresAt = now + ttlMs;
      this.db.prepare(`INSERT INTO profile_operation_locks VALUES(?,?,?,?) ON CONFLICT(profile_ref)
        DO UPDATE SET owner_ref=excluded.owner_ref,generation=excluded.generation,expires_at=excluded.expires_at`).run(profileRef, ownerRef, generation, expiresAt);
      return { profileRef, ownerRef, generation, expiresAt };
    });
  }
  renew(lease, ttlMs, now = Date.now()) {
    const result = this.db.prepare(`UPDATE profile_operation_locks SET expires_at=?
      WHERE profile_ref=? AND owner_ref=? AND generation=? AND expires_at>?`).run(now + ttlMs, lease.profileRef, lease.ownerRef, lease.generation, now);
    return Number(result.changes) === 1;
  }
  owns(lease, now = Date.now()) {
    return !!this.db.prepare("SELECT 1 FROM profile_operation_locks WHERE profile_ref=? AND owner_ref=? AND generation=? AND expires_at>?").get(lease.profileRef, lease.ownerRef, lease.generation, now);
  }
  release(lease) {
    this.db.prepare("UPDATE profile_operation_locks SET expires_at=0 WHERE profile_ref=? AND owner_ref=? AND generation=?").run(lease.profileRef, lease.ownerRef, lease.generation);
  }
  saveGrant(grant) {
    this.db.prepare("INSERT INTO managed_bootstrap_grants VALUES(?,?,?,?,?,?,?)").run(grant.grantRef, grant.profileRef, grant.instanceRef, grant.generation, grant.secretHash, grant.expiresAt, grant.consumedAt);
  }
  grant(grantRef) {
    const row = this.db.prepare("SELECT * FROM managed_bootstrap_grants WHERE grant_ref=?").get(grantRef);
    return row ? {
      grantRef: String(row.grant_ref),
      profileRef: String(row.profile_ref),
      instanceRef: String(row.instance_ref),
      generation: Number(row.generation),
      secretHash: String(row.secret_hash),
      expiresAt: Number(row.expires_at),
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at)
    } : null;
  }
  consumeGrant(grantRef, now = Date.now()) {
    return Number(this.db.prepare("UPDATE managed_bootstrap_grants SET consumed_at=? WHERE grant_ref=? AND consumed_at IS NULL AND expires_at>?").run(now, grantRef, now).changes) === 1;
  }
  instanceAuthenticated(instanceRef) {
    return !!this.db.prepare("SELECT 1 FROM managed_browser_instances WHERE instance_ref=? AND ended_at IS NULL AND authenticated_at IS NOT NULL").get(instanceRef);
  }
  authenticateInstance(instanceRef) {
    if (Number(this.db.prepare("UPDATE managed_browser_instances SET authenticated_at=? WHERE instance_ref=? AND ended_at IS NULL").run((/* @__PURE__ */ new Date()).toISOString(), instanceRef).changes) !== 1) throw new ProfileError("PROFILE_INSTANCE_UNVERIFIED");
  }
};

// apps/broker/src/storage/sqlite/runtime.ts
import { DatabaseSync } from "node:sqlite";
var NodeSqliteDatabase = class {
  database;
  transactionDepth = 0;
  savepointSequence = 0;
  constructor(path) {
    this.database = new DatabaseSync(path);
  }
  close() {
    this.database.close();
  }
  exec(sql) {
    this.database.exec(sql);
  }
  prepare(sql) {
    return this.database.prepare(sql);
  }
  pragma(sql) {
    this.database.exec(`PRAGMA ${sql}`);
  }
  transaction(work) {
    return () => {
      const nested = this.transactionDepth > 0;
      const savepoint = `octopus_sp_${++this.savepointSequence}`;
      this.database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      this.transactionDepth += 1;
      try {
        const result = work();
        this.transactionDepth -= 1;
        this.database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        this.transactionDepth -= 1;
        if (nested) {
          this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.database.exec("ROLLBACK");
        }
        throw error;
      }
    };
  }
};

// apps/broker/src/storage/sqlite/database.ts
var hashSecret = (value) => createHash("sha256").update(value).digest("hex");
var nowIso2 = () => (/* @__PURE__ */ new Date()).toISOString();
var jwkIdentity = (value) => JSON.stringify({
  kty: value.kty,
  crv: value.crv,
  x: value.x,
  y: value.y,
  n: value.n,
  e: value.e
});
function parseJson2(value) {
  if (typeof value !== "string") throw new Error("Expected JSON string from database.");
  return JSON.parse(value);
}
function toTarget(row) {
  return {
    targetId: String(row.target_id),
    alias: String(row.alias),
    publicKeyJwk: parseJson2(row.public_key_jwk),
    capabilities: parseJson2(row.capabilities_json),
    revoked: Boolean(row.revoked),
    consecutiveFailures: Number(row.consecutive_failures),
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
    lastErrorAt: row.last_error_at === null ? null : String(row.last_error_at),
    statusVersion: Number(row.status_version)
  };
}
function toLease(row) {
  return {
    leaseId: String(row.lease_id),
    targetId: String(row.target_id),
    principalId: String(row.principal_id),
    fencingToken: Number(row.fencing_token),
    expiresAt: String(row.expires_at),
    releasedAt: row.released_at === null ? null : String(row.released_at)
  };
}
function toBinding(row) {
  return {
    bindingId: String(row.binding_id),
    bindingRef: String(row.binding_ref),
    principalId: String(row.principal_id),
    targetId: String(row.target_id),
    targetAlias: String(row.target_alias),
    mode: "dedicated",
    createdAt: String(row.created_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}
function toCommand(row) {
  const command = {
    commandId: String(row.command_id),
    requestId: String(row.request_id),
    principalId: String(row.principal_id),
    ...row.run_id === null || row.run_id === void 0 ? {} : { runId: String(row.run_id) },
    bindingRef: String(row.binding_ref),
    targetId: String(row.target_id),
    targetAlias: String(row.target_alias),
    operation: String(row.operation),
    parameters: parseJson2(row.parameters_json),
    idempotencyClass: String(row.idempotency_class),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    state: String(row.state),
    decision: parseJson2(row.decision_json),
    deadlineAt: String(row.deadline_at),
    deliveredEpoch: row.delivered_epoch === null ? null : Number(row.delivered_epoch),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
  if (row.lease_id !== null) command.leaseId = String(row.lease_id);
  if (row.fencing_token !== null) command.fencingToken = Number(row.fencing_token);
  if (row.result_state !== null) {
    const result = {
      commandId: command.commandId,
      state: String(row.result_state)
    };
    if (row.output_json !== null) result.output = parseJson2(row.output_json);
    if (row.error_code !== null) result.errorCode = String(row.error_code);
    command.result = result;
  }
  return command;
}
var SqliteRelayStore = class {
  db;
  canonical;
  profiles;
  proxies;
  constructor(databasePath) {
    const existingDatabase = databasePath !== ":memory:" && existsSync(databasePath);
    if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.db = new NodeSqliteDatabase(databasePath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    try {
      this.migrate(existingDatabase ? databasePath : null);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.profiles = new SqliteProfileRepository(this.db);
    this.proxies = new SqliteProxyRepository(this.db);
    const repositories = {
      profiles: this.profiles,
      logical: new SqliteLogicalRepository(this.db),
      requests: new SqliteRequestRepository(this.db),
      events: new SqliteEventRepository(this.db),
      audit: new SqliteAuditRepository(this.db)
    };
    this.canonical = {
      ...repositories,
      transaction: (work) => this.db.transaction(() => work(repositories))()
    };
  }
  migrate(backupSource) {
    const migrations = [
      { version: 1, sql: readFileSync(new URL("./migrations/001-initial.sql", import.meta.url), "utf8") },
      { version: 2, sql: readFileSync(new URL("./migrations/002-real-world-trace.sql", import.meta.url), "utf8") },
      { version: 3, sql: readFileSync(new URL("./migrations/003-agent-target-bindings.sql", import.meta.url), "utf8") },
      { version: 4, sql: readFileSync(new URL("./migrations/004-workspaces-requests.sql", import.meta.url), "utf8") },
      { version: 5, sql: readFileSync(new URL("./migrations/005-window-focus-history.sql", import.meta.url), "utf8") },
      { version: 6, sql: readFileSync(new URL("./migrations/006-managed-profiles.sql", import.meta.url), "utf8") },
      { version: 7, sql: readFileSync(new URL("./migrations/007-profile-alias-only.sql", import.meta.url), "utf8") },
      { version: 8, sql: readFileSync(new URL("./migrations/008-profile-proxy.sql", import.meta.url), "utf8") }
    ];
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    if (backupSource && !this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=6").get()) {
      this.db.prepare("VACUUM INTO ?").run(`${resolve(backupSource)}.before-profiles-${randomUUID2()}.sqlite`);
    }
    for (const migration of migrations) {
      const applied = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(migration.version);
      if (applied) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        if (migration.version === 7) {
          const update = this.db.prepare("UPDATE profile_create_keys SET body_hash=? WHERE principal_id=? AND idempotency_key=?");
          for (const row of this.db.prepare("SELECT principal_id,idempotency_key FROM profile_create_keys").all()) {
            const key = String(row.idempotency_key);
            update.run(hashSecret(JSON.stringify({ idempotency_key: key })), String(row.principal_id), key);
          }
        }
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(migration.version, nowIso2());
      })();
    }
  }
  close() {
    this.db.close();
  }
  sqliteDiagnostics() {
    const journal = this.db.prepare("PRAGMA journal_mode").get();
    const foreignKeys = this.db.prepare("PRAGMA foreign_keys").get();
    const migration = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS value FROM schema_migrations").get();
    return {
      journalMode: String(journal.journal_mode),
      foreignKeys: Number(foreignKeys.foreign_keys) === 1,
      migrationVersion: Number(migration.value)
    };
  }
  createAgent(displayName, scopes, token = randomBytes(32).toString("base64url")) {
    const principalId = randomUUID2();
    const createdAt = nowIso2();
    this.db.prepare("INSERT INTO agents(principal_id, display_name, token_hash, scopes_json, created_at) VALUES(?,?,?,?,?)").run(principalId, displayName, hashSecret(token), JSON.stringify(scopes), createdAt);
    return { principal: { principalId, displayName, scopes }, token };
  }
  authenticateAgent(token) {
    const row = this.db.prepare("SELECT * FROM agents WHERE token_hash = ? AND enabled = 1").get(hashSecret(token));
    if (!row) return null;
    return {
      principalId: String(row.principal_id),
      displayName: String(row.display_name),
      scopes: parseJson2(row.scopes_json)
    };
  }
  getAgentById(principalId) {
    const row = this.db.prepare("SELECT * FROM agents WHERE principal_id = ? AND enabled = 1").get(principalId);
    if (!row) return null;
    return {
      principalId: String(row.principal_id),
      displayName: String(row.display_name),
      scopes: parseJson2(row.scopes_json)
    };
  }
  updateAgentScopes(principalId, scopes) {
    this.db.prepare("UPDATE agents SET scopes_json=? WHERE principal_id=? AND enabled=1").run(JSON.stringify([...new Set(scopes)]), principalId);
    return this.getAgentById(principalId);
  }
  rotateAgentToken(principalId, token) {
    return Number(this.db.prepare("UPDATE agents SET token_hash=? WHERE principal_id=? AND enabled=1").run(hashSecret(token), principalId).changes) === 1;
  }
  createPairingCode(alias, expiresAt) {
    if (this.getTargetByAlias(alias)) throw new Error(`Target alias already exists: ${alias}`);
    const code = randomBytes(6).toString("base64url").replace(/[-_]/g, "A").slice(0, 8).toUpperCase();
    this.db.prepare("INSERT INTO pairing_codes(code_hash, alias, expires_at, created_at) VALUES(?,?,?,?)").run(hashSecret(code), alias, expiresAt, nowIso2());
    return code;
  }
  consumePairingCode(code, publicKeyJwk, capabilities) {
    return this.db.transaction(() => {
      const current = nowIso2();
      const row = this.db.prepare("SELECT * FROM pairing_codes WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?").get(hashSecret(code), current);
      if (!row) throw new Error("PAIRING_CODE_INVALID");
      const alias = String(row.alias);
      const existing = this.db.prepare("SELECT target_id, revoked FROM targets WHERE alias = ?").get(alias);
      const targetId = existing ? String(existing.target_id) : randomUUID2();
      if (existing) {
        if (Number(existing.revoked) === 0) throw new Error(`Target alias already exists: ${alias}`);
        this.db.prepare(`UPDATE targets SET public_key_jwk = ?, capabilities_json = ?, revoked = 0,
          consecutive_failures = 0, last_seen_at = NULL, last_error_at = NULL,
          status_version = status_version + 1, updated_at = ? WHERE target_id = ?`).run(JSON.stringify(publicKeyJwk), JSON.stringify(capabilities), current, targetId);
      } else {
        this.db.prepare(`INSERT INTO targets(target_id, alias, public_key_jwk, capabilities_json, created_at, updated_at)
          VALUES(?,?,?,?,?,?)`).run(targetId, alias, JSON.stringify(publicKeyJwk), JSON.stringify(capabilities), current, current);
      }
      this.db.prepare("UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ?").run(current, hashSecret(code));
      const target = this.getTargetById(targetId);
      if (!target) throw new Error("Failed to create target.");
      return target;
    })();
  }
  registerExtension(alias, publicKeyJwk, capabilities) {
    return this.db.transaction(() => {
      const current = nowIso2();
      const existingRow = this.db.prepare("SELECT * FROM targets WHERE alias = ?").get(alias);
      const existing = existingRow ? toTarget(existingRow) : null;
      if (existing) {
        if (existing.revoked || jwkIdentity(existing.publicKeyJwk) !== jwkIdentity(publicKeyJwk)) {
          throw new Error("ENDPOINT_NICKNAME_CONFLICT");
        }
        this.db.prepare("UPDATE targets SET capabilities_json = ?, updated_at = ? WHERE target_id = ?").run(JSON.stringify(capabilities), current, existing.targetId);
        return this.getTargetById(existing.targetId);
      }
      const targetId = randomUUID2();
      this.db.prepare(`INSERT INTO targets(target_id, alias, public_key_jwk, capabilities_json, created_at, updated_at)
        VALUES(?,?,?,?,?,?)`).run(targetId, alias, JSON.stringify(publicKeyJwk), JSON.stringify(capabilities), current, current);
      return this.getTargetById(targetId);
    })();
  }
  listTargets() {
    return this.db.prepare("SELECT * FROM targets WHERE revoked = 0 ORDER BY alias").all().map(toTarget);
  }
  getTargetByAlias(alias) {
    const row = this.db.prepare("SELECT * FROM targets WHERE alias = ? AND revoked = 0").get(alias);
    return row ? toTarget(row) : null;
  }
  getTargetById(targetId) {
    const row = this.db.prepare("SELECT * FROM targets WHERE target_id = ? AND revoked = 0").get(targetId);
    return row ? toTarget(row) : null;
  }
  renameTarget(alias, newAlias) {
    this.db.transaction(() => {
      const target = this.getTargetByAlias(alias);
      if (!target) throw new Error(`Target not found: ${alias}`);
      const conflictingTarget = this.db.prepare("SELECT target_id FROM targets WHERE alias = ?").get(newAlias);
      const conflictingEndpoint = this.db.prepare("SELECT legacy_target_id FROM browser_endpoints WHERE nickname = ?").get(newAlias);
      if (conflictingTarget && conflictingTarget.target_id !== target.targetId || conflictingEndpoint && conflictingEndpoint.legacy_target_id !== target.targetId) {
        throw new Error("ENDPOINT_NICKNAME_CONFLICT");
      }
      const current = nowIso2();
      this.db.prepare("UPDATE targets SET alias = ?, status_version = status_version + 1, updated_at = ? WHERE target_id = ?").run(newAlias, current, target.targetId);
      this.db.prepare(`UPDATE browser_endpoints
        SET nickname = ?, status_version = status_version + 1, updated_at = ?
        WHERE legacy_target_id = ?`).run(newAlias, current, target.targetId);
    })();
  }
  revokeTarget(alias) {
    const current = nowIso2();
    this.db.transaction(() => {
      const target = this.getTargetByAlias(alias);
      if (!target) throw new Error(`Target not found: ${alias}`);
      this.db.prepare("UPDATE targets SET revoked = 1, status_version = status_version + 1, updated_at = ? WHERE target_id = ?").run(current, target.targetId);
      this.db.prepare("UPDATE leases SET released_at = ? WHERE target_id = ? AND released_at IS NULL").run(current, target.targetId);
      this.db.prepare("UPDATE agent_target_bindings SET revoked_at = ? WHERE target_id = ? AND revoked_at IS NULL").run(current, target.targetId);
    })();
  }
  createBinding(principalId, targetId) {
    return this.db.transaction(() => {
      const principal = this.getAgentById(principalId);
      if (!principal) throw new Error("AGENT_NOT_FOUND");
      const target = this.getTargetById(targetId);
      if (!target) throw new Error("TARGET_NOT_FOUND");
      const byPrincipal = this.getActiveBindingForPrincipal(principalId);
      if (byPrincipal) {
        if (byPrincipal.targetId === targetId) return byPrincipal;
        throw new Error("BINDING_CONFLICT");
      }
      const byTargetRow = this.db.prepare(`SELECT b.*, t.alias AS target_alias FROM agent_target_bindings b
        JOIN targets t ON t.target_id = b.target_id WHERE b.target_id = ? AND b.revoked_at IS NULL`).get(targetId);
      if (byTargetRow) throw new Error("BINDING_CONFLICT");
      const bindingId = randomUUID2();
      const bindingRef = `br_${randomBytes(24).toString("base64url")}`;
      const createdAt = nowIso2();
      this.db.prepare(`INSERT INTO agent_target_bindings(binding_id,binding_ref,principal_id,target_id,mode,created_at)
        VALUES(?,?,?,?,?,?)`).run(bindingId, bindingRef, principalId, targetId, "dedicated", createdAt);
      const binding = this.getBindingByRef(bindingRef);
      if (!binding) throw new Error("Failed to create binding.");
      return binding;
    })();
  }
  getBindingByRef(bindingRef) {
    const row = this.db.prepare(`SELECT b.*, t.alias AS target_alias FROM agent_target_bindings b
      JOIN targets t ON t.target_id = b.target_id WHERE b.binding_ref = ?`).get(bindingRef);
    return row ? toBinding(row) : null;
  }
  getActiveBindingForPrincipal(principalId) {
    const row = this.db.prepare(`SELECT b.*, t.alias AS target_alias FROM agent_target_bindings b
      JOIN targets t ON t.target_id = b.target_id
      WHERE b.principal_id = ? AND b.revoked_at IS NULL AND t.revoked = 0`).get(principalId);
    return row ? toBinding(row) : null;
  }
  listBindings() {
    const rows = this.db.prepare(`SELECT b.*, t.alias AS target_alias FROM agent_target_bindings b
      JOIN targets t ON t.target_id = b.target_id
      WHERE b.revoked_at IS NULL AND t.revoked = 0 ORDER BY b.created_at`).all();
    return rows.map(toBinding);
  }
  revokeBindingForPrincipal(principalId) {
    return this.db.transaction(() => {
      const binding = this.getActiveBindingForPrincipal(principalId);
      if (!binding) return false;
      const current = nowIso2();
      const changed = this.db.prepare("UPDATE agent_target_bindings SET revoked_at = ? WHERE binding_id = ? AND revoked_at IS NULL").run(current, binding.bindingId).changes === 1;
      if (changed) {
        this.db.prepare("UPDATE leases SET released_at = ? WHERE target_id = ? AND principal_id = ? AND released_at IS NULL").run(current, binding.targetId, principalId);
      }
      return changed;
    })();
  }
  revokeBindingsForTarget(targetId) {
    return Number(this.db.prepare("UPDATE agent_target_bindings SET revoked_at = ? WHERE target_id = ? AND revoked_at IS NULL").run(nowIso2(), targetId).changes);
  }
  updateTargetObservation(targetId, observation, capabilities) {
    const current = nowIso2();
    if (observation === "failure") {
      this.db.prepare(`UPDATE targets SET consecutive_failures = consecutive_failures + 1, last_error_at = ?, last_seen_at = ?,
        status_version = status_version + 1, updated_at = ? WHERE target_id = ?`).run(current, current, current, targetId);
    } else if (observation === "success") {
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
  bumpStatusVersion(targetId) {
    this.db.prepare("UPDATE targets SET status_version = status_version + 1, updated_at = ? WHERE target_id = ?").run(nowIso2(), targetId);
    const target = this.getTargetById(targetId);
    if (!target) throw new Error(`Target not found: ${targetId}`);
    return target.statusVersion;
  }
  getActiveLease(targetId, at) {
    const row = this.db.prepare(`SELECT * FROM leases WHERE target_id = ? AND released_at IS NULL AND expires_at > ?
      ORDER BY fencing_token DESC LIMIT 1`).get(targetId, at);
    return row ? toLease(row) : null;
  }
  acquireLease(targetId, principalId, expiresAt) {
    return this.db.transaction(() => {
      const current = nowIso2();
      this.db.prepare("UPDATE leases SET released_at = ? WHERE target_id = ? AND released_at IS NULL AND expires_at <= ?").run(current, targetId, current);
      const existing = this.getActiveLease(targetId, current);
      if (existing) return null;
      const maxRow = this.db.prepare("SELECT COALESCE(MAX(fencing_token), 0) AS value FROM leases WHERE target_id = ?").get(targetId);
      const fencingToken = Number(maxRow.value) + 1;
      const leaseId = randomUUID2();
      const lease = { leaseId, targetId, principalId, fencingToken, expiresAt, releasedAt: null };
      this.db.prepare("INSERT INTO leases(lease_id,target_id,principal_id,fencing_token,expires_at,created_at) VALUES(?,?,?,?,?,?)").run(leaseId, targetId, principalId, fencingToken, expiresAt, current);
      const sessionHandle = randomBytes(32).toString("base64url");
      this.db.prepare("INSERT INTO sessions(session_id,handle_hash,lease_id,principal_id,expires_at,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID2(), hashSecret(sessionHandle), leaseId, principalId, expiresAt, current);
      return { lease, sessionHandle };
    })();
  }
  resolveSession(handle, principalId, at) {
    const row = this.db.prepare(`SELECT l.*, t.alias, s.expires_at AS session_expires_at FROM sessions s
      JOIN leases l ON l.lease_id = s.lease_id JOIN targets t ON t.target_id = l.target_id
      WHERE s.handle_hash = ? AND s.principal_id = ? AND s.expires_at > ? AND l.released_at IS NULL AND l.expires_at > ? AND t.revoked = 0`).get(hashSecret(handle), principalId, at, at);
    if (!row) return null;
    return { ...toLease(row), alias: String(row.alias), sessionExpiresAt: String(row.session_expires_at) };
  }
  releaseSession(handle, principalId) {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT lease_id FROM sessions WHERE handle_hash = ? AND principal_id = ?").get(hashSecret(handle), principalId);
      if (!row) return false;
      const result = this.db.prepare("UPDATE leases SET released_at = ? WHERE lease_id = ? AND released_at IS NULL").run(nowIso2(), String(row.lease_id));
      return result.changes === 1;
    })();
  }
  expireLeases(at) {
    return Number(this.db.prepare("UPDATE leases SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?").run(at, at).changes);
  }
  createCommand(input) {
    const current = nowIso2();
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
      this.db.prepare("INSERT INTO command_events(command_id,state,reason_code,observed_at) VALUES(?,?,?,?)").run(command.commandId, input.initialState, decision.reasonCode, current);
    })();
    const created = this.getCommand(command.commandId);
    if (!created) throw new Error("Failed to create command.");
    return created;
  }
  findCommandByIdempotency(principalId, idempotencyKey) {
    const row = this.queryCommand("WHERE c.principal_id = ? AND c.idempotency_key = ?", [principalId, idempotencyKey]);
    return row ? toCommand(row) : null;
  }
  getCommand(commandId) {
    const row = this.queryCommand("WHERE c.command_id = ?", [commandId]);
    return row ? toCommand(row) : null;
  }
  queryCommand(where, params) {
    return this.db.prepare(`SELECT c.*, t.alias AS target_alias, r.state AS result_state, r.output_json, r.error_code
      FROM commands c JOIN targets t ON t.target_id = c.target_id LEFT JOIN results r ON r.command_id = c.command_id ${where}`).get(...params);
  }
  transitionCommand(commandId, state, reasonCode, connectionEpoch, result) {
    const current = nowIso2();
    this.db.transaction(() => {
      const update = this.db.prepare("UPDATE commands SET state = ?, delivered_epoch = COALESCE(?, delivered_epoch), updated_at = ? WHERE command_id = ?").run(state, connectionEpoch ?? null, current, commandId);
      if (update.changes !== 1) throw new Error(`Command not found: ${commandId}`);
      this.db.prepare("INSERT INTO command_events(command_id,state,reason_code,connection_epoch,observed_at) VALUES(?,?,?,?,?)").run(commandId, state, reasonCode ?? null, connectionEpoch ?? null, current);
      if (result) {
        this.db.prepare(`INSERT INTO results(command_id,state,output_json,error_code,created_at) VALUES(?,?,?,?,?)
          ON CONFLICT(command_id) DO UPDATE SET state=excluded.state, output_json=excluded.output_json, error_code=excluded.error_code`).run(commandId, result.state, result.output === void 0 ? null : JSON.stringify(result.output), result.errorCode ?? null, current);
      }
    })();
    const updated = this.getCommand(commandId);
    if (!updated) throw new Error(`Command not found: ${commandId}`);
    return updated;
  }
  listRecoverableCommands(at) {
    const rows = this.db.prepare(`SELECT c.*, t.alias AS target_alias, r.state AS result_state, r.output_json, r.error_code
      FROM commands c JOIN targets t ON t.target_id = c.target_id LEFT JOIN results r ON r.command_id = c.command_id
      WHERE c.state IN ('QUEUED','DELIVERED','ACKED','RUNNING') AND c.deadline_at > ? ORDER BY c.created_at`).all(at);
    return rows.map(toCommand);
  }
  countQueuedForTarget(targetId) {
    const row = this.db.prepare("SELECT COUNT(*) AS value FROM commands WHERE target_id = ? AND state = 'QUEUED'").get(targetId);
    return Number(row.value);
  }
  hasInFlightForTarget(targetId, excludingCommandId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS value FROM commands
      WHERE target_id = ? AND state IN ('DELIVERED','ACKED','RUNNING') AND (? IS NULL OR command_id <> ?)`).get(targetId, excludingCommandId ?? null, excludingCommandId ?? null);
    return Number(row.value) > 0;
  }
  trace(event) {
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
      event.observedAt ?? nowIso2()
    );
  }
  listTrace(runId) {
    const rows = this.db.prepare("SELECT * FROM trace_events WHERE run_id = ? ORDER BY trace_id").all(runId);
    return rows.map((row) => ({
      runId: String(row.run_id),
      requestId: String(row.request_id),
      commandId: row.command_id === null ? null : String(row.command_id),
      targetAlias: row.target_alias === null ? null : String(row.target_alias),
      bindingRef: row.binding_ref === null ? null : String(row.binding_ref),
      principalId: String(row.principal_id),
      stage: String(row.stage),
      connectionEpoch: row.connection_epoch === null ? null : Number(row.connection_epoch),
      outcomeCode: row.outcome_code === null ? null : String(row.outcome_code),
      observedAt: String(row.observed_at)
    }));
  }
  listCommandsByRunId(runId) {
    const rows = this.db.prepare(`SELECT c.*, t.alias AS target_alias, r.state AS result_state, r.output_json, r.error_code
      FROM commands c JOIN targets t ON t.target_id = c.target_id LEFT JOIN results r ON r.command_id = c.command_id
      WHERE c.run_id = ? ORDER BY c.created_at`).all(runId);
    return rows.map(toCommand);
  }
  audit(eventType, context) {
    const { principalId, targetAlias, ...safeContext } = context;
    this.db.prepare("INSERT INTO audit_events(event_type,principal_id,target_alias,context_json,observed_at) VALUES(?,?,?,?,?)").run(eventType, principalId ?? null, targetAlias ?? null, JSON.stringify(safeContext), nowIso2());
  }
};

// apps/broker/src/proxy/proxy-credential-store.ts
import { spawn, execFileSync } from "node:child_process";
import { randomUUID as randomUUID3 } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve as resolve2 } from "node:path";
var dpapi = (decrypt) => `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
async function protect(value, decrypt) {
  if (process.platform !== "win32") throw new ProfileError("PROXY_CREDENTIALS_UNAVAILABLE");
  return new Promise((ok, fail) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", dpapi(decrypt)], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => child.kill(), 15e3);
    child.stdout.on("data", (data) => {
      output += String(data);
      if (output.length > 65536) child.kill();
    });
    child.on("error", () => {
      clearTimeout(timer);
      fail(new ProfileError("PROXY_CREDENTIALS_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) ok(Buffer.from(output.trim(), "base64"));
      else fail(new ProfileError("PROXY_CREDENTIALS_UNAVAILABLE"));
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(value.toString("base64"));
  });
}
var ProxyCredentialStore = class {
  constructor(root) {
    this.root = root;
  }
  root;
  async provision(secret, principalId) {
    if (!principalId || typeof secret.username !== "string" || !secret.username || typeof secret.password !== "string" || !secret.password || secret.username.length > 1024 || secret.password.length > 4096) throw new ProfileError("INVALID_ARGUMENT");
    const ref = `pcr_${randomUUID3()}`;
    const bytes = Buffer.from(JSON.stringify({ principalId, ...secret }));
    try {
      const encrypted = await protect(bytes, false);
      await mkdir(this.root, { recursive: true, mode: 448 });
      const owner = /S-1-5-[\d-]+/u.exec(execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }))?.[0];
      if (!owner) throw new ProfileError("PROXY_CREDENTIALS_UNAVAILABLE");
      execFileSync("icacls.exe", [this.root, "/inheritance:r", "/grant:r", `*${owner}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true, stdio: "ignore", timeout: 1e4 });
      await writeFile(resolve2(this.root, `${ref}.bin`), encrypted, { flag: "wx", mode: 384 });
      return ref;
    } finally {
      bytes.fill(0);
    }
  }
  async read(ref, principalId) {
    if (!/^pcr_[0-9a-f-]{36}$/u.test(ref)) throw new ProfileError("PROXY_CREDENTIALS_UNAVAILABLE");
    let bytes;
    try {
      bytes = await protect(await readFile(resolve2(this.root, `${ref}.bin`)), true);
      const value = JSON.parse(bytes.toString());
      if (value.principalId !== principalId) throw new Error("unauthorized");
      return { username: value.username, password: value.password };
    } catch {
      throw new ProfileError("PROXY_CREDENTIALS_UNAVAILABLE");
    } finally {
      bytes?.fill(0);
    }
  }
};

// tools/provision-proxy-credential.ts
var args = process.argv.slice(2);
var option = (key) => {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : void 0;
};
var db = resolve3(option("--db") ?? process.env.RELAY_DB_PATH ?? ".relay-data/relay.sqlite");
var store;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 16384) throw new Error("Input too large");
  }
  const secret = JSON.parse(input);
  store = new SqliteRelayStore(db);
  const principal = option("--principal") ?? store.authenticateAgent(readFileSync2(resolve3(dirname2(db), "admin-token.txt"), "utf8").trim())?.principalId;
  if (!principal || !store.getAgentById(principal)) throw new Error("Unknown principal");
  const vault = new ProxyCredentialStore(resolve3(dirname2(db), "proxy-credentials"));
  const credentialRef = await vault.provision(secret, principal);
  process.stdout.write(`${JSON.stringify({ credential_ref: credentialRef })}
`);
} catch {
  process.stderr.write("Credential provisioning failed. Check stdin JSON, database, principal and Windows vault access.\n");
  process.exitCode = 1;
} finally {
  store?.close();
}
