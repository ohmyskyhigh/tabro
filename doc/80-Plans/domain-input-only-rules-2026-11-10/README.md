# Domain input-only rules implementation plan

Plan dated 2026-11-10; implementation approved and applied on 2026-11-11. The accepted [proposal](../../90-Proposals/domain-input-only-rules-2026-11-10.md) is incorporated into the canonical Product, User Experience, User Interface, System, Component and File owners. This record distinguishes implementation evidence from remaining release qualification.

## Status

### The source implementation is complete and cross-platform release qualification remains open

Implemented contract 6 without adding MCP tools: validated live rules, extension capability/revision synchronization, current-tab domain enforcement, guarded observation, actionable errors, durable held-input recovery, recovery reads, acknowledgement and separate uncertain-effect resolution. Setup guidance and Hermes browser/LinkedIn workflows describe the same behavior. Empty default rules preserve standard behavior until the user adds domains.

`pnpm verify` passes lint, TypeScript checks, unit/integration/contract suites, simulated multi-client end-to-end checks and the host build. The dedicated macOS arm64 browser test is run separately against the staged package because ordinary verification skips environment-gated native tests. Its report is `artifacts/qualification/darwin-arm64-input-only.json`; the report records the package manifest hash, Chrome version, source revision/local-change status and browser trace/event/effect evidence.

| Qualification | Current evidence |
| --- | --- |
| Policy, persistence, MCP and recovery regressions | Passed locally, including invalid edits, missing rules, guard refusals, lost responses, real SQLite restart, timeout boundaries, ownership and guarded reads past a blocked mutation. |
| macOS arm64 packaged input fixture | Passed with real Chrome: mouse, Unicode text, selection, wheel and drag; rejected scripted mutations; lost release confirmation; actual Broker process crash; 30-second modifier timeout; recovery acknowledgement; current-domain rules and live edits. |
| Windows x64, macOS x64 and Linux x64 | Not run in this session. The release workflow runs the packaged browser test and requires a passing evidence report on each native runner. |
| Packaged installer rule preservation | Passed on this macOS arm64 host with a dedicated install root and Chrome user-data directory: fresh rules, repeated setup, Broker restart, both profile ownership types and unchanged edited rules. Other platforms remain pending. |
| Public website through Native companion | Passed on macOS arm64 Chrome 157 against Selenium's public form: blocked script writes/clicks, guarded reads, Unicode text, checkbox/radio, keyboard select and successful submission/readback. All website commands used MCP → Broker → unmodified extension via the installed Native companion. |
| Actual Codex and Hermes applications/agents | Not run for this feature. The packaged stdio adapter was exercised under both session identities using the MCP SDK; this does not establish actual client application or agent acceptance. |
| Distribution and local installation | Source and a local staged macOS package updated; a separate temporary installation was tested and removed. No publication, commit, push or replacement of the user's normal installed Broker. The historical checked-in Hermes runtime remains its existing release. |

The 2026-11-11 public-site run used `TABRO_QUALIFY_WEBSITE=1 TABRO_QUALIFY_PACKAGE=artifacts/release/tabro-v0.5.0-macos-arm64 pnpm exec vitest run tests/real-world/portable-installation.test.ts`. The opt-in website checks avoid making ordinary CI depend on an external demo service. Evidence is `artifacts/qualification/darwin-arm64-portable-installation.json`, with `darwin-arm64-selenium-form-filled.png` and `darwin-arm64-selenium-form-submitted.png`. The native test took 39.55 seconds; the separate interruption fixture passed again in 58.11 seconds.

Two initial test assumptions failed and were corrected without weakening policy: CDP keys did not select an option in an already-open macOS native popup, but Tab focus followed by keyboard type-ahead did; Chrome refused a read-only URL-helper expression, so the test read `Page.getFrameTree` and parsed the URL in the host. The failed-attempt reports are retained as `darwin-arm64-native-popup-limitation.json` and `darwin-arm64-guarded-url-refusal.json`. Hermes browser guidance records both observation/input alternatives.

Release qualification must still run the full interruption matrix and actual client/user-handoff acceptance described below, in addition to all four native package jobs. This record does not claim those gates passed.

