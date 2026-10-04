# Repository map

Status: canonical map of the app-owned implementation and verification paths as of 2026-08-31.

This File-level document says where confirmed Component responsibilities are implemented. Source and tests remain the authority for the runtime behavior they execute. Relay-v1 files retained for migration do not redefine the canonical twenty-two-tool MCP contract.


## Repository root

### Root files define the monorepo, public entry points, and development gates

| Path | Current responsibility | Component owner |
| --- | --- | --- |
| `package.json` | Source package version, Node engine, pnpm version, broker, migration-only relay-v1 pairing, build, test, verification, and smoke scripts | Broker Runtime and Setup and Qualification |
| `pnpm-lock.yaml` | Locked JavaScript dependency graph | Setup and Qualification |
| `pnpm-workspace.yaml` | App workspace discovery plus allowed native package builds | Setup and Qualification |
| `tsconfig.json` | Editor and full TypeScript typecheck configuration | Protocol Contract |
| `tsconfig.build.json` | Compiled app and shared-protocol output configuration | Broker Runtime |
| `vitest.config.ts` | Automated test discovery and runtime | Setup and Qualification |
| `eslint.config.mjs` | Static-analysis configuration | Setup and Qualification |
| `.env.example` | Supported broker environment-variable example | Broker Runtime |
| `AGENTS.md` | Repository-wide documentation heading rule | Repository governance |
| `README.md` | Public product, installation, pairing, MCP, limits, and verification entry point | Setup and Qualification |
| `CONTRIBUTING.md` | Contribution workflow and implementation invariants | Setup and Qualification |
| `SECURITY.md` | Local reporting guidance | Repository governance |
| `LICENSE` | MIT license text | Repository governance |

The root `package.json` owns the monorepo scripts and dependencies. `apps/mcp-stdio-adapter/package.json` additionally declares the private adapter package and its compiled binary entry; the other source areas use the root package.

## Broker Runtime

### Three broker files validate configuration, compose components, and own process lifetime

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/broker/src/runtime/main.ts` | Loads configuration, acquires the data-directory PID lock, publishes bound runtime addresses, and removes owned discovery records on shutdown | `tools/smoke-test.ts` and integration tests that create the application |
| `apps/broker/src/runtime/config.ts` | Validates dynamic listener ports (default 0), database, logging, heartbeat, legacy threshold, and token environment values; creates the local token file when needed | Broker startup tests and setup preflight |
| `apps/broker/src/runtime/bootstrap.ts` | Constructs SQLite, canonical and legacy broker cores, relay gateway, canonical MCP gateway, health facts, recovery, sweeps, and orderly shutdown | `tests/integration/mcp-gateway.test.ts`, `tests/integration/websocket-gateway.test.ts`, and `tools/smoke-test.ts` |

`apps/broker/src/runtime/bootstrap.ts` exposes the canonical `OctopusBroker` to MCP and retains `BrokerCore` as the relay-v1 migration bridge.

## MCP Gateway

### The MCP gateway exposes exactly twenty-two authenticated tools over loopback Streamable HTTP

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/broker/src/mcp/server.ts` | Registers the canonical tool catalog, validates input and output, routes direct reads and controls, submits async work, and confirms ticket acknowledgement after HTTP response handoff | `tests/integration/mcp-gateway.test.ts` |
| `apps/broker/src/mcp/auth.ts` | Authenticates bearer tokens against the local store and constructs MCP `AuthInfo` | `tests/integration/mcp-gateway.test.ts` |
| `apps/broker/src/mcp/caller-evidence.ts` | Derives runtime, session, and parent-session evidence from authenticated context and transport headers rather than tool bodies | `tests/integration/mcp-gateway.test.ts` |
| `apps/broker/src/mcp/index.ts` | Exports the gateway and caller-evidence adapter | Typecheck and consumers |

The HTTP server owns `/mcp` and `/health` on the configured MCP port and rejects non-loopback host headers.

