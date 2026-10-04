# Product definition

Tabro is a local, MCP-accessible browser-control product that lets AI-agent sessions automate websites across multiple Chrome profiles without managing Chrome remote-debugging ports, pipes, or broker-private browser routing.

All Tabro-owned project components are open source under the MIT License: the Broker, MCP Adapter, browser extension, Native Host, Hermes integration, installation tooling, and proxy implementation. This scope also applies to components still awaiting implementation. Third-party dependencies retain their own licenses. The broker and its browser connections operate locally.

## Distribution

### First-time Hermes setup must install the Broker and its required runtime

Tabro's Hermes plugin distribution must serve users who have no Tabro installation. First-time Tabro setup must download and install the local Broker and the supporting runtime needed for browser automation; a separately preinstalled Broker is not a prerequisite. The distribution includes the [Profile networking](#profile-networking) capability under the same open-source scope.

This is an approved delivery requirement. Plugin packaging, first-time setup qualification and catalog admission remain pending; the [Hermes delivery plan](../80-Plans/tabro-hermes-provider-2026-10-01/README.md) tracks that work.

## Target client

The target client is an AI-agent session. The agent calls Tabro through MCP to perform website automation across one or more browser profiles.

Developers and human operators are not target clients. Installation, pairing, and maintenance are supporting operations rather than the product's browser-automation experience.

The expected human adopters are technically sophisticated AI users who are comfortable operating local agents and browser tooling. This adoption context does not change the agent-only target-client definition.

## Agent problem

Before Tabro, an agent controlling multiple Chrome profiles commonly connects directly to remote-debugging ports and must preserve the relationship among each connection, browser profile, window, target, and tab.

### A physical browser connection can fail without revealing whether the browser remains usable

A debugging port or its browser process can become unavailable during a task. The agent has no dependable source for distinguishing a working browser from one that is occupied, disconnected, unresponsive, or repeatedly failing.

### Running several debug-enabled profiles forces the agent to maintain transport and browser identity

The agent must arrange for each browser window to start with debugging configuration and then track its port, process, profile, window, targets, tabs, and changing connection state.

### Long tasks make physical browser mappings unreliable

Port-to-profile and target-to-tab mappings occupy the agent's working context. During a long task, those mappings can become stale, confused, or unavailable, allowing a valid command to reach a browser other than the one the agent intended.

### Direct CDP access couples website work to connection and target management

An agent connected directly to a debugging endpoint must manage sockets, protocol attachments, browser targets, reconnects, and the relationship between protocol traffic and the intended profile. These responsibilities are separate from choosing the CDP commands needed for the website task.

### Concurrent sessions can interfere without a shared coordination authority

Multiple agent sessions may use several browser profiles at once. They may also use the same extension and browser window for different tabs, while related subagents may continue different stages of one browser task.

Without shared coordination, commands can reach the wrong browser context, one session can change another session's browser state, and results can lose their relationship to the session and workspace that produced them.

The core product problem is therefore not a lack of CDP capability. It is that direct CDP automation makes the agent retain unstable transport, browser identity, tab ownership, and multi-agent coordination state throughout the task.

## Product promise

Tabro replaces agent-managed Chrome remote-debugging ports, pipes, and private target mappings with named browser endpoints, session-aware browser workspaces, and opaque broker-issued managed-tab references.

The broker retains browser identity, workspace ownership, routing, current status, coordination decisions, and operational history outside the agent's working context. The agent remains responsible for choosing CDP commands and deciding what the returned browser facts mean for its website task.

The promise includes the confirmed workspace and managed-tab targeting rules. It does not establish additional safety promises, access restrictions, or a fixed security policy; those require later explicit Product decisions.

## Product model

### Each participating browser profile becomes one uniquely named extension endpoint

