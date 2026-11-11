# Domain input-only rules

Accepted for implementation on 2026-11-11 after user review. The decision is incorporated into the canonical owners under [vault governance](../AGENTS.md). Delivery and platform qualification remain separately tracked in the implementation plan.

Parent entry point is [the knowledge vault](../TOP-DOWN-MOC.md). The linked [implementation plan](../80-Plans/domain-input-only-rules-2026-11-10/README.md) records delivery work and verification gates.

## Problem

### A site can require browser input while still allowing scripted observation

Tabro currently permits supported raw CDP commands within owned tabs. An agent can inspect a page and manipulate its controls through the same interface. Some sites need a rule that routes manipulation through browser mouse and keyboard input. An agent may discover this requirement only after submitting an unsuitable command.

The existing Product promise delegates CDP selection to the agent and requires an explicit Product decision for additional restrictions. This proposal introduces that decision through the canonical authority hierarchy.

## User direction

### Input-only constrains manipulation and preserves read-only observation

The user confirmed these requirements on 2026-11-10.

- Users maintain a domain rule list. Tabro selects the applicable policy automatically.
- Each domain or subdomain entry covers itself, all nested subdomains, and every URL path. The tab's current top-level URL determines the applicable rule.
- Navigation selects the destination domain's rule. A destination with no matching entry has standard behavior. Iframe-specific matching and redirect-chain tracking are outside this feature's scope.
- Actions on a matching site use browser input for clicks, scrolling, selection, dragging and typing, following the sequence of a person performing the gesture.
- Observation can use JavaScript, HTML and DOM inspection, accessibility information and screenshots.
- MCP descriptions explain the restriction, and rejected commands identify the supported way to proceed.
- Interrupted input uses recorded state and request reconciliation. Uncertain held input pauses manipulation in the affected window while permitting observation. The thirty-second inactivity timeout triggers that pause. Recovery requires the held state and any uncertain website effect to be resolved.
- The behavior applies to the common Tabro runtime used by Codex and Hermes on supported platforms.

The domain list supersedes the earlier proposed manual workspace mode. The proposed implementation uses the existing MCP command surface. Success is measured by supported input behavior and observable page results. Website acceptance of automation is outside that guarantee.

## Accepted behavior

### One local rule list applies across participating profiles and agent clients

Store the rules in the installation data directory at `browser-rules.json`. A documented configuration-file edit is the accepted first management interface. An operator can authorize an agent to edit this file through host tools. MCP browser commands expose the effective policy and do not modify the list as part of recovering from a rejection.

