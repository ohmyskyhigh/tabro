# Human Simulation observation, realism and verification handoff

Accepted for implementation on 2026-11-19 after the user resolved the open decisions ("按推荐来" accepting every recommended default). The decision is incorporated into the canonical owners under [vault governance](../AGENTS.md). Delivery and platform qualification are tracked in the linked [implementation plan](../80-Plans/human-simulation-observation-2026-11-19/README.md).

Parent entry point is [the knowledge vault](../TOP-DOWN-MOC.md). The linked [implementation plan](../80-Plans/human-simulation-observation-2026-11-19/README.md) records delivery work and verification gates. This proposal extends the accepted [domain input-only rules](./domain-input-only-rules-2026-11-10.md) and the v0.6.0 Human Simulation Mode.

## Problem

### Screenshot-only observation makes Human Simulation Mode too slow for list pages

Tabro v0.6.0 limits Human Simulation domains to screenshots and targeted DOM element queries. `DOM.getOuterHTML`, `Runtime.evaluate` and `Emulation.setDeviceMetricsOverride` are refused. An agent reading a product list must scroll, capture and visually transcribe every screen. That costs many round trips and introduces transcription errors.

### Current simulated input is distinguishable from a person

The per-tab control intervals in `humanControlInterval` are fixed (32 ms mouse move, 90 ms wheel, 150 ms release). Agents supply raw coordinates, so pointer paths are typically straight or single jumps landing on element centres. Tabro defaults to background tabs, where `document.hidden` is true and `document.hasFocus()` is false while the page receives mouse and wheel events. A page can detect that contradiction with two property reads.

### Tabro does not notice when a site challenges the session

A suspicious session can be redirected to a captcha, slider, interstitial or login wall. Tabro keeps dispatching commands into that page. The agent may keep clicking, reload the challenge or navigate away, which raises the site's suspicion further and can lock the account.

## User direction

### The user requested three changes on 2026-11-19

- Allow `Runtime.evaluate` for fast element reading on Human Simulation domains, without any page-mutating operation.
- Accompany evaluate with human wheel and hover behavior so the session remains plausible.
- Detect human-verification pages, stop automation, tell the user to complete the verification, and continue only after the user has finished it.

The user also approved folding the realism findings from the follow-up assessment into this proposal: foreground input, randomized trajectories and timing, page-level pacing, and clicking instead of direct URL jumps for in-site navigation.

## Accepted behavior

### Every Human Simulation rule admits guarded evaluate without a separate setting

The user decided on 2026-11-19 that evaluate is part of Human Simulation Mode, not a separate option. Any domain with a Human Simulation rule admits `Runtime.evaluate` in addition to the v0.6.0 screenshot and targeted DOM observations. The rule schema gains no observation field. The evaluate guard is tightened as follows.

- `throwOnSideEffect: true`, `silent: true`, `userGesture: false`, timeout at most 1000 ms, no `awaitPromise`, as in the current guard.
- `returnByValue: true` is forced. Results must be JSON primitives, arrays or plain objects. No remote object IDs are returned, so the agent cannot follow up with `Runtime.callFunctionOn` or `Runtime.getProperties` against page objects.
- `Runtime.callFunctionOn`, `Runtime.enable`, `Runtime.addBinding` and `Page.addScriptToEvaluateOnNewDocument` remain refused. `Runtime.enable` is the channel used by the well-known `Error.stack` getter detection technique.
- Evaluation runs in an isolated world requested with `Page.createIsolatedWorld` before every evaluate. Chrome returns the existing world for the current document, and execution context IDs are not unique across renderer processes, so a cached ID could name a new page's main world after a cross-site navigation. The world was qualified in real Chrome 157 on 2026-11-19: the side-effect guard works there, DOM reads work there, page-world globals written out of band are not visible to it, and a page-defined prototype override or getter is not reached by the expression. Page-side mutation is refused by the guard rather than silently ignored.
- Result size is bounded by the existing payload limit. Tool guidance asks for small, targeted queries because long evaluations block the page's main thread and are measurable.

An evaluate refused by the side-effect guard returns `INPUT_ONLY_REQUIRED` with the existing observation alternatives.

### Evaluate on a page creates a human-activity debt that blocks leaving the page

When a guarded evaluate succeeds on a Human Simulation tab, the Broker records an activity debt for the current document. The debt is satisfied by the following thresholds, measured from the first evaluate on that document.

| Measure | Accepted default |
| --- | --- |
| Dwell time on the document | at least 4 seconds, plus 0.5 seconds per evaluate after the third |
| Wheel scrolling | at least 1600 cumulative `deltaY` pixels |
| Pointer activity | at least 3 distinct hover points |