Every browser profile used with Tabro installs a distinct Tabro extension instance. The instance initially selects two short English words as a readable pairing code, and the operator may replace that default with two three-to-eight-letter words in the extension options. The extension normalizes and persists the code in profile-local storage, then combines the words into a compact lowercase endpoint nickname without a numeric suffix, such as pairing code `MINT-WAVE` and nickname `mintwave`. On its first connection to the local broker, the extension registers itself automatically as one browser-profile endpoint; the human does not obtain or enter a broker-generated code.

The readable pairing code helps the human correlate an installed extension with its broker endpoint. It is not the reconnect credential or an authorization secret. The extension persists a separate cryptographic profile identity, and the broker authenticates later connections against that identity.

The saved code remains the authoritative source of the nickname across ordinary browser windows, service-worker restarts, and reconnects. An already registered endpoint changes its nickname only after the broker authenticates the same persisted profile identity. The nickname is unique among endpoints registered with the same local broker; when a requested nickname belongs to another identity, the extension preserves the code and shows the conflict until the operator chooses another.

### Pairing makes browser capacity discoverable without assigning it permanently to an agent

Automatic pairing makes an extension endpoint available for discovery. Known paired endpoints remain discoverable with their current condition even when they cannot accept a workspace. Pairing does not hard-bind an endpoint to an agent.

An agent may request a workspace on a designated endpoint or ask Tabro to assign one. The broker establishes and records the resulting workspace binding at session time. A requested workspace count means that many distinct browser profiles and endpoints; the same profile or endpoint cannot satisfy the count more than once.

If the connected eligible endpoint set cannot satisfy that distinct count or a designated endpoint is not eligible, Tabro rejects the request before ticket admission and creates no workspace; an unavailable designation is not silently replaced. If an admitted multi-profile request later fails while creating its set, the request finishes failed, keeps any workspaces already created, and reports their references and other known facts without presenting a partial-success outcome.

### A browser workspace links one endpoint, one browser window, and one agent-session lineage

A browser workspace is represented by a Chrome tab group and is scoped to one paired extension endpoint, one browser window, and one agent-session lineage.

An agent-session lineage consists of a top-level agent session and its authorized subagents. One session may hold multiple workspaces when its task spans browser profiles or windows.

### Workspace acquisition creates a tab group in one eligible existing browser window

Tabro represents eligible existing browser windows with broker-issued logical window references. An agent may select one of those windows for a workspace; when it does not, Tabro uses the most recently focused eligible existing window on that endpoint. Workspace acquisition creates a new tab group in that selected existing window rather than creating another browser window.

### A persisted workspace without its browser group or tabs ends and receives a replacement

If a persisted workspace no longer has its Chrome tab group or any live workspace tabs, Tabro ends that logical workspace instead of reconstructing browser state under its old `workspace_ref`. The same acquisition journey automatically creates a replacement workspace with a new broker-issued reference and reports both the ended workspace and its replacement.

### Every successful workspace acquisition gives the agent at least one managed-tab target

The managed browser tab is the unit of agent control. Every successful workspace acquisition includes at least one current tab together with opaque broker-issued logical workspace and tab references.

Tabro can add another tab to an existing workspace, establish its workspace membership, and provide its broker-issued logical tab reference.

### Opener-linked child tabs inherit browser-work ownership without exposing Chrome target identity

When a page in a managed tab opens a child tab in the same browser window, Tabro adopts the child into the opener's workspace and tab group and issues a `tab_ref`. When the opener-linked child appears in a new browser window, Tabro creates a related child workspace and issues a new `workspace_ref` and `tab_ref` for it.

### The paired extension is the browser-control transport

The broker resolves a logical workspace-and-tab target to the paired extension. That extension relays CDP traffic through `chrome.debugger`.

Chrome remote-debugging ports and pipes are not part of this execution path. Extension attachment details and broker-private routing identifiers remain inside Tabro.

### The CDP surface stays inside the selected managed-tab tree

Tabro exposes the portion of `chrome.debugger` that it can prove remains within the selected managed-tab target tree. A domain or method that the extension API does not support, or whose effects cannot be confined to that tree, is unavailable instead of being routed through a browser-wide fallback.