### A session-owned stdio adapter gives Codex and Hermes the same tools with non-model caller evidence

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/mcp-stdio-adapter/package.json` | Declares the private adapter package, version, and compiled binary entry | Workspace install and build |
| `apps/mcp-stdio-adapter/src/config.ts` | Prefers `TABRO_RUNTIME_FILE` discovery over a legacy loopback URL and loads a token or token file; resolves Codex, Hermes, explicit, or process-local session evidence | `tests/integration/mcp-stdio-adapter.test.ts` |
| `apps/mcp-stdio-adapter/src/server.ts` | Validates Broker health/version/instance, reconnects before new calls on instance change, forwards twenty-two tools with caller headers, validates results, and never retries dispatched calls | `tests/integration/mcp-stdio-adapter.test.ts` |
| `apps/mcp-stdio-adapter/src/main.ts` | Starts the adapter and closes both MCP transports on signals or stdin end | Adapter integration test and compiled launch path |
| `apps/mcp-stdio-adapter/src/index.ts` | Exports adapter configuration and server APIs | Typecheck and tests |
| `apps/mcp-stdio-adapter/README.md` | Records adapter configuration, identity fallback, and the two-transport delivery boundary | Source review |

The adapter prefers runtime-owned session environment values and otherwise generates one identity for its process lifetime. One process is the fallback isolation boundary. The broker's HTTP acknowledgement and the adapter's stdout write cannot form one atomic cross-transport transaction.

## Broker Core

### The canonical broker modules own logical references, tickets, ordering, routing, recovery, and controls

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/broker/src/core/octopus/octopus-broker.ts` | Canonical application facade for context reads, workspace allocation, tab creation, CDP, events, ownership, recovery, stop/kill, resume, termination, and extension callbacks | `tests/integration/octopus-broker.test.ts` |
| `apps/broker/src/core/octopus/reference-factory.ts` | Generates broker-owned public references and private operation identities | `tests/unit/octopus-request-state.test.ts` and broker integration tests |
| `apps/broker/src/core/octopus/caller-registry.ts` | Resolves authenticated runtime evidence into durable session and lineage records | MCP and broker integration tests |
| `apps/broker/src/core/octopus/request-state-machine.ts` | Validates canonical request state, phase, pause, and terminal transitions | `tests/unit/octopus-request-state.test.ts` |
| `apps/broker/src/core/octopus/tab-lane.ts` | Represents same-tab ticket acceptance ordering and lane behavior | `tests/unit/octopus-request-state.test.ts` and broker integration tests |
| `apps/broker/src/core/octopus/extension-port.ts` | Defines the Broker Core port for endpoint inventory, browser operations, reconciliation, and event callbacks | Extension Gateway and broker integration tests |
| `apps/broker/src/core/octopus/broker-problem.ts` | Defines public problem construction used by the canonical presenter | Contract and broker integration tests |
| `apps/broker/src/core/octopus/mcp-presenter.ts` | Builds allowlisted canonical MCP result envelopes and ticket facts | MCP contract and broker integration tests |
| `apps/broker/src/core/index.ts` | Exports canonical and migration APIs | Typecheck and component consumers |

### The earlier target-binding broker remains isolated as relay-v1 migration code

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/broker/src/core/broker-core.ts` | Target pairing, authenticated extension alias changes, legacy binding, lease, and custom-operation orchestration used by relay v1 and pairing storage | Legacy broker and WebSocket integration tests |
| `apps/broker/src/core/routing-policy.ts` | Earlier binding/lease routing policy | `tests/unit/routing-policy.test.ts` |
| `apps/broker/src/core/target-state-index.ts` | Earlier target status projection | `tests/unit/status-derivation.test.ts` |
| `apps/broker/src/core/lease-manager.ts` | Earlier target lease calculations | Legacy broker integration tests |
| `apps/broker/src/core/command-state-machine.ts` | Earlier command transitions | `tests/unit/command-state-machine.test.ts` |

The legacy modules do not add MCP tools to the canonical gateway.

## Durable Store

### SQLite repositories persist canonical logical truth and retained migration state

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/broker/src/storage/repositories.ts` | Stored record types and repository ports for legacy and canonical state | Storage integration tests |
| `apps/broker/src/storage/sqlite/database.ts` | SQLite connection, migration runner, legacy repository methods, atomic legacy/canonical endpoint rename, and canonical repository composition | `tests/integration/sqlite-store.test.ts` and `tests/integration/sqlite-workspace-store.test.ts` |
| `apps/broker/src/storage/sqlite/runtime.ts` | Canonical `node:sqlite` runtime helpers | Canonical storage integration test |
| `apps/broker/src/storage/sqlite/shared.ts` | Shared row decoding, timestamps, JSON, and transaction utilities | Canonical storage integration test |
| `apps/broker/src/storage/sqlite/logical-repository.ts` | Endpoints, connections, capabilities, sessions, lineages, windows, workspaces, tabs, groups, attachments, controls, and recovery scans | `tests/integration/sqlite-workspace-store.test.ts` |
| `apps/broker/src/storage/sqlite/request-repository.ts` | Ticket creation, acknowledgement, claims, phases, pauses, terminal results, resolution, closure, and recovery scans | `tests/integration/sqlite-workspace-store.test.ts` |
| `apps/broker/src/storage/sqlite/event-repository.ts` | Tab event streams, cursors, retained events, and paginated reads | `tests/integration/sqlite-workspace-store.test.ts` |
| `apps/broker/src/storage/sqlite/audit-repository.ts` | Canonical append-only audit records | Storage integration tests and broker callers |
| `apps/broker/src/storage/index.ts` | Exports the SQLite store and repository contracts | Typecheck and component consumers |

