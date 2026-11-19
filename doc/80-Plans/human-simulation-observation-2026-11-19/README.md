# Human Simulation observation and verification implementation plan

Plan dated 2026-11-19 for the [proposal](../../90-Proposals/human-simulation-observation-and-verification-2026-11-19.md), which the user accepted on 2026-11-19 with every recommended default.

Parent: [development plans](../_MOC.md).

## Status

### The source implementation is complete and real-browser qualification remains open

Steps 1–6 are implemented on branch `codex/human-simulation-observation`, based on `origin/main` 5178dd3 (Tabro 0.6.0 plus macOS fixes). Nothing is committed or published.

| Qualification | Current evidence |
| --- | --- |
| Lint, typecheck, unit, contract and integration suites | Passed on Windows x64 on 2026-11-20: 366 tests in 58 files, plus the 2 e2e transport tests. |
| Isolated-world detection expression | Passed against headless Chrome stable on Windows with `artifacts/probe-detect.mjs`: the visible frame and slider are reported, the hidden resident frame and `display:none` widget are not, and a repeated `createIsolatedWorld` returns the same context. |
| Packaged real-browser test `tests/real-world/input-only-recovery.test.ts` | Not run. It needs a staged release package and a machine installation (`TABRO_QUALIFY_PACKAGE`, `TABRO_QUALIFY_INSTALL_ROOT`). |
| Live Taobao session | Not run; to be run by the user on their own account. |

### The 2026-11-20 review corrected six defects in the first implementation

- `HUMAN_PACING_WAIT` placed `earliest_at` inside `affected_target`, which the closed MCP schema rejects; the time is now only in the message.
- Loads were counted only for successful `Page.navigate`/`Page.reload`, so click navigation, the recommended path, was never paced. Every observed top-level URL change on a ruled domain now counts, and the interval and rest also gate mouse presses.
- URL signatures matched the whole URL including query and fragment, and a generic `captcha-` entry could pause unrelated sites from a search term. URL signatures now match host and path only, and the generic entry is removed.
- The isolated world's context ID was cached per tab. Context IDs are not unique across renderer processes, so after a cross-site navigation a cached ID could name the page's main world. The world is now requested before every evaluate; only the main frame ID is cached. Guarded evaluate on a child session is refused.
- `jitteredInterval` existed but the Broker still used fixed intervals; Human Simulation controls now receive log-normal extra delay. The `browserInputPolicy=3` capability was recorded but unused; evaluate on a capability-2 extension now returns `INPUT_POLICY_UNSUPPORTED` with reload guidance and skips the detection probe.
- A resume without `human_verification` while verification-paused reported success. It now fails with `HUMAN_VERIFICATION_REQUIRED`.

Hard-coded `x-octopus-contract-version: 7` headers in the e2e helper, real-world scripts and probe tools were updated to 8.

## Delivery

### Canonical owners are updated first in authority order

After acceptance, promote the decision through Product, User Experience, Operational Defaults, User Interface (Markdown contract and JSON schema together), System, Components and Files. Record the applied change under `doc/99-Changelog/` and move the proposal to the accepted index.

### Step 1 admits guarded evaluate in every Human Simulation rule

- `apps/shared/protocol/src/browser-interaction-policy.ts`: add `Runtime.evaluate` to the Human Simulation observations unconditionally and force `returnByValue: true` in `humanSimulationCommand`. Keep `Runtime.callFunctionOn`, `Runtime.enable` and `Runtime.getProperties` refused. The rule schema and the extension rule editor are unchanged.
- `apps/browser-extension/src/debugger/cdp-executor.ts`: create or reuse a main-frame isolated world per document and send `contextId` with the evaluate. Reject results containing remote object IDs. Fall back to the main world only if browser qualification fails, controlled by a constant.

### Step 2 adds activity debt and page pacing in the Broker

