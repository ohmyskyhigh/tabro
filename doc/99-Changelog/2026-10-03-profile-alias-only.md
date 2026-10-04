# Profile alias naming

## Authority

### The user approved one public name per Profile

The [accepted naming decision](../90-Proposals/Profile-Alias-Only.md) implements the user's request to remove separate display names while retaining existing pairing aliases. Product, UX, UI, System, Components and Files now describe the same naming model.

## Changes

### MCP contract 4 uses the pairing alias throughout Profile discovery and lifecycle results

`endpoint_nickname` is the sole Profile name. `create_browser_profile` accepts only `idempotency_key`; the extension assigns its alias through pairing. Following the user's clarification, migration 007 drops `managed_profiles.display_name`, removes the retired field from stored Profile ticket arguments/results, and normalizes creation hashes in the same transaction. The Profile type, repository and snapshot tool no longer accept or save an extra name. Pre-v4 creation keys still reuse their original Profile. Browser references, directories and existing aliases remain unchanged.

## Evidence

### Automated checks and the running Broker verify the updated public contract

Lint, typecheck, build, 194 tests and two E2E tests passed. The demo evidence verifier was updated to select role assignments by `profile_ref`, and its 14 tests passed. The build retained the locked native companion binary after a fresh temporary compilation succeeded; native source was unchanged.

After a verified SQLite backup, the local Broker was restarted on contract 4. Fresh MCP discovery returned 11 registered Profiles with no display-name field; the three demo browsers retained `mapleglen`, `fairwave` and `cloudcanyon` and were ready. Hermes dashboard connection probes for both Tabro configurations succeeded with 18 current tools. Existing conversation cache refresh was not independently verified. Local evidence is retained in `artifacts/alias-only-v4-verification.json` and `artifacts/alias-only-v4-hermes-check.json`.

### The local schema-seven migration removes stored names and preserves browser identities

The storage follow-up passed lint, typecheck, build, 197 tests and two E2E tests. Fresh-schema and schema-six migration tests verify removal of the column and historical Profile fields, preservation of unrelated raw CDP data, creation-key reuse and database integrity. The live database was backed up and migrated to schema 7. Comparison against the backup verified identical Profile identity/directory bindings, endpoint aliases and browser instances, zero remaining retired fields in Profile tickets, normalized creation hashes and successful integrity/foreign-key checks. Fresh MCP list and historical request reads passed schema validation. Evidence: `artifacts/drop-profile-name-verification.json`.
