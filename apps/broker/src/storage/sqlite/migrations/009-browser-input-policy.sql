CREATE TABLE browser_rules_initialization (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  initialized_at TEXT NOT NULL
);
CREATE TABLE browser_input_states (
  window_ref TEXT PRIMARY KEY,
  state_json TEXT NOT NULL
);
