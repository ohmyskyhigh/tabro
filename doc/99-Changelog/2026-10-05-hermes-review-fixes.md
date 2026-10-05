# Hermes review fixes

## Decision

### The user approved Teknium's relay and installation corrections

The [October 5 decision](../90-Proposals/hermes-review-fixes-2026-10-05.md) and [delivery plan](../80-Plans/tabro-hermes-provider-2026-10-01/review-fixes-2026-10-05.md) trace these changes to [Hermes PR #132619's review](https://github.com/NousResearch/hermes-agent/pull/132619#pullrequestreview-5410318729). System, Components and Files now describe the relay Origin boundary and the actual Hermes launch-environment probe. Product, UX and the MCP contract remain unchanged.

## Implementation

### Version 0.4.2 blocks web-page relay upgrades before automatic pairing

The Extension Gateway rejects a present Origin unless it exactly matches `chrome-extension://caekiojlchhifdomfghejkbfpmaklafe`. Missing Origin remains accepted for the WinHTTP Native Host. Rejections return HTTP 403 before WebSocket upgrade, increment rejection diagnostics, and never reach automatic pairing. Existing path, Host and relay identity checks remain in force. The browser-origin check does not authenticate arbitrary local processes.

### Custom install roots now reach the MCP subprocess through an explicit declaration

`mcp.json` forwards `TABRO_INSTALL_ROOT`. `common.ps1` treats Hermes's literal unresolved placeholder as unset and falls back to `%LOCALAPPDATA%\Tabro`; explicit invalid paths still fail. The installation probe applies Hermes's actual interpolation and filtered stdio launch environment, without restoring the parent environment afterward. It checks that an unrelated private sentinel is absent. Both named profiles use the same absolute custom path, including spaces and non-ASCII text.

### The README discloses every registry target and the live debugging listener

The existing HKCU Native Messaging targets are Chrome, Edge, Chromium and AdsPower SunBrowser. Broker-owned browsers expose a random loopback remote-debugging port and run with `--enable-unsafe-extension-debugging` while open. The plugin README and skill describe custom-root forwarding; README also describes the relay admission boundary.

## Verification

### Automated checks cover rejection and both supported relay paths

`pnpm verify` passed lint, typecheck, 268 tests, two simulated E2E tests and builds. The gateway suite includes eight rejected-Origin cases: website, loopback page, opaque `null`, empty, another extension, misleading extension suffix, trailing slash and duplicate headers. Two positive tests complete automatic pairing with the exact extension Origin and no Origin. Website-origin upgrades reproduced the reported defect before the fix.

### Real Hermes launch environments share one daemon at default and custom paths

Nine installation checks passed at each root mode with two isolated named Hermes profiles. Checks cover real plugin discovery, environment interpolation and filtering, distinct MCP sessions and all 22 tools, concurrent/repeated setup, disconnect independence, version/tamper rejection, rollback, DPAPI fixture credentials and guarded shutdown. The default-root run exercises the unresolved-placeholder fallback. Existing user configuration and normal Native Host registrations are untouched by this suite.

All fourteen live Edge checks passed: Native Messaging pairing for broker-owned and user-owned profiles, authenticated HTTP/HTTPS/SOCKS5 routing, proxy eligibility and workspace guards, authentication failure, reopen persistence, Broker outage/restart recovery and closed-clear-open behavior. They use isolated browser data and local proxy fixtures without customer credentials.

### The re-staged payload matches source and passes Hermes validation

The 0.4.2 runtime contains 53 hashed files. All payload hashes and 69 source/native/lockfile fingerprints matched. `hermes plugins validate --install-deps` passed with Edge available; the enabled scanner still reports `caution` for the disclosed Native Host binary and pre-existing bundled-dependency patterns. No validation guard was disabled.

Qualification used Windows 11 x64, Edge `154.0.4258.53` and Hermes source `c2606ad109f5f169ed1fc611c494a41089095aeb`. This delta does not requalify Chrome, every Chromium derivative, fresh VMs, ARM64 or other operating systems. Previous Chrome/browser-gate evidence remains in the [0.4.1 record](./2026-10-04-chromium-browser-compatibility.md). Catalog admission remains a Hermes maintainer action.
