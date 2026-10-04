# Profile alias naming

## Scope

### Pairing aliases replace the separate public Profile display name

The user approved one name per Profile on October 3: retain existing pairing aliases such as `mapleglen`, `fairwave` and `cloudcanyon`. Remove the independent public display name and stop requiring a name when creating a Profile. Extension pairing continues to assign the alias.

## Delivery

### The clarified requirement removes the stored field as well as the public field

The user clarified that no separate name may be stored. Remove `ManagedProfile.displayName` and the repository name arguments, migrate `managed_profiles` to drop `display_name`, remove that retired field from stored Profile ticket arguments/results, and normalize creation hashes to the key-only request. Preserve Profile references, endpoint bindings, instances and unrelated raw CDP data. Verify fresh and upgraded databases, then migrate the local Broker.

Completed: migration 007 is applied locally. Lint, typecheck, build, 197 tests and two E2E tests passed. Live schema inspection confirms the column is absent; comparison with the backup confirms stable identities, aliases and instances. Profile history has no retired name fields, and fresh MCP list/request reads validate successfully.

### Contract and runtime changes must preserve existing identities and creation retries

1. Record the accepted decision and update the canonical Product → Files chain.
2. Publish MCP contract version 4 without Profile `display_name`; create accepts only `idempotency_key`.
3. Adapt historical Profile result facts at read time and retain old audit records and idempotency reservations.
4. Verify discovery, creation, lifecycle results and upgrade compatibility; build, restart the local Broker and check both Hermes connections.

### Automated checks and live MCP discovery confirm the alias-only contract

Completed on October 3. Lint, typecheck, build, 194 unit/contract/integration tests and two E2E tests passed; the adjusted demo verifier also passed its 14 tests. The local Broker now reports MCP contract 4. A fresh stdio MCP session listed all 11 registered Profiles without `display_name`; `mapleglen`, `fairwave` and `cloudcanyon` retained their aliases and were connected and ready. Creation advertises only `idempotency_key`. Fresh dashboard connection probes for Hermes `tabro-1` and `tabro-2` each found 18 current tools. These probes do not assert that an existing conversation's cached tool catalog has refreshed.