## Objective

### Agents discover and obey domain rules through the existing MCP tools

Implement one user-managed rule list shared by the local Broker's profiles and clients. Matching sites allow guarded observation and require browser input for manipulation. Every rejected command explains a supported next action. The first management interface is a local configuration file.

## Delivery

### Canonical owners establish the contract before runtime changes

Promote the accepted proposal in authority order through Product, User Experience, User Interface, System, Components and Files. Update the Markdown contract and JSON schema together. Record the applied decision under `doc/99-Changelog/` and update the proposal index status. The user accepted these defaults on 2026-11-11. User-selected production domains are deployment configuration.

### Configuration and dispatch share a validated policy revision

Extend `apps/broker/src/runtime/config.ts` and `apps/broker/src/runtime/bootstrap.ts` to load and validate the local rules. Use a shared policy representation for normalization, matching and method classification, adding `apps/shared/protocol/src/browser-interaction-policy.ts` if needed to avoid divergent Broker and extension decisions. The installation data file is `browser-rules.json` and belongs to user data.

Update `apps/broker/src/core/octopus/octopus-broker.ts` to provide early refusal and policy facts. Carry the authenticated policy revision through `apps/shared/protocol/src/relay/v2-messages.ts`, the relay gateway and `apps/browser-extension/src/protocol/dispatcher.ts`. Advertise enforcement support explicitly in the capability representation. An extension without that support reports an update requirement when enforcement is needed.

Validate edits before applying them, retain the last valid policy on a failed live reload, and make configured-file failures explicit on startup. A newly applied revision governs queued commands at execution. Reconnects must establish the current policy before browser commands proceed.

### Browser execution selects the policy from the current tab URL

Update `apps/browser-extension/src/browser/inventory.ts` and `apps/browser-extension/src/debugger/cdp-executor.ts` to read the current top-level tab URL before execution. Match its hostname against each entry's exact hostname and nested subdomains, covering every URL path. The current URL selects the rule after any navigation. A listed A followed by an unlisted B uses standard behavior on B, while a listed B receives B's rule. Report the actual hostname and matching entry in MCP context and errors. Iframe-origin inspection, inherited frame policy and redirect-chain tracking are outside the implementation scope.

Force guarded evaluation for permitted observations and restrict method parameters. Normalize side-effect refusals through both direct execution and cached reconciliation. Provide read-only DOM or accessibility fallbacks where the browser refuses a legitimate observation. Classify each supported method in `apps/shared/protocol/capabilities/extension-baseline.json` for this policy.

### Interrupted input pauses manipulation until recovery is established

Use the existing durable request/attempt records in `apps/broker/src/storage/sqlite/request-repository.ts` to retain intended and confirmed input transitions. Track buttons and keys including modifiers, the owning session and target window. Update `apps/browser-extension/src/debugger/cdp-executor.ts` and the existing attempt cache to report confirmed outcomes. Reuse `RECONCILE_ATTEMPT` in `apps/browser-extension/src/protocol/dispatcher.ts` to resolve acknowledgement loss before deciding that input state is unknown.

In `apps/broker/src/core/octopus/octopus-broker.ts`, reserve input for the owning session while it is held and pause affected-window manipulation on interruption or thirty seconds of held-input inactivity. The timeout creates a pause and recovery diagnostic. Automatic recovery sends no release event or repeated gesture. Reconstruct unresolved input from durable records after restart so lost process memory cannot clear the pause.

Allow classified recovery observations through `send_cdp_command` while manipulation is paused, retaining ownership checks and browser side-effect guards. This requires an explicit amendment to the current same-tab FIFO contract and scheduler. The observation path cannot advance or terminalize the blocked mutation. Preserve the separate status of other stop, kill and disconnect causes.

Clear held state when reconciliation proves release completed or after explicit recovery acknowledgement following the user's intervention. Gate resume on both input-state recovery and resolution of any uncertain website effect. Add `INPUT_STATE_UNCERTAIN` to the proposed diagnostic contract and expose the last confirmed step, affected target and recovery instructions.

### MCP contracts and agent workflows describe the same recovery path

