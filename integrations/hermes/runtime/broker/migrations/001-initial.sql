PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  principal_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  target_id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  public_key_jwk TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  last_error_at TEXT,
  status_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(target_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES agents(principal_id),
  fencing_token INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_lease_per_target
ON leases(target_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  handle_hash TEXT NOT NULL UNIQUE,
  lease_id TEXT NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES agents(principal_id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES agents(principal_id),
  target_id TEXT NOT NULL REFERENCES targets(target_id),
  lease_id TEXT REFERENCES leases(lease_id),
  fencing_token INTEGER,
  operation TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  idempotency_class TEXT NOT NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  delivered_epoch INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(principal_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS command_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL REFERENCES commands(command_id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  reason_code TEXT,
  connection_epoch INTEGER,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  command_id TEXT PRIMARY KEY REFERENCES commands(command_id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  output_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  principal_id TEXT,
  target_alias TEXT,
  context_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS commands_target_state_idx ON commands(target_id, state);
CREATE INDEX IF NOT EXISTS commands_principal_idx ON commands(principal_id, created_at);
CREATE INDEX IF NOT EXISTS command_events_command_idx ON command_events(command_id, event_id);
