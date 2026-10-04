# MCP contract

Status: canonical implementation baseline for wire-contract version `5`.

The companion [`MCP-Contract.schema.json`](./MCP-Contract.schema.json) is the exact machine-readable authority for public tool inputs and structured outputs. This document explains how agents use that schema. If prose and schema disagree, the mismatch is a contract defect that must be corrected before implementation is considered conformant.

## Scope

### Codex and Hermes receive the same managed-tab browser contract

Codex and Hermes use one runtime-independent MCP surface. The runtime supplies caller evidence outside model-authored arguments. Agents discover browser context, request workspaces, submit extension-supported CDP, inspect events and tickets, and invoke explicit recovery or lifecycle controls.

The interface never exposes Chrome debugging ports, Chrome window or tab IDs, extension IDs, connection IDs, debugger attachment IDs, tab-group IDs, broker epochs, queue positions, or private routing keys.

### The extension-backed CDP subset is capability-discovered and tab-confined

`send_cdp_command` accepts a raw CDP method and parameters only after the broker proves that the paired extension supports the method and that the call remains inside the selected managed tab or its browser-issued child session tree.

Unsupported, unknown, browser-wide, or out-of-scope methods reject synchronously without a request ticket. The agent interprets raw CDP results and events; Tabro interprets routing, ownership, request lifecycle, and recovery.

## Tool catalog

### Sixteen tools submit durable asynchronous requests

| Tool | Purpose |
| --- | --- |
| `set_browser_proxy` | Save and apply authenticated Profile routing while idle. |
| `clear_browser_proxy` | Release Tabro routing while idle. |
| `check_browser_proxy` | Observe the applied route from a browser-originated IP check. |
| `create_browser_profile` | Create an owned Profile, load the extension and establish readiness. |
| `open_browser_profile` | Ensure an existing owned Profile is ready. |
| `stop_browser_profile` | Normally close an owned Profile after active work ends. |
| `request_browser_workspace` | Acquire an exact number of workspaces on distinct eligible browser-profile endpoints. |
| `create_browser_tab` | Create and register one managed tab in an owned workspace. |
| `send_cdp_command` | Send one extension-supported raw CDP command to one managed tab. |
| `take_over_workspace` | Transfer one exactly identified workspace and its owner-governed public tickets. |
| `terminate_workspace` | Fence new work, reconcile dispatched work, confirm archive rename, and end control. |
| `resolve_browser_request` | Resolve one owner-visible `user_confirmation_required` command. |
| `stop_workspace_automation` | Add the manual-stop cause to one workspace. |
| `resume_workspace_automation` | Reconcile one workspace and clear only its manual-stop cause. |
| `kill_browser_endpoint` | Pause every active workspace on an entirely owned endpoint. |
| `resume_browser_endpoint` | Reconcile an entirely owned endpoint and clear only endpoint kill. |

Every accepted asynchronous call returns a broker-issued `request_ref` before browser or extension work becomes eligible. Rejections completed before durable acceptance return synchronously and create no public ticket.

### Five tools read current bounded facts immediately

| Tool | Purpose |
| --- | --- |
| `get_browser_proxy` | Read configuration, application and exit-IP observations. |
| `list_browser_profiles` | List all extension-registered Profiles with nicknames, broker/user ownership and observed states. |
| `get_browser_context` | Read one targeted, paginated broker, endpoint, window, capability, workspace, tab, or request-summary view. |
| `read_cdp_events` | Read retained raw CDP events from a required broker-issued tab cursor. |
| `get_browser_request` | Read one authority-visible request ticket by its broker-issued reference. |

These reads create no request ticket and never release, reorder, or advance browser work.

### One immediate control removes a terminal ticket from the public view

`close_browser_request` performs an atomic authority, terminal-state, and owner-epoch check before removing a terminal ticket from public discovery. It preserves broker audit records and cannot cancel queued, running, or paused work.

## Public identity

### Agents only echo references that Tabro previously returned

The broker issues Profile, session, lineage, window, workspace, tab, request, pagination-cursor, and event-cursor values. The caller supplies only the creation idempotency key; that key deduplicates creation and is not a broker-issued resource reference. The model must not generate, derive, parse, or modify them.

The extension proposes a human-readable endpoint nickname during pairing. Raw browser-issued CDP values such as `sessionId`, `objectId`, or `nodeId` may be echoed only where the selected supported CDP method accepts them; they are not Tabro references.

### Every existing-tab operation repeats workspace and tab ownership context

The ordinary browser target is the composite pair `{workspace_ref, tab_ref}`. The broker validates that the tab currently belongs to that workspace and that the caller has current owner or lineage authority before acceptance and again immediately before dispatch.

Workspace acquisition returns each created or resumed `workspace_ref`, at least one managed `tab_ref`, and an initial event cursor. `create_browser_tab` returns the same composite context for the newly registered tab.