### Five immutable migrations build the stored model in application order

| Path | Current responsibility |
| --- | --- |
| `apps/broker/src/storage/sqlite/migrations/001-initial.sql` | Original targets, principals, leases, commands, pairing, and events |
| `apps/broker/src/storage/sqlite/migrations/002-real-world-trace.sql` | Earlier real-world trace records |
| `apps/broker/src/storage/sqlite/migrations/003-agent-target-bindings.sql` | Earlier explicit agent-target bindings |
| `apps/broker/src/storage/sqlite/migrations/004-workspaces-requests.sql` | Canonical endpoints, generations, capabilities, sessions, lineages, windows, groups, workspaces, tabs, attachments, tickets, lanes, events, controls, and audit state |
| `apps/broker/src/storage/sqlite/migrations/005-window-focus-history.sql` | Durable per-window focus history used by the most-recently-focused default selection |

Applied migrations are history and are not rewritten when later behavior changes.

## Extension Gateway

### One gateway accepts relay-v2 endpoint sessions while preserving relay-v1 migration traffic

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/broker/src/extension-relay/websocket-server.ts` | Loopback WebSocket upgrade, relay-v2 automatic extension registration, authenticated alias changes, retained relay-v1 one-time pairing, connection generations, inventory, correlated browser operations, event forwarding, detach, timeout, and disconnect handling | `tests/integration/websocket-gateway.test.ts` |
| `apps/broker/src/extension-relay/connection-registry.ts` | Live legacy target and canonical endpoint connection registries | `tests/integration/websocket-gateway.test.ts` |
| `apps/broker/src/extension-relay/index.ts` | Exports the extension gateway | Typecheck and Broker Runtime composition |

The same listener exposes `/relay` for WebSocket upgrades and `/health` for setup diagnostics. Native Messaging is a transport path into this loopback gateway, not a second browser protocol.

## Browser Extension

### The Manifest V3 extension pairs one profile and executes managed-tab browser operations

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/browser-extension/manifest.json` | Stable extension identity, minimum Chrome version, service worker, options page, debugger, tab-group, storage, tab, alarm, and Native Messaging permissions | `tests/contract/extension-manifest.test.ts` |
| `apps/browser-extension/options.html` | Editable readable pairing code, derived profile nickname, relay URL, transport, automatic-registration status, and reset controls | Extension build and manifest test |
| `apps/browser-extension/src/options.ts` | Loads identity facts and settings, validates and saves the custom code and connection settings, requests reconnect, and renders automatic-pairing status | Extension build and contract tests |
| `apps/browser-extension/src/config.ts` | Persists relay URL and native/diagnostic transport choice while removing obsolete entered-code settings | Extension build and unit coverage through consumers |
| `apps/browser-extension/src/service-worker.ts` | Composes identity, transport, browser inventory, tab groups, debugger adapter, dispatcher, reconnect alarm, and extension action | Extension build and contract tests |
| `apps/browser-extension/src/identity/device-identity.ts` | Creates the profile-local key pair and default code, normalizes and persists custom codes, derives the authoritative lowercase nickname, stores endpoint identity, and resets pairing | Relay gateway and extension identity tests |
| `apps/browser-extension/src/reconnect-alarm.ts` | Uses Chrome alarms to wake and reconnect a Manifest V3 worker | `tests/unit/reconnect-alarm.test.ts` |

### Browser inventory and tab-group modules keep raw Chrome identifiers inside the extension boundary

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/browser-extension/src/browser/browser-descriptor.ts` | Reads browser product and version facts | `tests/contract/extension-browser-adapter.test.ts` |
| `apps/browser-extension/src/browser/inventory.ts` | Snapshots windows, tabs, groups, focus, URLs, titles, and Chrome generations for relay v2 | `tests/contract/extension-browser-adapter.test.ts` |
| `apps/browser-extension/src/browser/tab-groups.ts` | Creates, groups, moves, and renames managed tabs and workspace groups | `tests/contract/extension-browser-adapter.test.ts` |

### Debugger modules attach managed tabs, execute admitted CDP, and forward events

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/browser-extension/src/debugger/attachment-manager.ts` | Owns `chrome.debugger` attachment generations, attach/detach, and listener routing | `tests/contract/cdp-adapter.test.ts` |
| `apps/browser-extension/src/debugger/cdp-executor.ts` | Validates a CDP attempt, sends it through `chrome.debugger`, and returns raw result or debugger failure facts | `tests/contract/cdp-adapter.test.ts` |
| `apps/browser-extension/src/debugger/event-forwarder.ts` | Sequences and forwards CDP events and debugger detach facts | `tests/contract/cdp-adapter.test.ts` |