While a debt is outstanding, `Page.navigate` and `Page.reload` return a new refusal, `HUMAN_ACTIVITY_REQUIRED`, that lists the missing measures. Input commands remain allowed so the agent can satisfy them. A navigation caused by a click cannot be refused in advance, and the inventory-observed URL change to a fresh document clears that document's debt, which is the intended human path. Scrolling is measured in pixels rather than viewport heights because the Broker does not observe layout.

Tool guidance recommends scrolling first and evaluating afterwards in one batch. Lazy-loaded lists only contain the items that have been scrolled into view.

### Tabro expands agent input into human-like trajectories and timing

On Human Simulation domains the extension executor expands agent mouse movement after the Broker's pacing decision, so one agent command keeps exactly one durable request, one attempt record and one input reservation.

- A `mouseMoved` to a target is expanded into a curved path from the last known pointer position. The path has easing, small overshoot, and a randomly offset landing point within two pixels. The first move in a tab starts from a plausible in-viewport position, not (0,0).
- Pacing intervals receive log-normal extra delay instead of fixed values. Wheel input is grouped into bursts with variable `deltaY`, followed by a reading pause.
- Press and release keep the agent's coordinates after the path ends, so click targets stay exact.
- Keyboard and `Input.insertText` intervals receive jitter.

The expansion is internal. One agent command remains one request ticket and one raw CDP result; Tabro does not report the intermediate event count because the extra dispatches are not separately addressable by the agent.

### Human Simulation input requires a foreground tab in a focused window

Before dispatching input on a Human Simulation domain, the extension checks that the tab is active in its window and that the window is focused. If not, the command returns `FOREGROUND_REQUIRED` with guidance to call `Page.bringToFront` once. Observation, including guarded evaluate, is still allowed in background tabs. Tool guidance recommends a dedicated browser window so automation does not compete with the user's own work.

### Pacing limits how many pages a session visits

Per Human Simulation domain, the Broker enforces a minimum interval between top-level page loads (6 seconds with jitter). After 30 consecutive pages it enforces a rest period of 2–5 minutes. Any observed top-level URL change counts as a load, including one reached by clicking, and so does a reload. Because a click can load a page, the interval and rest hold back mouse presses as well as `Page.navigate` and `Page.reload`. A wait of up to 20 seconds is absorbed in the command; a longer one returns retryable `HUMAN_PACING_WAIT` whose message names the earliest permitted time.

Tool guidance states that in-site paging and opening results should use real clicks. Direct `Page.navigate` jumps omit the referrer and the site's click-tracking parameters.

### Tabro detects human-verification pages before every command

Detection runs before every command on a managed tab. The current top-level URL and title are matched from the Broker's own tab record at no browser cost, so a redirect to a challenge host is caught even when that host carries no rule. On Human Simulation domains one additional guarded isolated-world observation per tab per interval reads the visible captcha frames and challenge widgets, because cross-origin frame URLs are not otherwise exposed and geometry alone cannot tell a resident hidden frame from a shown one. No script is injected into the page world and no unlisted domain receives that observation. An unlisted challenge host is therefore caught through its URL or title, and through the pause already recorded for the ruled session it came from.

| Signal | How it is read |
| --- | --- |
| Top-level URL host and path match a known challenge page | Current tab URL in the Broker's tab record, without query or fragment |
| Document title matches a known challenge title | Tab title in the Broker's tab record |
| A visible challenge frame exists | Visible iframe sources from the guarded observation |
| A visible challenge widget exists | Candidate selectors checked for layout, visibility and viewport position |

The signature list is versioned data shipped with Tabro and can be extended in `browser-rules.json`. The initial list covers Taobao punish and slider pages, Cloudflare challenge interstitials, reCAPTCHA, hCaptcha, GeeTest, Tencent captcha, and the Taobao login redirect. A URL match pauses at once on any domain, so URL entries are tested against host and path only and must name the challenge page itself; a generic `captcha-` URL fragment was dropped for matching ordinary search terms. These signatures come from public knowledge and must be qualified against live pages before release.

Hidden or zero-size captcha frames, which some sites keep resident, do not trigger detection.

### A detected challenge pauses automation until the user resolves it

On detection the Broker adds the pause cause `human_verification_required` to every active workspace on that Profile that owns a tab under the matched rule domain, plus the challenged tab's own workspace. It fails the pending command with `HUMAN_VERIFICATION_REQUIRED`. The diagnostic names the matched signature and evidence and the current URL, and tells the agent to ask the user to complete the verification in that browser window. Profile and workspace context report the pause. A visible red tab-group marking is a separate dashboard follow-up; the pause itself is authoritative in Broker state and MCP facts.