## Context reads

### Each context call requests one narrow view

`get_browser_context` uses the schema's closed `view.kind` union rather than returning the entire broker graph. Collection views use broker-issued opaque cursors and caller-supplied bounded page sizes.

Known offline endpoints remain discoverable. Status facts and `available_actions` remain separate: status says what Tabro observed, while an available action says what this caller may request now.

### Conflicting repeated endpoint selections reject before ticket creation

A workspace request may repeat an endpoint nickname, but the broker normalizes exact repeats to one endpoint. If repeated entries name different `window_ref` values for the same endpoint, the request rejects as `INVALID_ARGUMENT`; Tabro never chooses between conflicting model inputs.

When no `window_ref` is supplied, the broker uses the endpoint's most recently focused eligible existing window. It creates a tab group there rather than opening a new browser window.

## Request lifecycle

### Durable acceptance returns the exact normalized request body and one ticket

An accepted response contains the broker-issued `request_ref`, the exact normalized request body, lifecycle state `queued`, timestamps, current phase and checkpoint, nullable pause condition, and an executable `get_browser_request` action containing the same reference.

The request lifecycle is `queued` or `running`, followed by exactly one terminal state: `succeeded`, `failed`, or `uncertain`. Pause condition is a separate nullable fact and never becomes another lifecycle state.

### Same-tab CDP tickets retain one full-cycle FIFO lane until terminal commit

Accepted commands for the same exact `workspace_ref` and `tab_ref` occupy one broker-private lane in durable ticket-acceptance order. The head retains the lane through pre-dispatch waiting, extension execution, pause, reconciliation, and terminal commit. Later tickets never overtake it.

Polling is lane-neutral. Human resolution can atomically terminalize and release the head without waiting behind the ordinary tab lane. Scheduling across different tabs, workspaces, or endpoints is not represented by an agent-authored priority or order field.

### Ticket phases and checkpoints are diagnostic rather than agent-defined state machines

The version `5` schema retains a nonempty phase string and a checkpoint with `name`, `recorded_at`, and bounded details. Agents may display and reason from these values but must use lifecycle state, pause condition, problem, and available actions for control decisions.

Implementations may add internal phases without changing the wire version only when the public schema still accepts them and their meaning does not change a required public action.

## Recovery and control

### Browser ambiguity requires explicit owner resolution and never hidden replay

If disconnect or lost acknowledgement leaves a raw CDP effect ambiguous, the original request remains nonterminal with `user_confirmation_required`. `resolve_browser_request` is asynchronous and accepts exactly one of the schema-defined decisions.

`confirmed_succeeded` performs no browser mutation. `restart_failed` preserves the old tab, waits for stop and kill fences to clear, and uses one initial replacement attempt plus at most two reconcile-before-retry attempts. The exact successful and exhausted result relationships in the schema are normative.

### Stop, resume, kill, takeover, and termination remain distinct controls

Workspace manual stop and endpoint kill are independent pause causes. Workspace resume clears only manual stop; endpoint resume clears only endpoint kill. Takeover preserves both. Termination is an orderly lifecycle action rather than cancellation.

The exact modes are canonical: human resolution, workspace stop and resume, endpoint kill and resume, takeover, and termination are asynchronous; ticket close is immediate and terminal-only.

### Endpoint ownership freezes reject conflicting takeover synchronously

Endpoint kill and resume admit only when the caller owns every active workspace on the endpoint. Acceptance freezes those ownership facts through terminalization. A takeover attempted during that interval rejects synchronously without a ticket.

The endpoint-control ticket remains requester-scoped through terminal closure, including after a later ownership change. It never bulk-transfers with owner-governed workspace-operation tickets.

## Pagination and payload limits

### Page limits are advertised and invalid requests fail explicitly

Context collection views and event reads accept `page_size` from 1 through 100, as advertised by the tool schema and enforced by the broker. Cursors bind the query, ordering snapshot, caller visibility, and relevant owner or connection generation.

`list_browser_profiles` instead uses `limit` (1–100, default 50) and its Profile cursor, as defined in the same schema.

Changing a query or crossing an authority, stream, or connection generation invalidates the cursor rather than silently continuing a different collection.

### The current contract keeps raw values inline and rejects oversized payloads

Raw CDP JSON remains inline. A request or response that exceeds the active broker, Native Messaging, or MCP bound returns `PAYLOAD_TOO_LARGE` with no silent truncation. Broker-issued artifact retrieval requires a later wire-contract revision after both target runtimes prove support.

## Compatibility

### The current contract is closed and shared by both target runtimes

Every tool publishes the exact input and output root from [`MCP-Contract.schema.json`](./MCP-Contract.schema.json). Unknown input fields reject. Required public fields, discriminators, references, states, ownership semantics, and tool names change only under a new contract version.

