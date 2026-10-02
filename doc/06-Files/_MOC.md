# Files MOC

Authority level: Files.

This level maps confirmed Component responsibilities to exact repository-relative source, test, migration, configuration, manifest, and documentation paths. Executable runtime evidence remains outside the documentation authority chain.

Status: the current repository map and physical runbook are canonical File-level records. Planned paths remain intentions in `80-Plans` until they exist.

## Current repository

### App-owned paths make each implementation owner visible from the top down

[`Repository-Map.md`](./Repository-Map.md) maps the current Broker Runtime, MCP Gateway, Broker Core, Durable Store, Extension Gateway, Browser Extension, Protocol Contract, setup, and verification files.

Broker-specific source is nested under `apps/broker`; independently launched or loaded programs remain sibling app directories; the shared protocol lives under `apps/shared/protocol`; setup and GitHub Release update code lives under `tools`; and generated runtime artifacts live under root `dist/` while release packages live under ignored `artifacts/release/`. The map also distinguishes retained relay-v1 migration code and automated evidence paths.

## Real-world qualification

### Physical Chrome, AdsPower, Codex, and Hermes evidence follows one reproducible runbook

[`Real-World-Runbook.md`](./Real-World-Runbook.md) maps installation, preflight, profile pairing, local fixtures, agent registration, ticketed CDP execution, concurrency, recovery, controls, evidence, and cleanup to checked-in commands and paths.

The runbook keeps Native Messaging qualification separate from direct-WebSocket diagnostics and records unresolved adapter or setup behavior as a failed or blocked checkpoint.

## Managed Profile qualification

### The Demo runbook separates shared Broker state from per-run evidence

[`../../tests/demo/README.md`](../../tests/demo/README.md) introduces the probe and Demo evidence. [`../../tests/demo/RUNBOOK.md`](../../tests/demo/RUNBOOK.md) owns current Demo commands, fixture lifetime, saved-URL recovery and Profile cleanup. [`../80-Plans/single-agent-multi-chrome-demo-2026-09-27/implementation-report.md`](../80-Plans/single-agent-multi-chrome-demo-2026-09-27/implementation-report.md) preserves the dated physical results.

## Translated operator guidance

### Simplified Chinese entry documents remain traceable to the canonical English Files and contracts

[`../zh-CN/README.md`](../zh-CN/README.md) routes readers to Chinese installation and architecture/MCP guidance. These translations help operators but do not replace the canonical English authority spine.

## Planned changes

### Undelivered paths remain in the active plan instead of appearing as runtime facts

The active plan under [`../80-Plans`](../80-Plans/_MOC.md) retains unfinished qualification and follow-up work. A path enters this File map only after it exists; a behavior becomes verified only through its stated executable evidence.

Parent: [`05-Components`](../05-Components/_MOC.md).