Update `doc/03-User-Interface/MCP-Contract.schema.json`, `apps/shared/protocol/src/mcp/tool-catalog.ts`, `apps/shared/protocol/src/mcp/validators.ts` and `apps/shared/protocol/src/error-codes.ts` together. Review `apps/shared/protocol/src/domain/facts.ts` for effective-policy and input-recovery facts. Extend `get_browser_context`, `get_browser_request` diagnostics and `resume_workspace_automation` acknowledgement while preserving the distinct purpose of `resolve_browser_request`. Use the existing public tool catalog.

Update `integrations/hermes/skills/tabro-browser/SKILL.md`, `integrations/hermes/skills/tabro-linkedin-post/SKILL.md` and its `references/cdp-workflow.md` with guarded observations, complete input sequences and policy-error recovery. Refresh setup guidance in `GETTING_STARTED.md` and installation-data preservation in the supported installers as required. Review hard-coded contract gates in `integrations/hermes/common.ps1` and `tools/tabro-setup.ts` if the wire version advances.

## Review closure

### All six review gaps have implemented resolutions and explicit qualification requirements

The source implementation addresses each row. Deterministic checks and the macOS arm64 packaged browser fixture provide the evidence below; full native-platform and actual client acceptance remain release requirements.

| Review gap | Implemented resolution | Evidence required to close delivery |
| --- | --- | --- |
| 1. Read-only JavaScript can be refused | Force the side-effect guard and provide DOM/accessibility alternatives, including `DOM.getBoxModel` for bounds. Explain ambiguous guard refusals accurately. | A refused observation is recoverable through the recommended read, and scripted mutations cause no observed fixture effects. |
| 2. Domain scope and navigation behavior were underspecified | Every entry covers its hostname, nested subdomains and all paths. Select the matching rule from the current top-level tab URL at execution. The user's scope excludes iframe matching and redirect-history tracking. | Parent and subdomain entries match the specified hosts and paths. Navigating to listed B applies B's rule, and navigating from listed A to unlisted B restores standard behavior. Queued commands use the current URL. |
| 3. Rule management and updates were underspecified | Use a validated local file, initialize it once, persist initialization, apply valid revisions atomically, retain the prior live revision after an invalid edit, and preserve data on upgrade. | Fresh install, edit, empty-list removal, malformed file, configured-file deletion, restart, reconnect and upgrade tests have the specified outcomes. |
| 4. Input behavior and exceptions were underspecified | Define navigation, keyboard events, Unicode insertion and user handoff for unsupported clipboard/composition and file-picker interactions. Track intended and confirmed input. Reconcile interruptions, pause manipulation on unresolved held state or timeout, allow guarded observation, and require recovery before resume. | Click, type, select, scroll and drag fixtures prove event order and readback. Disconnect, lost acknowledgement, restart and inactivity expose accurate state. Timeout sends no release or replay. Observations work during the pause, competing manipulation stays blocked, and resume requires input and uncertain-effect resolution. |
| 5. CDP exceptions could appear as successful actions | Map guard refusals to `INPUT_ONLY_REQUIRED`, retain ordinary error causes, return usable alternatives, and preserve the result through cached reconciliation and polling. | Both synchronous refusals and failures after acceptance have correct structured outcomes. Ordinary script errors and uncertain effects retain their own semantics. |
| 6. Extension, schema and skills could disagree | Promote the contract and capability changes together, require an enforcing extension, and update Codex/Hermes descriptions, LinkedIn workflows, setup guidance and contract gates. | Contract tests, old-extension tests, real Codex and Hermes discovery, and packaged Chrome qualification pass on all supported targets. |

## Verification

### Passing requires agreement between browser effects, recorded state and recovery behavior

Testing must establish these outcomes independently:

1. A matching domain allows observation and rejects scripted manipulation before it changes the fixture. An unlisted domain retains standard behavior.
2. Supported input completes click, typing, selection, scroll and drag with the expected event order and visible result.
3. Lost confirmation never causes automatic input replay, release, or a false claim that the gesture completed. A missing cache entry does not prove that Chrome did nothing.
4. Interrupted held input pauses manipulation in the affected window, survives Broker restart, and cannot be bypassed by another session. A connected owner can still perform guarded recovery reads.
5. Resume requires established input recovery, separate resolution of an uncertain website effect, and clearance of other pause causes.
6. The packaged extension, Broker, MCP descriptions and Codex/Hermes workflows produce the same outcomes on every supported platform target.

