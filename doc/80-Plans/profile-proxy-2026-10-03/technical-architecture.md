# Profile proxy architecture

**Plan date:** 2026-10-03
**Status:** Historical approved design baseline. Initial delivery adjustments are in the [implementation report](./implementation-report.md). The later [closed-Profile amendment](./closed-profile-amendment.md) restricts proxy changes to closed broker-owned Profiles and supersedes this document's user-owned and live-application design. Proposed types and file splits below preserve the original design; the current canonical contract and actual source paths govern the delivered version.

## Context

### The pre-feature launcher and extension had no Profile proxy implementation

The extension manifest has no `proxy` permission. `ChromeLauncher.launch` supplies process and bootstrap arguments but no proxy setting. `ManagedProfile` contains launch and identity metadata, not network configuration. User-owned Profiles come from authenticated extension registrations and have no managed launch row, so adding fields only to `managed_profiles` would omit them.

| Existing path | Reuse |
| --- | --- |
| `apps/broker/src/core/octopus/octopus-broker.ts` | Registry resolution, workspace admission, request coordination |
| `apps/broker/src/core/octopus/mcp-presenter.ts` | Profile facts |
| `apps/broker/src/profiles/profile-manager.ts` | Lifecycle serialization and admission barriers |
| `apps/broker/src/profiles/chrome-launcher.ts` | Startup routing for broker-owned Chrome |
| `apps/broker/src/storage/sqlite/database.ts` | Atomic schema migrations |
| `apps/broker/src/mcp/auth.ts` | Principal scope enforcement |
| `apps/browser-extension/src/protocol/dispatcher.ts` | Authenticated relay dispatch |
| `apps/browser-extension/src/service-worker.ts` | Extension startup composition |
| `apps/shared/protocol/src/relay/v2-messages.ts` | Existing closed relay contract to migrate deliberately |
| `apps/shared/protocol/src/mcp/tool-catalog.ts` | Tool catalog |

## Routing

### A separate loopback listener routes each Profile to one immutable upstream revision

```text
Operator credential input -> OS-protected vault -> opaque credential_ref
                                                    |
Agent -> MCP -> ticket/authority/idle fence -> saved Profile binding
                                          -> ProxyGatewayManager
                                          -> authenticated extension command
                                          -> chrome.proxy.settings

Chrome Profile URL request
  -> that Profile's loopback HTTP proxy
  -> HTTP / HTTPS / SOCKS5 upstream with Broker-held credentials
  -> destination website

Browser IP probe -> same Profile route -> fixed HTTPS echo service
                 -> revision + observed IP + time -> request result
```

Use `fixed_servers` with one HTTP loopback proxy and no `DIRECT` fallback. Retain Chrome's localhost and link-local bypass behavior so local Broker discovery, relay and the demo canvas continue working. Do not add broad intranet bypasses or arbitrary PAC code. Incognito support is deferred; use `regular_only` and report the scope explicitly. [Proxy settings](https://developer.chrome.com/docs/extensions/reference/api/proxy), [setting scopes](https://developer.chrome.com/docs/extensions/reference/api/types).