### Protocol and transport modules run relay v2 over Native Messaging or diagnostic WebSocket

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/browser-extension/src/protocol/dispatcher.ts` | Parses broker operations, invokes browser/tab/debugger adapters, caches attempt results, and returns correlated outcomes | Extension adapter and relay contract tests |
| `apps/browser-extension/src/transport/relay-transport.ts` | Defines Native Messaging and direct-WebSocket adapters, loopback URL validation, framing, readiness, close, and error signals | Native smoke and extension contract tests |
| `apps/browser-extension/src/transport/websocket-client.ts` | Runs relay-v2 hello, pairing, challenge/auth, ready, explicit naming-conflict handling, heartbeat, inventory, event, reconnect, and command exchange | WebSocket gateway integration and extension build |
| `apps/browser-extension/src/executor/recent-command-cache.ts` | Retains bounded attempt outcomes for reconnect reconciliation | `tests/contract/cdp-adapter.test.ts` and dispatcher consumers |
| `apps/browser-extension/src/executor/browser-executor.ts` | Retained relay-v1 custom browser-operation executor | Legacy WebSocket and E2E tests |

`dist/browser-extension/` is generated by `pnpm build:extension` and is the unpacked extension load path. It is build output, not an editable source owner.

## Native Messaging companion

### The Windows native host forwards JSON messages between Chrome and the loopback relay

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/native-host/src/relay-native-host.cpp` | Native Messaging framing, adjacent relay-runtime discovery and process/URL checks, legacy fallback only when discovery is absent, WinHTTP forwarding, and closure/error signals | `tests/real-world/native-host-smoke.ts` and physical preflight |

`dist/native-host/relay-native-host.exe` is generated by `tools/build-native-host.ps1`. The current host name is `io.github.ohmyskyhigh.octopus_browser_relay`; installation removes the prototype registration only when its manifest can be attributed to this extension identity.

## Protocol Contract

### Canonical MCP code materializes the approved twenty-two-tool JSON Schema

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `doc/03-User-Interface/MCP-Contract.schema.json` | Canonical Draft 2020-12 agent-facing request and result schema | `tests/contract/mcp-contract-v2.test.ts` |
| `apps/shared/protocol/src/mcp/tool-catalog.ts` | Exact twenty-two tool names, execution classes, and descriptions | MCP contract and gateway integration tests |
| `apps/shared/protocol/src/mcp/validators.ts` | Runtime input/output validators and public per-tool JSON Schema roots derived from the canonical schema | `tests/contract/mcp-contract-v2.test.ts` |
| `apps/shared/protocol/src/domain/references.ts` | Branded canonical public and private reference types | Typecheck and protocol tests |
| `apps/shared/protocol/src/domain/facts.ts` | Shared endpoint, window, workspace, tab, request, and result facts | Typecheck and broker tests |

### Runtime discovery locates a Broker without becoming a browser authority

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/shared/protocol/src/runtime-discovery.ts` | Closed discovery schema, local URLs, process liveness, atomic publication and instance-owned removal | `tests/integration/runtime-discovery.test.ts` |
| `apps/shared/protocol/src/version.ts` | Shared service version used by Broker and adapter | Version consistency during release staging |
| `tests/integration/runtime-discovery.test.ts` | Discovery priority, invalid/dead records, replacement ownership and restart with stable caller identity | Isolated dynamic-port Broker/stdio integration |
| `tests/integration/native-runtime-discovery.test.ts` | Native relay discovery overrides an obsolete URL and rejects an invalid record | Windows; requires `dist/native-host/relay-native-host-dynamic.exe`, otherwise skipped |

### Relay-v2 schemas define profile inventory, generations, operations, results, and events

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/shared/protocol/src/relay/v2-messages.ts` | Relay-v2 envelope, 21 message payload schemas, operation bodies, browser facts, debugger failures, and parser | `tests/contract/relay-v2.test.ts` |
| `apps/shared/protocol/src/capabilities/manifest.ts` | Capability-manifest validator, comparison, and CDP method admission helpers | Protocol and broker tests |
| `apps/shared/protocol/capabilities/extension-baseline.json` | Shipped conservative relay-v2, browser, limit, feature, and managed-tab CDP baseline | Capability loading and contract tests |
| `apps/shared/protocol/src/index.ts` | Public canonical and migration exports | Typecheck and component consumers |

### Earlier schemas remain reachable only for relay-v1 migration code

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `apps/shared/protocol/src/schemas.ts` | Earlier target, binding, lease, and custom-operation MCP schemas | Legacy protocol tests |
| `apps/shared/protocol/src/domain-types.ts` | Earlier target, binding, lease, and command domain types | Legacy broker tests |
| `apps/shared/protocol/src/relay-messages.ts` | Relay-v1 envelopes and parser | `tests/contract/protocol.test.ts` and legacy gateway tests |
| `apps/shared/protocol/src/error-codes.ts` | Earlier public relay error codes and exception | Legacy broker and gateway tests |

