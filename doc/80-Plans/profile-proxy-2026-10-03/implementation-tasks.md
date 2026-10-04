# Profile proxy implementation tasks

**Plan date:** 2026-10-03
**Status:** Historical initial task breakdown. Use the [implementation report](./implementation-report.md) for the initial delivery and the [closed-Profile amendment](./closed-profile-amendment.md) for the current broker-only rule and qualification. The original proposed file locations and acceptance checklist below are design history, not assertions that every proposed experiment ran.

## Contract and qualification

### Task 1.1 establishes the Profile-wide network contract before implementation

**Files:** Proposed decision under `doc/90-Proposals/Profile-Proxy.md`; after approval, Product, UX, MCP, System, Components and Files canonical owners and their MOCs. Update `apps/shared/protocol/src/mcp/tool-catalog.ts`, `apps/shared/protocol/src/domain/facts.ts`, `apps/shared/protocol/src/error-codes.ts`, `apps/shared/protocol/src/version.ts`, `doc/03-User-Interface/MCP-Contract.schema.json` and new `apps/shared/protocol/src/relay/v3-messages.ts` only after those decisions.

**Approach:** Define four tools, secret-free inputs, saved/applied/observed semantics, idle-only mutations and independent network authority. Retain alias-only names and both ownerships. Add explicit closed-contract versioning and compatibility errors.

**Dependencies:** Approval of proposed scope, idle policy and credential provisioning; protocol/auth coverage is already selected.

**Deliverables:** Traceable decision and contract tests in `tests/contract/profile-proxy.test.ts` and `tests/contract/proxy-relay.test.ts`.

**Verification:** `pnpm exec vitest run tests/contract/profile-proxy.test.ts tests/contract/proxy-relay.test.ts`; `pnpm typecheck`. Reject unknown fields, password-bearing URLs, zero/oversized ports, unregistered references, obsolete protocol versions and stale revisions. Assert no extra Profile display name appears.

### Task 1.2 proves authentication and Chrome routing before selecting the gateway dependency

**Files:** `tests/helpers/proxy-fixtures.ts`, `tests/integration/proxy-gateway.test.ts`, `tests/real-world/profile-proxy.test.ts`; then `package.json` and `pnpm-lock.yaml` for a pinned gateway dependency.

**Approach:** Controlled HTTP Basic, TLS proxy and SOCKS5 username/password servers plus a destination echo server. A real Chrome harness must measure regular-profile routing, WebSocket and keep-alive transitions, startup behavior and clear/restart semantics. Validate destination DNS at the upstream side. Never run against the user's logged-in profiles.

**Dependencies:** Task 1.1 draft contract. Real-browser fixture capability is a release gate, not a manual checklist.

**Deliverables:** Protocol support evidence and a fixed dependency version; explicit restart requirement if Chrome retains connections across configuration changes.

**Verification:** `pnpm exec vitest run tests/integration/proxy-gateway.test.ts`; `pnpm exec vitest run tests/real-world/profile-proxy.test.ts`. Include HTTP destinations, HTTPS CONNECT, WebSocket, invalid TLS certificates, wrong passwords and a blackholed upstream. Assert zero target requests on the direct control route when a configured upstream fails.

**Group gate:** Both tasks' commands pass; otherwise keep proxy capability unavailable.

## Persistence and credentials

### Task 2.1 stores bindings for user-owned and broker-owned Profiles

**Files:** New `apps/broker/src/storage/sqlite/proxy-repository.ts` and `migrations/008-profile-proxy.sql`; update `database.ts`, `apps/broker/src/storage/repositories.ts`; add `tests/integration/proxy-repository.test.ts`.

**Approach:** Persist bindings, revisions, leases, idempotency keys, listener reservations and timestamped observations. Reuse stable references and resolve both registry forms. Database constraints must prevent duplicate listener ownership and stale revision commits. Check the next migration number before creating the file.

**Dependencies:** Task 1.1.

**Deliverables:** Transactional migration without changes to existing identities, aliases, tickets or launch ownership.

**Verification:** `pnpm exec vitest run tests/integration/proxy-repository.test.ts`. Exercise fresh DB, schema-7 upgrade, interrupted transaction, renamed alias, pre-pairing broker Profile, user Profile with no launch row, conflicting writers and listener collisions. Assert foreign-key and integrity checks.