For each gesture, compare three records: the exact outbound CDP input sequence, the Broker's durable request/input state and public diagnostics, and the fixture's actual event log, DOM result and effect-request count. A successful transport response alone is insufficient. Use fixture-specific expected event sequences; do not require identical incidental pointer events across operating systems. These tests qualify supported interaction and recovery behavior, not acceptance by a website's anti-crawler system.

### Deterministic interruptions cover each point where execution and confirmation can disagree

Extend `FakeDebugger` and `MemoryStorage` in `tests/contract/cdp-adapter.test.ts`, and `FakeExtensionPort` in `tests/integration/octopus-broker.test.ts`, with controllable barriers for dispatch, Chrome completion, cache persistence and response delivery. Await each barrier before injecting failure. Use fake clocks for timeout boundaries, avoiding timing-dependent sleeps. Keep fault controls in the test harness; do not add a production policy bypass or public fault-injection tool.

Run the press/release cases for both mouse buttons and keyboard modifiers. Test a multi-key combination so releasing one key cannot incorrectly clear another held key. The matrix distinguishes an input that is known to be held from one whose state cannot be established; only the latter receives `INPUT_STATE_UNCERTAIN`.

| Interruption or recovery case | Required evidence |
| --- | --- |
| Cancel after intent is recorded but before proven dispatch | No input reaches Chrome. Record that this step did not execute, retaining any input already held from an earlier step. |
| Press executes, then confirmation is lost before a reliable cache record exists | Retain the possibility of held input, pause manipulation and report uncertainty. Do not send another press, a release, or a replacement gesture. |
| Press is cached, but its response to the Broker is lost | Reconcile the original attempt once available. Report the confirmed press and keep manipulation paused for recovery; do not replay it. |
| A move fails while a drag is held, or focus/target changes after a press | Preserve the held-button state and affected-window pause. Do not move to a new target or synthesize a drop. Repeat for a held modifier. |
| Release executes and is cached, but its response is lost | Reconcile the release and clear only the corresponding held state. The fixture receives exactly one release; establish the website result separately. |
| Release may have executed, but cache persistence fails or the record is lost | Keep the state uncertain and paused. A storage failure after execution must not become proof that the action failed before execution. No second release is sent. |
| Cached outcomes expire, are evicted, or belong to a stale tab/window/attachment generation | Absence or stale evidence cannot clear input state. Late responses cannot clear a newer gesture's state or another target's pause. |
| Broker restarts after recording intent, dispatch or confirmation; extension reconnects with retained or missing cache | Reconstruct the durable state and reconcile where possible. Restart and reconnect alone never mark held input released or replay an uncertain command. |
| Held-input inactivity reaches 29,999 ms and then 30,000 ms | The timeout does not fire early, then creates the specified pause without sending input. An acknowledged owner input step resets inactivity; observations and polling do not keep a held gesture alive. |
| Another session acts in the affected window, or an authorized session acts in an independent window | Competing manipulation is blocked in the affected window. The input pause does not leak into independent windows; ordinary ownership and focus checks still apply. |
| The paused mutation remains at the head of its tab queue | A permitted recovery read completes while that mutation remains unchanged. A side-effecting expression, guard-disabling parameter, or unauthorized read cannot use this exception. Other mutations retain FIFO order. |
| An owner attempts resume with missing recovery acknowledgement, unresolved effect, or an additional stop/kill/disconnect cause | Resume remains blocked for the outstanding cause. Input acknowledgement does not resolve the website effect, and resolving that effect does not clear held input. |

Finish recovery tests with a fresh, intentional gesture after the required recovery and request resolution. It must complete exactly once, proving the pause is recoverable. In automated tests, simulated user intervention is labeled as such and occurs through the test harness; separately verify the actual user handoff in the client acceptance exercise. Neither path treats an agent's unsupported claim as proof of a successful website action.

