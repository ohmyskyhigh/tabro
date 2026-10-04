# User Experience definition

Product parent: [`../01-Product/Product-Definition.md`](../01-Product/Product-Definition.md).

## User

Tabro is used by AI-agent sessions that need to perform website automation in one or more browser profiles. Codex agent sessions and Hermes agent sessions are the concrete runtimes covered by this contract; the interaction model remains defined for the Product's AI-agent target.

Codex and Hermes use Tabro through MCP. A human can initiate installation and give an agent its website-automation task, but the agent session is the user that discovers browser endpoints, obtains workspaces, sends CDP commands to managed tabs, reads relayed CDP events, and manages workspace continuation through Tabro.

The desired outcome is for the agent to use the portion of Chrome's `chrome.debugger` CDP surface that Tabro can keep inside a selected managed-tab tree across long tasks, multiple profiles, and session handoffs. The paired extension attaches to managed tabs and relays that traffic, so the agent does not launch or manage Chrome through a remote-debugging port or pipe and does not manage broker-private extension attachments or target routing. The agent remains responsible for selecting permitted CDP methods and deciding what raw results, debugger errors, and events prove about its website task.

## Installation

Installation is a supporting journey that occurs before a Codex or Hermes automation session starts using Tabro.

### First-time Hermes setup downloads and installs the local browser runtime

For the Hermes plugin distribution, the human starts Tabro setup after installing and enabling the plugin. Setup downloads and installs the Broker, MCP Adapter, Native Host and browser-extension files, and prepares the required runtime dependencies. The human is not asked to obtain or start a separate Broker beforehand. Setup registers the local integration, starts the Broker and guides any browser-required extension installation or permission steps before reporting readiness.