### Task 2.2 protects credentials before any network request can persist them

**Files:** New `apps/broker/src/proxy/proxy-credential-store.ts`, `tools/provision-proxy-credential.ts`, `tools/proxy-credential-dpapi.ps1`, `tests/integration/proxy-credentials.test.ts`.

**Approach:** Hidden/stdin provisioning into Windows DPAPI CurrentUser storage; no secret CLI flags or stdout. Store credential references in requests and bind their use to principal authority. Redact upstream library errors. Return explicit failure on unsupported OS, invalid ciphertext or missing vault entry.

**Dependencies:** Task 2.1 and the agreed provisioning contract.

**Deliverables:** Provision/use/remove-unused operations and no plaintext persistence in the DB, transcripts generated by Tabro, relay or logs.

**Verification:** `pnpm exec vitest run tests/integration/proxy-credentials.test.ts`. Test special characters, empty/long inputs, corrupted blobs, revoked references, unauthorized principal use and write failures. Use a unique synthetic password and assert its absence across captured logs, ticket JSON, extension messages and command-line captures.

**Group gate:** Run both new suites and `pnpm typecheck`; new schema remains inert without an enabled binding.

## Forwarder and extension

### Task 3.1 routes each Profile through a bounded loopback gateway

**Files:** New `apps/broker/src/proxy/types.ts` and `proxy-gateway-manager.ts`; update `apps/broker/src/runtime/bootstrap.ts`; extend `tests/integration/proxy-gateway.test.ts`.

**Approach:** Start and reserve a per-Profile listener; keep upstream revisions immutable for admitted connections; explicitly reject missing upstream configuration. Support HTTP/HTTPS Basic and SOCKS5 authentication without TLS interception. Bound connection counts and timeouts, clean up sockets and redact credentials. Recover persisted ports before readiness.

**Dependencies:** Tasks 1.2, 2.1 and 2.2.

**Deliverables:** Routing isolation, bounded resources and restart reconciliation.

**Verification:** `pnpm exec vitest run tests/integration/proxy-gateway.test.ts`. Flood slow CONNECT requests, disconnect upstreams, terminate/restart the manager, occupy a saved port, send malformed authorities and mix two Profile routes. Assert no wildcard binding, no direct fallback, no cross-Profile route and no orphan listener after orderly shutdown.

### Task 3.2 applies settings through the authenticated extension and reports effective state

**Files:** New `apps/browser-extension/src/proxy/proxy-controller.ts` and `exit-ip-probe.ts`; update manifest, `src/service-worker.ts`, `src/protocol/dispatcher.ts`, `src/transport/websocket-client.ts`, `apps/broker/src/extension-relay/websocket-server.ts`, `apps/broker/src/core/octopus/extension-port.ts`; new `tests/unit/extension-proxy.test.ts`.

**Approach:** Add proxy permission and one fixed IP-check origin. Implement set/read/clear/probe with generation/revision fencing and read-back of `levelOfControl`. Keep regular-only scope and localhost bypass. A restarted worker must restore observation and reconcile without resetting to direct. Carry no upstream secret over relay.

**Dependencies:** Tasks 1.1 and 3.1.

**Deliverables:** Distinct applied, conflict, pending and failed states; bounded, validated IP responses.

**Verification:** `pnpm exec vitest run tests/unit/extension-proxy.test.ts tests/contract/proxy-relay.test.ts`; `pnpm build:extension`. Inject policy control, competing extension, stale connection, worker restart, failed set/read, oversized IP body, cross-origin redirect and duplicate attempt. Assert no request is marked applied from a stale acknowledgement.

**Group gate:** Gateway, extension and relay suites pass. The real-browser harness proves the selected Chrome version supports the required behavior.

## MCP and lifecycle

### Task 4.1 coordinates proxy tickets with every Profile admission path

**Files:** New `apps/broker/src/proxy/profile-network-service.ts`; update `apps/broker/src/core/octopus/octopus-broker.ts`, `mcp-presenter.ts`, `apps/broker/src/profiles/profile-manager.ts`, `apps/broker/src/mcp/auth.ts` and runtime composition; new `tests/integration/profile-proxy.test.ts`.

**Approach:** Implement the proposed four tools using durable acknowledgement-before-dispatch. Use one persistent network fence across mutation, lifecycle and workspace admission. Do not route user-owned references through the existing launcher-only guard. Readiness checks consider desired/applied revision separately from connectivity and manual pauses.

