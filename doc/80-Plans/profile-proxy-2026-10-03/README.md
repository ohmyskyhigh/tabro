# Profile proxy support

**Plan date:** 2026-10-03
**Status:** Implemented and qualified on 2026-10-03
**Target milestone:** Windows Profile proxy MVP

## Scope

Add persistent network configuration to MCP-managed Tabro Profiles (`ownership=broker`). The user selected HTTP, HTTPS and SOCKS5 with username/password authentication, approved implementation and source-of-truth updates, then restricted proxy changes to closed broker-owned Profiles. The [closed-Profile amendment](./closed-profile-amendment.md) supersedes the original both-ownership, idle-only scope.

- Configure one upstream proxy per Profile and retain it across reconnects.
- Let agents inspect, configure, clear and test the setting through MCP.
- Share the same proxy across that Profile's windows and workspaces.
- Distinguish saved configuration, extension application and a dated exit-IP observation.
- Keep credentials out of MCP results, ticket bodies, extension storage and logs.

`ownership` describes browser launch responsibility and now determines eligibility for proxy configuration: only `broker` is supported. The pairing alias remains the only Profile name; configuration is keyed by stable `profile_ref`, never the alias.

## Recommendation

### A Broker-managed local forwarder supports authenticated proxies for managed Profiles

Use the extension's `chrome.proxy` API to route Profile URL traffic through a dedicated loopback listener. A Broker-managed forwarder translates that traffic to the configured HTTP, HTTPS or SOCKS5 upstream, including authentication. This avoids two separate authentication implementations and keeps upstream credentials in the Broker.

Chrome supports proxy configuration through extensions, but its native SOCKS5 client does not support authentication. The local forwarder is therefore useful functionality for the selected MVP, not merely an extra abstraction. [Chrome proxy API](https://developer.chrome.com/docs/extensions/reference/api/proxy), [Chromium proxy behavior](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md).

### Profile-wide changes require verified closure and a separate network capability

Use `profiles:network:manage` for setting and clearing a broker-owned Profile. Reject open or unverified browser state and conflicting active work. Verify actual process closure before committing. Save the change without launching Chrome; apply it on the next explicit open. User-owned Chrome cannot bypass this rule through disconnection or a confirmation flag.

When a configured proxy fails, fail proxied requests rather than silently selecting direct access. This is regular-profile URL proxying, not system-wide VPN coverage.

## Delivery

| Document | Purpose |
| --- | --- |
| [Technical architecture](./technical-architecture.md) | State, routing, credentials, control boundaries and proposed interfaces |
| [Implementation tasks](./implementation-tasks.md) | Five task groups, executable checks and rollback points |
| [Implementation report](./implementation-report.md) | Actual delivery, qualification evidence, deployment and documented adjustments |
| [Closed Profile amendment](./closed-profile-amendment.md) | Broker-only closed-Profile rule, current implementation and qualification |

New components: ProfileNetworkService, ProxyGatewayManager, ProxyCredentialStore, ProxyRepository and ExtensionProxyController.

Existing foundations: authenticated extension registry; stable Profile references; durable request tickets; Profile lifecycle fences; extension relay; SQLite migrations; agent-visible fact projections.

Task groups: (1) contract and qualification, two tasks; (2) storage and credentials, two tasks; (3) forwarder and extension adapter, two tasks; (4) MCP coordination and lifecycle, two tasks; (5) qualification and rollout, one task.

## Acceptance

- Authenticated HTTP/HTTPS and SOCKS5 work for two isolated test Profiles with different upstream routes.
- User-owned Profiles reject proxy operations both connected and disconnected; broker-owned changes require closure and a subsequent explicit open.
- Wrong passwords, upstream failure and missing credentials never select a direct fallback for proxied requests.
- Concurrent switching and workspace admission cannot cross the Profile network fence.
- A browser-originated exit-IP check is separate from a Broker-side upstream check and includes observation time and configuration revision.
- Alias changes and Broker restarts preserve bindings; secret scans of MCP output, database tickets and logs find no test password.

## Boundaries

Proxy pools, scheduled rotation, country selection, per-tab proxies and fingerprint changes are deferred. HTTP(S) authentication initially means Basic username/password; NTLM, Kerberos and client certificates are excluded. HTTPS describes encryption to the proxy, independently of whether the destination website uses HTTPS.

The approved decision is now recorded in the canonical Product-to-Files hierarchy. Capability negotiation on relay 2 replaces the draft relay-3 bump; MCP advances to version 5. See [vault rules](../../AGENTS.md).
