CREATE TABLE profile_proxies (
  profile_ref TEXT PRIMARY KEY,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  listener_port INTEGER UNIQUE CHECK(listener_port BETWEEN 1 AND 65535)
);
CREATE TABLE profile_proxy_requests (
  request_ref TEXT PRIMARY KEY REFERENCES request_tickets(request_ref),
  profile_ref TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES agents(principal_id),
  idempotency_key TEXT,
  body_hash TEXT NOT NULL,
  saved_revision INTEGER,
  UNIQUE(principal_id, idempotency_key)
);
