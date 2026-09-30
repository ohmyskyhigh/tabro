# Tabro knowledge vault

This is the entry point for project knowledge. Read canonical knowledge in authority order and stop when a level reports that its parent contract is not confirmed.

## Canonical authority spine

1. [`01-Product/`](./01-Product/_MOC.md) — product identity, audience, problem, promised outcome, capabilities, exclusions, and governing constraints.
2. [`02-User-Experience/`](./02-User-Experience/_MOC.md) — the user journey and interaction contract derived from confirmed Product truth.
3. [`03-User-Interface/`](./03-User-Interface/_MOC.md) — the agent-facing MCP contract derived from confirmed Product and User Experience truth.
4. [`04-System/`](./04-System/_MOC.md) — system-wide behavior and boundaries derived from confirmed Product, User Experience, and User Interface truth.
5. [`05-Components/`](./05-Components/_MOC.md) — operational owners of confirmed System responsibilities.
6. [`06-Files/`](./06-Files/_MOC.md) — exact implementation and verification paths for confirmed Component responsibilities.

## Supporting governance

- [`80-Plans/`](./80-Plans/_MOC.md) contains development plans.
- [`90-Proposals/`](./90-Proposals/_MOC.md) contains proposed vault changes and migration material.
- [`99-Changelog/`](./99-Changelog/_MOC.md) records applied vault changes.

The Product contract is confirmed. Each participating browser profile installs a separate Tabro extension instance, generates or accepts a customized readable pairing code, persists its derived endpoint nickname, and registers automatically as one uniquely named local-broker endpoint without a copied broker code. A requested-name collision remains visible until the operator chooses another code. Workspace capacity counts distinct connected eligible profiles. Agents select broker-issued logical windows or accept the most-recently-focused eligible default; the broker creates tab-group workspaces there, supplies managed tabs and initial event cursors, and routes confined CDP through the paired extension. Request tickets precede browser dispatch, pause and recovery facts remain broker-owned, and workspace or endpoint controls preserve inspectable browser state.

The User Experience contract and operational defaults are confirmed for implementation. The canonical User Interface exposes eighteen tools through one exact Draft 2020-12 wire schema. The canonical System keeps logical truth in the broker, confines raw CDP to managed tabs through one extension per profile, issues durable request tickets before dispatch, serializes each tab's full request cycle, and recovers through explicit reconciliation and controls. The Component layer assigns this behavior to eight owners nested beneath their owning applications, while the File layer maps broker modules under `apps/broker`, independent runtimes under sibling app directories, shared protocol source under `apps/shared/protocol`, setup under `tools`, tests under `tests`, and generated output under root `dist`. Numeric limits, runtime adapters, capability fixtures, and operational thresholds may be tuned through evidence-backed proposals; logical identity, ownership, ticket ordering, recovery, and control semantics remain fixed.

The active implementation plan is [`80-Plans/octopus-browser-relay-implementation-2026-08-31`](./80-Plans/octopus-browser-relay-implementation-2026-08-31/README.md). Existing implementation documentation and the earlier plan remain preserved as migration evidence rather than delivered proof of the new architecture.