## Setup and qualification

### Public English and Simplified Chinese entry documents route users without duplicating canonical authority

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `README.md` | English project overview, Release and source installation, browser pairing, agent registration, update, verification, limits, and troubleshooting | `tests/contract/public-documentation.test.ts` and physical runbook evidence |
| `README.zh-CN.md` | Simplified Chinese public project, installation, update, verification, and troubleshooting guide with an explicit English-authority boundary | `tests/contract/public-documentation.test.ts` against the same implementation paths |
| `doc/zh-CN/README.md` | Chinese documentation index and translation-governance boundary | `tests/contract/public-documentation.test.ts` |
| `doc/zh-CN/Installation-and-Setup.md` | Chinese GitHub Release, source build, browser extension, Codex, Hermes, update, stop, and troubleshooting procedure | `tests/contract/public-documentation.test.ts`, release rehearsal, and physical runbook evidence |
| `doc/zh-CN/Architecture-and-MCP.md` | Chinese explanatory map of components, request lifecycle, controls, tools, CDP boundary, and update gate | `tests/contract/public-documentation.test.ts`, canonical English parent links, and contract tests |

### Build and installation scripts generate handoffs while Hermes registration applies them

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `tools/build-extension.ts` | Bundles the service worker and options page, then copies the manifest and HTML into `dist/browser-extension` | `pnpm build:extension` and manifest contract test |
| `tools/build-native-host.ps1` | Locates the Visual Studio x64 tools and builds the WinHTTP companion into `dist/native-host`; accepts an output path for isolated builds | `pnpm build:native` and native smoke test |
| `tools/stage-release.ts` | Bundles portable broker and MCP adapter entries, copies release runtime files plus English/Chinese public guides, checks synchronized versions, and writes the per-file release manifest with runtime discovery version 1 | `pnpm stage:release` and release-package rehearsal |
| `tools/package-release.ps1` | Runs verification/build, stages the Windows release, produces the ZIP, archive checksum, and standalone updater asset | `pnpm package:release` and the tag release workflow |
| `tools/update-local.ps1` | Resolves a GitHub Release or local rehearsal package, verifies archive/file hashes and discovery support before shutdown, installs versioned runtime files, preserves data, refreshes stable extension/MCP/native paths including the Hermes all-profile helper, starts and health-checks the broker, and rolls back failed startup | Local update rehearsal and release runbook |
| `tools/stop-installed-broker.ps1` | Stops only the PID whose command line names the stable installed broker launcher | Local update rehearsal |
| `tools/register-hermes-profiles.ps1` | Discovers the default and installed named Hermes profiles, then registers the same Tabro stdio adapter and all twenty-two tools in each isolated profile | `tests/real-world/register-hermes-profiles.test.ts` and per-profile `hermes mcp list`/`test` |
| `tools/installed-broker-launcher.mjs` | Loads the selected broker, supplies installed discovery paths and dynamic-port defaults, and loads managed configuration | Installed broker startup and health check |
| `tools/installed-mcp-adapter-launcher.mjs` | Loads the selected adapter and supplies installed runtime-file discovery | Codex/Hermes tool discovery through an installed release |
| `tools/copy-assets.ts` | Copies SQLite migrations into the compiled `dist` tree | `pnpm build` |
| `tools/create-pairing-code.ts` | Retains broker-generated short-lived codes only for relay-v1 migration fixtures | `pnpm pair:legacy --nickname <name>` and storage pairing tests |
| `tools/install-local.ps1` | Builds dependencies/artifacts, verifies the compiled stdio adapter, writes and registers the current-user Native Messaging manifest, generates automatic-pairing and Codex plus all-installed-profile Hermes stdio handoffs, optionally starts the broker, or runs readiness without `-Install` | `tests/real-world/setup-readiness.ts` and physical runbook |
| `tools/real-world-preflight.ps1` | Runs setup readiness with explicit discovered URLs; legacy fixed defaults remain and `-RunId` is rejected | Setup readiness and operator output |
| `tools/smoke-test.ts` | Starts an in-memory application and checks the MCP transport/tool surface | `pnpm smoke` |

### Shared startup, Demo evidence and offline migrations have explicit file owners

