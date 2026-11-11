import type {
  Page,
  RequestRecoverySnapshot,
  RequestRepository,
  StoredRequestAttempt,
  StoredRequestTicket,
  StoredTabLane
} from '../repositories.js';
import type { SqliteDatabase } from './runtime.js';
import type { SQLInputValue } from 'node:sqlite';
import { nowIso, nullableNumber, nullableString, pageLimit, parseJson, type Row } from './shared.js';

function toRequest(row: Row): StoredRequestTicket {
  return {
    requestRef: String(row.request_ref), toolName: String(row.tool_name), requesterSessionRef: String(row.requester_session_ref),
    authorityScope: String(row.authority_scope) as StoredRequestTicket['authorityScope'], authoritySessionRef: String(row.authority_session_ref),
    authorityLineageRef: String(row.authority_lineage_ref), endpointRef: nullableString(row.endpoint_ref),
    workspaceRef: nullableString(row.workspace_ref), tabRef: nullableString(row.tab_ref), acceptedOwnerEpoch: nullableNumber(row.accepted_owner_epoch),
    normalizedBody: parseJson(row.normalized_body_json), state: String(row.state) as StoredRequestTicket['state'],
    phase: String(row.phase), checkpoint: parseJson(row.checkpoint_json), pauseCondition: nullableString(row.pause_condition),
    problem: row.problem_json === null ? null : parseJson(row.problem_json), result: row.result_json === null ? null : parseJson(row.result_json),
    effectMayHaveOccurred: Boolean(row.effect_may_have_occurred),
    acknowledgementState: String(row.acknowledgement_state) as StoredRequestTicket['acknowledgementState'],
    acknowledgedAt: nullableString(row.acknowledged_at), publiclyVisible: Boolean(row.publicly_visible),
    lanePosition: nullableNumber(row.lane_position), claimGeneration: Number(row.claim_generation), claimedBy: nullableString(row.claimed_by),
    claimExpiresAt: nullableString(row.claim_expires_at), acceptedAt: String(row.accepted_at), updatedAt: String(row.updated_at),
    terminalAt: nullableString(row.terminal_at), closedAt: nullableString(row.closed_at),
    resolutionOfRequestRef: nullableString(row.resolution_of_request_ref)
  };
}

function toAttempt(row: Row): StoredRequestAttempt {
  return {
    attemptRef: String(row.attempt_ref), requestRef: String(row.request_ref), attemptNumber: Number(row.attempt_number),
    endpointRef: String(row.endpoint_ref), connectionGeneration: Number(row.connection_generation),
    locatorGeneration: nullableNumber(row.locator_generation), attachmentGeneration: nullableNumber(row.attachment_generation),
    privateMessageRef: nullableString(row.private_message_ref), state: String(row.state) as StoredRequestAttempt['state'],
    outcome: row.outcome_json === null ? null : parseJson(row.outcome_json), effectClassification: nullableString(row.effect_classification),
    preparedAt: String(row.prepared_at), dispatchedAt: nullableString(row.dispatched_at), completedAt: nullableString(row.completed_at)
  };
}

function toLane(row: Row): StoredTabLane {
  return {
    workspaceRef: String(row.workspace_ref), tabRef: String(row.tab_ref), nextPosition: Number(row.next_position),
    headRequestRef: nullableString(row.head_request_ref), laneGeneration: Number(row.lane_generation), updatedAt: String(row.updated_at)
  };
}

export class SqliteRequestRepository implements RequestRepository {
  constructor(private readonly db: SqliteDatabase) {}

  browserRulesInitialized(): boolean {
    return !!this.db.prepare('SELECT 1 FROM browser_rules_initialization WHERE singleton=1').get();
  }
  markBrowserRulesInitialized(): void {
    this.db.prepare('INSERT OR IGNORE INTO browser_rules_initialization VALUES(1,?)').run(nowIso());
  }
  inputStates(): ReturnType<RequestRepository['inputStates']> {
    return (this.db.prepare('SELECT state_json FROM browser_input_states').all() as Row[]).map(row => parseJson(row.state_json));
  }
  saveInputState(tabRef: string, state: Parameters<RequestRepository['saveInputState']>[1]): void {
    if (state === null) { this.db.prepare('DELETE FROM browser_input_states WHERE tab_ref=?').run(tabRef); return; }
    this.db.prepare('INSERT INTO browser_input_states(tab_ref,state_json) VALUES(?,?) ON CONFLICT(tab_ref) DO UPDATE SET state_json=excluded.state_json')
      .run(tabRef, JSON.stringify(state));
  }