Every CDP call names one logical workspace and one managed tab. Tabro does not expose browser-wide or exclusive-browser control.

Agents can inspect a paginated capability view through their browser context before submitting a command. An unsupported or out-of-managed-tab-scope method is also rejected precisely before admission, so discovery and reactive correction use the same current capability boundary without adding a separate capability product.

### Raw CDP facts remain protocol data rather than typed website outcomes

The agent uses CDP methods and parameters and can receive raw CDP results, extension-debugger errors, and event data without Tabro replacing them with typed website-operation outcomes.

Browser-generated CDP handles may be passed back unchanged when a later permitted command in the same managed-tab scope requires them; the agent does not invent those handles.

Tabro does not define typed website operations or decide whether a CDP result proves that a click, navigation, or website task succeeded. The agent selects the permitted CDP commands and interprets their results.

### Every managed tab begins with a broker-issued event cursor

Every tab fact supplies the initial broker-issued cursor required to read that tab's retained CDP events. A broker or extension outage invalidates the previous event stream. Recovery preserves the logical `workspace_ref` and `tab_ref`, reconciles the current live page and browser context, and supplies a fresh initial cursor; it does not reload the page or replay the invalidated stream, and the extension is not an alternate event-replay buffer.

### The broker owns coordination truth and operational history

The broker is the source of truth for the relationships and facts needed to coordinate browser work:

- **Identity and binding truth** records the authoritative relationships among sessions, lineages, endpoints, windows, workspaces, and managed tabs.
- **Routing truth** records which paired extension and managed tab correspond to each logical browser target.
- **Target selection** resolves a call's requested logical target against routing truth and the calling session's current workspace relationship.
- **Status truth** records the observed condition of the broker, extension connections, endpoints, and workspaces—including whether an endpoint's extension CDP relay is usable—without turning those facts into a routing decision.
- **Broker decisions** use current truth to determine whether a workspace request or browser call can proceed; those decisions do not replace the underlying status facts.
- **Operational history** includes operational, command, routing, CDP-transport, and audit records needed to reconstruct pairing, binding, routing, command, outcome, and event-delivery lifecycles.

### Every asynchronous CDP command is durably ticketed and acknowledged before dispatch

Every CDP command, including one expected to finish quickly, is an asynchronous browser request. Tabro durably records its broker-issued request ticket and delivers that ticket to the caller before dispatching the command to the extension. If the acknowledgement cannot be delivered, Tabro treats that as an immediate transport failure and does not dispatch the command.

A disconnected extension preserves a nonterminal request at a durable checkpoint. Its pause condition remains separate from its lifecycle state instead of becoming another terminal outcome.

### An ambiguous raw CDP effect after reconnect waits for explicit human resolution

After the same endpoint reconnects, Tabro first reconciles the selected tab and current browser state. If a previously dispatched raw CDP effect still cannot be proved, the request stays nonterminal and waits for human confirmation rather than finishing as uncertain or being repeated automatically.

The owning agent asks the human what happened and records either confirmed completion or a failed restart decision through Tabro. Confirmed completion finishes the request successfully. A failed restart records that the effect may have occurred, keeps the old tab in the active group for inspection, and starts replacement-tab creation.

Replacement creation makes one initial attempt and no more than two retries, reconciling the workspace before each retry. Accepted later commands targeting the old tab finish failed without browser dispatch and are never redirected to the replacement, and the old tab remains managed for inspection.

When creation succeeds, Tabro issues a new `tab_ref` and initial event cursor so the agent can restart its workflow on the replacement. If all three attempts fail, the original CDP ticket and its resolution ticket both finish failed, the original records that its effect may have occurred, no replacement reference is returned, and the old managed-tab lane releases atomically. The workspace remains active, and the agent can use the existing managed-tab creation capability to recover deliberately.

### Independent sessions remain separate while related subagents can continue shared work