**Dependencies:** Groups 1–3.

**Deliverables:** MCP operations for both ownerships, principled conflict responses, bounded read facts and browser-originated IP checks.

**Verification:** `pnpm exec vitest run tests/integration/profile-proxy.test.ts tests/integration/mcp-gateway.test.ts tests/integration/mcp-stdio-adapter.test.ts`. Race two mutations against workspace acquisition, stop/open and reconnect. Reject wrong scopes and foreign tickets. Exercise crash-before-ack, crash-after-dispatch, offline save and stale probe result. Assert an identical retry does not create a second revision.

### Task 4.2 preserves startup routing and removes launch flags when clearing

**Files:** Update `apps/broker/src/profiles/chrome-launcher.ts`, `profile-manager.ts`, `apps/broker/src/runtime/bootstrap.ts`; extend `tests/integration/managed-profiles.test.ts` and `tests/real-world/profile-proxy.test.ts`.

**Approach:** Prepare gateway before a configured broker-owned launch; include only its loopback route in Chrome arguments. Clear normally restarts an idle broker-owned browser without the proxy flag, then verifies the underlying effective setting. A user-owned browser never gets launched or stopped by this service. If restart is necessary for clean connection replacement, return that requirement honestly.

**Dependencies:** Task 4.1 and routing-transition evidence from Task 1.2.

**Deliverables:** Consistent open/reopen/clear semantics and no credentials in process arguments.

**Verification:** `pnpm exec vitest run tests/integration/managed-profiles.test.ts tests/real-world/profile-proxy.test.ts`. Kill the Broker with Chrome open, restart both independently, remove vault access, occupy listener ports and clear a Profile with a startup flag. Verify clear does not leave traffic pointed at a deleted listener and startup does not fall back to direct when setup fails.

**Group gate:** Run both tasks' suites, `pnpm lint` and `pnpm typecheck`. Existing Profile lifecycle and workspace ownership tests stay green.

## Qualification and rollout

### Task 5.1 qualifies two agents and two ownership modes before enabling the feature

**Files:** New `tests/e2e/profile-proxy.test.ts`; update `tests/helpers/simulated-v2-extension.ts` or introduce a version-3 counterpart, `tests/real-world/preflight.ts`, `tools/update-local.ps1` and approved operational documentation.

**Approach:** Use disposable Profiles and test upstreams. Exercise fresh MCP connections equivalent to Hermes Tabro-1 and Tabro-2, different authenticated routes and simultaneous use of one Profile. Include actual extension permission/version rollout and Native Messaging transport. Collect redacted machine-readable evidence.

**Dependencies:** Groups 1–4.

**Deliverables:** Reproducible compatibility and routing evidence, update/rollback procedure, no modifications to real social accounts.

**Verification:** `pnpm verify`; `pnpm exec vitest run tests/real-world/profile-proxy.test.ts`. The qualification harness must fail, not silently skip, when required Chrome, fixtures or platform prerequisites are missing. A controlled browser echo must identify the intended route; test failure preserves diagnostics and blocks deployment.

**Group gate:** All checks pass; documented limits match measured DNS, WebRTC, startup and existing-connection behavior. Proxy support is not declared complete from unit tests alone.

## Acceptance checklist

- [ ] All three upstream schemes authenticate successfully and reject invalid credentials.
- [ ] Independent Profile routes and shared-Profile conflicts are proven with two agent sessions.
- [ ] Both ownerships work without giving agents new launch rights over user Chrome.
- [ ] Configuration, application and exit observations cannot be confused in tool output.
- [ ] Crash and version-mismatch tests preserve known routing intent and surface uncertainty.
- [ ] Secrets never appear in test-captured public output or persisted request history.

## Rollback

1. After group 1, retain the plan and qualification findings without exposing new tools.
2. After group 2, leave additive storage inert; keep protected credentials available for deliberate operator removal.
3. After group 3, disable admission of proxy changes while preserving listeners for browsers still pointing at them. Never remove the forwarder first.
4. After group 4, clear through the new service on idle test Profiles and verify effective routing, including restart without launch flags, before reverting code.
5. After rollout, restore a coherent Broker/adapter/extension version set only after all applied bindings have been released or their compatible forwarders retained. Do not silently reset user proxies to direct.
