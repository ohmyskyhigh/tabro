# Operational defaults

These defaults complete the agent-visible behavior needed to implement and test the canonical User Experience. They may be tuned through an evidence-backed proposal when real Codex, Hermes, Chrome, or AdsPower behavior differs, but tuning must not weaken the Product invariants for broker-issued identity, owner authority, ticket-before-dispatch, managed-tab confinement, full-cycle same-tab ordering, or explicit control.

## Recovery

### Debugger detach pauses affected work until attachment reconciliation succeeds

When Chrome reports that the extension debugger detached, Tabro marks the affected tab attachment unusable and pauses work that requires it. The extension may reattach automatically after the conflicting debugger is gone, but it must reconcile the live tab before browser work continues and must never infer that an interrupted command succeeded.

The agent sees the detach fact, the affected tab, the observation time, and the currently available retry, resolve, stop, or terminate actions. Opening DevTools must not silently move the workspace or retarget a command.

### Broker restart preserves public tickets and reconciles nonterminal work before continuation

Open public request tickets survive a broker-process restart. Queued work that never dispatched may continue from its durable lane position. Work that may have reached the extension is reconciled before any continuation; Tabro does not automatically replay an ambiguous raw CDP effect.

Each recovered tab starts a fresh current-page event baseline. The agent should treat it as beginning work on the currently loaded page with the same logical `workspace_ref` and `tab_ref`, not as a replay of missed events.

### A valid event cursor is retained within a bounded broker-managed window

Agents must not depend on a fixed retention duration or event count. A valid cursor reads the retained stream while it remains available. When its retained segment has expired, Tabro returns an explicit recovery result containing a fresh broker-issued cursor and current-page baseline rather than returning an empty page or replaying browser history.

The broker publishes its current retention limits as status or capability facts. Changing numeric retention limits does not change cursor semantics.

## Endpoint continuity

### A persisted profile identity restores the same endpoint after ordinary reconnects

Browser restart, extension service-worker restart, Native Messaging restart, and broker reconnect preserve the endpoint identity, readable pairing code, and nickname when the extension proves possession of the same persisted profile key.

Reset pairing, explicit re-pair, or extension reinstall creates a new endpoint identity. It does not inherit old workspaces or routing merely because it proposes the same nickname.

### Existing and manually configured identities preserve their label after a nickname collision

The extension proposes the compact nickname formed by combining the two words in its saved generated or customized code. If that nickname is already active or reserved for another profile identity, the broker returns a non-retryable conflict for that code and the extension shows the error without changing the saved label. The operator chooses another code and saves again, while the cryptographic profile identity remains unchanged. Resetting pairing creates a new profile identity, generated code, and nickname candidate.

A new managed Profile without an endpoint may generate a different candidate up to five times on collision, preserving its cryptographic identity and bootstrap binding. Established endpoints and ordinary extensions retain operator-controlled labels.

A retired nickname remains reserved until its endpoint is explicitly revoked or the broker's local maintenance operation releases it. Reusing text never restores the retired endpoint identity.

## Status

### Every retained status fact exposes source time and freshness

Broker, endpoint connection, browser observation, workspace, tab attachment, request phase, pause, and stall facts include `observed_at`, their source generation, and `current`, `stale`, or `unknown` freshness. Transport connection is event-driven; retained browser observations can become stale without being rewritten as current truth.

The endpoint conditions remain `usable`, `busy`, `offline`, `unresponsive`, and `failing`. Conditions describe facts. `available_actions` separately states what the caller can request now.

### A stalled request remains nonterminal until evidence or an explicit control changes it

The broker may label a request stalled and report its last phase, checkpoint, and observation time. Time alone does not fail, cancel, or complete it. The owner chooses whether to keep polling or use resolution, stop, kill, takeover, or termination where those controls apply.

## Request access

### Takeover during a nonterminal endpoint ownership freeze is rejected before ticket creation

A takeover that would change ownership while an accepted endpoint kill or resume is nonterminal is rejected synchronously without a ticket. The result identifies the ownership freeze and exposes the existing endpoint-control ticket when the caller has authority to inspect it.

The agent may retry takeover after the endpoint-control ticket becomes terminal. Tabro does not create a waiting takeover ticket behind the private freeze.

### Endpoint-control tickets remain requester-scoped after terminalization

The session that successfully submitted an endpoint kill or resume retains read-and-close authority for that ticket through terminal closure, even if a later takeover changes workspace ownership. The terminal endpoint-control ticket does not transfer to later workspace owners.

Audit records preserve the endpoint and workspace ownership facts that applied when the control was accepted and completed.

## Payloads and polling

### Agents use documented polling guidance while remaining free to wait longer

The default client guidance starts near 500 milliseconds and backs off to at most two seconds while no phase changes. This guidance is not a wire field, timeout, lease, or cancellation boundary.

Agents may poll less often. Polling never advances, releases, or reorders a browser request lane.

### Oversized raw CDP values fail explicitly instead of being truncated

Raw CDP parameters, results, errors, and event pages remain inline in contract version `5`. When a value exceeds the active inline or message limit, Tabro returns `PAYLOAD_TOO_LARGE` with the applicable limit and never silently truncates JSON.

Numeric inline, page, and retention limits are broker configuration published through capability facts. Broker-issued resource retrieval can be added in a later contract version after Codex and Hermes prove equivalent support.

## Compatibility

### Contract version three uses exact schemas and explicit launch ownership

The current public wire contract is version `5`, incorporating the [approved alias-only naming decision](../90-Proposals/Profile-Alias-Only.md) and the [extension registration and launch ownership decision](../90-Proposals/Extension-Profile-Ownership.md). Inputs and structured outputs are closed against unknown fields. A compatible implementation may tune documented numeric limits and polling hints; adding, removing, or changing a required public field, discriminator, tool name, state, or ownership rule requires a new contract version and a vault proposal.

Codex and Hermes must load the same tool definitions and produce equivalent structured results. Runtime quirks are handled in adapters and conformance profiles rather than by changing browser semantics for one agent.

Parent: [`User Experience MOC`](./_MOC.md).

## Managed Profiles

### Lifecycle operations have bounded waits without changing raw CDP recovery semantics

Managed launch supports compatible Chromium browsers on Windows; the current browser version floor is 153, with required capabilities checked during launch. Hermes installation checks the operator-selected executable before admitting the plugin; setup and Profile readiness remain separate steps. Exact tested builds belong in verification records. Profiles are owned by the authenticated principal and require profiles:read or profiles:manage; workspace authority remains session-based. Default page size is 50 (maximum 100), create keys contain 8–128 characters, and the pending lifecycle queue is bounded at 32 with three active operations. Queue and extension-ready waits are 120 seconds; launch and normal-close waits are 30 seconds. Bootstrap grants expire after five minutes. Request and Profile leases are renewed during long operations.

The directory reports process and extension observations separately from ready and automation_paused. State is reconciled on Broker startup and every ten seconds. Unverified ownership remains unknown. Disabling launchesEnabled in the managed configuration rejects create/open while preserving authorized list/stop. Stop retains Profile data and refuses active browser work.
