# Tabro rename

## Decision

### The approved product name is Tabro

The user selected Tabro on 2026-09-30 to distinguish the project from Octo Browser. The rename changes branding and MCP registration names without changing browser ownership, profile persistence, or the eighteen-tool contract.

## Tasks

### The rename updates public surfaces and preserves installed identities

- [x] Rename package metadata, extension labels, runtime identification, and demo labels.
- [x] Update current product, experience, interface, system, component, file, and setup documentation; preserve historical records and working GitHub links.
- [x] Generate `tabro` MCP registrations and support Tabro environment variables with legacy fallbacks.
- [x] Rename future release assets and let the updater discover both old and new asset names.
- [x] Rename existing local Codex and Hermes registrations in place with backups, preserving each entry's connection settings.
- [x] Update the pending Hermes task definitions to use `tabro`.
- [x] Verify configuration compatibility, eighteen-tool discovery, tests, and build output.
- [x] Apply the separately approved GitHub repository rename, update the local remote and current installation links, and verify repository identity and historical release access.

## Compatibility

### Existing Chrome identities and data paths remain valid after the rename

Retain the extension key and ID, Native Messaging host name, persisted storage keys, capability IDs, wire fields and headers, internal module identifiers, existing installation directory, profile directories, and database paths. Existing `OCTOPUS_*` variables continue working. The user subsequently approved migrating GitHub and the local remote to `ohmyskyhigh/tabro`. The existing checkout directory stays in place; historical records retain their original URLs as migration evidence.
