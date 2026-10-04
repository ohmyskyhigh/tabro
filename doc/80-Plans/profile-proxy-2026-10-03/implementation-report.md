# Profile proxy implementation report

**Date:** 2026-10-03
**Status:** Historical initial delivery, qualified on Windows with Chrome 153.0.8010.53. Its both-ownership, idle-only scope and automatic clear/restart behavior are superseded by the [closed-Profile amendment](./closed-profile-amendment.md). The current contract permits proxy configuration only while a broker-owned Profile is closed.

## Delivery

### Both Profile ownerships now support authenticated HTTP, HTTPS and SOCKS5 proxies

The 0.4.0 Broker and extension implement Profile-wide regular-browser routing through a dedicated loopback gateway. MCP contract 5 exposes twenty-two tools, including `get_browser_proxy`, `set_browser_proxy`, `clear_browser_proxy` and `check_browser_proxy`. Migration 008 stores bindings and durable ticket associations. The network scope is independent of launch ownership.

Credentials enter through the local stdin provisioning tool and use Windows DPAPI CurrentUser encryption with restricted directory ACLs. MCP receives only a principal-bound `credential_ref`. The extension never receives upstream credentials. The pinned gateway dependency is `proxy-chain` 3.0.1.

### Saved configuration, effective application and observed exit IP remain separate

Set/clear require an idle Profile and an expected revision. Persistent tickets fence workspace admission and lifecycle operations. Exit checks also prevent a simultaneous mutation or lifecycle change. A failed credential validation leaves the previous working configuration intact. A saved offline configuration remains pending until the extension reports application.

Clear releases Tabro's regular-profile setting. Broker-owned Chrome is normally restarted to remove any startup proxy flag; user-owned Chrome remains open. Enabled proxies do not fall back to direct on authentication failure or Broker outage.

## Verification

### Automated checks and isolated real Chrome runs cover authentication and lifecycle behavior

`pnpm verify` passed lint, typecheck, the unit/integration/contract suites, 2 E2E tests and the production build. After five additional regression cases for TLS/WebSocket tunnels, pending-check admission fencing and precommit credential failure, the final full `pnpm test` passed 239 tests across 48 files. Lint and typecheck passed again on the final source.

| Evidence | Coverage |
| --- | --- |
| `tests/integration/proxy-gateway.test.ts` | All three authenticated schemes; wrong-password rejection; TLS certificate verification; SOCKS remote DNS; isolated listeners; clear blackhole; occupied ports; TLS and WebSocket CONNECT; connection retirement on revision change |
| `tests/integration/profile-proxy.test.ts` | Both registry reference forms; durable acknowledgement; idempotency; principal authority; active-work rejection; pending checks; offline reconciliation; unsupported extensions; revision and credential failures |
| `tests/unit/extension-proxy.test.ts` | Serialized application; revision persistence; effective-setting conflicts; fixed-origin bounded exit probes |
| `tests/integration/proxy-credentials.test.ts` | Windows encryption; secret absence from vault bytes; principal binding and malformed reference rejection |
| `tools/probe-profile-proxy.ts` | Real Chrome, two MCP sessions, both launch ownerships, all three authenticated schemes, browser-originated IP checks, active-work conflicts, reopen/clear/restart behavior and no direct fallback |

Successful real-browser evidence: `artifacts/real-world/profile-proxy-1791016866341/report.json`. The test used disposable Profiles, a private Native Messaging registration and controlled proxy/echo fixtures. The echo addresses are documentation-range test values, not public Internet egress measurements. All temporary browser processes and the test Native Messaging registration were closed; artifacts are retained locally.

The real-browser run found and fixed a native `fetch` receiver error that simulated tests did not expose. Neither logged-in account browsing nor posting was used for qualification.

## Deployment

### The local Broker and fresh stdio sessions expose the new contract

The local database was backed up under `.relay-data/backups/profile-proxy-20261003/` before migration. The stable extension bundle and managed-runtime digest were rebuilt. The shared Broker now reports service 0.4.0, MCP 5 and relay 2. A fresh production stdio adapter listed all twenty-two tools and successfully read `get_browser_proxy` for mapleglen; its proxy remains unconfigured.

Broker-owned Profiles receive the new extension bundle on their next MCP launch. Existing user-owned Chrome must reload its unpacked extension to load the new permission and capability. Old extensions retain ordinary automation but cannot apply proxy commands. Existing MCP client processes must reconnect to load the new tool catalog. This deployment does not provision or enable a commercial proxy for any existing account.

## Adjustments

### Capability negotiation and consolidated modules replace draft-only file splits

Relay stays at 2 and advertises optional `profileProxy: 1`; `PROFILE_PROXY` carries a closed action enum. A relay-3 file and native protocol migration were unnecessary. Exit probing is inside `proxy-controller.ts`, DPAPI invocation inside `proxy-credential-store.ts`, and persistence tests share the service/repository suites. The physical harness is an explicit executable under `tools/`; it fails if its Windows/Chrome prerequisites are unavailable.

Effective settings are polled every two seconds and read back after each command. The draft's event-subscription design was not needed for this version. Credential provisioning supports protected stdin; interactive UI and an automated unused-credential deletion command are deferred. Protected files remain available until deliberately removed by the local operator.

## Limits

### Regular-profile URL routing does not provide a system-wide VPN

Chrome's implicit local-address bypass remains in place. Incognito, WebRTC/UDP, proxy pools, rotation, geographical selection and fingerprint changes are outside this version. HTTP(S) upstream authentication is Basic username/password; upstream HTTPS certificates are verified. SOCKS hostname forwarding is tested; this does not establish absence of every DNS or WebRTC leak.

Existing connections through Tabro's gateway are closed on revision changes. Connections created before Tabro controlled a user-owned Profile are not claimed to be retroactively routed; reopen that browser when a completely new browsing session is required. Policy or another extension can prevent control. User-owned startup before the extension loads is outside Broker launch control.

Parent: [implementation plan](./README.md).