Proposed configuration example uses a reserved example domain.

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "example-input-only",
      "domain": "example.com",
      "mode": "input_only"
    }
  ]
}
```

The first installation starts with an empty list. Initial production domains require user selection. The rules live outside versioned release directories so upgrades preserve them. A validated ruleset has a revision derived from its normalized content. The Broker applies a new revision atomically and informs connected extensions. Dispatch requires confirmation of the applicable revision.

An invalid live edit retains the last valid ruleset and exposes a configuration diagnostic. A malformed or missing previously configured file on startup blocks browser dispatch until repaired. An explicitly saved empty list is a valid removal of restrictions. First initialization creates the empty file and then records successful initialization in persistent Broker data. After initialization, an absent file is a configuration failure. Upgrade and rollback preserve both the file and the initialization record.

### Each entry covers its hostname and every nested subdomain across all paths

Parse the tab's current top-level URL and normalize its hostname, including case, internationalized names and a trailing dot. An entry matches its exact hostname and every hostname ending in `.` plus that domain. Subdomain coverage is automatic. Every path and query under a matching hostname receives the same rule. `example.com.evil.test` cannot match `example.com`. Reject entries containing schemes, paths, wildcard strings, or duplicate normalized hostnames.

| Configured entry | Covered examples | Examples outside this entry |
| --- | --- | --- |
| `example.com` | `example.com`, `app.example.com`, `nested.app.example.com`, and every path under each | `other.test`, `example.com.evil.test` |
| `app.example.com` | `app.example.com`, `nested.app.example.com`, `/settings`, `/projects/123`, and all other paths on those hosts | `example.com`, `www.example.com` |

If several entries match, use the most specific matching hostname in diagnostics. Every matching entry applies the same `input_only` behavior.

### Navigation selects the rule for the domain currently in the tab

The extension reads the tab's current top-level URL immediately before executing a command and matches it against the active list. MCP context and errors report that hostname and the matched entry. The lookup uses the current URL rather than a separate redirect history. Iframe origins are excluded from the matching inputs.

| Navigation between distinct domains | Behavior after the tab reaches B |
| --- | --- |
| A is unlisted and B is listed | Apply B's rule. |
| A is listed and B is unlisted | Use standard behavior on B. |
| A and B are both listed | Apply the matching entry for B. |
| A and B are both unlisted | Use standard behavior on B. |

The same lookup applies after direct navigation, redirects, history navigation and reload. A queued command uses the current URL when it reaches execution. The rule for A is active while A is the tab's current page and is replaced by the result of matching B once B becomes current. A URL with no matching hostname has standard behavior. If the current tab cannot be read or the active policy revision is unavailable, report the execution prerequisite failure.

### A method and parameter policy distinguishes observations from page actions

| Operation | Proposed behavior on a matching target |
| --- | --- |
| Read text, HTML, attributes or field state | Allow supported DOM and accessibility reads, screenshots, and guarded JavaScript. |
| Read element bounds | Prefer `DOM.getBoxModel` when guarded JavaScript cannot establish a safe observation. |
| Evaluate an expression or call a function for observation | Force the browser side-effect guard and bounded execution. Caller parameters cannot disable the guard. |
| Click, scroll, select or drag | Use supported mouse and keyboard input with the required event sequence and freshly observed coordinates. |
| Type text | Focus through input and use keyboard events for ordinary typing. Permit `Input.insertText` for Unicode text entry through Chrome's text-input path. Report that operation as text insertion. |
| Paste from the clipboard or use an operating-system composition window | Use a supported, explicitly requested clipboard or composition workflow. Hand control to the user when the available browser methods cannot perform it. |
| Run `.click()`, `.focus()`, `.scrollIntoView()`, write field values, dispatch synthetic DOM events, or issue page-side requests | Reject through the guard or an explicit method restriction. |
| Set attributes, remove attributes, or focus through DOM mutation methods | Reject and recommend the matching input sequence. |
| Navigate to an ordinary HTTP(S) URL or reload | Allow browser navigation. Re-evaluate the destination policy before subsequent work. |
| Navigate to `javascript:`, `data:`, `blob:`, `file:` or another unclassified scheme | Reject agent-requested executable or unclassified navigation while the current tab matches an input-only entry. An internally created blank tab uses standard behavior until its current URL matches a configured hostname. |
| Set files through `DOM.setFileInputFiles` | Reject and offer a file-picker handoff. The agent may open the visible picker through input and observe the selected files after the user completes it. |
| Use other supported CDP methods | Admit only after their methods and parameters have an explicit policy classification. |

The `Input` namespace alone does not establish permission. For example, ignoring user input is distinct from sending a mouse gesture. The policy also reviews editing-command parameters, event scope, and mutable state in existing `Network` and `Emulation` methods.

### Browser gestures preserve order and account for interrupted input

Agents observe the target before acting and re-observe after scrolling, navigation or layout changes. Clicking follows pointer movement, button press and button release. Dragging holds the button while moving to the destination. Keyboard input respects focus, modifiers and release events.

Existing per-tab FIFO ordering serializes individual commands. While a Tabro-injected button or key is held, reserve input in that browser window for the initiating session and target. Other clients receive a busy outcome for competing input. Track keys including modifiers, along with the owning session, workspace, tab and browser window.

Record the intended press or release before dispatch using the durable request record. Record its confirmed outcome after Chrome acknowledges it. Clear the tracked press after a confirmed release. An interrupted acknowledgement leaves both possible outcomes available for reconciliation. Recover this information from durable request state after a Broker restart.

A target or focus change, cancellation, connection loss, or thirty seconds of inactivity during held input pauses manipulation and starts request reconciliation. Consult the existing extension attempt cache to establish whether the last command completed. A confirmed release can clear the held state. If input may still be held, retain the window pause and report the last confirmed step. Observation remains available when the browser transport is connected and the request is demonstrably read-only.

Automatic recovery sends no release event and does not replay the gesture. A mouse release can itself cause a click or drop. The agent observes the page and asks the user to finish or cancel the gesture when reconciliation cannot establish released input. Record that recovery confirmation separately from the outcome of the interrupted website action. Resume only when held input is resolved, any uncertain request is explicitly resolved, and other pause causes permit continuation.

## MCP

### An agent can discover the effective rule or recover from a first rejection

Update `send_cdp_command` descriptions to explain domain rules, guarded observation and supported input alternatives. Extend the targeted tab view of `get_browser_context` with the effective interaction policy, matched rule and domain, active revision, and supported alternatives. The exact public shape belongs to the User Interface owner.

Use a structured policy refusal with the code `INPUT_ONLY_REQUIRED`. Its message names the domain and blocked method and gives a usable next command. A known rejected action gets an input recommendation. A guard refusal explains that Chrome could not establish read-only execution and gives observation alternatives as well as input guidance. The guard alone cannot determine whether the agent intended a read or an action.

For example, a refusal of `DOM.focus` on `example.com` directs the agent to inspect the target with a DOM query and `DOM.getBoxModel`, then use `Input.dispatchMouseEvent` or `Input.dispatchKeyEvent` to focus it. A refused bounds expression directs the agent to the supported geometry read.

Before request acceptance, rejection creates no ticket. A queued command rejected at execution ends with a failed ticket and the same policy diagnostic. A policy rejection carries `retryable: false` for repeating the identical command. A possibly executed command retains the current uncertain-result semantics.

The current problem schema is closed and has no arbitrary diagnostic-detail field. Add the approved fields to [the canonical schema](../03-User-Interface/MCP-Contract.schema.json), validators and tool descriptions together when this proposal is promoted. Review the MCP contract version and extension capability negotiation before release, even though the proposed tool catalog stays at twenty-two tools.

### Guard exceptions must become meaningful policy outcomes

The current executor returns JavaScript `exceptionDetails` inside a successful raw CDP result. Adding `throwOnSideEffect` alone does not deliver the required MCP rejection. Recognize guard refusals and preserve their diagnostics through execution, cached attempt reconciliation and request polling. Preserve ordinary JavaScript errors with their actual cause. Agents must not receive a successful website-action claim because a CDP transport call returned successfully.

### An interrupted gesture exposes input recovery through existing MCP controls

Use the diagnostic `INPUT_STATE_UNCERTAIN` when held input cannot be reconciled. Report the affected workspace/tab, owning session, last confirmed input step, possibly held buttons or keys, and the recovery required. For example, the message may say “Mouse press completed; release status unknown. Manipulation is paused. Inspect the page and confirm the gesture has been finished or cancelled before resuming.” Repeating the original input is not a retry recommendation.

Expose this state through `get_browser_context` and the relevant `get_browser_request` result. Extend the existing `resume_workspace_automation` contract to accept explicit recovery acknowledgement when needed and enforce all remaining pause causes. Keep that acknowledgement separate from `resolve_browser_request`, which resolves the uncertain website effect. Confirming that input was released does not establish whether a click or drop succeeded.

The current strict same-tab FIFO also queues observation CDP commands. The contract therefore needs an explicit recovery-read exception that allows classified read-only commands through `send_cdp_command` while manipulation is paused. These reads retain ownership checks and forced side-effect guards and cannot release, replay or complete the blocked mutation. New manipulation waits until recovery is complete.

## Evidence

### Acceptance requires deliberate interruptions and independent browser evidence

The [test strategy](../80-Plans/domain-input-only-rules-2026-11-10/README.md#verification), expanded on 2026-11-11, specifies deterministic failure boundaries before dispatch, after browser execution, during cache persistence and during response delivery. It checks timeout, restart, window ownership, recovery reads and separate input/effect acknowledgement. Every case compares dispatched input, durable Broker state and independently recorded page effects. Missing or stale cache evidence cannot establish that an action never happened.

Native packaged tests must qualify the same behavior on Windows x64, macOS arm64/x64 and Linux x64, including actual Codex and Hermes recovery flows. The strategy identifies the existing suites to extend, one focused real-browser suite to create, the evidence to retain and release-blocking failures. These are planned acceptance checks; the input-only feature and interrupted-gesture recovery have not yet passed them.

### A local Chrome probe confirmed both useful reads and conservative refusals

On 2026-11-10, an isolated local Chrome 157 probe exercised `Runtime.evaluate` with `throwOnSideEffect: true`. Text, HTML, input-value, computed-style and element-list reads succeeded. Clicks, focus, value writes, a getter with a page-state write and a direct page-side request were refused. Fixture counters and field values remained unchanged, and no effect request reached the server.

The observation expression `JSON.stringify(document.querySelector("#button").getBoundingClientRect())` was also refused. This establishes the need for an observation fallback. The probe qualified those expressions in that browser build. Chrome describes the guard as rejecting evaluation when side effects cannot be ruled out. [Protocol definition](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/js_protocol.pdl)

The current [CDP executor](../../apps/browser-extension/src/debugger/cdp-executor.ts) and [Broker completion path](../../apps/broker/src/core/octopus/octopus-broker.ts) preserve raw results, which explains the error-mapping work. The [LinkedIn skill](../../integrations/hermes/skills/tabro-linkedin-post/SKILL.md) currently prescribes scripted focus and direct file attachment, so policy promotion includes updating that workflow.

## Authority changes

### Acceptance propagates from Product through the executable contract

| Owner | Proposed amendment |
| --- | --- |
| [Product](../01-Product/Product-Definition.md) | Establish user-managed domain rules, observation freedom within read-only execution, and browser-input requirements for manipulation. |
| [User Experience](../02-User-Experience/User-Experience-Definition.md) and [Operational Defaults](../02-User-Experience/Operational-Defaults.md) | Define list management, effective-policy discovery, rejection recovery and gesture behavior. |
| [User Interface](../03-User-Interface/MCP-Contract.md) and its schema | Define diagnostics, context facts, tool descriptions, contract version and request outcomes. |
| [System](../04-System/System-Architecture.md) | Define hostname matching, automatic subdomain coverage, current-tab URL lookup, active policy revisions and execution recovery. |
| [Components](../05-Components/Component-Architecture.md) | Assign configuration, dispatch, guarded evaluation and input-state responsibilities. |
| [Files](../06-Files/Repository-Map.md) and [Runbook](../06-Files/Real-World-Runbook.md) | Map runtime/configuration changes and native-platform qualification. |

## Review defaults

### Accepted defaults resolve the six design gaps

1. Manage the first version through the validated local configuration file, with atomic revision application and the initialization/reload behavior above.
2. Start with an empty production rule list. Each hostname entry automatically covers nested subdomains and all URL paths. Actual domain names are deployment input supplied by the user.
3. Allow ordinary HTTP(S) navigation, keyboard input and Unicode text insertion. Use user handoff for unsupported clipboard/composition interactions and file selection.
4. Select the rule from the current top-level URL for each command. Navigating to an unlisted hostname restores standard behavior. Iframe-specific matching and redirect-history tracking are excluded by the user's scope decision.
5. Track intended and confirmed held input under one session's control within a window. Use the thirty-second inactivity limit to pause manipulation, reconcile attempts, permit guarded recovery observations, and resume after input and uncertain outcomes are resolved. Automatic recovery emits no release or replay.

The user accepted these defaults as one design on 2026-11-11. They are implemented in source; platform qualification remains tracked separately. The [six-gap checklist](../80-Plans/domain-input-only-rules-2026-11-10/README.md#review-closure) maps every review finding to its resolution and acceptance evidence. Completion evidence requires Codex and Hermes with native Chrome checks on the supported platform targets.

## Dashboard follow-up

### Explicit termination can abandon an uncertain website effect after input is released

The user confirmed no current input during cleanup on 2026-11-11. Preserve that physical acknowledgement separately from the unknown website result. Explicit termination may archive a stopped workspace once input is confirmed released; abandoned commands fail with an explicit possible-effect fact instead of being marked successful, replayed or replaced. Unreleased input still blocks termination. This cleanup clarification follows the user's stop/cleanup/update request and changes no MCP tool or input schema.

### The user chose a soft background preference and accurate connection status on 2026-11-11

Background tabs are the default. Explicit foreground activation remains available when a website needs it to initialize or receive input; this is agent guidance rather than a hard policy denial or new approval requirement. Agents should avoid repeatedly activating a tab and respect a user's switch away during a gesture. The dashboard distinguishes live connection from automation pause and displays connection failures instead of indefinitely labeling them Connecting. This clarification supersedes the assistant's earlier suggestion of a mandatory foreground gate.

### The user approved extension-based connection and rule management on 2026-11-11

The extension opens a two-tab dashboard. Connection shows pairing code, profile alias and live pairing status. Broker management lists registered profiles and their status as read-only information, as the user clarified, and manages the shared domain rule list. This adds a human interface to the same persisted rules; MCP still cannot weaken rules to recover from a refusal. The accepted decision is propagated to the canonical owners.