### Existing suites own most checks and one focused browser suite proves actual effects

| File to update or create during implementation | Responsibility |
| --- | --- |
| `tests/contract/cdp-adapter.test.ts` | Guard parameters, JavaScript exception mapping, exact input-call traces, cache persistence failures and stale reconciliation results. Reuse its debugger and storage doubles. |
| `tests/integration/octopus-broker.test.ts` | The interruption matrix, fake-clock boundaries, session/window coordination, queued recovery observations, public diagnostics and resume gates. Extend its existing extension port rather than making a parallel Broker simulator. |
| `tests/integration/sqlite-workspace-store.test.ts` | Close and reopen a real temporary SQLite database at the intent, dispatch and confirmation boundaries. Verify intended/confirmed state, ownership, pending attempts and pause causes survive. |
| `tests/contract/mcp-contract-v2.test.ts` and `tests/contract/relay-v2.test.ts` | Validate effective-policy facts, recovery diagnostics, acknowledgement schema and capability negotiation, including pre-acceptance refusal and later ticket failure. |
| `tests/real-world/input-only-recovery.test.ts` | A focused local website and real Chrome test for supported gestures, forbidden mutations, observation fallbacks, response loss and actual Broker-process termination/restart. Keep destructive interruption fixtures separate from installation smoke tests. |
| `tests/real-world/portable-installation.test.ts` | Fresh installation, rules preserved across upgrade, compatible extension reload, and user-owned/broker-owned profile checks for the packaged feature. |
| `tests/unit/linkedin-post-skill.test.ts` and `tests/contract/public-documentation.test.ts` | Agent instructions and public links stay consistent with the approved contract. Skill text assertions supplement actual client acceptance. |
| `.github/workflows/release.yml` | Run the packaged qualification explicitly on the native platform matrix and retain evidence. Missing prerequisites or skipped qualification cannot satisfy the release gate. |

### Automated checks cover rule changes and the complete request lifecycle

Extend the existing test suites where they cover the changed responsibilities. Add focused policy tests only where those suites lack a suitable fixture.

| Verification area | Required cases |
| --- | --- |
| Rule configuration | Parent-domain entries, subdomain entries, automatic nested-subdomain coverage, all URL paths, case, internationalized names, trailing dots, deceptive suffixes, duplicate entries, empty lists, missing configured files, invalid reloads and restart. |
| Current-tab policy | Listed and unlisted current URLs, navigation from A to B with each listing combination, queued commands after the URL changes, unreadable tabs, policy revisions and old extensions. |
| Observation | Successful text/HTML/state reads, geometry fallback, side-effect getters, `Runtime.evaluate`, `Runtime.callFunctionOn`, caller attempts to disable the guard and bounded execution. |
| Manipulation | Scripted click/focus/scroll, direct values and attributes, synthetic events, page-side requests and executable navigation URLs. Verify observable state and server request counts. |
| Input | Click, typing, selection, scroll and drag sequences, focus changes, interruption before/after press or release acknowledgement, cache reconciliation, held-input inactivity, Broker restart, competing requests, recovery reads, user acknowledgement and resume. Verify timeout sends no release or replay and unresolved effects retain their separate outcome. |
| MCP lifecycle | Pre-acceptance refusal, failure after acceptance, guard exceptions in raw results, cached attempt recovery, clear alternatives and no automatic replay of uncertain effects. |
| Integration | Codex and Hermes tool discovery, policy descriptions, user-owned and broker-owned profiles, and preservation of rules across updates. |

Run the focused suites as they are extended.

```sh
pnpm exec vitest run tests/contract/mcp-contract-v2.test.ts tests/contract/cdp-adapter.test.ts tests/contract/relay-v2.test.ts tests/contract/extension-manifest.test.ts tests/integration/octopus-broker.test.ts tests/integration/sqlite-workspace-store.test.ts tests/unit/linkedin-post-skill.test.ts tests/contract/public-documentation.test.ts
pnpm verify
```

### A local fixture verifies input behavior on every supported platform target

