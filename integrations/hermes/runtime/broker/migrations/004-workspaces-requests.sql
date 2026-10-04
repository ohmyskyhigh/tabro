PRAGMA foreign_keys = ON;

CREATE TABLE browser_endpoints (
  endpoint_ref TEXT PRIMARY KEY,
  legacy_target_id TEXT UNIQUE REFERENCES targets(target_id),
  nickname TEXT NOT NULL UNIQUE,
  pairing_identity_hash TEXT,
  credential_json TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'paired' CHECK(lifecycle IN ('paired','revoked')),
  connection_generation INTEGER NOT NULL DEFAULT 0 CHECK(connection_generation >= 0),
  status_version INTEGER NOT NULL DEFAULT 1 CHECK(status_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO browser_endpoints(
  endpoint_ref, legacy_target_id, nickname, credential_json, lifecycle,
  connection_generation, status_version, created_at, updated_at
)
SELECT
  'ep_' || lower(hex(randomblob(16))), target_id, alias, public_key_jwk,
  CASE WHEN revoked = 1 THEN 'revoked' ELSE 'paired' END,
  0, status_version, created_at, updated_at
FROM targets;

CREATE TABLE endpoint_connections (
  endpoint_ref TEXT NOT NULL REFERENCES browser_endpoints(endpoint_ref) ON DELETE CASCADE,
  connection_generation INTEGER NOT NULL CHECK(connection_generation > 0),
  connection_ref TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  extension_version TEXT,
  browser_product TEXT,
  browser_version TEXT,
  connected_at TEXT NOT NULL,
  disconnected_at TEXT,
  disconnect_reason TEXT,
  PRIMARY KEY(endpoint_ref, connection_generation)
);

CREATE UNIQUE INDEX one_live_connection_per_endpoint
ON endpoint_connections(endpoint_ref) WHERE disconnected_at IS NULL;

CREATE TABLE caller_lineages (
  lineage_ref TEXT PRIMARY KEY,
  runtime_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE caller_sessions (
  session_ref TEXT PRIMARY KEY,
  lineage_ref TEXT NOT NULL REFERENCES caller_lineages(lineage_ref),
  parent_session_ref TEXT REFERENCES caller_sessions(session_ref),
  runtime_session_key_hash TEXT NOT NULL UNIQUE,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','ended')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX caller_sessions_lineage_idx
ON caller_sessions(lineage_ref, lifecycle, created_at);

CREATE TABLE logical_windows (
  window_ref TEXT PRIMARY KEY,
  endpoint_ref TEXT NOT NULL REFERENCES browser_endpoints(endpoint_ref),
  private_window_key TEXT NOT NULL,
  locator_generation INTEGER NOT NULL CHECK(locator_generation > 0),
  focused INTEGER NOT NULL DEFAULT 0 CHECK(focused IN (0,1)),
  eligible INTEGER NOT NULL DEFAULT 1 CHECK(eligible IN (0,1)),
  last_observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(window_ref, endpoint_ref),
  UNIQUE(endpoint_ref, private_window_key, locator_generation)
);

CREATE INDEX logical_windows_endpoint_focus_idx
ON logical_windows(endpoint_ref, eligible, focused, last_observed_at DESC);

CREATE TABLE browser_workspaces (
  workspace_ref TEXT PRIMARY KEY,
  endpoint_ref TEXT NOT NULL REFERENCES browser_endpoints(endpoint_ref),
  window_ref TEXT NOT NULL,
  lineage_ref TEXT NOT NULL REFERENCES caller_lineages(lineage_ref),
  owner_session_ref TEXT NOT NULL REFERENCES caller_sessions(session_ref),
  parent_workspace_ref TEXT REFERENCES browser_workspaces(workspace_ref),
  group_label TEXT NOT NULL,
  private_group_key TEXT,
  locator_generation INTEGER NOT NULL DEFAULT 1 CHECK(locator_generation > 0),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','ended')),
  owner_epoch INTEGER NOT NULL DEFAULT 1 CHECK(owner_epoch > 0),
  control_epoch INTEGER NOT NULL DEFAULT 0 CHECK(control_epoch >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY(window_ref, endpoint_ref) REFERENCES logical_windows(window_ref, endpoint_ref)
);

CREATE INDEX browser_workspaces_owner_idx
ON browser_workspaces(lineage_ref, owner_session_ref, lifecycle, created_at);
CREATE INDEX browser_workspaces_endpoint_idx
ON browser_workspaces(endpoint_ref, lifecycle, created_at);

CREATE TABLE managed_tabs (
  tab_ref TEXT PRIMARY KEY,
  workspace_ref TEXT NOT NULL REFERENCES browser_workspaces(workspace_ref),
  endpoint_ref TEXT NOT NULL REFERENCES browser_endpoints(endpoint_ref),
  window_ref TEXT NOT NULL REFERENCES logical_windows(window_ref),
  opener_tab_ref TEXT REFERENCES managed_tabs(tab_ref),
  private_tab_key TEXT NOT NULL,
  locator_generation INTEGER NOT NULL CHECK(locator_generation > 0),
  attachment_generation INTEGER NOT NULL DEFAULT 0 CHECK(attachment_generation >= 0),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','closed','replaced')),
  title TEXT,
  url TEXT,
  last_observed_at TEXT NOT NULL,
  replaced_by_tab_ref TEXT REFERENCES managed_tabs(tab_ref),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tab_ref, workspace_ref),
  UNIQUE(endpoint_ref, private_tab_key, locator_generation)
);

CREATE INDEX managed_tabs_workspace_idx
ON managed_tabs(workspace_ref, lifecycle, created_at);

CREATE TABLE workspace_pause_causes (
  workspace_ref TEXT NOT NULL REFERENCES browser_workspaces(workspace_ref) ON DELETE CASCADE,
  cause TEXT NOT NULL,
  source_request_ref TEXT,
  recorded_at TEXT NOT NULL,
  cleared_at TEXT,
  PRIMARY KEY(workspace_ref, cause)
);

CREATE TABLE capability_selections (
  capability_selection_ref TEXT PRIMARY KEY,
  endpoint_ref TEXT NOT NULL REFERENCES browser_endpoints(endpoint_ref),
  connection_generation INTEGER NOT NULL,
  profile_version TEXT NOT NULL,
  browser_product TEXT,
  browser_version TEXT,
  extension_version TEXT,
  methods_json TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  retired_at TEXT,
  FOREIGN KEY(endpoint_ref, connection_generation)
    REFERENCES endpoint_connections(endpoint_ref, connection_generation)
);

CREATE INDEX capability_selections_current_idx
ON capability_selections(endpoint_ref, retired_at, selected_at DESC);

CREATE TABLE request_tickets (
  request_ref TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  requester_session_ref TEXT NOT NULL REFERENCES caller_sessions(session_ref),
  authority_scope TEXT NOT NULL CHECK(authority_scope IN ('owner','requester')),
  authority_session_ref TEXT NOT NULL REFERENCES caller_sessions(session_ref),
  authority_lineage_ref TEXT NOT NULL REFERENCES caller_lineages(lineage_ref),
  endpoint_ref TEXT REFERENCES browser_endpoints(endpoint_ref),
  workspace_ref TEXT REFERENCES browser_workspaces(workspace_ref),
  tab_ref TEXT,
  accepted_owner_epoch INTEGER,
  normalized_body_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','uncertain')),
  phase TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  pause_condition TEXT,
  problem_json TEXT,
  result_json TEXT,
  effect_may_have_occurred INTEGER NOT NULL DEFAULT 0 CHECK(effect_may_have_occurred IN (0,1)),
  acknowledgement_state TEXT NOT NULL DEFAULT 'pending' CHECK(acknowledgement_state IN ('pending','delivered','failed')),
  acknowledged_at TEXT,
  publicly_visible INTEGER NOT NULL DEFAULT 1 CHECK(publicly_visible IN (0,1)),
  lane_position INTEGER,
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(claim_generation >= 0),
  claimed_by TEXT,
  claim_expires_at TEXT,
  accepted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  closed_at TEXT,
  resolution_of_request_ref TEXT REFERENCES request_tickets(request_ref),
  FOREIGN KEY(tab_ref, workspace_ref) REFERENCES managed_tabs(tab_ref, workspace_ref),
  CHECK((tab_ref IS NULL AND lane_position IS NULL) OR (tab_ref IS NOT NULL AND workspace_ref IS NOT NULL AND lane_position IS NOT NULL))
);

CREATE INDEX request_tickets_owner_visible_idx
ON request_tickets(authority_lineage_ref, authority_session_ref, publicly_visible, accepted_at, request_ref);
CREATE INDEX request_tickets_workspace_idx
ON request_tickets(workspace_ref, publicly_visible, accepted_at, request_ref);
CREATE INDEX request_tickets_recovery_idx
ON request_tickets(state, acknowledgement_state, pause_condition, claim_expires_at, accepted_at);
CREATE UNIQUE INDEX request_tickets_lane_position_idx
ON request_tickets(workspace_ref, tab_ref, lane_position) WHERE lane_position IS NOT NULL;

CREATE TABLE request_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_ref TEXT NOT NULL REFERENCES request_tickets(request_ref) ON DELETE CASCADE,
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  pause_condition TEXT,
  reason_code TEXT,
  claim_generation INTEGER NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE INDEX request_transitions_request_idx
ON request_transitions(request_ref, transition_id);

CREATE TABLE request_attempts (
  attempt_ref TEXT PRIMARY KEY,
  request_ref TEXT NOT NULL REFERENCES request_tickets(request_ref) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  endpoint_ref TEXT NOT NULL REFERENCES browser_endpoints(endpoint_ref),
  connection_generation INTEGER NOT NULL,
  locator_generation INTEGER,
  attachment_generation INTEGER,
  private_message_ref TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','completed','missing')),
  outcome_json TEXT,
  effect_classification TEXT,
  prepared_at TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at TEXT,
  UNIQUE(request_ref, attempt_number),
  FOREIGN KEY(endpoint_ref, connection_generation)
    REFERENCES endpoint_connections(endpoint_ref, connection_generation)
);

CREATE INDEX request_attempts_recovery_idx
ON request_attempts(state, request_ref, attempt_number);

CREATE TABLE tab_lanes (
  workspace_ref TEXT NOT NULL,
  tab_ref TEXT NOT NULL,
  next_position INTEGER NOT NULL DEFAULT 1 CHECK(next_position > 0),
  head_request_ref TEXT REFERENCES request_tickets(request_ref),
  lane_generation INTEGER NOT NULL DEFAULT 1 CHECK(lane_generation > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_ref, tab_ref),
  FOREIGN KEY(tab_ref, workspace_ref) REFERENCES managed_tabs(tab_ref, workspace_ref)
);

CREATE INDEX tab_lanes_heads_idx
ON tab_lanes(head_request_ref, updated_at);

CREATE TABLE control_records (
  control_ref TEXT PRIMARY KEY,
  request_ref TEXT NOT NULL UNIQUE REFERENCES request_tickets(request_ref),
  kind TEXT NOT NULL CHECK(kind IN ('workspace_stop','workspace_resume','endpoint_kill','endpoint_resume','takeover','termination','human_resolution')),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('request','workspace','endpoint')),
  scope_ref TEXT NOT NULL,
  control_epoch INTEGER NOT NULL CHECK(control_epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('active','succeeded','failed')),
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  terminal_at TEXT
);

CREATE INDEX control_records_active_idx
ON control_records(scope_type, scope_ref, state, control_epoch);

CREATE TABLE event_streams (
  stream_ref TEXT PRIMARY KEY,
  tab_ref TEXT NOT NULL REFERENCES managed_tabs(tab_ref),
  stream_generation INTEGER NOT NULL CHECK(stream_generation > 0),
  initial_cursor_ref TEXT NOT NULL UNIQUE,
  baseline_json TEXT NOT NULL,
  next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','replaced','ended')),
  created_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(tab_ref, stream_generation)
);

CREATE UNIQUE INDEX one_active_event_stream_per_tab
ON event_streams(tab_ref) WHERE state = 'active';

CREATE TABLE event_cursors (
  cursor_ref TEXT PRIMARY KEY,
  stream_ref TEXT NOT NULL REFERENCES event_streams(stream_ref) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  query_hash TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL CHECK(owner_epoch > 0),
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(stream_ref, sequence, query_hash, owner_epoch)
);

CREATE TABLE cdp_events (
  stream_ref TEXT NOT NULL REFERENCES event_streams(stream_ref) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  method TEXT NOT NULL,
  params_json TEXT NOT NULL,
  connection_generation INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(stream_ref, sequence)
);

CREATE INDEX cdp_events_read_idx
ON cdp_events(stream_ref, sequence);

CREATE TABLE status_observations (
  observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('broker','endpoint','window','workspace','tab','request','attachment')),
  subject_ref TEXT NOT NULL,
  condition TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  source TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation >= 0),
  observed_at TEXT NOT NULL
);

CREATE INDEX status_observations_subject_idx
ON status_observations(subject_type, subject_ref, observation_id DESC);

CREATE TABLE canonical_audit_events (
  audit_ref TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_session_ref TEXT REFERENCES caller_sessions(session_ref),
  endpoint_ref TEXT REFERENCES browser_endpoints(endpoint_ref),
  workspace_ref TEXT REFERENCES browser_workspaces(workspace_ref),
  tab_ref TEXT REFERENCES managed_tabs(tab_ref),
  request_ref TEXT REFERENCES request_tickets(request_ref),
  context_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE INDEX canonical_audit_request_idx
ON canonical_audit_events(request_ref, observed_at, audit_ref);
CREATE INDEX canonical_audit_workspace_idx
ON canonical_audit_events(workspace_ref, observed_at, audit_ref);
