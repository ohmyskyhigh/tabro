ALTER TABLE commands ADD COLUMN run_id TEXT;

CREATE TABLE trace_events (
  trace_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command_id TEXT,
  target_alias TEXT,
  principal_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  connection_epoch INTEGER,
  outcome_code TEXT,
  observed_at TEXT NOT NULL
);

CREATE INDEX trace_events_run_idx ON trace_events(run_id, trace_id);
CREATE INDEX commands_run_idx ON commands(run_id, created_at);
