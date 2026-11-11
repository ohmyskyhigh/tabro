# Tabro installer review

## Objective

Provide the same existing Tabro experience on Windows, macOS, and Linux in one release, with host-based installation and Chrome pairing instructions.

## Changes

- Updated [AGENTS.md](../AGENTS.md) with the host-only installation rule, the Chrome extension steps, and the end-to-end verification requirement.
- Added a macOS and Linux installer with the shared Broker, MCP adapter, extension, Native Messaging relay, and managed profile lifecycle. Proxy credentials use Keychain on macOS and Secret Service on Linux.
- Added a stable Windows extension path and a stdio MCP handoff to its installer. The release workflow stages each platform package, verifies its archive against Chrome, and publishes the qualified assets together.
- Updated [Getting Started](../GETTING_STARTED.md) with the platform entry points and shared Chrome walkthrough.
- Added a copyable agent setup prompt at the top of the [README](../README.md).
- Reconciled the canonical platform scope, operator guidance, translated MCP catalog, historical release pin, and updater reload action. Standalone manifests use the runtime's MCP and browser compatibility values, and macOS and Linux share one discovery record.
- Matched the schema bundle ID and tool-count metadata to MCP v5. Updated the WebSocket and stdio test fixtures to track and shut down their own resources reliably.
- Recorded the Hermes catalog delisting and pointed installation instructions to the pinned Windows preview while relisting is pending.
- Prepared `0.5.0` with one release for all supported targets. The Windows release workflow publishes and attests the standalone archive's Native Host, and the staged Hermes package verifies that same versioned asset at setup. Added release checks for clean Hermes setup, tampered downloads, reuse and the `0.4.2` upgrade. Added host-only setup and Chrome extension steps to the Hermes browser skill.
- Installed the checksum-verified `0.5.0` Apple Silicon archive on the desktop host on 2026-11-10 and registered its stdio launcher in Codex. Created a separate managed Chrome profile for the walkthrough.

## Result

The `0.5.0` Apple Silicon macOS archive passed existing and managed profile pairing, workspace CDP, managed stop and reopen, authenticated proxy traffic using Keychain, and Broker restart on 2026-11-06. The source gate passed. A local staging fixture verified identical manifest bytes, omission of the catalog executable and rejection of modified companion bytes. Windows x64, Intel macOS, and Linux x64 require native runner qualification before publication. The final Hermes payload and catalog pin depend on the qualified public Windows asset and a real Hermes validation run.

The installed desktop runtime exposed all twenty-two MCP tools. Chrome 157 connected the managed profile through Native Messaging. An MCP workspace navigated to a local test page and read back its title, and the page remained open for inspection.