| Path | Current responsibility | Verification |
| --- | --- | --- |
| `tools/start-local-broker.ps1` | Startup mutex, matching healthy process reuse, data/discovery paths and dynamic ports | Recorded local startup and duplicate-start qualification |
| `tools/stop-local-broker.ps1` | Checks recorded PID and exact compiled entry before stopping | `tests/real-world/stop-local-broker.test.ts` |
| `tools/prepare-single-agent-demo.ts` | Starts/reuses the shared Broker, starts a fixture and saves its runtime/trace manifest; shutdown closes only the fixture | Shared-runtime qualification record and Demo runbook |
| `tools/single-agent-demo-call.ts` | Forwards explicit Agent calls and polls tickets using the manifest URL and stable session | `tests/e2e/single-agent-multi-extension.test.ts`; restart caveat in Demo runbook |
| `tools/snapshot-demo-runtime.ts` | Captures owned Profile process observations for a run | Demo evidence verifier |
| `tools/verify-single-agent-demo.ts` | Invokes the evidence verifier for a recorded run | `tests/demo/evidence-verifier.test.ts` |
| `apps/mcp-stdio-adapter/src/demo-trace.ts` | Writes bounded redacted MCP call/result evidence | `tests/unit/demo-trace.test.ts` |
| `tests/demo/fixture-server.ts` | Local three-account task and summary fixture | `tests/demo/fixture-server.test.ts` |
| `tests/demo/evidence-verifier.ts` | Checks assignments, traces, process identity and fixture outcomes | `tests/demo/evidence-verifier.test.ts` |
| `tests/demo/RUNBOOK.md` | Physical managed-Profile Demo preparation, Agent execution and cleanup | Dated implementation report; does not assert a fresh physical run |
| `tools/migrate-hermes-tabro.py` | Plans/applies/verifies active-reference migration with backups and checked rollback | `tests/migrations/test_hermes_tabro.py` |
| `tools/hermes-tabro-rules.json` | Scoped rename and preservation rules for the migration CLI | Migration tests |
| `tools/merge-broker-databases.py` | Produces a separate merged SQLite store, offsets integer history IDs and rejects schema/identity/integrity conflicts | `tests/migrations/test_broker_store_merge.py` |

Migration backups, live configurations, credentials and browser data remain local ignored evidence. These CLIs do not run during ordinary startup. The Demo caller currently uses a saved MCP URL, while generated ordinary MCP registrations use runtime discovery; the runbook documents how to refresh a Demo after Broker restart.

### The canonical physical procedure lives beside the File map

| Path | Current responsibility |
| --- | --- |
| `doc/06-Files/Real-World-Runbook.md` | Native installation, profile pairing, fixture, Codex/Hermes handoff, ticketed CDP, multi-profile behavior, recovery, controls, evidence, and cleanup |
| `tests/real-world/setup-readiness.ts` | Machine-readable readiness checks; direct CLI defaults still require explicit dynamic health/MCP URL arguments |
| `tests/real-world/setup-readiness-checks.ts` | Handoff and native-registration checks; literal broker-URL checks still need adaptation for runtime-file handoffs |
| `tests/real-world/fixture-server.ts` | Loopback A/B/C browser-isolation fixture pages |
| `tests/real-world/native-host-smoke.ts` | Native Messaging companion framing and forwarding evidence |

The remaining `tests/real-world/*` and `tools/real-world-start.ps1`, `real-world-verify.ps1`, and `real-world-cleanup.ps1` are retained from the earlier run-manifest harness. They are useful migration and fixture code, but their relay-v1 roles and version fields do not prove the canonical twenty-two-tool physical run.

## Automated verification

### Contract tests prove schemas, extension packaging, browser adapters, and relay messages

| Path | Current evidence |
| --- | --- |
| `tests/contract/mcp-contract-v2.test.ts` | Eighteen tool names plus input/output validator and JSON Schema behavior |
| `tests/contract/relay-v2.test.ts` | Relay-v2 messages and capability facts |
| `tests/contract/extension-manifest.test.ts` | Manifest identity, service worker, version, and permissions |
| `tests/contract/extension-browser-adapter.test.ts` | Browser descriptor, inventory, and tab groups |
| `tests/contract/cdp-adapter.test.ts` | Debugger attachment, CDP execution, events, detach, and attempt cache |
| `tests/contract/public-documentation.test.ts` | English/Chinese installation handoff alignment and local Markdown link integrity |
| `tests/contract/protocol.test.ts` | Retained relay-v1 contract |

### Unit tests prove state transitions and retained legacy policy helpers

| Path | Current evidence |
| --- | --- |
| `tests/unit/octopus-request-state.test.ts` | Canonical request lifecycle and tab-lane behavior |
| `tests/unit/reconnect-alarm.test.ts` | Extension reconnect scheduling |
| `tests/unit/command-state-machine.test.ts` | Retained legacy command transitions |
| `tests/unit/routing-policy.test.ts` | Retained legacy routing policy |
| `tests/unit/status-derivation.test.ts` | Retained legacy target status projection |

### Integration tests prove canonical storage, broker, MCP, and relay-v2 seams