An existing compatible local installation may be reused through the shared-deployment journey below. Reuse is an optimization, not a prerequisite for new users. Proxy configuration follows [the Profile networking journey](#profile-networking) after installation; it retains the closed broker-owned Profile restriction.

This approved journey is pending implementation and clean-machine qualification in the [Hermes delivery plan](../80-Plans/tabro-hermes-provider-2026-10-01/README.md). The scripted installation and direct MCP registration described below remain the existing supporting path.

### The same installer sequence applies whether a human or setup agent starts it

A human can run the scripted installer directly or ask a standalone setup agent to run it on the human's behalf. Both entry paths use the same scripted installation journey because the Tabro MCP tool is not available until installation and registration are complete.

The scripted installer dictates the order of the setup work required to install:

- the local Tabro broker and MCP integration required by the intended agent runtime; and
- one distinct Tabro browser-extension instance in each browser profile intended to participate.

When an agent runs the installer, the agent follows the script's sequence and reports its output and result instead of reconstructing or improvising a separate installation sequence.

For Hermes, the registration script targets the default profile and every named profile installed when the script runs. Each isolated Hermes profile receives its own Tabro MCP entry and starts a new session before using the tools. Creating another Hermes profile later requires running the same registration script again for the expanded profile set.

Exact script names, commands, implementation language, packaging, and extension-to-broker transport details belong to later System, Component, and File definitions. The browser execution path is already fixed at the Product level: the installed extension relays managed-tab-confined CDP through Chrome's `chrome.debugger` API without a Chrome remote-debugging port or pipe.

### Demo and ordinary sessions share the local deployment while retaining their own workspaces

The October 1 deployment decision places Demo and ordinary MCP sessions on the same local Broker. Changing listener addresses does not require the automation agent to remember ports or change browser references. Agent sessions keep their own identity and workspace authority. Broker restart follows the existing reconciliation journey and does not authorize replay of a possibly dispatched browser effect. System owns the runtime discovery and instance checks that realize this behavior.

### Each participating browser profile saves one editable readable code and pairs automatically

After installation in a browser profile, that profile's distinct extension instance selects two short English words as its default pairing code. The operator may replace the default in the extension options with two three-to-eight-letter words. The saved uppercase code remains authoritative in that profile's extension storage and combines into the compact lowercase nickname that identifies its browser endpoint to agents. `MINT-WAVE` and `mintwave` illustrate the relationship; no numeric suffix is added. With the local broker running, the extension starts the pairing exchange automatically through its selected local transport. The human does not request or copy a code from the broker.

The options page lets the human edit the code and shows the derived endpoint nickname, transport, and current connection result so the profile can be correlated with the broker. Saving reconnects with the requested label. The pairing code is a readable installation label rather than a password. Successful first connection registers that one extension instance and browser profile as one browser endpoint. Later code changes rename that endpoint only after challenge authentication proves the persisted profile identity. If the proposed nickname belongs to another profile identity, the extension preserves the requested code and displays the conflict until the human chooses another.

Pairing registers browser capacity without assigning it to an agent. A Codex or Hermes automation session later binds designated or assigned workspaces to that endpoint through the ordinary session-time workspace request.

The installation journey is not ready for browser automation until every intended profile's extension reports that it is paired with the broker and its generated endpoint nickname is available for discovery. Ordinary reconnect uses the persisted profile identity without another pairing step. Reset or reinstall generates a new identity, readable code, and nickname candidate.

### The installer result tells the setup actor whether raw CDP automation can begin

The installer result states:

- whether the local broker is installed and running;
- whether Tabro is registered as an MCP tool for each intended agent runtime;
- whether each intended browser profile has its own extension instance;
- whether those profile-local extension instances are connected to the broker;
- whether each connected extension/profile endpoint has an extension-generated nickname registered uniquely within the broker;
- whether the intended endpoint can accept extension-relayed CDP traffic through `chrome.debugger`; and
- which unmet prerequisite prevents automation when the environment is not ready.

The installer result uses the extension's automatic-pairing result, generated code, and endpoint nickname when reporting whether those prerequisites are complete.

The Codex-and-Hermes demonstration is ready when Tabro is available as an MCP tool in both sessions, each intended browser profile has its own extension instance, and every resulting endpoint is paired, uniquely named within the local broker, and able to relay permitted CDP traffic through `chrome.debugger`.

### A verified update preserves pairing and reloads the unpacked extension from one stable path

GitHub Releases provide the versioned local-runtime package and checksum. The local updater verifies the package, stops only the installer-owned broker, installs the versioned runtime, preserves broker data, refreshes Native Messaging and MCP launch paths, starts the updated broker, and reports matching health evidence.

The human loads the updater's stable unpacked-extension directory once through browser developer mode. Later updates replace the contents at that same path. When the extension reconnects with an older version, the updated broker withholds browser-work readiness and requests one extension reload. The extension reloads, retains its profile-local identity and pairing, and reconnects before publishing browser inventory. A repeated mismatch stops with an explicit update error instead of creating a reload loop.

### Codex and Hermes begin browser work through the same ready MCP experience

The Codex or Hermes session performing website automation begins after the installer reports readiness. The automation session does not need the installer transcript or setup history in its browser-task context.

Both runtimes receive the same agent-facing concepts:

- browser endpoint discovery by nickname and condition;
- session-scoped browser workspaces;
- explicit logical workspace and tab targeting;
- managed-tab control within each workspace;
- asynchronous execution submission with broker-issued request references and direct request-status polling;
- raw CDP results or debugger errors within the managed-tab-confined surface permitted through `chrome.debugger`;
- direct cursor-paginated raw CDP event reading; and
- workspace continuation, transfer, termination, and restart.

Runtime-specific MCP registration or session-metadata adapters may differ, but those differences do not change the agent journey.

## Use cases

The default use case takes an agent from browser requirements through asynchronous workspace and CDP requests to extension-relayed command and event traffic against managed tabs in the intended browser workspace. Supporting use cases let an agent inspect its Tabro browser context, poll and close accepted request tickets, continue work across sessions, control more than one workspace, resolve an ambiguous command with human input, pause and resume work at workspace scope, pause work at endpoint scope, and recover when existing work should be transferred or abandoned.

### Profile, workspace and browser submissions share a ticket-first lifecycle

Profile create/open/stop, workspace acquisition, tab creation, CDP commands, human resolution, takeover, termination, and pause/resume controls use the asynchronous request lifecycle defined by the [MCP contract](../03-User-Interface/MCP-Contract.md). Profile launch ownership is broker/user; current lifecycle scopes govern Broker launches, tickets remain requester-principal scoped, and workspace operations retain their session and lineage rules. The broker first validates the caller and the submitted ownership and target relationships. For `send_cdp_command`, it also validates that the requested CDP method is available through the extension and can remain inside the selected managed-tab tree.

An invalid caller, ownership relationship, target, unsupported CDP method, or out-of-scope CDP method is rejected synchronously without a request ticket. For any other accepted submission, the broker durably accepts the work and returns the submission disposition `accepted` together with a broker-issued `request_ref` and the exact normalized request body the broker accepted, without waiting for browser or extension execution to finish. The acknowledgement must be delivered to the caller before any browser or extension dispatch. If that delivery fails, the caller receives an immediate transport failure and Tabro does not dispatch the work; there is no lost-acknowledgement rediscovery journey. The agent echoes the reference; it does not create or modify it.

`accepted` is the disposition of the submission response, not a request state. The accepted request begins in `queued`, advances to `running`, and finishes in exactly one terminal state: `succeeded`, `failed`, or `uncertain`. A disconnected extension can pause a queued or running request at its durable phase or checkpoint without changing that lifecycle state; the pause reason is a separate nullable condition, not a sixth state. The agent calls the direct `get_browser_request` read with the returned `request_ref` to see the exact normalized request body, current state, pause condition, and, after the request becomes terminal, its domain result. The domain result retains the existing workspace, tab, raw CDP, takeover, or termination meaning instead of becoming a typed website-operation outcome.

`list_browser_profiles`, `get_browser_context`, `read_cdp_events`, and `get_browser_request` are direct reads and do not issue request tickets. `read_cdp_events` requires a broker-issued cursor and returns the currently retained bounded event page immediately; it does not wait for a future browser event. A terminal `uncertain` request is never replayed automatically. The User Interface contract owns the complete tool catalog and execution classes: thirteen asynchronous submissions, four immediate reads, and one immediate terminal-ticket close.

### The default use case requests browser workspaces and sends raw CDP commands

The default journey is:

1. The agent starts with Tabro present in its MCP tool set.
2. The agent calls the direct `get_browser_context` read and sees known paired endpoints by nickname and condition, their paginated managed-tab capability summaries and eligible existing windows, the endpoints already bound to its session, and the workspaces its session lineage owns.
3. The agent determines how many distinct browser profiles and endpoints the task requires, which endpoint nicknames the human instruction designates, and whether to select any eligible window by its broker-issued `window_ref`.
4. The agent submits `request_browser_workspace` with that total, the designated nicknames, and any selected window references. The same profile or endpoint cannot satisfy the requested count twice.
5. Tabro rejects an invalid submission, an unavailable designated endpoint, or a request for more connected eligible distinct endpoints than are available synchronously without a ticket and without creating any workspace. Otherwise it durably accepts the request, delivers `accepted` with a broker-issued `request_ref`, and only then may begin browser execution.
6. The agent polls that request through the direct `get_browser_request` read while its state advances from `queued` to `running` and then to `succeeded`, `failed`, or `uncertain`.
7. During accepted execution, Tabro binds the designated endpoints, assigns additional available endpoints for any undesignated portion, and creates or resumes one tab-group workspace for each distinct endpoint binding and the agent's session lineage. A selected `window_ref` determines the existing window; omission uses that endpoint's most recently focused eligible existing window. If several eligible windows exist but Tabro has no focus history that establishes the default, it reports `WINDOW_UNAVAILABLE`; the agent reads the window choices and retries with one broker-issued `window_ref`. Tabro creates the new tab group there instead of opening another browser window.
8. A succeeded workspace result reports every resolved endpoint nickname, whether it was designated or assigned, its broker-issued logical workspace reference, selected logical window, current condition, and at least one managed-tab fact containing that `workspace_ref`, a broker-issued `tab_ref`, and the tab's initial broker-issued event cursor. A binding is reported as resolved only with at least one current workspace tab; a newly created workspace establishes its first tab before it appears in the result.
9. If execution fails after Tabro accepted a multi-profile request, the request finishes `failed`, keeps every workspace it already created, and returns those workspace references and all other known allocation facts. It does not report a partial-success state or result.
10. The agent names the intended workspace and managed tab when it submits `send_cdp_command`.
11. Tabro either rejects an invalid, unsupported, or out-of-scope command synchronously without a ticket or durably accepts it, delivers `accepted` with a broker-issued `request_ref`, and only then may dispatch it.
12. The agent polls that command request through `get_browser_request` until it becomes terminal or exposes a pause condition that requires an available recovery action.
13. The terminal command result exposes the raw CDP result or extension-debugger command error. A reconnect ambiguity follows the explicit human-resolution journey defined below instead of automatically becoming terminal uncertainty.
14. The agent calls the direct `read_cdp_events` read with the tab's broker-issued event cursor when currently retained protocol events provide evidence needed by its task.
15. The agent interprets the raw result, error, and events and chooses its next CDP command or Tabro workspace action.
16. The agent refreshes its browser context when it needs to verify current endpoint status, workspace ownership, managed tabs, window choices, or current capability facts.

If the task requires one endpoint and designates an eligible nickname, Tabro binds that endpoint and issues its workspace. If the task requires one endpoint without naming it, Tabro assigns one available endpoint and issues its workspace.

The agent communicates the total number of distinct browser profiles and endpoints required and zero or more designated endpoint nicknames. Designated endpoints are honored, while automatic assignment applies to the unfilled portion of the requested total. A designated or assigned endpoint counts once even if the agent repeats it.

For a request requiring three workspaces:

- three distinct designated nicknames produce three designated bindings;
- two distinct designated nicknames produce those two bindings plus one automatically assigned endpoint;
- one designated nickname produces that binding plus two automatically assigned endpoints; and
- no designated nicknames produce three automatically assigned endpoints.

The terminal request result identifies which endpoints were designated and which were assigned. An unavailable designated endpoint is not silently replaced: it causes synchronous rejection without a ticket or workspace creation even when other capacity exists. The same rejection applies when the connected eligible distinct endpoint set cannot satisfy the requested total at admission time. If creation fails only after admission, the ticket finishes `failed` and reports the workspaces already created and the remaining known facts without calling that result partial success.

Repeating a workspace request that resolves to an existing endpoint binding inside the same session lineage yields the existing workspace in its terminal domain result rather than creating a duplicate tab group.

If that persisted workspace no longer has a live Chrome tab group or any live workspace tabs, Tabro ends it and automatically creates a replacement in the selected or default existing window. The result returns the ended workspace facts together with the replacement's new `workspace_ref`, tab facts, and initial event cursor rather than reusing the old workspace identity.

### Agents create another workspace tab through Tabro and receive its tab reference

When an agent needs another tab inside a workspace it already controls, it submits `create_browser_tab` with the broker-issued `workspace_ref`. Tabro either rejects an invalid caller, ownership relationship, or target synchronously without a ticket or durably accepts the request and delivers `accepted` with a broker-issued `request_ref` before any browser dispatch.

The agent polls `get_browser_request` until the request reaches a terminal state. On the successful branch, Tabro has created the browser tab inside that workspace's existing browser window, added it to the workspace's tab group, established the private browser-to-workspace mapping, and returned a tab fact containing the `workspace_ref`, a new broker-issued `tab_ref`, and that tab's initial broker-issued event cursor in the terminal result.

If tab creation does not return a conclusive result, Tabro keeps the workspace active and reconciles the current window, tab group, and tabs before any retry. It retries only after proving that the intended tab is absent and makes at most three creation attempts in total. A tab-creation request that still does not succeed finishes `failed`; tab creation does not finish `uncertain`.

If the extension disconnects while this request is `queued` or `running`, its lifecycle state remains unchanged and its pause condition identifies the durable phase or checkpoint where work stopped. When the same endpoint reconnects, Tabro reconciles the live window, group, and tabs, resumes from that checkpoint, and retries creation only when it proves the effect is absent.

The tab-creation request establishes the logical tab target; it does not replace CDP website automation. After receiving the new `tab_ref` from a succeeded terminal result, the agent uses managed-tab-confined methods permitted through `chrome.debugger` to navigate, inspect, and interact with that tab.

### Opener-linked page children become managed tabs or related child workspaces automatically

When a managed page opens a child tab in the same browser window, Tabro adopts that child into the opener's workspace and tab group and exposes a tab fact with a broker-issued `tab_ref` and initial event cursor. When an opener-linked child appears in a new browser window, Tabro creates a related child workspace and exposes its new `workspace_ref`, `tab_ref`, and initial event cursor.

The agent discovers those new logical facts through its browser context and does not translate a Chrome target identifier into Tabro identity.

### Browser automation repeats a target, command, inspect, and decide loop

After a workspace request reaches a succeeded terminal result with a ready workspace, the binding portion of the journey is complete and the raw-CDP automation loop begins.

Each loop proceeds as follows:

1. The agent selects the logical workspace and the relevant managed tab, or submits and polls a tab-creation request when it needs another workspace tab.
2. The agent selects a CDP method permitted through `chrome.debugger` and confined to the selected managed-tab tree, supplies its raw parameters, and submits `send_cdp_command`.
3. Tabro either rejects an invalid caller, ownership relationship, target, unsupported method, or out-of-scope method synchronously without a ticket or durably accepts the command and delivers `accepted` with a broker-issued `request_ref` before dispatch.
4. The agent polls the accepted request through the direct `get_browser_request` read while it is `queued` or `running`, including while a separate pause condition prevents progress.
5. When the request becomes terminal, the agent receives the raw CDP result, extension-debugger command error, or failure associated with the selected logical target. If reconnect reconciliation cannot prove a previously dispatched command's effect, the agent follows the human-resolution journey instead of receiving an automatic retry or an immediate terminal-uncertain result.
6. When the agent needs browser-event evidence, it calls `read_cdp_events` with the tab's current broker-issued cursor to receive a bounded page of currently retained raw CDP events without waiting for future events or loading an unbounded history.
7. The agent decides whether the returned protocol facts prove its website intent and chooses the next command submission, request poll, event read, workspace, handoff, termination, or completion action.

The workspace and managed tab remain the explicit target throughout submission and polling. The agent does not rediscover or rebind the workspace before every CDP command, and Tabro does not rely on an implicit globally current browser or tab.

A successful CDP response proves only that the selected managed tab returned that protocol result through the extension relay. Tabro does not reinterpret it as confirmation that a click, navigation, form submission, or website task achieved the agent's intent.

### Agents inspect broker, endpoint, extension, browser, workspace, ownership, and tab state

An agent can call the direct `get_browser_context` read for a targeted slice of its current Tabro browser context when a session begins, while browser work is underway, or whenever its working context may be stale. The read returns current context without creating a `request_ref`.

The inspectable context identifies:

- the broker's current condition;
- connected and known offline browser endpoints by nickname and current condition;
- the extension and browser observations linked to a selected endpoint;
- broker-issued references for eligible existing windows and which eligible window was most recently focused;
- the current managed-tab-confined CDP capabilities available through each selected endpoint's extension;
- the endpoints bound to the calling session;
- each broker-issued logical workspace reference associated with the session;
- the owning session or inherited session lineage associated with each workspace;
- the browser endpoint and broker-issued managed-tab references associated with each workspace; and
- an initial broker-issued event cursor with every tab fact.

Collection views are paginated so the agent requests only the targeted portion it currently needs. Raw CDP events use their own direct cursor-paginated read path rather than being embedded in general browser context.

The endpoint condition distinguishes whether an endpoint is usable, busy, offline, unresponsive, or failing. These conditions are factual state rather than decisions about which action the agent should take.

The ordinary context view does not expose broker logs, Chrome remote-debugging ports or pipes, extension `chrome.debugger` attachment identifiers, or broker-private routing identifiers.

### Capability discovery supports planning and precise command correction

The paginated browser-context view lets an agent inspect the extension-backed managed-tab CDP surface proactively without introducing another capability tool. If the agent nevertheless submits a method that is unsupported or cannot remain inside the managed-tab tree, Tabro rejects it synchronously without a ticket or browser delivery and identifies that precise capability problem so the agent can correct the command.

### Event reads restart from a fresh tab cursor after a broker or extension outage

`read_cdp_events` requires a broker-issued cursor, and every tab fact supplies the initial cursor for its current stream. A broker or extension outage invalidates the previous stream and its cursor; the extension does not provide an alternate replay buffer.

After recovery, Tabro preserves the existing `workspace_ref` and `tab_ref`, reconciles the current live page and browser context, and exposes a fresh initial cursor. The agent approaches that current page as a new event stream. Tabro neither reloads the page nor replays the invalidated events.

### Agents monitor one accepted execution request through its broker-issued ticket

After an asynchronous submission returns `accepted`, the applicable authority polls the direct `get_browser_request` read with its broker-issued `request_ref`. Managed Profile requests use authenticated-principal authority. Ordinary workspace operations use current owner authority, workspace acquisition uses the requesting session's prospective-owner authority, and takeover and endpoint-control requests retain the requester authority defined by the canonical contract. Each poll returns the exact normalized request body, the request's current `queued`, `running`, `succeeded`, `failed`, or `uncertain` state, and any nullable pause condition without starting another asynchronous request.

A nonterminal poll reports request state and any pause condition rather than pretending the browser action has completed. A terminal poll exposes the request's domain result and its currently available Tabro actions. For `send_cdp_command`, that result preserves the raw CDP result or extension-debugger error; a reconnect ambiguity remains nonterminal until the explicit resolution journey finishes it. The request ticket does not turn protocol data into a semantic click, navigation, or website-task result.

This request-status read monitors only the Tabro execution request named by the ticket. It does not monitor unrelated Codex or Hermes work, replace endpoint and workspace context inspection, or expose broker-private log correlation identities. Tabro does not dispatch a newly accepted request until it has delivered the ticket acknowledgement, so failed acknowledgement delivery produces an immediate transport failure and no hidden accepted work to rediscover.

Workspace acquisition remains visible to its requesting prospective owner through terminal result and closure, and each replacement session likewise retains its own takeover-control ticket even when it never becomes owner. Ordinary workspace-operation tickets use current-owner authority. An authorized subagent call may operate under that authority but gains no independent entitlement. A winning workspace takeover transfers every still-public owner-governed ticket—including terminal tickets not yet closed—to the replacement owner and removes it immediately from the former owner; requester-scoped acquisition and competing takeover-control tickets do not transfer. A terminal ticket remains agent-visible without a timeout until its applicable authority deliberately closes it. Closing removes it from that authority's agent-visible request view, retains the internal broker audit, and cannot be undone.

Tabro exposes no per-request cancellation and applies no broker terminal timeout. Elapsed time or a reported stall can remain visible only as a nonterminal fact; it does not by itself move a request to a terminal state. Agents follow the documented polling guidance, open public tickets survive broker restart, stalled facts retain their checkpoint and freshness, and oversized inline raw values fail explicitly rather than being silently truncated.

### A replacement session takes ownership using the exact current binding references

When an error or urgent handoff requires a new independent session to continue existing browser work, the human gives that session the information required to identify the existing binding.

The replacement session requests takeover with:

- the broker-issued logical workspace reference;
- the browser endpoint nickname representing the extension connection; and
- the previous owning session ID.

If those values do not identify the same current binding, Tabro rejects the submission synchronously without a request ticket and leaves ownership unchanged. When they do identify the current binding, Tabro durably accepts `take_over_workspace`, delivers `accepted` with a broker-issued `request_ref` before performing the transfer, and proceeds asynchronously while the replacement session polls `get_browser_request`.

After acknowledgement delivery, the first valid takeover workspace-state commit makes the takeover request `succeeded` immediately; it does not wait for an earlier dispatched command to reconcile. At that commit:

- the replacement session becomes the workspace owner;
- the previous session no longer owns the workspace;
- the same managed-tab-group workspace and browser state remain available;
- any endpoint-kill or workspace-stop pause cause remains in effect;
- the replacement session receives the updated workspace, endpoint, ownership, and tab facts needed to continue with raw CDP; and
- access to inspect, resolve, or close every still-public owner-governed ticket associated with that workspace moves to the replacement owner and is removed immediately from the former owner, while requester-scoped acquisition and competing takeover-control tickets remain with their requesters.

The takeover flow uses the broker-issued workspace reference and endpoint nickname rather than a Chrome remote-debugging port or pipe or raw Chrome extension, window, and tab-group identifiers.

Takeover may proceed while the workspace is paused after an endpoint kill or workspace stop has reached its applicable state. It cannot commit an ownership change while an accepted endpoint kill or endpoint resume for that workspace's endpoint remains nonterminal. A takeover attempted during that ownership freeze is rejected synchronously before ticket creation and may be retried after the endpoint-control ticket becomes terminal.

Concurrent takeover and termination requests otherwise use the first valid workspace-state commit; the other accepted request revalidates against the resulting owner or lifecycle state and finishes `failed`, never `uncertain`. Its replacement-session requester keeps authority to poll and close that takeover ticket through its terminal result. The canonical User Interface contract defines its public failure shape.

An ordinary command that was already dispatched before takeover is not cancelled and does not delay takeover success. Its request remains in its managed-tab lane, Tabro reconciles its effect under the replacement owner, and the replacement owner can inspect or resolve that ticket while the former owner cannot. Original-caller attribution remains visible in broker history.

### Related subagents issue concurrent CDP calls in one lineage workspace

A subagent belonging to the same agent-session lineage can select the same browser endpoint nickname and resume the existing logical workspace.

The subagent receives the tabs produced by earlier work in that lineage. It does not create a separate tab group merely because execution moved to another agent inside the lineage.

Related subagents may submit CDP calls concurrently inside the shared workspace under the current workspace-owner authority. Every synchronously valid submission is durably accepted with its own broker-issued `request_ref`, but the subagent does not gain an independent ticket entitlement; inspection remains controlled by the owner authority until takeover transfers it. A synchronously invalid submission returns a rejection without a ticket and never enters an execution lane.

Accepted commands targeting the same `workspace_ref` and `tab_ref` enter one managed-tab lane in broker ticket-acceptance order. The head owns that lane through browser action, any pause, reconciliation, and terminal commit. A paused nonterminal head therefore blocks later same-tab commands; reconnect or explicit human resolution continues the head cycle before the next accepted ticket can start. Direct request-status polls do not occupy or release the lane, and no agent-supplied queue identifier is involved. Scheduling among different managed tabs remains a System decision. Shared raw CDP events are not presented as belonging to one command unless the protocol data itself establishes that relationship.

This concurrent continuation is different from replacement-session takeover: related subagents inherit the lineage workspace, while a replacement independent session explicitly takes ownership from the previous session.

### One session names several workspaces when a task spans browser profiles

When one task spans several browser profiles or windows, the agent submits the required workspace count, polls the broker-issued request ticket, and receives one logical workspace for each resolved binding in the terminal domain result.

The request may combine endpoint nicknames designated by the human with endpoints assigned by Tabro. Every raw CDP call names the intended logical workspace and managed tab, so Tabro does not depend on the agent remembering which workspace or tab was most recently active.

### An interrupted owner resumes the existing workspace when it remains available

Disconnecting the agent, MCP connection, broker, or extension does not itself request workspace termination.

When the same session lineage returns, selects the same browser endpoint, submits a workspace request, and polls the broker-issued ticket, the terminal result resumes the existing workspace when its group and tabs remain available. If the persisted group and tabs are gone, Tabro ends the old workspace and automatically returns a newly created replacement with a new `workspace_ref`, current tab facts, and an initial event cursor. The agent refreshes current browser context and uses asynchronously submitted raw CDP to inspect browser state rather than reconstructing browser identity from a remote-debugging port or pipe or from private routing identifiers.

When the extension disconnects, a queued or running request remains in that lifecycle state and exposes a pause condition tied to its durable phase or checkpoint. After the same endpoint reconnects, Tabro reconciles current browser state and resumes from that checkpoint, retrying a browser effect only after proving that the effect is absent.

If a different independent session must continue instead, that session follows the explicit ownership-transfer use case.

### An unprovable raw CDP effect pauses until the human resolves the request

After reconnect, Tabro first reconciles the selected tab and its current browser state. If that inspection still cannot prove whether the previously dispatched raw CDP effect occurred, the request remains nonterminal and exposes the pause reason `user_confirmation_required`. It does not finish as uncertain or replay the command automatically.

The agent asks the human whether the effect should be treated as completed or whether the workflow should restart. It then calls `resolve_browser_request` with the broker-issued `request_ref` and one of the confirmed resolutions:

- `confirmed_succeeded` finishes the existing request as `succeeded`; or
- `restart_failed` records that the effect may have occurred and begins replacement-tab recovery before releasing the old request's lane. When replacement succeeds, the existing request finishes `failed` with `effect_may_have_occurred` set to true.

On `restart_failed`, the old tab stays in the active workspace group for inspection. Tabro makes one initial replacement-creation attempt and no more than two retries, reconciling the workspace and proving the intended replacement absent before each retry. When creation succeeds, the agent receives the replacement `tab_ref` and initial event cursor and restarts its website workflow there rather than treating the ambiguous command as safely repeatable. Later tickets already queued for the old `tab_ref` finish `failed` without browser dispatch and are never redirected to the replacement.

`confirmed_succeeded` may finish while workspace-stop or endpoint-kill fences are present because it does not mutate the browser. The browser-mutating `restart_failed` recovery waits until every applicable workspace-stop and endpoint-kill fence clears.

If all three replacement attempts fail, Tabro finishes both the original CDP ticket and the resolver ticket as `failed`. The original result records `effect_may_have_occurred: true`; the old tab remains managed, no replacement reference is returned, and the old managed-tab lane releases atomically. The workspace stays active, and the agent can submit `create_browser_tab` through its existing ticketed journey to obtain a deliberate recovery target.

If an accepted resolution loses a race to another valid resolution or lifecycle transition, it finishes `failed`, never `uncertain`, using the canonical User Interface failure shape.

### A workspace task-stop pauses automation before a separate termination decision

The workspace task-stop control targets one broker-issued `workspace_ref`. It pauses that workspace, blocks new ordinary browser-automation dispatch there, and leaves its tabs, ownership, ticket inspection, context inspection, and other read-only inspection available. Eligible takeover and termination controls remain available.

Task-stop does not terminate or archive the workspace. Its pause cause remains independent from an endpoint-kill cause. If the human or agent later decides the workspace should end, the owning agent submits `terminate_workspace` separately.

When the workspace should continue, the owning agent submits `resume_workspace_automation`. Tabro validates the current ownership and target before ticket admission, durably accepts a valid request, and delivers its broker-issued `request_ref` before reconciliation begins. The agent polls that ticket while Tabro reconciles the workspace and clears only the manual workspace-stop cause. An endpoint-kill cause remains in effect and continues to block ordinary browser automation.

### An endpoint-wide kill switch remains active until an explicit resume

The endpoint-wide kill switch affects one paired endpoint and every workspace on it. It pauses their browser automation and remains sticky until an explicit endpoint-resume action. Endpoint-wide kill or resume is admitted only when the caller owns every active workspace on the endpoint. If any active workspace has another owner, Tabro rejects the control synchronously without a ticket and offers workspace task-stop as the narrower available action.

After endpoint kill or resume is accepted, ownership of every workspace on that endpoint stays unchanged until that endpoint-control ticket becomes terminal. This rule freezes ownership only; it does not change workspace lifecycle, workspace allocation, or unrelated endpoint behavior. A takeover attempted during the freeze rejects synchronously without a ticket. The submitting endpoint-control requester retains read-and-close authority through terminal closure even if a later takeover changes workspace ownership.

Resume reconciles the endpoint's current live browser state, clears only the endpoint-kill pause cause, and continues work that has no remaining independent workspace-stop cause. Endpoint kill, endpoint resume, and workspace stop use the canonical asynchronous MCP tools, while ticket close remains immediate and terminal-only.

### Control priority fences ordinary browser work only after its acknowledgement is delivered

The broker applies four control classes within overlapping scope:

1. endpoint kill installs the highest-priority fence across the endpoint;
2. workspace task-stop installs the next-priority fence inside its workspace;
3. termination and takeover may proceed while paused and take priority over ordinary CDP; and
4. ordinary CDP remains the lowest-priority browser work.

This priority is broker behavior, not a value supplied by the agent. Every asynchronous control still follows ticket-before-effect: its acknowledgement must be delivered before its fence or workspace-state change takes effect. Endpoint kill and workspace stop can coexist. Takeover preserves both pause causes. Workspace resume clears only the manual workspace-stop cause after reconciliation. A successful termination ends the workspace regardless of either pause. A nonterminal accepted endpoint kill or resume prevents an ownership-changing commit on that endpoint without deciding whether the attempted takeover waits or is rejected.

Concurrent takeover and termination use the first valid workspace-state commit rather than a fixed priority between them. A losing accepted takeover, termination, or resolution control finishes `failed`, never `uncertain`. A lower-priority ordinary browser request that has not dispatched and becomes invalid after a control transition also finishes `failed` without browser dispatch. A winning takeover commits ownership and active-ticket authority immediately; a browser effect already dispatched is not force-cancelled and continues reconciliation under the new owner.

### A human can tell the owning agent to terminate a workspace and start over

When an error makes the current workspace unsuitable for continuation, the human can instruct the owning agent session to terminate it.

The agent identifies the broker-issued logical workspace and submits `terminate_workspace`. Tabro rejects an invalid caller, ownership relationship, or target synchronously without a ticket; otherwise it durably accepts the request and delivers `accepted` with a broker-issued `request_ref` before beginning termination. After acknowledgement delivery, Tabro immediately fences new browser work in that workspace and finishes accepted work that has not started as `failed`. The agent polls `get_browser_request` for the resulting workspace state while work already dispatched reconciles.

Termination may proceed while endpoint-kill or workspace-stop causes are present. It reaches `succeeded` only after every already-dispatched effect has reconciled and Tabro has confirmed that `archive` was appended as a suffix to the Chrome tab-group name. The terminated workspace is then unavailable for further CDP commands, while the archived group and its tabs stay open so the human can inspect and close them manually. Ending browser control does not orphan its tickets: the terminating owner keeps read-and-close authority over every still-public owner-governed operation ticket until each receives its terminal result and is closed. The agent refreshes request discovery for the ended workspace rather than reusing a pre-termination pagination cursor.

If dispatched work cannot be reconciled or the archive suffix cannot be confirmed, termination finishes `failed`, never `uncertain`, and the workspace remains active but paused for recovery. A termination request that loses a concurrent valid workspace-state commit also finishes `failed`. Exact problem codes belong to the User Interface contract.

To start over, the agent follows the default workspace-request journey. Tabro reports the new binding and logical workspace rather than silently treating it as the terminated workspace.

## Visible results and control boundaries

### Visible responses separate factual protocol and browser state from available Tabro actions

Direct context results expose endpoint nicknames and conditions, eligible logical windows, managed-tab capability summaries, and tab facts that each carry an initial event cursor. Direct event reads require a broker-issued cursor and expose bounded pages of currently retained raw CDP events plus the cursor needed for continuation. Neither direct read creates a request ticket.

An accepted execution submission exposes `accepted`, a broker-issued `request_ref`, and the exact normalized request body without claiming that execution has started or completed. Tabro delivers that acknowledgement before dispatch. A direct `get_browser_request` poll repeats that normalized body and exposes the request's current state and any pause condition. Its terminal result exposes the domain facts for that request: workspace requests expose distinct designated and assigned endpoints, selected existing windows, workspace references, current ownership, and at least one current managed-tab fact with an initial event cursor for every resolved workspace; accepted multi-profile creation that later fails keeps and reports already-created workspaces under the terminal `failed` result; tab-creation results expose the owning `workspace_ref`, the new broker-issued `tab_ref`, event cursor, and current tab facts after success or the reconciled attempt facts after terminal failure; raw command results expose the selected logical target, CDP method, raw CDP result or extension-debugger command error, while a reconnect ambiguity remains paused for human resolution; takeover results expose the resulting ownership facts; workspace-resume results expose the reconciled workspace and remaining pause causes; and termination results expose the invalidated accepted work, reconciliation and archive-confirmation facts, and whether the workspace ended or remains active and paused.

A `restart_failed` exhaustion exposes two failed terminal tickets. The original ticket reports that its effect may have occurred, the old tab remains managed, the workspace remains active, no replacement reference is returned, and the available actions include `create_browser_tab` after the old lane has been released.

The submission disposition `accepted` and the visible request states are separate facts. An accepted request is first `queued`, then `running`, and then exactly one of `succeeded`, `failed`, or `uncertain`. A nullable pause condition can accompany `queued` or `running`; it is not another state. A synchronous rejection occurs before ticket issuance and is not a request state.

Each direct-read, synchronous-rejection, submission-acknowledgement, or request-status result that leaves the agent with an Tabro control decision separates:

- **factual state**, which reports what the broker currently knows about the broker, endpoint, workspace, ownership, target, CDP response, and event stream; and
- **available Tabro actions**, which identify the MCP actions the caller can currently request.

Available Tabro actions can include inspecting another context or capability view, polling an accepted request, closing a terminal request from the agent-visible view, requesting workspaces, creating another tab in an owned workspace, sending another CDP command to an allowed target, reading more retained events, resolving `user_confirmation_required` through `resolve_browser_request`, stopping or asynchronously resuming one workspace's automation, killing or resuming one endpoint's automation when the caller owns every active workspace there, continuing in another workspace, correcting a rejected takeover request, terminating a workspace, or using an automatically created replacement workspace or tab.

The available-action list does not enumerate or recommend the CDP methods the agent should use. Selecting CDP methods and interpreting their effects remain the agent's responsibility.

An invalid caller, ownership relationship, or target is rejected synchronously without a `request_ref`. A command that requests a method unavailable through `chrome.debugger`, or whose method or target-bearing parameters cannot be confined to the selected managed-tab tree, is also rejected synchronously without a ticket or browser delivery. A workspace request that cannot be satisfied by the connected eligible distinct endpoint set is rejected synchronously without a ticket or workspace creation, and an unavailable designated endpoint is not silently replaced. Endpoint kill or resume is rejected synchronously without a ticket when the caller does not own every active workspace on that endpoint, and workspace task-stop remains available. A reconnect-ambiguous raw CDP effect remains paused for explicit human resolution and is not automatically retried.

The thirteen asynchronous submissions, four direct reads, and immediate terminal-ticket close use the modes defined by the canonical User Interface contract. Exact agent-visible wire schemas and problem codes belong there. Internal endpoint selection, CDP attachment, durable request storage, broker event retention, checkpointing, and cross-lane concurrency policy belong to the System layer.

### Tabro owns browser routing while the agent owns CDP intent and interpretation

Tabro handles:

- associating each call with its session and lineage context;
- producing targeted views of browser endpoints, extensions, browser observations, eligible windows, capabilities, workspaces, ownership, and tabs;
- rejecting invalid execution submissions synchronously without issuing a request ticket;
- rejecting insufficient distinct connected eligible workspace capacity synchronously without issuing a ticket or creating a workspace;
- durably accepting valid execution submissions, issuing their broker-owned `request_ref` values, delivering the acknowledgement, and dispatching no browser or extension work before that delivery;
- maintaining each accepted request's `queued`, `running`, `succeeded`, `failed`, or `uncertain` state and its separate nullable pause condition;
- returning request state and terminal domain results through the direct `get_browser_request` read;
- binding designated endpoints and assigning unspecified workspace capacity across distinct profiles and endpoints;
- using a selected logical window or the most recently focused eligible existing window for each new tab-group workspace;
- keeping already-created workspaces and reporting them as known facts when an accepted multi-profile creation request ultimately fails;
- resuming an intact tab-group workspace or ending and replacing one whose group and tabs are gone;
- ensuring that every resolved workspace returns at least one broker-issued tab target and an initial event cursor;
- creating another browser tab inside an owned workspace, establishing its tab-group membership, issuing its `tab_ref` and initial cursor, and reconciling before a maximum of three total creation attempts;
- adopting opener-linked child tabs into the opener workspace or a related child workspace according to their browser window;
- maintaining full-cycle, acceptance-ordered managed-tab lanes for each workspace;
- maintaining logical workspace relationships;
- resolving each logical target into its paired extension and private `chrome.debugger` attachment;
- transporting raw CDP commands, results, debugger errors, and events within the managed-tab-confined surface permitted through `chrome.debugger`;
- retaining event pages behind broker-issued cursors, invalidating the prior stream after broker or extension outage, and issuing a fresh initial cursor after live-page reconciliation without reload or replay;
- pausing disconnected work at durable phases or checkpoints without inventing another request state;
- reconciling reconnect-ambiguous raw CDP effects and waiting for `resolve_browser_request` when human confirmation is required;
- making one initial and no more than two replacement-tab retries after `restart_failed`, preserving the old tab, failing queued old-tab commands without dispatch or retargeting, returning replacement tab facts when creation succeeds, and conclusively failing both the original and resolver tickets without a replacement reference while releasing the old lane and preserving the active workspace when all attempts fail;
- keeping terminal tickets visible to their applicable requester or current workspace owner until they are closed from the agent view while retaining internal audit records;
- pausing a workspace through task-stop, asynchronously reconciling and resuming it without clearing an endpoint-kill cause, pausing or resuming every workspace on one endpoint only when the caller owns every active workspace there, and keeping those workspace owners unchanged until the accepted endpoint-control ticket becomes terminal;
- maintaining connection, routing, command, and audit records;
- retaining nonterminal requests without per-request cancellation or a broker terminal timeout;
- transferring workspace ownership and active-ticket authority immediately at a winning takeover commit while continuing in-flight reconciliation under the replacement owner;
- failing losing takeover, termination, and resolution controls rather than reporting them as uncertain;
- fencing new work and failing accepted-not-started work after termination acknowledgement;
- reconciling already-dispatched work before terminating a workspace;
- appending and confirming the `archive` suffix before termination succeeds, or leaving the workspace active and paused when reconciliation or archive confirmation fails; and
- leaving the archived tab group open for manual human closure.

The agent controls:

- how many distinct browser profiles and endpoints its task requires;
- which endpoint nicknames the human instruction designates;
- which eligible browser windows it selects by broker-issued `window_ref`, or whether to accept the most recently focused eligible-window default;
- when to submit each execution request and when to poll its broker-issued ticket;
- when to close a terminal ticket from its visible request view;
- when its task needs another tab inside an owned workspace;
- which logical workspace and tab receive each raw CDP command;
- which managed-tab-confined CDP method and parameters permitted through `chrome.debugger` to send;
- how to use browser-generated CDP handles returned within the managed-tab scope;
- which raw results and events prove progress toward the website task;
- when to inspect browser context, inspect request state, or read additional retained event pages;
- when to ask the human to resolve an unprovable raw CDP effect and communicate that decision through `resolve_browser_request`;
- when to stop or asynchronously resume one workspace's automation or invoke an eligible endpoint-wide kill or resume control;
- when to continue through a related subagent;
- when to request ownership transfer using the required binding references; and
- when a human instruction requires workspace termination and a fresh start.

The human controls whether an unprovable raw CDP effect is confirmed as succeeded or restarted as failed, and when to close an archived Chrome tab group and its tabs after termination.

Tabro reports its browser, request-lifecycle, and protocol facts but does not make the agent's website-task decisions or monitor the rest of the Codex or Hermes workflow.

## Success evidence, principles, and Product traceability

### Success evidence covers setup, raw CDP automation, multiple profiles, continuation, and recovery

Setup value is demonstrated when the scripted installer prepares the MCP integration, extension, broker, and extension-relayed `chrome.debugger` path and returns a readiness result that identifies any remaining prerequisite.

Automation first value is demonstrated when an agent requests capacity on distinct profiles and endpoints, selects an eligible existing window or accepts the focus-based default, receives its broker-issued request ticket before any dispatch, polls it to a succeeded result containing a ready workspace with at least one broker-issued tab reference and initial event cursor, and then uses the same submission-and-polling journey to obtain its first raw CDP result without launching Chrome with a remote-debugging port or pipe or managing a private extension attachment.

Tab-lifecycle value is demonstrated when an agent submits another-tab creation inside an owned workspace, polls its broker-issued request ticket to a succeeded result containing the new `tab_ref` and initial event cursor, and uses that tab as the explicit target of later raw CDP calls. Failure evidence shows reconciliation before each retry, no more than three total attempts, a terminal `failed` result instead of uncertainty, and an active original workspace.

Ongoing automation value is demonstrated when an agent repeats the target, submit, poll, inspect, and decide loop across raw CDP requests and immediate retained-event pages without rebinding the workspace or losing its intended target. A disconnected extension leaves nonterminal work visibly paused at its checkpoint, and reconnect resumes only after reconciliation.

Context value is demonstrated when an agent can inspect broker, endpoint, extension, browser, eligible-window, capability, workspace, ownership, managed-tab, and initial-event-cursor facts without reconstructing those relationships from model memory.

Multi-profile value is demonstrated when one session receives one workspace for each distinct requested browser profile and endpoint without allowing one endpoint to satisfy the count twice or confusing their browser state and CDP traffic. An admission-time capacity shortfall creates no ticket or workspace; an execution-time creation failure preserves and reports workspaces already created under a terminal failed ticket.

Subagent-concurrency value is demonstrated when related subagents submit concurrent raw CDP calls under one workspace-owner authority, each accepted call receives its own broker-issued request ticket before dispatch, no subagent gains an independent ticket entitlement, and each same-tab request retains its acceptance-ordered lane through terminal completion without overtaking.

Replacement-session recovery is demonstrated when a new independent session submits takeover using the exact workspace reference, endpoint nickname, and previous session ID; can poll its own requester-scoped takeover ticket through closure; and, at the winning commit, immediately receives the workspace and every still-public owner-governed workspace-ticket authority while requester-scoped tickets stay with their submitters, the former owner loses access, and any dispatched effect continues reconciliation under the replacement owner.

Browser-child recovery is demonstrated when an opener-linked child in the same window receives a `tab_ref` in the opener workspace and an opener-linked child in a new window receives a related child `workspace_ref` and `tab_ref`.

Event recovery is demonstrated when a broker or extension outage invalidates the old event cursor, preserves the workspace and tab references, reconciles the current live page, and supplies a fresh initial cursor without page reload or event replay.

Ambiguous-command recovery is demonstrated when reconciliation first inspects the current tab, an unprovable effect exposes `user_confirmation_required`, and the human selects `confirmed_succeeded` or `restart_failed`. The restart branch reports `effect_may_have_occurred`, keeps the old tab inspectable, makes one initial and no more than two reconciled replacement attempts, and fails queued old-tab commands without dispatch or retargeting. Success supplies a replacement tab and cursor. Exhaustion returns no replacement, fails both the original and resolver tickets, atomically releases the old lane, keeps the workspace active, and exposes `create_browser_tab` as the deliberate recovery action.

Pause-control value is demonstrated when endpoint kill and workspace task-stop install independent prioritized fences, workspace context and read inspection remain available, takeover preserves both pause causes, `resume_workspace_automation` reconciles and clears only the manual workspace-stop cause, and endpoint resume clears only the kill cause after reconciliation. Endpoint kill or resume without ownership of every active workspace is rejected without a ticket and offers workspace task-stop instead; after acceptance, endpoint-workspace ownership remains fixed until that control ticket is terminal.

Control-priority value is demonstrated when acknowledged kill and stop controls fence lower-priority not-yet-dispatched browser work, termination and takeover can proceed while paused, concurrent state changes use the first eligible valid commit, and losing takeover, termination, or resolution controls finish failed rather than uncertain. An eligible winning takeover immediately transfers ownership and active-ticket authority, while termination fences new work, fails accepted-not-started work, and waits for already-dispatched effects to reconcile.

Ticket-control value is demonstrated when acquisition and takeover-control tickets remain requester-scoped, ordinary workspace-operation tickets follow current-owner authority, a winning takeover immediately transfers every still-public owner-governed ticket and removes former-owner access, a terminal ticket remains visible without a visibility timeout, and deliberate close removes it from the agent view without erasing internal audit or offering undo. Nonterminal requests expose neither per-request cancellation nor broker terminal timeout; elapsed time cannot terminalize them.

Restart recovery is demonstrated when an owning session submits termination for an unsuitable workspace, observes the immediate fence and failed accepted-not-started work, waits for dispatched work to reconcile and the archive suffix to be confirmed, then receives either a succeeded ended-workspace result or a failed result with the workspace still active and paused. After success it obtains a new workspace through the default asynchronous journey.

Codex and Hermes compatibility is demonstrated when both runtimes complete the same installation handoff, asynchronous execution submission, request-ticket polling, direct context and event reads, ownership, continuation, and recovery journeys through the shared MCP experience.

Evaluation records whether each asynchronous submission delivered its broker-issued ticket before any browser or extension dispatch, whether failed acknowledgement delivery caused no dispatch, whether polling exposed the request's current state, pause condition, and terminal domain evidence, and whether each journey reached the intended managed tab without requiring Chrome remote-debugging ports or pipes, extension attachment identifiers, or broker-private routing identifiers. This contract does not set numerical acceptance thresholds.

### Experience principles keep raw protocol power inside understandable workspace boundaries

| Experience principle | Decision consequence |
| --- | --- |
| Identify the agent user before describing setup or use cases. | The UX begins with Codex and Hermes, then explains installation, the default journey, and supporting journeys in that order. |
| Let the installer dictate the installation journey. | A human or setup agent invokes the same scripted workflow instead of defining a separate installation sequence. |
| Let each profile-local extension identify and register its endpoint automatically. | Each participating browser profile has a distinct extension instance that generates or accepts two readable English words, persists them as the source of a short lowercase nickname without digits, and initiates local registration without a copied broker code. A collision preserves the requested label for explicit correction. |
| Make potentially long execution visible through broker-owned tickets. | Each asynchronous submission durably accepts valid work and delivers `accepted` with a broker-issued `request_ref` before any effect becomes eligible; direct `get_browser_request` polling exposes progress and the terminal domain result. |
| Keep acceptance, lifecycle state, and pause condition distinct. | `accepted` describes the submission response; the request moves through `queued`, `running`, and one of `succeeded`, `failed`, or `uncertain`, while a nullable pause condition can explain why queued or running work cannot advance. |
| Count workspace capacity by distinct browser profiles and endpoints. | One profile or endpoint can satisfy the requested count only once; an admission-time capacity shortfall is rejected without a ticket or workspace, while a later creation failure keeps and reports already-created workspaces under `failed`. |
| Put new workspaces in an eligible existing window. | The agent may select a broker-issued `window_ref`; omission uses the most recently focused eligible existing window, where Tabro creates a new tab group without opening another browser window. |
| Make extension-relayed CDP the ordinary browser journey. | Discovery and asynchronous workspace allocation lead to permitted raw command submission against an explicit managed tab, request polling, raw results or errors, immediate retained-event reading, and the agent's next decision. |
| Let Tabro establish workspace tab identity before the agent sends CDP. | A succeeded workspace request returns at least one tab reference and initial event cursor, while succeeded agent-requested tab creation returns its workspace-scoped reference and cursor through the terminal request result. |
| Reconcile tab creation before bounded retry. | Tabro preserves the workspace, proves the intended tab absent before retrying, makes no more than three total attempts, and ends an unsuccessful request as `failed` rather than `uncertain`. |
| Keep opener-linked child tabs in logical browser ownership. | A same-window child joins the opener workspace and group, while a new-window child receives a related workspace; both receive broker-issued tab facts. |
| Relay CDP through the extension without Chrome remote-debugging configuration. | The agent targets logical workspaces and managed tabs while the extension uses `chrome.debugger`; the agent does not manage Chrome debugging ports or pipes. The approved managed-Profile lifecycle may use a private loopback management connection; website execution continues through the extension. |
| Preserve CDP protocol meaning instead of inventing operation semantics. | Tabro returns raw CDP results, errors, and events, while the agent decides what proves website-task success. |
| Keep public execution within managed tabs. | Every public CDP call names a workspace and `tab_ref`; browser-wide and exclusive-browser targets are not available. |
| Make browser context and CDP capability inspectable rather than memory-dependent. | Agents can refresh broker, endpoint, extension, browser, eligible-window, capability, workspace, ownership, managed-tab, and event-cursor facts whenever context may be stale. |
| Paginate collections and require event cursors. | Direct context and retained-event reads return bounded pages; every tab fact supplies an initial cursor, and event reads require a broker-issued cursor without waiting for future events. |
| Restart an invalidated event stream from the current live page. | Broker or extension outage preserves logical workspace and tab identity, reconciles current browser context, and supplies a fresh initial cursor without reload or replay. |
| Separate status truth from available action choices. | Direct reads, submission acknowledgements, and request-status results report factual state and applicable Tabro actions, while the agent selects its CDP method or workspace action. |
| Preserve browser work across explicit ownership transfer. | Requester-scoped acquisition and takeover-control tickets stay with their submitters; the winning commit immediately moves ownership and every still-public owner-governed workspace ticket while earlier dispatched work continues reconciliation under the replacement owner. |
| Let related subagents submit concurrently without allowing same-tab request cycles to overtake. | Related subagents may submit concurrent CDP calls in one lineage workspace, while each accepted command for the same managed tab retains its acceptance-ordered lane through terminal completion. |
| Require human resolution for an unprovable raw CDP effect. | Reconnect reconciles the current tab first; `resolve_browser_request` then communicates `confirmed_succeeded` or `restart_failed` without automatic replay, while restart recovery is bounded, never retargets queued old-tab commands, and conclusively releases the lane after total replacement failure. |
| Pause automation separately from request state and termination. | Workspace task-stop and endpoint kill preserve browser context while blocking automation; each explicit resume reconciles and clears only its own pause cause, endpoint-wide control requires complete active-workspace ownership, and accepted endpoint control freezes that ownership until terminal. |
| Give control intent priority without exposing a caller-authored priority value. | Endpoint kill fences first, workspace stop fences its workspace next, termination and takeover outrank ordinary CDP, a losing state-changing control fails, an eligible winning takeover transfers control immediately, and termination waits for reconciliation and archive confirmation. |
| Keep request completion domain-driven. | Tabro exposes no per-request cancellation and imposes no broker terminal timeout; elapsed time or a visible stall remains nonterminal. |
| Keep terminal tickets until their applicable authority deliberately closes them. | Requester authority controls acquisition and takeover-control tickets; current workspace ownership controls ordinary ticket inspection, resolution, and closure; winning takeover transfers owner-governed ticket access, ticket visibility has no timeout, and close has no undo or effect on internal audit. |
| Archive terminated browser work for manual closure. | Termination succeeds only after dispatched work reconciles and the `archive` suffix is confirmed; failure leaves the workspace active and paused, while success ends control and leaves the group open for the human to close. |
| Keep the agent journey consistent across runtimes. | Codex and Hermes use the same installation handoff, workspace, raw CDP, ownership, and recovery concepts. |

### Product requirements trace into the raw-CDP agent experience

| Product requirement | User Experience realization |
| --- | --- |
| Hermes distribution serves a user without a preinstalled Broker. | First-time Tabro setup downloads and installs the local runtime, guides extension setup and reports whether automation can begin; qualification remains pending. |
| Open-source distribution includes Profile proxy support. | The existing proxy journey closes a broker-owned Profile, saves configuration through MCP, then explicitly reopens it and checks its exit IP. |
| Agents can create and reopen persistent owned browser identities. | Shared extension-registry discovery exposes both launch ownerships and ready endpoint nicknames; scoped Broker lifecycle operations preserve data and reject stop during active work. |
| MCP access serves AI-agent sessions. | Codex and Hermes agent sessions receive the same MCP experience against Chrome. |
| Installation remains a supporting operation outside the target automation journey. | A human runs the scripted installer directly or asks a setup agent to run it, after which every distinct extension instance generates or accepts a customized readable code, persists its endpoint nickname, and pairs automatically with the running local broker before automation begins. |
| Agents discover paired browser endpoints by nickname and condition, including known endpoints that cannot currently accept a workspace. | Targeted paginated context shows known endpoints, eligible existing windows, and current managed-tab capability summaries, while workspace acquisition separately reports designated and assigned bindings. |
| One paired extension instance and browser profile form one broker endpoint. | Successful automatic first connection registers that profile-local extension endpoint without assigning it to an agent; later connections authenticate the persisted profile identity. |
| Session-time workspace binding replaces permanent hard binding. | A later workspace request binds distinct registered endpoints, using each profile or endpoint at most once toward the requested count. |
| Managed tabs inside tab-group workspaces are the browser-control units. | Each succeeded workspace request uses a selected or focus-defaulted eligible existing window and reports every ready logical workspace with at least one managed `tab_ref` and initial event cursor. |
| Broker-issued tab identity keeps private browser target naming outside the agent's task context. | Every resolved workspace returns at least one workspace-scoped `tab_ref`; separately ticketed tab creation and automatic opener-child adoption provide additional broker-issued tab facts. |
| Raw CDP is routed through explicit managed-tab targets. | Every `send_cdp_command` submission names its `workspace_ref` and `tab_ref`, and every accepted submission receives a separate broker-issued request ticket. |
| Chrome remote-debugging ports and pipes are not part of the execution path. | Agents receive raw protocol traffic through the paired extension's private `chrome.debugger` attachment without handling that attachment or broker-private routing. |
| Public execution is limited to managed tabs and the confined CDP surface permitted through `chrome.debugger`. | The agent targets only broker-issued managed-tab references, and browser-wide, exclusive-browser, unsupported, or unprovably confined protocol methods are unavailable. |
| The broker owns coordination truth and operational history outside the agent's working context. | The broker durably accepts valid execution requests, delivers their references before dispatch, reports lifecycle state, pause conditions, and terminal domain facts through direct polling, and keeps those facts separate from available Tabro actions. |
| Broker-owned status truth includes the broker, extension connections, endpoints, and workspaces, including extension-relay usability. | Direct targeted context inspection exposes current facts separately from available Tabro actions, while browser records remain reported observations. |
| Independent sessions remain separated for managed-tab work. | Independent sessions receive distinct workspaces unless an explicit ownership-transfer request succeeds. |
| Related subagents can continue shared lineage work and operate concurrently. | Related subagents resume the lineage workspace and submit separately ticketed raw CDP calls; same-tab requests retain one full acceptance-ordered lane cycle until terminal completion. |
| A replacement session can take ownership of an existing workspace. | The replacement keeps authority over its own takeover ticket, then receives the preserved workspace and every still-public owner-governed ticket immediately at an eligible winning commit; an accepted nonterminal endpoint control prevents that ownership commit, while requester-scoped tickets remain separate and earlier effects reconcile under the eventual replacement owner. |
| Workspace and endpoint pause controls preserve browser context. | Endpoint kill and workspace stop are independent prioritized fences; takeover preserves both, asynchronous workspace resume and endpoint resume each reconcile and clear only their own cause, endpoint-wide control requires ownership of every active workspace in scope, and acceptance freezes that ownership through the control ticket's terminal result. |
| An owning session can terminate a workspace and start over. | The owner invokes termination separately from task-stop; termination fences new work, fails accepted-not-started work, waits for dispatched work and archive confirmation, and either ends successfully or leaves the workspace active and paused after failure. |
| Every managed tab begins with a broker-issued event cursor. | Every tab fact supplies the cursor required for immediate event reads; outage recovery preserves logical refs and starts a fresh stream from reconciled live state without reload or replay. |
| Ambiguous raw CDP effects require explicit resolution after reconnect. | The request pauses with `user_confirmation_required`; `resolve_browser_request` records `confirmed_succeeded` or `restart_failed`, and restart makes no more than three replacement attempts, leaves the old tab inspectable, fails queued old-tab commands without dispatch or retargeting, and fails both the original and resolver tickets while releasing the old lane after exhaustion. |
| Terminal browser-request tickets remain visible to their applicable authority until deliberately closed. | Acquisition and takeover-control tickets remain requester-scoped, ordinary workspace-operation tickets follow current ownership, winning takeover transfers every still-public owner-governed ticket, and terminal close removes agent visibility without timeout, undo, or internal-audit deletion. |
| Tabro does not interpret semantic browser success. | The agent evaluates raw CDP results and events against its own website-task intent. |


## Managed Profiles

### Creating a Profile provides a ready endpoint without per-Profile extension installation

The agent lists all extension-registered Profiles and their nicknames, ownership and readiness. With `ownership=broker`, an authorized agent can reopen the returned Profile; with `ownership=user`, the human opens Chrome and the agent uses the extension after it connects. Both support the same workspace journey. Enabling the verified managed runtime additionally lets an authorized agent create a broker-owned Profile using only an idempotency key, without supplying a separate display name. It polls the durable request until process identity, extension authentication and current inventory establish readiness. The extension assigns the pairing alias; the returned nickname is the sole Profile name throughout discovery, lifecycle results and the workspace journey. No additional name is stored on the Profile. A connection-ready endpoint may still have paused automation.

### Stopping a Profile preserves its identity and requires active work to finish first

The agent ends its workspaces before stopping. A blocked stop reports active work and leaves the browser available. A normal stop preserves cookies, storage and the extension identity. A later authorized lifecycle caller can reopen a broker-owned Profile. Failed creation retains its reservation and failure facts through its ticket and same-key retry; it enters the registered-Profile list after its extension first authenticates and connects. Retrying the same creation key never allocates another Profile. User-owned Chrome is opened and closed by the human.

### Bounded Profile lifecycle waits do not time out ambiguous website effects

The no-terminal-timeout rules for workspace and raw-CDP work above do not remove the managed lifecycle's explicit queue, launch, extension-ready and normal-close bounds in [Operational defaults](./Operational-Defaults.md). Lifecycle timeout or unverified process identity produces the corresponding failure or uncertain fact; it never authorizes replay of a website action or blind process termination.

## Profile networking

### Agents close a broker-owned Profile before changing its proxy

The agent ends its work, closes the broker-owned Profile, reads the current proxy revision and selects HTTP/HTTPS/SOCKS5 host and port plus an operator-provisioned credential reference. Set and clear save a ticketed change while Chrome is closed. The agent explicitly reopens the Profile and checks its exit IP after application. User-owned Profiles reject proxy configuration, even when disconnected; no human-closure confirmation flow is needed. Network changes never transfer workspace ownership.

### Saved configuration and verified browser routing are separate facts

Responses distinguish saved revision, effective extension application, and a dated browser-originated exit IP and latency observation. Saving while closed reports pending connection. Policy or competing-extension control reports a conflict. Clear saves removal of Tabro's setting; the next explicit launch omits the startup proxy flag and the extension releases its setting to the browser's underlying configuration, which may itself use a system proxy. Reconnection reconciles settings before automation becomes eligible.

Parent: [`02-User-Experience`](./_MOC.md).