  private insertTransition(request: StoredRequestTicket, reasonCode: string | null, at: string): void {
    this.db.prepare(`INSERT INTO request_transitions(request_ref,state,phase,checkpoint_json,pause_condition,reason_code,claim_generation,observed_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(request.requestRef, request.state, request.phase, JSON.stringify(request.checkpoint),
      request.pauseCondition, reasonCode, request.claimGeneration, at);
  }

  private advanceLane(request: StoredRequestTicket, at: string): void {
    if (!request.workspaceRef || !request.tabRef || request.lanePosition === null) return;
    const lane = this.db.prepare(`SELECT * FROM tab_lanes WHERE workspace_ref = ? AND tab_ref = ? AND head_request_ref = ?`)
      .get(request.workspaceRef, request.tabRef, request.requestRef) as Row | undefined;
    if (!lane) return;
    const next = this.db.prepare(`SELECT request_ref FROM request_tickets
      WHERE workspace_ref = ? AND tab_ref = ? AND lane_position > ? AND state IN ('queued','running') AND publicly_visible = 1
      ORDER BY lane_position LIMIT 1`).get(request.workspaceRef, request.tabRef, request.lanePosition) as Row | undefined;
    this.db.prepare(`UPDATE tab_lanes SET head_request_ref = ?, lane_generation = lane_generation + 1, updated_at = ?
      WHERE workspace_ref = ? AND tab_ref = ? AND head_request_ref = ?`).run(
      next ? String(next.request_ref) : null, at, request.workspaceRef, request.tabRef, request.requestRef);
  }

  acceptRequest(input: Parameters<RequestRepository['acceptRequest']>[0]): StoredRequestTicket {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      let lanePosition: number | null = null;
      if (input.tabRef !== undefined) {
        if (!input.workspaceRef) throw new Error('WORKSPACE_REQUIRED_FOR_TAB');
        this.db.prepare(`INSERT INTO tab_lanes(workspace_ref,tab_ref,next_position,updated_at) VALUES(?,?,1,?)
          ON CONFLICT(workspace_ref,tab_ref) DO NOTHING`).run(input.workspaceRef, input.tabRef, at);
        const lane = this.db.prepare('SELECT * FROM tab_lanes WHERE workspace_ref = ? AND tab_ref = ?')
          .get(input.workspaceRef, input.tabRef) as Row;
        lanePosition = Number(lane.next_position);
      }
      this.db.prepare(`INSERT INTO request_tickets(request_ref,tool_name,requester_session_ref,authority_scope,authority_session_ref,
        authority_lineage_ref,endpoint_ref,workspace_ref,tab_ref,accepted_owner_epoch,normalized_body_json,state,phase,
        checkpoint_json,lane_position,accepted_at,updated_at,resolution_of_request_ref)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?)`).run(
        input.requestRef, input.toolName, input.requesterSessionRef, input.authorityScope, input.authoritySessionRef,
        input.authorityLineageRef, input.endpointRef ?? null, input.workspaceRef ?? null, input.tabRef ?? null,
        input.acceptedOwnerEpoch ?? null, JSON.stringify(input.normalizedBody), input.phase, JSON.stringify(input.checkpoint),
        lanePosition, at, at, input.resolutionOfRequestRef ?? null);
      if (input.tabRef !== undefined && input.workspaceRef && lanePosition !== null) {
        this.db.prepare(`UPDATE tab_lanes SET next_position = next_position + 1,
          head_request_ref = COALESCE(head_request_ref, ?), updated_at = ? WHERE workspace_ref = ? AND tab_ref = ?`)
          .run(input.requestRef, at, input.workspaceRef, input.tabRef);
      }
      const request = this.getRequest(input.requestRef)!;
      this.insertTransition(request, 'accepted', at);
      return request;
    })();
  }

  getRequest(requestRef: string): StoredRequestTicket | null {
    const row = this.db.prepare('SELECT * FROM request_tickets WHERE request_ref = ?').get(requestRef) as Row | undefined;
    return row ? toRequest(row) : null;
  }

  listVisibleRequests(input: Parameters<RequestRepository['listVisibleRequests']>[0]): Page<StoredRequestTicket> {
    const limit = pageLimit(input.page.limit);
    const clauses = [`authority_lineage_ref = ?`, `publicly_visible = 1`, `closed_at IS NULL`, `request_ref > ?`];
    const values: SQLInputValue[] = [input.authorityLineageRef, input.page.after ?? ''];
    if (input.authoritySessionRef) {
      clauses.push(`(authority_scope = 'owner' OR authority_session_ref = ?)`);
      values.push(input.authoritySessionRef);
    } else {
      clauses.push(`authority_scope = 'owner'`);
    }
    if (input.workspaceRef) { clauses.push('workspace_ref = ?'); values.push(input.workspaceRef); }
    if (!input.includeTerminal) clauses.push(`state IN ('queued','running')`);
    values.push(limit + 1);
    const rows = this.db.prepare(`SELECT * FROM request_tickets WHERE ${clauses.join(' AND ')} ORDER BY request_ref LIMIT ?`)
      .all(...values) as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toRequest);
    return { items, next: hasMore ? items.at(-1)?.requestRef ?? null : null };
  }

  markAcknowledgementDelivered(requestRef: string, at = nowIso()): StoredRequestTicket | null {
    const result = this.db.prepare(`UPDATE request_tickets SET acknowledgement_state = 'delivered', acknowledged_at = ?, updated_at = ?
      WHERE request_ref = ? AND acknowledgement_state = 'pending' AND state = 'queued'`).run(at, at, requestRef);
    if (result.changes !== 1) return null;
    const request = this.getRequest(requestRef)!;
    this.insertTransition(request, 'acknowledgement_delivered', at);
    return request;
  }

  failAcknowledgement(requestRef: string, reasonCode: string, at = nowIso()): StoredRequestTicket | null {
    return this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE request_tickets SET acknowledgement_state = 'failed', publicly_visible = 0, state = 'failed',
        phase = 'acknowledgement_failed', problem_json = ?, terminal_at = ?, updated_at = ?
        WHERE request_ref = ? AND acknowledgement_state = 'pending' AND state = 'queued'`)
        .run(JSON.stringify({ code: reasonCode }), at, at, requestRef);
      if (result.changes !== 1) return null;
      const request = this.getRequest(requestRef)!;
      this.insertTransition(request, reasonCode, at);
      this.advanceLane(request, at);
      return request;
    })();
  }

  claimRequest(input: Parameters<RequestRepository['claimRequest']>[0]): StoredRequestTicket | null {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const current = this.getRequest(input.requestRef);
      if (!current || current.acknowledgementState !== 'delivered' || !current.publiclyVisible || !['queued', 'running'].includes(current.state)) return null;
      if (current.workspaceRef && current.tabRef) {
        const lane = this.db.prepare('SELECT head_request_ref FROM tab_lanes WHERE workspace_ref = ? AND tab_ref = ?')
          .get(current.workspaceRef, current.tabRef) as Row | undefined;
        if (!lane || (String(lane.head_request_ref) !== current.requestRef && !input.recoveryObservation)) return null;
      }
      const result = this.db.prepare(`UPDATE request_tickets SET state = 'running', claimed_by = ?, claim_expires_at = ?,
        claim_generation = claim_generation + 1, updated_at = ? WHERE request_ref = ? AND state IN ('queued','running')
        AND (claimed_by IS NULL OR claim_expires_at <= ? OR claimed_by = ?)`)
        .run(input.workerRef, input.leaseExpiresAt, at, input.requestRef, at, input.workerRef);
      if (result.changes !== 1) return null;
      const request = this.getRequest(input.requestRef)!;
      this.insertTransition(request, 'worker_claimed', at);
      return request;
    })();
  }

  recordCheckpoint(input: Parameters<RequestRepository['recordCheckpoint']>[0]): StoredRequestTicket | null {
    const at = input.at ?? nowIso();
    const result = this.db.prepare(`UPDATE request_tickets SET phase = ?, checkpoint_json = ?, pause_condition = ?, updated_at = ?
      WHERE request_ref = ? AND state IN ('queued','running') AND claim_generation = ?`).run(
      input.phase, JSON.stringify(input.checkpoint), input.pauseCondition === undefined ? null : input.pauseCondition,
      at, input.requestRef, input.expectedClaimGeneration);
    if (result.changes !== 1) return null;
    const request = this.getRequest(input.requestRef)!;
    this.insertTransition(request, input.reasonCode ?? null, at);
    return request;
  }

  startAttempt(input: Parameters<RequestRepository['startAttempt']>[0]): StoredRequestAttempt {
    const at = input.at ?? nowIso();
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT COALESCE(MAX(attempt_number),0) AS value FROM request_attempts WHERE request_ref = ?')
        .get(input.requestRef) as Row;
      const attemptNumber = Number(row.value) + 1;
      this.db.prepare(`INSERT INTO request_attempts(attempt_ref,request_ref,attempt_number,endpoint_ref,connection_generation,
        locator_generation,attachment_generation,private_message_ref,state,prepared_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?)`).run(
        input.attemptRef, input.requestRef, attemptNumber, input.endpointRef, input.connectionGeneration,
        input.locatorGeneration ?? null, input.attachmentGeneration ?? null, input.privateMessageRef ?? null, at);
      return this.getAttempt(input.attemptRef)!;
    })();
  }

  private getAttempt(attemptRef: string): StoredRequestAttempt | null {
    const row = this.db.prepare('SELECT * FROM request_attempts WHERE attempt_ref = ?').get(attemptRef) as Row | undefined;
    return row ? toAttempt(row) : null;
  }

  markAttemptDispatched(attemptRef: string, at = nowIso()): StoredRequestAttempt | null {
    const result = this.db.prepare(`UPDATE request_attempts SET state = 'dispatched', dispatched_at = ?
      WHERE attempt_ref = ? AND state = 'prepared'`).run(at, attemptRef);
    return result.changes === 1 ? this.getAttempt(attemptRef) : null;
  }

  finishAttempt(input: Parameters<RequestRepository['finishAttempt']>[0]): StoredRequestAttempt | null {
    const at = input.at ?? nowIso();
    const result = this.db.prepare(`UPDATE request_attempts SET state = ?, outcome_json = ?, effect_classification = ?, completed_at = ?
      WHERE attempt_ref = ? AND state IN ('prepared','dispatched')`).run(input.state,
      input.outcome === undefined ? null : JSON.stringify(input.outcome), input.effectClassification ?? null, at, input.attemptRef);
    return result.changes === 1 ? this.getAttempt(input.attemptRef) : null;
  }

  terminalizeRequest(input: Parameters<RequestRepository['terminalizeRequest']>[0]): StoredRequestTicket | null {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const values: SQLInputValue[] = [input.state, input.phase, JSON.stringify(input.checkpoint),
        input.problem === undefined ? null : JSON.stringify(input.problem), input.result === undefined ? null : JSON.stringify(input.result),
        Number(input.effectMayHaveOccurred ?? false), at, at, input.requestRef];
      let claimClause = '';
      if (input.expectedClaimGeneration !== undefined) { claimClause = ' AND claim_generation = ?'; values.push(input.expectedClaimGeneration); }
      const result = this.db.prepare(`UPDATE request_tickets SET state = ?, phase = ?, checkpoint_json = ?, pause_condition = NULL,
        problem_json = ?, result_json = ?, effect_may_have_occurred = ?, terminal_at = ?, updated_at = ?,
        claimed_by = NULL, claim_expires_at = NULL WHERE request_ref = ? AND state IN ('queued','running')${claimClause}`).run(...values);
      if (result.changes !== 1) return null;
      const request = this.getRequest(input.requestRef)!;
      this.insertTransition(request, input.reasonCode ?? null, at);
      this.advanceLane(request, at);
      return request;
    })();
  }

  closeRequest(input: Parameters<RequestRepository['closeRequest']>[0]): boolean {
    const at = input.at ?? nowIso();
    const values: SQLInputValue[] = [at, at, input.requestRef, input.authoritySessionRef, input.authoritySessionRef];
    let ownerClause = '';
    if (input.expectedOwnerEpoch !== undefined) { ownerClause = ' AND (authority_scope = \'requester\' OR accepted_owner_epoch = ?)'; values.push(input.expectedOwnerEpoch); }
    const result = this.db.prepare(`UPDATE request_tickets SET closed_at = ?, publicly_visible = 0, updated_at = ?
      WHERE request_ref = ? AND closed_at IS NULL AND publicly_visible = 1 AND state IN ('succeeded','failed','uncertain')
      AND ((authority_scope = 'requester' AND requester_session_ref = ?) OR (authority_scope = 'owner' AND authority_session_ref = ?))${ownerClause}`)
      .run(...values);
    return result.changes === 1;
  }

  resolveRequest(input: Parameters<RequestRepository['resolveRequest']>[0]): boolean {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const target = this.getRequest(input.targetRequestRef);
      const resolver = this.getRequest(input.resolverRequestRef);
      if (!target || target.state !== 'running' || target.pauseCondition !== 'user_confirmation_required'
        || !resolver || !['queued', 'running'].includes(resolver.state)) return false;
      const targetResult = this.db.prepare(`UPDATE request_tickets SET state = ?, phase = 'human_resolved', checkpoint_json = ?,
        pause_condition = NULL, problem_json = ?, result_json = ?, effect_may_have_occurred = ?, terminal_at = ?, updated_at = ?, claimed_by = NULL, claim_expires_at = NULL
        WHERE request_ref = ? AND state = 'running' AND pause_condition = 'user_confirmation_required'`)
        .run(input.targetState, JSON.stringify({ name: 'human_resolved', recorded_at: at }),
          input.targetProblem === undefined ? null : JSON.stringify(input.targetProblem),
          input.targetResult === undefined ? null : JSON.stringify(input.targetResult),
          Number(input.targetEffectMayHaveOccurred ?? false), at, at, input.targetRequestRef);
      if (targetResult.changes !== 1) return false;
      const resolverState = input.resolverState ?? 'succeeded';
      const resolverResult = this.db.prepare(`UPDATE request_tickets SET state = ?, phase = 'resolved', checkpoint_json = ?,
        result_json = ?, terminal_at = ?, updated_at = ? WHERE request_ref = ? AND state IN ('queued','running')`).run(
        resolverState,
        JSON.stringify({ name: 'resolved', recorded_at: at, details: {} }),
        JSON.stringify(input.resolverResult ?? { target_request_ref: input.targetRequestRef, target_state: input.targetState }),
        at, at, input.resolverRequestRef);
      if (resolverResult.changes !== 1) throw new Error('STALE_RESOLVER_REQUEST');
      const updatedTarget = this.getRequest(input.targetRequestRef)!;
      const updatedResolver = this.getRequest(input.resolverRequestRef)!;
      this.insertTransition(updatedTarget, 'human_resolution', at);
      this.insertTransition(updatedResolver, 'resolution_completed', at);
      this.advanceLane(updatedTarget, at);
      this.advanceLane(updatedResolver, at);
      return true;
    })();
  }

  scanRequestRecovery(_at = nowIso()): RequestRecoverySnapshot {
    const requests = (this.db.prepare(`SELECT * FROM request_tickets WHERE state IN ('queued','running','uncertain')
      AND publicly_visible = 1 ORDER BY accepted_at, request_ref`).all() as Row[]).map(toRequest);
    const attempts = (this.db.prepare(`SELECT request_attempts.* FROM request_attempts
      JOIN request_tickets ON request_tickets.request_ref = request_attempts.request_ref
      WHERE request_tickets.state IN ('queued','running','uncertain') ORDER BY request_attempts.prepared_at`).all() as Row[]).map(toAttempt);
    const lanes = (this.db.prepare(`SELECT * FROM tab_lanes WHERE head_request_ref IS NOT NULL ORDER BY workspace_ref,tab_ref`).all() as Row[]).map(toLane);
    return { requests, attempts, lanes };
  }
}