| Path | Current evidence |
| --- | --- |
| `tests/integration/sqlite-workspace-store.test.ts` | Canonical migration, repositories, transactions, requests, events, controls, and restart scans |
| `tests/integration/octopus-broker.test.ts` | Canonical context, workspace, initial tab/cursor, raw CDP ticket, successful restart-failed resolution, follower invalidation, and exhausted replacement retries |
| `tests/integration/mcp-gateway.test.ts` | Exact tool publication, bearer authentication, caller evidence, schema validation, structured results, and acknowledgement delivery |
| `tests/integration/mcp-stdio-adapter.test.ts` | Runtime-session identity resolution and two independent stdio adapter processes sharing one token |
| `tests/integration/websocket-gateway.test.ts` | Relay-v2 pairing, authentication, inventory, operations, events, and fencing plus retained v1 behavior |
| `tests/integration/sqlite-store.test.ts` | Retained pairing and legacy storage behavior |
| `tests/integration/broker-core.test.ts` | Retained target-binding broker behavior |

### Fault tests retain migration evidence while E2E targets the canonical three-session path

| Path | Current evidence |
| --- | --- |
| `tests/fault/recovery.test.ts` | Retained legacy restart behavior |
| `tests/fault/serialization.test.ts` | Retained legacy target serialization behavior |
| `tests/e2e/multi-agent-multi-extension.test.ts` | Scenario for three independently authenticated MCP sessions, three paired relay-v2 endpoints, designated workspace allocation, raw CDP result routing, and cross-session rejection |

The E2E extension clients are simulated. Canonical physical acceptance remains the procedure in `Real-World-Runbook.md`.

## Generated and local paths

### Build, install, and test output stays outside the editable authority spine

| Path | Generated content |
| --- | --- |
| `dist/browser-extension/` | Unpacked extension bundle loaded by Chrome and AdsPower |
| `dist/` | Compiled JavaScript, copied migrations, and native executable |
| `.relay-data/` | Local token, SQLite database, runtime discovery, startup lock, PID, Native Messaging manifest, and generated registration/pairing handoff |
| `artifacts/` | Local automated and physical test evidence |
| `artifacts/release/` | Staged release tree, Windows ZIP, checksum, and standalone updater generated by release packaging |

These paths do not become canonical documentation and must not be committed with local credentials or browser-private evidence.

## File rules

### The Hermes package ships pinned runtime bytes and profile-aware launch scripts

Under Setup and Qualification, `integrations/hermes/plugin.json`, `mcp.json` and `skills/tabro-browser/SKILL.md` own the portable entry. `setup.ps1`, `common.ps1`, `broker-service.mjs`, `launch.ps1`, `stop.ps1` and `proxy-credential.ps1` own installation, shared startup, stdio transport, guarded shutdown and local credentials. `tools/stage-hermes-plugin.ts` builds the committed `runtime/` and `runtime-manifest.json`; `.gitattributes` preserves exact payload bytes. `tests/real-world/hermes-plugin-installation.test.ts` and `hermes-profile-plugin-probe.py` qualify isolated installations and real Hermes plugin loading. Package instructions and platform limits live in `integrations/hermes/README.md`.

### Each source area stays inside its confirmed Component boundary

- Browser APIs stay under `apps/browser-extension`.
- Native browser-to-loopback forwarding stays under `apps/native-host`.
- MCP SDK and HTTP transport code stay under `apps/broker/src/mcp`.
- SQL and migrations stay under `apps/broker/src/storage`.
- workspace routing, authority, recovery and control stay under `apps/broker/src/core`; managed Profile lifecycle and its request service stay under `apps/broker/src/profiles`.
- shared public, relay, and capability schemas stay under `apps/shared/protocol`.
- process composition stays under `apps/broker`.
- local installation and artifact construction stay under `tools`.
- executable evidence stays under `tests`.

Tests may import public Component ports and dedicated fixtures. Production code does not import from `tests` or use a proposal document as a runtime contract.

## Managed Profiles

### Profile lifecycle source and tests keep process identity separate from workspace ownership

| Source | Responsibility | Verification |
| --- | --- | --- |
| `apps/broker/src/core/octopus/octopus-broker.ts` | Shared extension-registry discovery, alias-only names and broker/user ownership facts | `tests/contract/registered-profiles.test.ts`, `tests/e2e/multi-agent-multi-extension.test.ts` |
| `apps/broker/src/core/octopus/octopus-broker.ts` | Retire missing idle workspaces from current inventory without bypassing pending work | `tests/integration/missing-workspace-retirement.test.ts` |
| `apps/broker/src/profiles/profile-manager.ts` | Serialized lifecycle, readiness and stopping barrier | `tests/integration/managed-profiles.test.ts` |
| `apps/broker/src/profiles/profile-request-service.ts` | Principal-scoped durable MCP operations with name-free creation | `tests/contract/profile-management.test.ts` |
| `apps/broker/src/profiles/chrome-launcher.ts` | Owned Chrome process launch, inspect and close | `tests/unit/chrome-launcher.test.ts`, `tools/probe-profile-manager.ts` |
| `apps/broker/src/profiles/bootstrap-grants.ts` | Instance-bound signed bootstrap | `tests/unit/managed-bootstrap.test.ts` |
| `apps/broker/src/storage/sqlite/profile-repository.ts` | Persistent directory, leases and request associations | `tests/integration/profile-repository.test.ts` |
| `apps/browser-extension/src/identity/managed-bootstrap.ts` | Initialize the managed relay before every connect entry point | managed Profile physical probe |
| `tools/configure-managed-profiles.ps1` | Verified runtime configuration and directory ACL | isolated configuration smoke check |