Independent sessions using the same extension and browser window receive separate tab-group workspaces. Their calls remain associated with the managed tabs in their own workspaces.

Authorized subagents in the same lineage may continue work in the same tab-group workspace and may submit raw CDP calls concurrently. Accepted calls targeting the same `workspace_ref` and `tab_ref` occupy one request cycle at a time in broker ticket-acceptance order. The head request retains that tab lane through browser action, pause, reconciliation, and terminal commit; later accepted calls cannot overtake it. Agent polling observes the cycle but does not keep it open or release it. Activity remains attributable to its original caller and logical target, while scheduling across other logical targets and the attachment model belong to the System contract.

### A replacement session can take over a specific workspace without discarding browser state

When an error or urgent handoff requires another independent session to continue existing work, that session can request deliberate takeover of the exact current workspace. The broker requires the workspace identity, endpoint nickname, and broker-returned previous owning session ID that identify the current binding.

After the takeover ticket reaches the replacement session, the first eligible valid takeover commit moves ownership to that session immediately. The previous session no longer owns the workspace, while its browser state and active request tickets remain available to the new owner.

### An owning session can terminate a workspace that should not continue

When a workspace is no longer useful, a human can instruct its owning agent session to terminate it. After its acknowledgement is delivered, termination immediately fences new browser work and finishes accepted work that has not started as failed. Work already dispatched remains under reconciliation.

Termination succeeds and ends the workspace only after dispatched work has reconciled and the tab group's `archive` suffix has been confirmed. If reconciliation or archive confirmation fails, termination finishes failed and leaves the workspace active but paused for recovery. Successful termination preserves ticket-only authority for the terminating owner over every still-public owner-governed operation ticket until each receives its terminal result and is deliberately closed. The agent can then request a new workspace through the ordinary workspace-acquisition flow.

### Workspace and endpoint pause controls stop automation without discarding browser context

A workspace task-stop pauses automation for one `workspace_ref`, blocks new ordinary browser-automation dispatch there, and preserves its tabs, ownership, and read-only inspection. Eligible takeover and termination controls remain available, and termination remains a separate later request.

An explicit asynchronous workspace resume reconciles the workspace and clears only its manual workspace-stop cause. It does not clear an endpoint-kill cause.

An endpoint-wide kill switch pauses automation for every workspace on one endpoint and remains in effect until an explicit endpoint resume. Endpoint kill or resume is admitted only when the caller owns every active workspace on that endpoint. Otherwise Tabro rejects the control synchronously without a ticket and offers workspace-level stop instead. Once either endpoint control is accepted, ownership of every workspace on that endpoint remains unchanged until that control ticket becomes terminal. This freeze applies only to ownership and does not establish another lifecycle or allocation rule.

Endpoint resume reconciles the endpoint's live browser state, clears only the endpoint-kill cause, and continues work whose workspace has no remaining independent stop cause.

### Control priority prevents queued browser work from crossing a stop or lifecycle decision

After its ticket acknowledgement is delivered, endpoint kill has the highest control priority, workspace stop has the next priority within its workspace, termination and takeover have priority over ordinary CDP work, and ordinary CDP has the lowest priority. Endpoint kill and workspace stop remain independent pause causes rather than replacing each other.

Takeover and termination may proceed while a workspace is paused. Takeover preserves both pause causes, endpoint resume clears only the endpoint-kill cause, and successful termination ends the workspace regardless of either pause. Concurrent termination and takeover are resolved by the first eligible valid workspace-state commit. An eligible winning takeover does not wait for an already-dispatched effect: ownership and active-ticket authority move immediately, and Tabro reconciles that effect under the replacement owner instead of cancelling it.

An accepted takeover, termination, or resolution control that loses its state-changing race finishes failed rather than uncertain. A `confirmed_succeeded` resolution can finish under a workspace stop or endpoint kill because it does not mutate the browser. The browser-mutating `restart_failed` recovery waits until every applicable workspace-stop and endpoint-kill fence has cleared.

