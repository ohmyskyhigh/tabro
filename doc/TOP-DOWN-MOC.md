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

## Current baseline

### Canonical owners cover managed Profiles and the shared dynamic runtime

The Product and UX contracts include principal-owned persistent Profiles alongside session-owned tab-group workspaces. User Interface owns MCP contract version `2`: eighteen tools, including Profile list/create/open/stop. System owns the shared local Broker, runtime discovery and recovery rules; Components assigns their owners; Files maps their source, tests and operator procedures. Follow those owners for the normative details.

The source package version is recorded in `package.json`. Repository publication evidence is in [the September 30 source publication](./99-Changelog/2026-09-30-tabro-source-publication.md); publication of source does not establish publication of an equivalent installer package.

## Delivery records

### Completed migrations and pending integration work have separate evidence

- [Managed Profile implementation report](./80-Plans/single-agent-multi-chrome-demo-2026-09-27/implementation-report.md) records the September 27 Windows qualification and its limits.
- [Hermes reference migration](./99-Changelog/2026-10-01-hermes-tabro-migration.md) and [shared dynamic runtime](./99-Changelog/2026-10-01-shared-dynamic-runtime.md) record the October 1 changes in execution order.
- [Hermes Provider plan](./80-Plans/tabro-hermes-provider-2026-10-01/README.md) owns the remaining Plugin, cross-platform installation and upstream menu work. Shared-runtime consolidation is complete in that plan; those later milestones remain pending.
- [Runtime conformance follow-up](./80-Plans/runtime-conformance-follow-up-2026-10-02/README.md) records the audit's pending discovery-helper, isolated-probe, scheduler-bound and retention work. Canonical requirements do not by themselves prove these implementations exist.
- [The August implementation plan](./80-Plans/octopus-browser-relay-implementation-2026-08-31/README.md) remains a historical implementation and qualification record. Its original fourteen-tool scope does not override the current MCP contract.

[Development plans](./80-Plans/_MOC.md) routes other work; [the changelog](./99-Changelog/_MOC.md) records applied documentation updates. These records do not override the canonical owners above.