Evaluate a pinned release of `proxy-chain` behind a small adapter rather than writing CONNECT and SOCKS authentication from scratch. Its upstream chaining supports HTTP, HTTPS and authenticated SOCKS; it documents Basic authentication support. Validate its remote-DNS behavior with controlled fixtures before choosing the exact version. Always verify HTTPS upstream certificates; never set `ignoreUpstreamProxyCertificate`. [Project documentation](https://github.com/apify/proxy-chain).

Bind only `127.0.0.1`; persist listener allocation before publishing it to Chrome. A loopback port is private routing information, not an agent authorization token. This MVP trusts processes under the local operator account; it does not claim isolation from hostile local software. Reject requests that cannot map to a committed Profile/revision; never let an absent upstream value activate a library's default direct mode. Bound connections, timeouts and queues; forwarder shutdown closes its sockets. Do not record destination bodies or browsing URLs as proxy diagnostics.

## Components

### The network store covers registered user Profiles without creating launch ownership

New paths:

```text
apps/broker/src/proxy/
  types.ts                     shared internal interfaces
  profile-network-service.ts   authorization, tickets, fences, reconciliation
  proxy-gateway-manager.ts     listener and upstream lifecycle
  proxy-credential-store.ts    opaque references and protected credential access
apps/broker/src/storage/sqlite/
  proxy-repository.ts           bindings, revisions, observations and leases
  migrations/008-profile-proxy.sql
apps/browser-extension/src/proxy/
  proxy-controller.ts          set/get/clear and effective-setting observation
  exit-ip-probe.ts             bounded fixed-origin browser fetch
apps/shared/protocol/src/relay/
  v3-messages.ts               explicit network operations and observations
tools/
  provision-proxy-credential.ts
  proxy-credential-dpapi.ps1
```

Migration 008 is the proposed next number; recheck before implementation. Key bindings by the existing public `profile_ref` and resolve it through a common registry resolver. Broker-owned references may exist before first extension pairing; bind the later endpoint without changing the network row. Do not foreign-key every row to `managed_profiles`, key by alias, or create a new display-name field.

Persist desired revision, credential reference, network lease/fence, listener reservation and bounded observations separately. Runtime reports contain the extension connection generation and Broker instance ID. An old observation survives as history but cannot imply current readiness.

### Credentials enter through local provisioning rather than durable MCP arguments

Provide an operator command with hidden input or protected stdin; never pass passwords in command-line arguments. On Windows, use DPAPI CurrentUser through a fixed helper and stdin, plus restricted file ACLs. Store only opaque credential references in bindings and tickets. Provisioning prints the reference, not the secret. Validate the authenticated principal's right to use that reference before applying it. Unsupported platforms return an explicit unavailable result until an OS-vault adapter exists. [Microsoft DPAPI](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata?view=netframework-4.8).

Decrypt only in the forwarder process. Encode credentials correctly when constructing an upstream URL in memory and scrub dependency error objects before logging. Extension messages contain loopback routing and revisions, never upstream passwords. No need for `webRequestAuthProvider` or broad website interception just to authenticate proxies.

### The extension reports effective settings rather than assuming set succeeded

Check `levelOfControl` before changing settings and read the value back after setting it. Other extensions or policy can prevent control; return a distinct conflict instead of overwriting unrelated configuration. Subscribe to settings changes and proxy errors. A matching saved revision, current connection and matching effective value establish application; an IP probe establishes only a dated network observation.

The permission change needs a deliberate extension rollout. Restrict the exit-IP fetch to a fixed approved HTTPS origin; a candidate is ipify's documented JSON endpoint. Bound response size/time, prohibit redirects to a different origin and validate the response as an IP address. Automated tests substitute an isolated echo fixture, never live accounts. Do not expose arbitrary probe URLs to agents. [ipify API](https://www.ipify.org/).

### Network mutations serialize with lifecycle and workspace admission

Resolve `profile_ref` without using a launcher-only authorization method that rejects user-owned Profiles. Read access follows Profile discovery authority; set and clear require proposed scope `profiles:network:manage`. Preserve requester authority over network tickets.

Set/clear use durable ticket acknowledgement before effects and a persistent per-Profile fence. While holding the fence, recheck active workspaces, acquisitions, nonterminal browser requests and lifecycle operations. Reject if any exist, including the caller's own workspaces; the agent must end them first. Block new workspace admission and lifecycle dispatch during a network change. Two agents submitting the same expected revision cannot both commit different settings. Use idempotency keys and expected revision to make retries observable.

Prepare the new gateway before application; replace settings, read back, and retire old gateway connections only after the transition is accounted for. Never claim old unmanaged Chrome connections have changed route merely because a setting changed. Qualification must measure keep-alive and WebSocket behavior; if existing connections cannot be reliably retired, require browser restart for changes needing a clean route boundary. Broker-owned restart remains subject to existing idle/process checks; user-owned restart stays with the user.

An offline Profile can save the desired revision with `pending_connection`. That result means configuration stored, not applied. Reconnect reconciles before browser automation resumes. A configured but failed proxy prevents new automation and surfaces a network-specific cause without clearing independent workspace or endpoint pauses.

### Startup and rollback preserve routing intent without promising a system-wide kill switch

For broker-owned Chrome with an enabled proxy, prepare its listener before launching and supply the loopback proxy as a startup argument. The extension later owns normal setting management. Empty or unavailable credentials must block launch readiness, not omit the proxy flag.

For user-owned Chrome, the extension persists its regular-profile setting and reconciles on startup. Tabro cannot enforce routing before the user-owned extension takes control, or after it is disabled; do not claim otherwise. Settings changed by policy or another extension become `control_conflict`, not automatic direct success.

On Broker failure, the applied loopback proxy remains selected and proxied traffic fails. Restart reclaims the persisted port; a collision blocks readiness until reconciled. No reassignment of another Profile's port. If any revision may have applied before a crash, read effective settings before settling its ticket; never silently mark failure while presenting the old route as current.

Clear means release Tabro's setting and return to the browser's underlying configuration, which can itself be a system proxy. Broker-owned Chrome launched with a proxy argument must be normally restarted without that argument before clear is complete. Do not delete listener/vault state before verifying that release or restart. Saved configuration, observed application and observed exit IP remain distinct throughout.

DNS, WebRTC/UDP and other non-URL traffic need separate qualification. A later privacy option may use `chrome.privacy.network.webRTCIPHandlingPolicy`; introducing it requires explicit scope and permission decisions. MVP must not claim that a successful IP echo proves absence of every DNS or WebRTC leak. [Chrome privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy).

## Interfaces

### Proposed types keep secrets and observations separate from public configuration

These are proposed new application types; existing request, principal and reference types are reused when implementing their branded equivalents.

```ts
export type ProxyScheme = 'http' | 'https' | 'socks5';
export type ProxyApplicationState = 'unmanaged' | 'pending_connection'
  | 'applying' | 'applied' | 'failed' | 'control_conflict' | 'restart_required';
export interface UpstreamProxy {
  scheme: ProxyScheme;
  host: string;
  port: number;
  credentialRef: string | null;
}
export interface ProfileProxyBinding {
  profileRef: string;
  desired: UpstreamProxy | null;
  revision: number;
  updatedAt: string;
}
export interface ProxyAuthority {
  principalId: string;
  scopes: readonly string[];
}
export interface ProxyCredentials { username: string; password: string }
export interface ProxyCredentialStore {
  provision(value: ProxyCredentials, authority: ProxyAuthority): Promise<string>;
  read(ref: string, authority: ProxyAuthority): Promise<ProxyCredentials>;
  removeUnused(ref: string, authority: ProxyAuthority): Promise<void>;
}
export interface ProxyGatewayLease {
  profileRef: string;
  revision: number;
  fence: number;
  brokerInstanceId: string;
  host: '127.0.0.1';
  port: number;
  expiresAt: string;
}
export interface ProxyObservation {
  profileRef: string;
  desiredRevision: number;
  appliedRevision: number | null;
  connectionGeneration: number | null;
  state: ProxyApplicationState;
  levelOfControl: string | null;
  observedAt: string;
  problemCode: string | null;
}
export interface ProxyExitObservation {
  profileRef: string;
  revision: number;
  connectionGeneration: number;
  source: 'browser';
  ip: string | null;
  latencyMs: number;
  observedAt: string;
  problemCode: string | null;
}
export interface ProfileProxyFacts {
  binding: ProfileProxyBinding;
  application: ProxyObservation;
  exit: ProxyExitObservation | null;
}
export interface GetBrowserProxyInput { profile_ref: string }
export interface SetBrowserProxyInput {
  profile_ref: string;
  expected_revision: number;
  idempotency_key: string;
  proxy: {
    scheme: ProxyScheme;
    host: string;
    port: number;
    credential_ref?: string;
  };
}
export interface ClearBrowserProxyInput extends GetBrowserProxyInput {
  expected_revision: number;
  idempotency_key: string;
}
export interface CheckBrowserProxyInput extends GetBrowserProxyInput {
  expected_revision: number;
}
export interface ProxyRelayContext {
  connectionGeneration: number;
  revision: number;
  fence: number;
  attemptId: string;
}
export interface ApplyProxyCommand extends ProxyRelayContext {
  type: 'APPLY_PROFILE_PROXY';
  scope: 'regular_only';
  proxy: { scheme: 'http'; host: '127.0.0.1'; port: number };
}
export interface ClearProxyCommand extends ProxyRelayContext {
  type: 'CLEAR_PROFILE_PROXY';
  scope: 'regular_only';
}
export interface ReadProxyCommand extends ProxyRelayContext {
  type: 'READ_PROFILE_PROXY';
}
export interface ProbeProxyCommand extends ProxyRelayContext {
  type: 'PROBE_PROFILE_PROXY';
}
export type ProfileProxyCommand = ApplyProxyCommand | ClearProxyCommand
  | ReadProxyCommand | ProbeProxyCommand;
export interface ProxyRelayResult extends ProxyRelayContext {
  observation: ProxyObservation;
  exit: ProxyExitObservation | null;
}
```

## MCP

### Four tools expose configuration and browser-originated checks

| Proposed tool | Behavior |
| --- | --- |
| `get_browser_proxy` | Immediate bounded configuration and observations |
| `set_browser_proxy` | Ticketed save/apply; requires network-management scope |
| `clear_browser_proxy` | Ticketed release of Tabro routing; requires network-management scope |
| `check_browser_proxy` | Ticketed browser IP/latency check; requires a connected, stable revision |

Profile list facts gain a compact proxy summary. No upstream password, local listener port or process identifier is public. Normalize and validate host/port separately; reject URL userinfo, arbitrary schemes, invalid ports and unknown credential references. Present an observed IP as an observation, not a permanent property of a rotating provider.

The implementation advances the MCP contract from version 4 to 5 and from eighteen to twenty-two tools. Broker and adapter deploy together. Relay remains at 2 with optional `profileProxy: 1` capability negotiation, replacing the original proposed relay-3 migration. Old extensions are unsupported for proxy commands and never treated as having applied a proxy; ordinary automation remains available without a configured binding.
