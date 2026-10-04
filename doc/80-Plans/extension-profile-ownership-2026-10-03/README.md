# Extension registration and browser launch ownership

## Decision

### Every authenticated extension is managed by the Broker and available to agents

The user confirmed on October 3 that extension connection is the registration boundary. `ownership=broker` means MCP can launch or reopen the browser; `ownership=user` means the user opens Chrome before its extension connects. Both use the same Broker workspace and tab APIs. Ownership describes launch responsibility, not an agent's workspace authority.

## Delivery

### Discovery must join launch metadata onto the extension registry

Replace the principal-filtered managed-directory list with bounded extension-registry discovery. Include previously connected offline identities, exclude incomplete registrations, and enrich each row with `broker` or `user` ownership. Preserve existing references, pairing and browser data. A failed create remains inspectable through its ticket or idempotency key until the extension registers.

### Contract version three makes launch ownership visible without weakening workspace isolation

Add ownership to Profile, endpoint and window facts. Keep create/open/stop ticketed and scope-checked, share Broker launch resources across authorized agents, and reject process lifecycle operations for user-owned Chrome. Keep request access and workspace ownership independently fenced. Upgrade the Broker, adapter and startup version checks together.

### Regression checks cover automatic registration and access by independent agents

Verify both ownerships, no launcher configuration, offline retention, fresh inventory after reconnect, bounded pagination beyond 200 records, explicit user-owned lifecycle rejection and independent agents using extension-backed CDP. Run type checks, lint, the automated suites and the build before checking the installed runtime.

Parent decision: [accepted proposal](../../90-Proposals/Extension-Profile-Ownership.md).

## Verification

### The live Broker and both Hermes demo profiles use the new contract

The October 3 deployment rebuilt the Broker and adapter, restarted the shared Broker, and verified MCP contract version 3 against the existing database. The live registered list contains eleven identities: three broker-owned and eight user-owned, including connected and ready `goldjay`. Previous pairing and browser data were preserved in place, with a verified SQLite backup before restart. Stale adapter processes were closed so hosts reconnect using the new build.

Hermes desktop's MCP connection tests succeeded for both `tabro-1` and `tabro-2`, each discovering all eighteen tools with the updated Profile-list description. Automated checks cover shared discovery, process ownership, reconnect inventory, pagination, old ticket presentation and independent-agent CDP isolation. Lint, type checks, unit/contract/integration tests, end-to-end tests and the build passed. These checks do not claim a fresh physical launch test for every broker-owned Chrome Profile.
