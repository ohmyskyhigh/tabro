# Chromium browser compatibility and Hermes host admission

## Decision

### The approved browser scope includes compatible Chromium derivatives

The user approved Chrome, Chromium and Chromium-based browsers such as Microsoft Edge, then authorized the implementation, PR update and review reply. The [decision record](../90-Proposals/chromium-browser-compatibility-2026-10-04.md) and [delivery plan](../80-Plans/tabro-hermes-provider-2026-10-01/browser-compatibility-2026-10-04.md) trace this change to Product and the downstream owners.

## Implementation

### Version 0.4.1 declares the selected browser and accepts compatible upgrades

The Hermes portable manifest declares `servers.tabro.app.win32`, using `%TABRO_BROWSER_PATH%` and the official `pe_resource` version source with `requires.app: true` and `min_version: 153.0.0.0`. The README explains selecting and persisting the browser path before installation. This avoids both a Chrome-only dependency and an unsupported alternatives schema. The upstream change remains one catalog file; no Hermes core override or schema change is needed.

Setup and standalone configuration share browser discovery, preserve the saved executable, and support `-BrowserPath` with the prior `-ChromePath` alias. An explicit invalid selection fails. Native Messaging registration includes Microsoft Edge. Managed launch checks the Chromium engine floor and required extension loading, with authentication and inventory still required for readiness. Process discovery includes derivatives, while PID, creation time, full executable path and exact data directory continue to guard control. The saved setup version no longer locks launch to one exact build.

## Verification

### Chrome and Edge passed isolated Native Messaging and proxy qualification

Windows 11 x64 qualification on 2026-10-04 used Chrome `153.0.8010.53` and Edge `154.0.4258.53`. Each completed fourteen checks through `tools/probe-profile-proxy.ts`: managed and user-owned Native Messaging connections; rejection of user-owned and open-Profile proxy changes; authenticated HTTP, HTTPS and SOCKS5 routing; authentication failure; active-workspace protection; reopen persistence; Broker outage and restart recovery; and closed-clear-open behavior. Proxy traffic used local fixtures and fixture credentials. Existing user browser data and normal Native Host registrations were preserved.

### Hermes admission rejects unavailable browsers before replacing the plugin tree

`tests/real-world/hermes-browser-gate-probe.py` loads the portable package through the installed Hermes and calls its actual installer refusal function. Nine checks passed: unset path, missing executable, both real browser PE versions, simulated older/minimum/newer PE versions, and declaration availability for Linux/macOS. The latter are schema checks on Windows, not native cross-platform runs.

The nine Windows installation checks passed with two isolated named Hermes profiles using the same Edge-configured runtime, actual Hermes plugin discovery, distinct MCP sessions, concurrent/repeated setup, disconnect independence, mismatch/tamper rejection, rollback, protected credentials and guarded stop. The final payload also passed the same nine checks with Chrome selected. `hermes plugins validate --install-deps` passed with Edge reported as available. The scanner reports `caution` for the disclosed Native Host binary and existing bundled-dependency patterns; no scan guard was disabled.

### Automated checks and qualification limits remain explicit

`pnpm verify` passed lint, typecheck, 257 tests, two simulated E2E tests and builds. The additional PowerShell browser-selection regression passed separately, including relative/drive-relative path rejection and saved-selection precedence; lint and typecheck passed after its addition. The rebuilt Hermes runtime contains 53 hashed payload files.

Hermes qualification used source `c2606ad109f5f169ed1fc611c494a41089095aeb`. This does not qualify every Chromium derivative, browser release, fresh VM, ARM64 host or operating system. The package remains Windows x64. Catalog admission and code-owner approval remain Hermes maintainer actions. The pre-existing core consent-summary wording for dynamically discovered MCP tools is outside this catalog-only change.