### Managed runtime support files preserve launch identity and upgrade evidence

| Source | Responsibility | Verification |
| --- | --- | --- |
| `apps/broker/src/profiles/runtime-config.ts` | Validates managed browser, extension and storage configuration | `tests/real-world/managed-profile-installation.test.ts` |
| `apps/broker/src/profiles/types.ts` | Internal Profile, instance, launcher and observation contracts | Typecheck and managed Profile tests |
| `apps/broker/src/profiles/management-connection.ts` | Private browser lifecycle connection | Launcher and physical Profile probes |
| `apps/broker/src/storage/sqlite/migrations/006-managed-profiles.sql` | Initial Profile directory, instance, request, idempotency, grant and lease persistence | `tests/integration/profile-repository.test.ts` |
| `apps/broker/src/storage/sqlite/migrations/007-profile-alias-only.sql` and `database.ts` | Drop the extra Profile name, clean Profile ticket fields and normalize creation hashes atomically | Fresh-schema and schema-six upgrade cases in `tests/integration/profile-repository.test.ts` |
| `tools/managed-upgrade-snapshot.mjs` | Busy checks, consistent database snapshots and retained Profile metadata | `tests/real-world/managed-profile-installation.test.ts` |
| `tools/probe-managed-chrome.ts` | Isolated physical Chrome bootstrap and retained-state probe | `tests/real-world/managed-chrome-probe.test.ts` checks harness behavior; physical run remains separate |
| `tools/probe-profile-manager.ts` | Physical Profile Manager lifecycle and Broker restart qualification | Dated implementation report |
| `tools/probe-profile-upgrade.ts` | Isolated old/new runtime upgrade and downgrade evidence | Dated implementation report |
| `tools/lib/chrome-probe-control.ts` | Scoped probe-root and process controls | Managed Chrome probe tests |
| `tests/e2e/single-agent-multi-extension.test.ts` | Simulated single-session multi-endpoint execution and recovery | Automated E2E, not a physical Chrome run |

### Browser admission and Chromium lifecycle compatibility have dedicated checks

`tools/browser-runtime.ps1` owns browser discovery and setup version checks and ships with both setup distributions. `integrations/hermes/plugin.json` declares the selected executable and PE version floor; `tests/real-world/hermes-browser-gate-probe.py` exercises the real Hermes install gate. `apps/broker/src/profiles/browser-compatibility.ts` owns engine eligibility, with `tests/unit/browser-compatibility.test.ts` covering upgrades and unsupported engines. `tests/real-world/browser-selection.test.ts` executes the PowerShell selection logic. Launcher identity tests cover Edge, and `tools/probe-profile-proxy.ts` accepts `TABRO_BROWSER_PATH` for isolated browser qualification without reading a personal runtime configuration.

## Profile networking

### Proxy implementation paths preserve the Profile and extension boundaries

`apps/broker/src/proxy/` owns network service, gateway and credentials. `apps/broker/src/storage/sqlite/proxy-repository.ts` and migration 008 own persistence. `apps/browser-extension/src/proxy/proxy-controller.ts` owns effective regular-profile settings and exit probes. Existing protocol, MCP, relay, runtime and Profile lifecycle modules wire these operations. `tools/provision-proxy-credential.ts` provisions protected references. `tests/integration/profile-proxy.test.ts`, `proxy-gateway.test.ts`, `proxy-credentials.test.ts` and `tests/unit/extension-proxy.test.ts` supply automated qualification. `ChromeLauncher.isClosed` and `ProfileManager.assertClosed` prove closure by process inspection; `tests/unit/chrome-launcher.test.ts` and the proxy integration suite cover open, disconnected and untracked process cases. `tools/probe-profile-proxy.ts` runs isolated real Chrome and Native Messaging, rejects user ownership online and offline, and verifies closed-configure-open behavior. The [closed-Profile amendment](../80-Plans/profile-proxy-2026-10-03/closed-profile-amendment.md) records current verification; the initial implementation report retains transport history.

Parent: [`Files MOC`](./_MOC.md).