Use the focused `tests/real-world/input-only-recovery.test.ts`. Its local website contains a click counter, text field, selection control, scroll area and drag destination that records a drop. Record input-event order, coordinates, button/modifier state, DOM results and effect requests. Instrumentation belongs to the fixture; all actions under test travel through the actual MCP, Broker and extension path. Direct CDP may inspect the harness or arrange a labeled fault, but must not substitute for the action being qualified.

Exercise listed and unlisted hostnames, nested subdomains and multiple paths through local host resolution. Navigate between A and B and verify the rule for the current URL, including a server redirect as one navigation case. Observe controls, act through input, and read back the result. Reject scripted click/focus/scroll, direct values, synthetic events and page-side requests with no corresponding fixture effect. Include guarded observations and DOM/accessibility fallbacks. Since Chrome may change which legitimate expressions its guard accepts, force the refusal in the adapter test and independently prove the fallback in real Chrome; do not fail a future Chrome solely because it safely permits the geometry read.

Use the exhaustive boundary matrix in the deterministic suites. In real Chrome, reproduce lost response delivery through a test transport barrier after execution and cache persistence, and separately terminate the isolated Broker process after the fixture records a press. Test both mouse and modifier recovery. A Broker object recreated in a test is insufficient evidence of process-crash recovery. Use one actual thirty-second inactivity run to check timer wiring; the complete boundary matrix uses fake time.

The central drag test presses, moves, and withholds the response while keeping the browser target attached and focused, before an intentional release. Assert that the fixture has no drop and that Tabro emits no release or replay while pausing and serving recovery observations. Then test the complementary case: Chrome performs the release/drop but its response is lost. The drop count must remain exactly one through reconciliation and recovery. In separate detach/focus-change cases, if Chrome itself releases input, record that browser event and its page effect; Tabro must still avoid a second release and must not infer success without evidence.

Run the packaged tests on the host that runs Chrome, with its browser sandbox enabled, on Windows x64, macOS arm64 and x64, and Linux x64. Use the release workflow's extracted-archive setup and an isolated installation and test profile. Never terminate the user's running Broker or browser. Where native-host registration is shared at the OS-account level, use a dedicated qualification account or a proven save/restore harness before running setup; a temporary install directory alone does not guarantee isolation. Parse every JavaScript exception as part of verification. The policy probe recorded in the proposal establishes selected browser behavior and remains distinct from this end-to-end qualification.

```sh
TABRO_QUALIFY_PACKAGE=/absolute/path/to/extracted/archive pnpm exec vitest run tests/real-world/portable-installation.test.ts tests/real-world/input-only-recovery.test.ts
```

Both files are implemented and the command is runnable. The Windows runner sets the same environment variable through PowerShell. Run installation and recovery suites serially where they share account-level native registration. The qualification job must check that the expected tests actually ran; `pnpm verify` can skip environment-gated browser tests and is not sufficient qualification by itself.

### Client acceptance and recorded platform results determine delivery readiness

On each supported platform, exercise the packaged feature through actual Codex and Hermes connections with the installed extension. Start with an agent that has not been told the domain is input-only: its scripted action must receive an accurate rejection and usable alternative, then succeed through the prescribed observation/input sequence. Exercise an interrupted gesture, read its diagnostic, inspect while paused, complete the user handoff, resolve any uncertain effect and resume. Verify that the tool descriptions and error advice agree and do not recommend replay or an automatic release. Use platform-appropriate key combinations and compare the intended result.

Retain the source revision, package hash, OS/architecture, Chrome and client versions, rule revision, case results, CDP trace, request/attempt history and fixture event/effect log. Capture a screenshot on browser failures. Use only local synthetic content in these artifacts. Report each platform as passed, failed or not run; an unavailable target remains an explicit delivery gap.

Run the deterministic suites on changes to their owners, and the full native qualification matrix before release. Any unintended effect from a rejected command, recovery-generated release/replay, duplicate action, false cleared state, blocked recovery observation, incorrect resume, or skipped required platform blocks delivery. Passing means the defined invariants and actual browser results agree; it is not a guarantee against every possible website behavior.

## Completion

### Delivery requires documented policy decisions and verified browser outcomes