While paused, screenshots, targeted read-only DOM and accessibility queries, layout metrics and `Page.bringToFront` remain available so the agent can show the user the state. Input, evaluate, navigation and reload are refused; refreshing only deepens the site's suspicion.

A URL-shaped challenge is unambiguous and pauses on the first match. A title, frame or widget match pauses only once it has persisted for eight seconds, so an interstitial that clears itself never interrupts the user; because detection runs before each command, that confirmation is observed on subsequent commands rather than by polling idle tabs.

### The accepted thresholds are code defaults for this release

The user accepted decision 4 on 2026-11-19 as recommended: the activity, pacing, probe and grace values are shipped as documented code defaults, exposed through tests as an internal Broker option but not as user configuration in `browser-rules.json`. The only user-configurable addition in this contract is the optional `verification_signatures` extension list.

### Resume requires user confirmation and a clean re-check

`resume_workspace_automation` accepts a new optional argument, `human_verification: { user_confirmed_completed: true }`. The Broker re-runs detection before clearing the cause. If the challenge is still present, resume fails with the current signature, so an agent cannot falsely claim completion. A resume without the argument also fails with `HUMAN_VERIFICATION_REQUIRED` while the pause is present, rather than reporting success for a workspace that stays paused. Evaluate stays available after resume because it is part of Human Simulation Mode.

### Agents report challenges that Tabro does not recognize

Tool guidance instructs agents that see a verification page in a screenshot without a Tabro pause to call `stop_workspace_automation` and ask the user. No new tool is added.

## MCP

### The contract gains fields and errors without new tools

| Change | Detail |
| --- | --- |
| Contract version | 7 to 8; extension capability `browserInputPolicy` 2 to 3 |
| New problem codes | `HUMAN_ACTIVITY_REQUIRED`, `FOREGROUND_REQUIRED`, `HUMAN_PACING_WAIT`, `HUMAN_VERIFICATION_REQUIRED` |
| `get_browser_context` tab facts | outstanding activity debt, pacing state, verification pause with signature |
| `resume_workspace_automation` | optional `human_verification` acknowledgement |
| `send_cdp_command` description | evaluate rules, scroll-then-read, foreground input, click-based navigation, unrecognized-challenge stop |
| Rule schema | optional top-level `verification_signatures`; rule entries unchanged |

The tool catalog stays at its 22 tools. An extension that advertises only capability 2 keeps enforcing the v0.6.0 domain rules but refuses `Runtime.evaluate` on ruled domains and never performs the foreground gate, trajectory expansion or widget detection; the Broker reports the reload requirement through the existing capability diagnostic when a Human Simulation rule is present.

## Limits

### These changes reduce detectable automation artifacts but do not guarantee site acceptance

Request volume, account history and IP reputation dominate e-commerce risk scoring and are outside Tabro's control. Pacing reduces volume artifacts but cannot make a high-volume crawl look like a person. The success measure stays as in the accepted input-only proposal: supported behavior and observable page results, not website acceptance of automation.

## Decisions

### The user resolved all four decisions on 2026-11-19

1. **Evaluate enablement.** Evaluate is part of Human Simulation Mode with no separate option; every ruled domain admits the guarded plain-data read.
2. **Pause scope.** Every active workspace on the same Profile that owns a tab under the challenged rule domain pauses, because the site flags the account and IP rather than one tab.
3. **Login redirects.** A redirect from a Human Simulation page to the site's login page is a verification pause and is in the built-in signature list.
4. **Thresholds.** The proposed activity, pacing, probe and grace defaults ship as code defaults; user configuration is deferred except for the optional signature additions.

## Authority changes

### Acceptance propagates from Product through the executable contract

| Owner | Proposed amendment |
| --- | --- |
| [Product](../01-Product/Product-Definition.md) | Observation levels, human-activity realism, verification handoff as a user-facing promise |
| [User Experience](../02-User-Experience/User-Experience-Definition.md) and [Operational Defaults](../02-User-Experience/Operational-Defaults.md) | Debt, pacing, foreground and verification journeys and default values |
| [User Interface](../03-User-Interface/MCP-Contract.md) and its schema | Contract 8 fields, errors and resume argument |
| [System](../04-System/System-Architecture.md) | Detection timing, pause scope, trajectory expansion, pacing state |
| [Components](../05-Components/Component-Architecture.md) | Broker and extension responsibilities |
| [Files](../06-Files/Repository-Map.md) and [Runbook](../06-Files/Real-World-Runbook.md) | Source map and qualification steps |