Numeric queue, page, payload, retention, and polling guidance may be tuned from real tests when the broker advertises the active value and preserves the same observable error or recovery semantics.

Codex and Hermes conformance must prove the same tool catalog, non-model caller injection, broker-issued-reference behavior, ticket-before-dispatch ordering, structured outputs, recovery facts, and raw CDP bytes.


## Managed Profiles

### Four Profile tools add persistent lifecycle management to the existing workspace contract

| Tool | Input | Response |
| --- | --- | --- |
| `list_browser_profiles` | Optional `limit` (1–100, default 50) and opaque `cursor` | Immediate extension-registered Profile facts for both ownerships, including previously connected offline Profiles |
| `create_browser_profile` | Only `idempotency_key` (8–128 ASCII letters, digits, dot, underscore, colon or hyphen) | Durable ticket; an already completed or closed same-key request returns the existing Profile |
| `open_browser_profile` | Broker-issued `profile_ref` | Durable ensure-ready ticket |
| `stop_browser_profile` | Broker-issued `profile_ref` | Durable normal-stop ticket; active work blocks closure |

Profile, endpoint and window facts include required `ownership` (`broker` or `user`) describing launch responsibility. All authenticated MCP callers can discover registered Profiles regardless of creator and whether the managed launcher is configured. `profile_ref` retains the launch-directory reference for a broker-owned Profile and uses the broker-issued endpoint reference for a user-owned Profile. `endpoint_nickname` is the sole human-facing name (pairing alias) for both. Profile facts have no `display_name`, and creation does not accept that field. Before first pairing, lifecycle facts may have a null nickname and retain their opaque `profile_ref`. The list contains identities with at least one authenticated connection, retains offline identities, and omits incomplete or revoked registrations. Its bounded opaque cursor belongs to the calling session and authenticated principal.

Browser state, extension state, readiness and automation pause remain separate. A disconnected user-owned browser has unknown process state; disconnection does not prove Chrome has closed. Current connection generation and fresh eligible-window inventory determine readiness. No tool accepts process IDs, data paths, Chrome extension IDs, Chrome arguments or principal IDs. `profiles:read` governs lifecycle ticket inspection; `profiles:manage` governs Broker lifecycle operations and terminal ticket closure. Launch capacity is shared across authorized principals, while lifecycle ticket inspection and closure stay with the requesting principal. `open_browser_profile` and `stop_browser_profile` reject user-owned references with `PROFILE_USER_OWNED`; agents use `request_browser_workspace` after the human opens Chrome. No launch ownership grants access to another agent's workspace.

The database migration removes the retired display name from the Profile schema and stored Profile ticket arguments/results. Pre-v4 creation hashes are normalized to the key-only request, so the original Profile is still reused. Raw CDP data and unrelated agent names are outside this migration.

### Contract version 5 requires a matching Broker and adapter before tool execution

The Broker exposes twenty-two tools and returns `contract_version: "5"`. The HTTP MCP transport requires `x-octopus-contract-version: 5`; authenticated mismatches return HTTP 409 before admission, while unauthenticated requests remain HTTP 401. The stdio adapter checks `/health` before connecting and sends the version header. Browser extension relay protocol remains version 2 independently.

## Profile networking

### Four network tools extend the contract to twenty-two tools in version 5

`get_browser_proxy` reads one `profile_ref`. `set_browser_proxy` accepts that reference, `expected_revision`, `idempotency_key` and a `proxy` containing `scheme` (http/https/socks5), `host`, `port` and optional `credential_ref`. `clear_browser_proxy` accepts the reference, expected revision and idempotency key. `check_browser_proxy` accepts the reference and expected revision. Get is an immediate read; the other three return durable tickets before effects. No tool accepts passwords or proxy URLs with embedded credentials. Set/clear require `profiles:network:manage`; reads/checks require Profile read authority. Request inspection stays with the requesting principal. Profile facts include a compact proxy summary. The schema bundle owns exact result shapes and error names.

### Network observations never replace workspace or launch ownership

Get can read saved facts for either ownership. Set, clear and exit checks require `ownership=broker`; user-owned references reject with `PROFILE_USER_OWNED`. Set and clear additionally require the Profile to be closed: a connected extension or known open instance rejects with `PROFILE_IN_USE`, and unverified process inspection reports `PROFILE_INSTANCE_UNVERIFIED`. Active work, acquisition and lifecycle conflicts also prevent changes. A saved change does not launch Chrome and remains pending until the next explicit launch and extension read-back. Get remains usable while open; exit checks require an applied proxy. Effective state and IP observations carry revisions and freshness. Contract 5 retains the same closed tool inputs and outputs; network-capable extensions advertise an explicit proxy capability on relay version 2. Unsupported extensions cannot be marked applied.

Parent: [`User Interface MOC`](./_MOC.md).