Completion requires accepted canonical amendments, validated persistent rules, live-target enforcement, actionable MCP outcomes, compatible extension behavior, corrected agent workflows and the native-platform results above. Record failures and remaining qualification gaps explicitly. Any rollback must retain the user's rule file and require a compatible enforcement path before resuming protected browser work.

## Extension dashboard

### The reloaded macOS installation passes 48 background Taobao checks without activation

After the user confirmed extension reload on 2026-11-11, the installed MCP → Broker → Native companion → extension path passed 48 checks in 21.044 seconds. The single test tab stayed hidden and unfocused at creation, after Taobao loaded and at the end; no `Page.bringToFront` or real pointer/keyboard gesture was dispatched. Thirty-seven attempts were refused with `INPUT_ONLY_REQUIRED`, including prototype/bound DOM calls, async/deferred execution, mutating serialization getters, guard overrides, direct CDP mutations and script injection. Two unsupported methods were refused with `CDP_METHOD_UNSUPPORTED_BY_EXTENSION`. Guarded JavaScript, DOM, accessibility and clipped screenshot observations succeeded. A harmless mutation succeeded after leaving Taobao for unlisted example.com, then was blocked after returning to Taobao.

No policy bypass was found in this bounded pass. Evidence is `artifacts/qualification/taobao-input-only-report.json`, preserving previous run history. Cleanup terminated the workspace and archived its group; the test tab remains for manual closure. Installed health returned to zero active workspaces and zero open requests, with `sunnyoak` connected, ready and unpaused and the Taobao rule unchanged. Real input gestures and foreground-dependent initialization were deliberately not retested during the user's background-work request; iframe enforcement remains outside the approved scope. The earlier focused native fixture is separate evidence, not proof of those behaviors on Taobao in this run.

### Released input permits cleanup without claiming an uncertain website action succeeded

The user's confirmation that no input is held allows cleanup of the stopped Taobao test. Inspection found that termination rejects even acknowledged released input, while resume requires website-effect resolution first. Fix this cleanup deadlock in `octopus-broker.ts`: retain the input guard while any input is held, pending or uncertain; after confirmed release, permit explicit workspace termination and fail abandoned confirmation-waiting commands with `effect_may_have_occurred: true`. Never replay, create a replacement tab or invent successful website effects. Keep the recovery record until archival succeeds, and test both blocked pre-acknowledgement termination and successful post-acknowledgement cleanup in the existing Broker integration suite. This implements the existing request to stop the test and install the update without foreground activation.

Completed after user acknowledgement: the regression and full verification pass (308 non-E2E tests, two simulated E2E tests, lint/type checks/build; 21 gated skips). Backed up the stopped local Broker and ran the corrected host Broker temporarily to archive the exact test workspace through MCP, preserving the uncertain scroll as a failed command with possible effects. The normal installer then installed macOS arm64 package digest `191b3c71a68e86d377e46ce6d3d561cd4b09419a9e9bbb55c74944bc2fd88b33`. Installed MCP checks report `sunnyoak` connected, ready and unpaused, zero active workspaces/open requests, and the unchanged Taobao rule. `quietharbor` is stopped; its prior connection failure was not retested. Updated dashboard assets are installed, but browser reload/visual confirmation remain manual. No page activation or input replay was performed.

### Background defaults stay advisory and profile rows distinguish connection from automation

On 2026-11-11 the user clarified that background operation is a soft preference: some websites need foreground activation to start. Default new workspace, additional and replacement tabs to inactive; retain explicit `Page.bringToFront` and advise agents to activate only when needed, without repeated activation or automatic focus restoration. Do not add a hard foreground denial, per-domain focus rule or new approval flow. Input-only restrictions and interrupted-gesture recovery continue to govern manipulation.

The reported dashboard shows a connected extension, a timed-out managed profile mislabeled Connecting, and a connected user profile whose automation is paused. Fix the presentation by showing connection and automation separately, respecting actual extension state and displaying timeout diagnostics. Keep profile controls read-only and do not restart Chrome or resume the stopped test to refresh the display.