- New `apps/broker/src/core/octopus/human-activity.ts`: per tab and document state for first-evaluate time, evaluate count, cumulative wheel `deltaY`, distinct hover points and the last departure. Per Profile and domain pacing state for last document load and consecutive page count.
- `apps/broker/src/core/octopus/octopus-broker.ts`: update the state after confirmed input and evaluate results; refuse `Page.navigate` and `Page.reload` with `HUMAN_ACTIVITY_REQUIRED` while debt remains; count every observed top-level URL change as a load and gate `Page.navigate`, `Page.reload` and mouse presses on pacing, waiting or returning `HUMAN_PACING_WAIT`. Document identity is the observed top-level URL. State is in memory; a Broker restart clears debt, which is acceptable because restart already pauses held input.

### Step 3 expands input into trajectories and jittered timing

- New `apps/shared/protocol/src/human-motion.ts`: deterministic, seedable path generator (eased cubic Bézier with overshoot and landing offset), log-normal jitter and wheel bursts. Seedable so tests are reproducible.
- `octopus-broker.ts`: on Human Simulation domains, expand one `mouseMoved` request into a sequence of dispatches under the same ticket and input-recovery attempt chain; track last pointer position per tab. Replace fixed `humanControlInterval` values with jittered ones.
- Input recovery must treat the expanded sequence as one gesture: an interruption mid-path pauses with the last confirmed point and no replay.

### Step 4 enforces foreground input

- `apps/browser-extension/src/debugger/cdp-executor.ts`: before input on a Human Simulation domain, read `tab.active` and the window's `focused` flag through `chrome.tabs` and `chrome.windows`; refuse with `FOREGROUND_REQUIRED`. No new extension permission is needed.

### Step 5 detects verification pages and pauses

- New `apps/shared/protocol/src/verification-signatures.ts`: versioned URL, title and frame-URL signatures, merged with optional `verification_signatures` from `browser-rules.json`.
- Extension: report the matched signature with inventory and before each dispatch, using tab URL/title and `Page.getFrameTree` plus `DOM.getBoxModel` for visible frame size. No script injection.
- Broker: add pause cause `human_verification_required` across the scope chosen in decision 2, reuse the workspace pause tables, apply the grace period, and restrict the paused tab to screenshot, targeted DOM reads and `Page.bringToFront`. Extend `executeWorkspaceResume` with the `human_verification` acknowledgement and a fresh detection pass.
- Extension UI: red tab group colour and action badge while paused.

### Step 6 updates the contract, guidance and skills

- `apps/shared/protocol/src/mcp/tool-catalog.ts`: contract 8, new descriptions. `error-codes.ts`: four new codes. `domain/facts.ts` and `relay/v2-messages.ts`: new facts and capability 3. `websocket-client.ts`: advertise capability 3.
- `doc/03-User-Interface/MCP-Contract.schema.json` and validators.
- `integrations/*/skills` Tabro guidance: scroll-then-read, click navigation, foreground window, report unrecognized challenges.

## Verification

### Unit and integration tests cover policy, debt, motion and pause logic

- `tests/unit/browser-interaction-policy.test.ts`: evaluate admitted on every Human Simulation rule, forced `returnByValue`, refused Runtime methods.
- New unit tests for motion generation (path bounds, landing offset, jitter distribution with a fixed seed) and signature matching including hidden-frame exclusion.
- `tests/integration/octopus-broker.test.ts`: debt refusal and satisfaction, pacing wait, foreground refusal, verification pause scope, resume refused while challenge persists, resume after clearance, interruption mid-trajectory.

### Real-browser qualification proves behavior against fixtures and live pages

- Extend `tests/real-world/input-only-recovery.test.ts` with fixture pages that override `querySelectorAll`, define `Error.stack` getters and record `document.hidden` at input time. Expected evidence: no page-side record of evaluate, no input recorded while hidden.
- Isolated-world qualification: side-effect guard and DOM reads both work in the isolated world on current Chrome stable. The result decides the fallback constant.
- Fixture challenge pages for each initial signature, including a hidden resident captcha frame that must not trigger.
- Manual live check, run by the user on their own account: a Taobao search session reaches the result list, evaluate reads titles and prices, and a forced challenge (if one occurs) pauses with the correct diagnostic. No automated test targets live third-party sites.

### Release gates follow the existing native matrix

`pnpm verify` must pass. Native packaged qualification follows the existing Windows x64, macOS arm64/x64 and Linux x64 matrix from the domain input-only plan.
