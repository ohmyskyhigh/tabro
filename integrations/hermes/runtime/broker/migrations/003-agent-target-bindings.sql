CREATE TABLE agent_target_bindings (
  binding_id TEXT PRIMARY KEY,
  binding_ref TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL REFERENCES agents(principal_id),
  target_id TEXT NOT NULL REFERENCES targets(target_id),
  mode TEXT NOT NULL CHECK(mode = 'dedicated'),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX one_active_binding_per_principal
ON agent_target_bindings(principal_id) WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX one_active_binding_per_target
ON agent_target_bindings(target_id) WHERE revoked_at IS NULL;

CREATE INDEX bindings_target_idx
ON agent_target_bindings(target_id, revoked_at);

ALTER TABLE commands ADD COLUMN binding_ref TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX commands_binding_ref_idx ON commands(binding_ref, created_at);

ALTER TABLE trace_events ADD COLUMN binding_ref TEXT;