Update `apps/broker/src/core/octopus/octopus-broker.ts`, extension `browser/tab-groups.ts`, `options.html`, `options.css`, `options.ts` and a testable profile-status presenter; update MCP descriptions and the Hermes browser workflow. Cover inactive creation/retries, explicit foreground support, failed/disconnected versus connecting states and connected-but-paused presentation. Run source verification; avoid interactive host-browser qualification while the user is working. Propagate this accepted clarification through the canonical owners and record evidence here.

Implemented and verified: `pnpm verify` passes lint, TypeScript, 307 non-E2E tests, two simulated E2E tests and the host build; 21 environment-gated tests remain skipped. The macOS arm64 package is staged with manifest SHA-256 `58304c1360188c7eb1a81ed73993a58c2f572ccaf71c5cf4e0fca0acf5527d5f`. Native interactive verification was deliberately not rerun. The installed Broker still reports `quietharbor` as disconnected with `PROFILE_EXTENSION_TIMEOUT` and `sunnyoak` as connected with automation paused. Installing this follow-up awaits cleanup of the earlier input-recovery workspace; the user was asked to confirm released inputs before that cleanup. The presentation fix does not establish that the managed profile's underlying connection issue is repaired.

### The approved dashboard makes connection details and Broker management available from the extension

On 2026-11-11 the user requested a dashboard opened from the extension with two tabs: pairing code, alias and status; and Broker management with profiles and rules. Extend the existing options page and toolbar action. Use the authenticated extension relay for typed, connection-generation-bound management messages; expose no administrator token or generic MCP execution endpoint to page code. The user clarified that profiles and their status are read-only in this dashboard.

Update the extension HTML, TypeScript and stylesheet, relay schemas/client/gateway, Broker dashboard handler and rule-file writer. Add validated rule add/edit/remove with revision checks and atomic file replacement. Test rejected unauthenticated/stale messages, concurrent edits, malformed rules, persistence and real Chrome interaction. Verify desktop and narrow layouts, keyboard tabs/dialogs, reconnect/errors, and actual rule enforcement after saving through the dashboard.

The direct-build reference is the existing extension page's task structure with Refero's bundled typography, color and craft guidance (live lookup was unavailable). Preserve neutral system typography, compact tables, restrained surfaces and clear focus states. Use a near-white canvas, charcoal text, cobalt primary/active controls and semantic green/amber/red status. Pairing information is a single focused panel; the management tab uses stacked profile and rule sections with labeled actions. No external assets or runtime font requests are required.

### The dashboard implementation passes source checks and native macOS Chrome qualification

The release matrix sets `TABRO_QUALIFY_DASHBOARD=1` for every packaged installation run, making the real dashboard probe a required step on each supported target. The local passing run below does not substitute for those remote platform results.

Implemented the two-tab extension page, authenticated and generation-bound dashboard relay, read-only profile snapshots, and validated rule add/edit/remove. Saves reject stale revisions and files beyond the 256 KiB read limit before replacing the file. Dashboard support is negotiated without adding a field to legacy HELLO messages or changing READY for older clients. Pairing controls, confirmation dialogs and responsive tables are included; the public MCP catalog remains twenty-two tools.

`pnpm verify` passes lint, TypeScript, 298 unit/integration/contract tests, two simulated E2E tests and the host build; 21 environment-gated tests remain skipped in that command. The separate `TABRO_QUALIFY_DASHBOARD=1` packaged test passes on macOS arm64 with Chrome 157.0.8103.50 through Native companion. It verifies real keyboard tab navigation, read-only profiles, invalid-domain rejection, rule CRUD, confirmation cancellation, stale-edit preservation, narrow layout, alias reconnect, actual MCP enforcement of a UI-saved rule, and rule preservation through restart. The final native run took 22.77 seconds.

Evidence: `artifacts/qualification/darwin-arm64-portable-installation.json`, plus `darwin-arm64-dashboard-connection.png`, `darwin-arm64-dashboard-broker.png` and `darwin-arm64-dashboard-narrow.png` in that directory. The package manifest SHA-256 is `67830566f25ef11451095d75961e42db4fb30851394c22e94c2c8baa37a85ed3`. Desktop and narrow screenshots were visually inspected. Windows/Linux native dashboard runs and actual Codex/Hermes application acceptance remain unverified here. The normal host installation was not replaced and no package was published.
