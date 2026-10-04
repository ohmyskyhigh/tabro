CREATE TABLE managed_profiles (
  profile_ref TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES agents(principal_id),
  data_dir_key TEXT NOT NULL UNIQUE,
  runtime_ref TEXT NOT NULL,
  endpoint_ref TEXT UNIQUE REFERENCES browser_endpoints(endpoint_ref),
  identity_hash TEXT,
  problem_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX managed_profiles_owner ON managed_profiles(principal_id, created_at, profile_ref);

CREATE TABLE managed_browser_instances (
  instance_ref TEXT PRIMARY KEY,
  profile_ref TEXT NOT NULL REFERENCES managed_profiles(profile_ref),
  generation INTEGER NOT NULL CHECK(generation > 0),
  browser_state TEXT NOT NULL CHECK(browser_state IN ('starting','running','stopping','stopped','unknown')),
  extension_state TEXT NOT NULL CHECK(extension_state IN ('unknown','missing','connecting','connected','disconnected')),
  authenticated_at TEXT,
  pid INTEGER,
  process_created_at TEXT,
  executable_path TEXT,
  data_dir TEXT,
  management_url TEXT,
  observed_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(profile_ref, generation)
);
CREATE UNIQUE INDEX managed_one_live_instance ON managed_browser_instances(profile_ref) WHERE ended_at IS NULL;

CREATE TABLE profile_requests (
  request_ref TEXT PRIMARY KEY REFERENCES request_tickets(request_ref),
  profile_ref TEXT NOT NULL REFERENCES managed_profiles(profile_ref),
  principal_id TEXT NOT NULL REFERENCES agents(principal_id)
);
CREATE INDEX profile_request_resource ON profile_requests(profile_ref, request_ref);

CREATE TABLE profile_create_keys (
  principal_id TEXT NOT NULL REFERENCES agents(principal_id),
  idempotency_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  profile_ref TEXT NOT NULL REFERENCES managed_profiles(profile_ref),
  request_ref TEXT NOT NULL REFERENCES request_tickets(request_ref),
  PRIMARY KEY(principal_id, idempotency_key)
);

CREATE TABLE profile_operation_locks (
  profile_ref TEXT PRIMARY KEY REFERENCES managed_profiles(profile_ref),
  owner_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE managed_bootstrap_grants (
  grant_ref TEXT PRIMARY KEY,
  profile_ref TEXT NOT NULL REFERENCES managed_profiles(profile_ref),
  instance_ref TEXT NOT NULL REFERENCES managed_browser_instances(instance_ref),
  generation INTEGER NOT NULL,
  secret_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE profile_list_cursors (
  cursor_ref TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES agents(principal_id),
  after_created_at TEXT NOT NULL,
  after_profile_ref TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
