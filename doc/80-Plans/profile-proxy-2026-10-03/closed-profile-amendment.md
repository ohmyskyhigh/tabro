# Closed Profile proxy changes

**Date:** 2026-10-03
**Status:** Approved, implemented, physically qualified and deployed locally on 2026-10-03.

## Decision

### Proxy changes should follow close, configure and reopen

The user replaced the idle-workspace explanation with a simpler closed-Profile workflow. For broker-owned Profiles, set and clear must reject an open browser even if it has no active workspace. Saving a change does not open the browser. The next explicit launch applies the saved revision before admitting automation. Reading configuration and checking an applied proxy remain available while open.

### Only broker ownership permits proxy configuration

The user explicitly selected only MCP-managed ownership. Its existing wire value is `broker`; no new `mcp` ownership enum is introduced. User-owned Profiles reject set, clear and exit checks with `PROFILE_USER_OWNED`, both connected and disconnected. Get remains a read of saved facts. Automatic reconciliation and recovered tickets cannot apply user-owned proxy settings. No confirmation flag can bypass ownership. The Product-to-Files authority spine and operational instructions now reflect this decision.

## Implementation

### Managed checks inspect Chrome processes before committing a proxy revision

`ChromeLauncher.isClosed` checks the exact managed data directory against current Chrome process command lines, including processes outside the tracked instance record. `ProfileManager.assertClosed` rejects an unavailable inspection. `ProfileNetworkService` rejects cached open/unknown managed states or a connected extension at admission, and rechecks actual process closure immediately before committing. Managed set/clear save pending intent without dispatching an extension change or automatically closing/reopening Chrome.

Network tickets retain existing revision, authority and lifecycle fences. Actual application remains a separate observation on the next extension connection. Existing MCP 5 input/result schemas and error codes cover the narrowed rule, so no wire-version or database migration is needed. The production database had no saved proxy bindings before this amendment; no user-owned binding was deleted or silently reset.

## Verification

### Focused tests cover open browsers, extension outages and deferred clear

`pnpm verify` passed lint, typecheck, 246 tests across 48 unit/integration/contract files, 2 E2E tests and the production build. Focused proxy and launcher coverage passed 20 tests. Cases prove that an idle open managed Profile is rejected, a disconnected extension does not conceal a running Chrome process, no tracked instance is required to detect that process, closure is rechecked after acknowledgement, user ownership cannot bypass the rule, and an offline clear waits for the next connection without starting Chrome.

### Real Chrome proves the revised workflow through Native Messaging

`pnpm exec tsx tools/probe-profile-proxy.ts` passed all fourteen checkpoints on Chrome 153.0.8010.53. Evidence: `artifacts/real-world/profile-proxy-1791021022166/report.json`. It verified user-owned rejection online and offline, rejection of an idle open managed Profile, closed-configure-open authentication with HTTP/HTTPS/SOCKS5, wrong-credential failure, a second agent's active-work conflict, browser reopen, Broker outage/recovery and closed-clear-explicit-open without a proxy startup argument. These runs use isolated Profiles and controlled fixture IP values, not commercial Internet egress.

## Deployment

### The shared local Broker now enforces the revised rule

The rebuilt Broker was restarted successfully with service 0.4.0 and MCP contract 5. A fresh production stdio connection listed twenty-two tools with the new closed/broker-only descriptions. Both set and clear against an existing user-owned Profile returned `PROFILE_USER_OWNED`; its revision stayed zero. Production proxy bindings were empty before rollout, and no existing account received a proxy configuration. Reconnecting existing clients refreshes their tool descriptions; the Broker enforces the new restriction regardless of cached client wording.

Parent: [Profile proxy plan](./README.md).