### Terminal browser-request tickets remain visible to their applicable authority until explicitly closed

Ticket access follows either requester scope or current workspace-owner authority. Workspace acquisition remains with its requesting prospective owner through terminal result and closure. Each replacement session likewise retains its own takeover-control ticket even if another control wins and it never owns the workspace. Ordinary workspace-operation tickets follow the current owner; authorized subagent calls may act under that authority but gain no independent entitlement. When takeover wins the workspace-state commit, every still-public owner-governed ticket—including terminal tickets not yet closed—moves atomically to the replacement owner and is removed immediately from the former owner. Requester-scoped acquisition and competing takeover-control tickets do not transfer, and original-caller attribution remains in broker history.

A terminal ticket has no visibility timeout. Its applicable requester or current owner can close it to remove it from that authority's agent-visible request view; closing has no undo and does not remove the broker's internal audit record.

Tabro does not expose per-request cancellation and does not impose a broker terminal timeout. Elapsed time or a reported stall can remain visible as a nonterminal fact but cannot by itself finish a request.

## Capability summary

| Capability | Product outcome |
| --- | --- |
| Profile proxy configuration | An agent can configure and verify the authenticated upstream proxy of a broker-owned Profile through MCP, under the [Profile networking](#profile-networking) rules. |
| Endpoint discovery and workspace acquisition | An agent can discover paired browser profiles by nickname and condition, then request one or more session-time workspaces without a permanent agent-to-profile binding. |
| Managed-tab lifecycle | A workspace request counts each endpoint once, creates or resumes each admitted tab-group workspace in an eligible existing window, and supplies a broker-issued managed-tab target; Tabro can create additional tabs and adopt opener-linked child tabs without exposing Chrome target identity. |
| Extension-relayed CDP | An agent can send permitted raw CDP commands and receive raw results, extension-debugger errors, and events without handling a debugging port, pipe, attachment, or private browser target. |
| Capability discovery and correction | An agent can inspect a paginated capability view and receives precise pre-admission rejection for a method that the current extension-backed managed-tab surface cannot execute. |
| Durable request recovery | Every CDP command is ticketed and acknowledged before dispatch, disconnect pauses remain visible without adding a request state, ambiguous reconnect effects wait for explicit human resolution, exhausted replacement recovery fails both the original and resolver tickets and releases the old lane without losing the managed tab or workspace, and elapsed time does not cancel or terminalize a request. |
| Event-stream recovery | Every managed tab supplies an initial event cursor, while outage recovery preserves logical targets, reconciles the live page, and begins a fresh stream without reload or replay. |
| Multi-agent coordination | Independent sessions receive separate workspaces, while authorized subagents can submit work concurrently in a shared lineage workspace and same-tab request cycles run one at a time without overtaking their ticket-acceptance order. |
| Workspace continuity and control | Endpoint kill, workspace stop and resume, lifecycle and ownership changes, and ordinary CDP follow distinct control priorities; endpoint control freezes endpoint-workspace ownership while its ticket is nonterminal, pause causes remain independent, losing state-change races fail, takeover immediately transfers ownership and active-ticket authority when eligible, and termination ends the workspace only after reconciliation and confirmed archiving. |
| Ticket visibility and closure | Current workspace ownership controls request inspection and resolution; terminal tickets remain visible without timeout until deliberately and irreversibly closed from the agent view. |
| Broker truth and records | The broker owns identity, binding, routing, target resolution, current status, coordination decisions, and the history needed for diagnosis and recovery. |

## Product success

### An agent reaches first browser value without managing Chrome debugging transport

The product succeeds when an agent can:

- discover Tabro through MCP;
- discover paired browser endpoints by nickname and condition;
- acquire each requested workspace on a distinct browser endpoint and an eligible existing window, with at least one broker-issued managed-tab reference;
- create another managed tab inside an existing workspace and receive its logical reference;
- send a permitted CDP method and parameters to the intended workspace and tab;
- receive the corresponding raw CDP result or extension-debugger command error;
- read raw CDP events from the initial cursor supplied with that managed tab; and
- pass browser-generated CDP handles back unchanged when later permitted commands require them.

### Long-running and concurrent work retains the intended browser relationship

The product succeeds when an agent can:

- use multiple workspaces when a task spans profiles or windows;
- run alongside independent sessions without managed-tab workspace crossover;
- hand browser work to an authorized subagent in the same lineage;
- issue concurrent CDP calls from related subagents while retaining the intended logical target and serializing each same-tab request cycle in ticket-acceptance order;
- transfer a specific existing workspace and its active request-ticket authority to a replacement session without waiting for already-dispatched work to reconcile;
- pause one workspace without losing its browser context, then terminate it separately when needed;
- explicitly resume one stopped workspace after reconciliation without clearing an endpoint-kill cause;
- pause every workspace on one endpoint, then reconcile every surviving workspace and resume only those without an independent workspace stop;
- reject endpoint-wide kill or resume without a ticket when the caller does not own every active workspace on that endpoint and preserve workspace-level stop as the available narrower control;
- keep endpoint-workspace ownership unchanged from endpoint-control acceptance through that ticket's terminal result;
- keep endpoint-kill and workspace-stop causes independent while control priority fences ordinary browser work;
- recover from exhausted restart replacement by receiving two failed tickets, retaining the old managed tab and active workspace, and deliberately creating another managed tab after the old lane releases;
- allow takeover or termination while paused, resolving concurrent takeover and termination by the first valid workspace-state commit, failing the losing control, and reconciling already-dispatched work under a winning replacement owner;
- terminate a workspace that should not continue only after dispatched work reconciles and archive confirmation succeeds, or leave it active and paused after a failed termination;
- preserve nonterminal requests without per-request cancellation or broker terminal timeout; and
- continue long-running work without retaining Chrome transport or broker-private routing identity in its working context.

### Broker facts make browser availability and interrupted execution diagnosable

The product succeeds when an agent can distinguish whether an endpoint is usable, busy, offline, unresponsive, or failing, including whether the endpoint's extension CDP relay is usable.

When a reconnect leaves a raw CDP effect ambiguous after tab reconciliation, the request visibly waits for human confirmation instead of claiming success or repeating the command. The broker's operational records retain enough connection, binding, routing, command, outcome, event-delivery, pause, and resolution facts to reconstruct the browser-control lifecycle when diagnosis or recovery is required.

## Problem traceability

| Agent problem | Product response |
| --- | --- |
| An agent needs browser identities that survive closing Chrome and changing agent sessions. | Principal-owned persistent Profiles support list/create/open/stop while preserving browser data; session/lineage authority continues to govern workspaces. |
| A debugging connection can stop representing a usable browser. | The broker exposes current connection and endpoint truth independently from its routing decisions. |
| The agent must remember ports, profiles, windows, targets, and tabs. | Named extension endpoints, logical workspaces, and broker-issued managed-tab references replace physical routing details. |
| One browser profile could be counted repeatedly while requested capacity remains unavailable. | Workspace counts use distinct connected eligible endpoints, reject an admission-time shortfall without creation, and retain created workspace facts if an admitted multi-profile operation later fails. |
| Long tasks can lose browser-target context. | The broker retains session, workspace, and managed-tab relationships outside the agent's working memory. |
| Direct CDP requires socket, attachment, and target management. | The paired extension relays permitted CDP through logical workspace-and-tab targets. |
| CDP-created tabs do not automatically carry Tabro workspace identity. | Tabro creates agent-requested workspace tabs, establishes their membership, and returns broker-issued logical references. |
| Page-created child tabs can escape the opener's logical workspace. | Tabro adopts an opener-linked child in the same window or creates a related child workspace when it opens in another window. |
| A fixed typed-operation catalog would constrain CDP and require operation-specific semantics. | Tabro forwards managed-tab-confined methods, parameters, raw results, debugger errors, and events without inventing website-operation outcomes. |
| Independent sessions can interfere inside one browser. | The broker assigns separate tab-group workspaces and resolves each call through the calling session's workspace relationship. |
| Related subagents need to continue one browser process. | Authorized members of the same lineage can share a workspace and submit concurrent raw CDP calls, while each accepted call for one managed tab retains the lane through its complete nonterminal cycle and cannot be overtaken. |
| A replaced session can leave useful browser state and in-flight work behind. | A replacement session can deliberately take over the exact existing workspace, receive its active ticket authority immediately at an eligible winning commit, and continue reconciliation without cancelling dispatched work; a losing lifecycle or ownership control finishes failed. |
| A damaged or unwanted workspace should not continue. | Its owning session can fence new work, fail accepted work that has not started, reconcile dispatched work, confirm the archived group, and then end the workspace; failed reconciliation or archiving leaves the workspace active and paused. |
| A workspace or endpoint may need to stop before browser context is discarded. | Endpoint kill and workspace stop install independent prioritized fences ahead of ordinary CDP; explicit workspace resume and endpoint resume reconcile and clear only their own pause causes, endpoint-wide control requires ownership of every active workspace in scope, and accepted endpoint control freezes that ownership until it becomes terminal. |
| A command response can disappear after dispatch. | Tabro reconciles the current tab, then waits for explicit human resolution if the effect remains ambiguous; it neither claims success nor repeats the command automatically, and exhausted replacement recovery fails both the original and resolver tickets while preserving a deliberate tab-creation recovery path. |
| A broker or extension outage can invalidate an event stream. | Tabro preserves logical workspace and tab identity, reconciles the current live page, and issues a fresh initial cursor without reload or event replay. |
| Browser failures are difficult to reconstruct. | Broker-owned operational history preserves the relationships and lifecycle facts needed for diagnosis and recovery. |


## Managed Profiles

### Agents can create and reopen persistent Profiles with an automatically connected extension

The approved managed-Profile journey adds an owned persistent Profile directory to the endpoint model. Agents can list both open and closed Profiles, create an independent Profile, ensure an existing Profile is ready, and normally stop it while retaining its data and extension identity. Management authority belongs to the authenticated installation principal across sessions; workspace authority remains session and lineage based. Existing manually connected endpoints do not acquire process-management rights.

### Lifecycle management keeps browser-wide debugging private to Tabro

On the verified Windows runtime, Tabro uses a private loopback browser connection only to load its extension, inspect the owned instance, prepare an empty window and close normally. Website actions and native tab-group workspaces continue through the extension. Active work prevents a Profile stop.

The workspace/raw-CDP no-terminal-timeout rule does not eliminate the approved managed lifecycle's bounded startup and normal-close waits. A lifecycle failure reports its known state while preserving data and refusing unverified process termination; it does not decide whether an ambiguous website effect succeeded.

## Profile networking

### Broker-owned Profiles can use one authenticated upstream proxy

Profiles with `ownership=broker` support HTTP and HTTPS proxies with Basic username/password authentication and SOCKS5 proxies with username/password authentication. One setting covers all regular windows and workspaces in that Profile. User-owned Profiles do not support Tabro proxy configuration. Launch ownership remains broker/user, and network management also requires its dedicated authority. The pairing alias remains the sole Profile name.

### Network changes require a closed broker-owned Profile and apply on its next launch

Agents can inspect, set, clear and check proxy configuration through MCP. Setting and clearing require dedicated network-management authority, broker ownership, verified browser closure and no conflicting unfinished work. The change is saved while closed and applied on the next explicit launch; configuration never automatically closes or opens Chrome. Enabled proxy failures do not silently select direct routing. Credentials remain protected on the local machine and are represented by opaque references in MCP. The promise covers regular-profile URL proxying, not system-wide VPN or incognito.

Parent: [`01-Product`](./_MOC.md).
