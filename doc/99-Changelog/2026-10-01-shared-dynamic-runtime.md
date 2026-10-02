# Shared dynamic Tabro runtime

## Decision

### Demo and ordinary MCP sessions now share one Broker

The user requested one shared deployment with dynamically allocated ports. This supersedes the earlier Plugin migration plan that preserved two fixed-port Brokers. The eighteen-tool contract and separate Agent session identities remain unchanged. Hermes Plugin packaging and installation are still pending.

## Implementation

### Runtime discovery replaces fixed MCP and relay addresses

Both Broker listeners default to port 0. The Broker publishes actual URLs, instance identity, PID and database path atomically. The stdio adapter validates the record and health identity, then reconnects before a new call when the instance changes. It never retries a dispatched operation. Native Host discovers the relay from `relay-runtime.json` beside its executable; older fixed-port installations without a discovery file retain their fallback behavior.

The local startup command reuses a healthy instance under a startup mutex. A data-directory lock also prevents duplicate Broker entry processes. Managed Chrome bootstrap uses the bound relay address. Demo preparation starts only the fixture and records the shared runtime; its shutdown does not stop the Broker.

### Both stores were backed up and merged without moving Chrome identity data

The merged store retains 14 browser endpoints, three managed Profiles and both stores' authentication, requests, workspaces and history. Historical integer audit IDs are offset; conflicting identities or invalid foreign keys abort the merge. The original managed root remains in the existing Demo directory. Nine Chrome authentication-related files had identical hashes before and after migration.

All 14 Hermes Profile registrations and Codex now reference `.relay-data/runtime.json` and the shared local credential file. The existing managed Profile owner's credential was reused, allowing the shared registrations to list those Profiles; other stored principals remain valid. Only the Tabro MCP configuration changed. Twelve previously running Hermes Gateways were stopped at an idle point and restored; the two previously stopped Profiles were not started.

Private database and configuration backups and verification reports are under `artifacts/unified-runtime/20261001-2320/`. Tokens and database credential contents are excluded from documentation and public page sources.

## Verification

### Automated tests and local clients verify discovery and preserved identity

The automated suite passed 185 tests after correcting a test fixture that closed its store before shutting down queued Broker work. Two E2E tests and all 17 Python migration tests passed, including four new merge tests. Lint, type checking, full build, PowerShell syntax and release staging passed. Staged packages declare runtime discovery version 1; the current updater rejects older packages before stopping an existing installation. Dynamic restart tests preserve the caller session; Native Host tests discover the actual relay instead of an old configured URL and reject invalid records. All 14 Hermes `mcp test tabro` checks discovered the exact 18 tools. A pre-existing Chrome extension automatically reconnected to the shared relay. A real Demo fixture reused the same Broker, and its shutdown left that Broker healthy. Duplicate direct Broker startup was rejected.

This is Windows local qualification. Linux/macOS runtime support, Plugin installation and an upstream default Provider menu have not been delivered. Chrome login pages were not reopened during consolidation; file preservation is the evidence for retained login data.
