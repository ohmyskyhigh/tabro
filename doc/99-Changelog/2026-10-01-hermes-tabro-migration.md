# Hermes Tabro migration

## Changes

### Active Hermes references now use Tabro across all installed Profiles

Applied the approved local migration on 2026-10-01: 148 distinct files, 149 writes in two batches, and 23 file/directory renames. The scope includes 14 configurations, 127 Skill/resource files across 42 installations, and seven memory files. Screenshot Skill discovery now uses tabro-site-screenshots. Added a reusable migration CLI, rules and thirteen isolated tests; private configurations and backups remain ignored artifacts.

## Validation

### All Profiles discover eighteen tools and both Brokers accept real Hermes calls

Fourteen Profile checks matched the exact expected tool set. Twelve previously running gateways were restarted through supported Profile-scoped commands and confirmed running with new PIDs. Fresh real Hermes agents used the actual deferred tool execution flow for read-only Broker queries against both existing destinations. Existing chats were not messaged or individually exercised.

Tests passed, the final active plan has no changes, and isolated reversal of both real snapshots restored all 148 original file hashes. Authentication file hashes remained unchanged, and no browser control request was submitted.

## Boundaries

### Original history and compatibility identities retain their names

The announced preserve branch leaves logs, conversations, saved prompts, backups, curator ledgers and database history intact. Real installation paths, Native Host and extension capability identities remain unchanged; unrelated products and authors are retained. Locked or inaccessible scan paths are reported separately. Canonical MCP contracts did not change.

The stopped Demo Broker was recovered with its existing database and token. MCP remains on 13618; Relay uses 13620 because Verge occupied 13619. No Chrome window was reopened. Later Hermes plugin and configuration-version changes were retained with MCP semantics unchanged; whole-file rollback refuses later edits.

## References

### The execution plan records evidence and recovery instructions

See [plan](../80-Plans/hermes-tabro-migration-2026-10-01/README.md), [technical design](../80-Plans/hermes-tabro-migration-2026-10-01/technical-architecture.md), and [execution TODO](../80-Plans/hermes-tabro-migration-2026-10-01/implementation-tasks.md).
