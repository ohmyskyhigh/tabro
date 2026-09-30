# MCP contract

Status: canonical implementation baseline for wire-contract version `2`.

The companion [`MCP-Contract.schema.json`](./MCP-Contract.schema.json) is the exact machine-readable authority for public tool inputs and structured outputs. This document explains how agents use that schema. If prose and schema disagree, the mismatch is a contract defect that must be corrected before implementation is considered conformant.

## Scope

### Codex and Hermes receive the same managed-tab browser contract

Codex and Hermes use one runtime-independent MCP surface. The runtime supplies caller evidence outside model-authored arguments. Agents discover browser context, request workspaces, submit extension-supported CDP, inspect events and tickets, and invoke explicit recovery or lifecycle controls.

The interface never exposes Chrome debugging ports, Chrome window or tab IDs, extension IDs, connection IDs, debugger attachment IDs, tab-group IDs, broker epochs, queue positions, or private routing keys.

### The extension-backed CDP subset is capability-discovered and tab-confined

`send_cdp_command` accepts a raw CDP method and parameters only after the broker proves that the paired extension supports the method and that the call remains inside the selected managed tab or its browser-issued child session tree.

Unsupported, unknown, browser-wide, or out-of-scope methods reject synchronously without a request ticket. The agent interprets raw CDP results and events; Tabro interprets routing, ownership, request lifecycle, and recovery.

## Tool catalog

### Thirteen tools submit durable asynchronous requests

| Tool | Purpose |
| --- | --- |
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

### Four tools read current bounded facts immediately

| Tool | Purpose |
| --- | --- |
| `list_browser_profiles` | List persistent owned Profiles and their observed states. |
| `get_browser_context` | Read one targeted, paginated broker, endpoint, window, capability, workspace, tab, or request-summary view. |
| `read_cdp_events` | Read retained raw CDP events from a required broker-issued tab cursor. |
| `get_browser_request` | Read one authority-visible request ticket by its broker-issued reference. |

These reads create no request ticket and never release, reorder, or advance browser work.

### One immediate control removes a terminal ticket from the public view

`close_browser_request` performs an atomic authority, terminal-state, and owner-epoch check before removing a terminal ticket from public discovery. It preserves broker audit records and cannot cancel queued, running, or paused work.

## Public identity

### Agents only echo references that Tabro previously returned

The broker issues session, lineage, window, workspace, tab, request, pagination-cursor, and event-cursor values. The model must not generate, derive, parse, or modify them.

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

The version `2` schema retains a nonempty phase string and a checkpoint with `name`, `recorded_at`, and bounded details. Agents may display and reason from these values but must use lifecycle state, pause condition, problem, and available actions for control decisions.

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

Every paginated view and event read accepts `page_size` from 1 through 100, as advertised by the tool schema and enforced by the broker. Cursors bind the query, ordering snapshot, caller visibility, and relevant owner or connection generation.

Changing a query or crossing an authority, stream, or connection generation invalidates the cursor rather than silently continuing a different collection.

### Contract version two keeps raw values inline and rejects oversized payloads

Raw CDP JSON remains inline. A request or response that exceeds the active broker, Native Messaging, or MCP bound returns `PAYLOAD_TOO_LARGE` with no silent truncation. Broker-issued artifact retrieval requires a later wire-contract revision after both target runtimes prove support.

## Compatibility

### Contract version two is closed and shared by both target runtimes

Every tool publishes the exact input and output root from [`MCP-Contract.schema.json`](./MCP-Contract.schema.json). Unknown input fields reject. Required public fields, discriminators, references, states, ownership semantics, and tool names change only under a new contract version.

Numeric queue, page, payload, retention, and polling guidance may be tuned from real tests when the broker advertises the active value and preserves the same observable error or recovery semantics.

Codex and Hermes conformance must prove the same tool catalog, non-model caller injection, broker-issued-reference behavior, ticket-before-dispatch ordering, structured outputs, recovery facts, and raw CDP bytes.

Parent: [`User Interface MOC`](./_MOC.md).

## Managed Profiles

### Four Profile tools add persistent lifecycle management to the existing workspace contract

| Tool | Input | Response |
| --- | --- | --- |
| `list_browser_profiles` | Optional `limit` (1–100, default 50) and opaque `cursor` | Immediate owned Profile facts, including closed Profiles |
| `create_browser_profile` | Trimmed `display_name` (1–80 UTF-16 units) and `idempotency_key` (8–128 ASCII letters, digits, dot, underscore, colon or hyphen) | Durable ticket; an already completed or closed same-key request returns the existing Profile |
| `open_browser_profile` | Broker-issued `profile_ref` | Durable ensure-ready ticket |
| `stop_browser_profile` | Broker-issued `profile_ref` | Durable normal-stop ticket; active work blocks closure |

Profile facts separate browser state, extension state, readiness and automation pause. No tool accepts process IDs, data paths, extension IDs, Chrome arguments or principal IDs. `profiles:read` governs discovery and request inspection; `profiles:manage` governs lifecycle actions and terminal request closure. The current authenticated principal must own the Profile. That authority takes precedence over historical requester-session fields and cannot fall back to workspace authority.

### Contract version 2 requires a matching Broker and adapter before tool execution

The Broker exposes eighteen tools and returns `contract_version: "2"`. The HTTP MCP transport requires `x-octopus-contract-version: 2`; authenticated mismatches return HTTP 409 before admission, while unauthenticated requests remain HTTP 401. The stdio adapter checks `/health` before connecting and sends the version header. Browser extension relay protocol remains version 2 independently.
