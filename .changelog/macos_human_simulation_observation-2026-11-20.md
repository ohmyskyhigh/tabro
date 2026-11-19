## Objective

Qualify Tabro 0.7.0 and MCP contract 8 on the local Mac and fix compatibility issues found during the run.

## Changes

- Read verification observations from the real Chrome extension's `rawResult`, preserve detections between probes, and keep automation paused if a required recheck cannot be completed.
- Update the dashboard expectations for normalized rules and repair the Chrome qualification checks for tab focus, verification state, and installer reconnects.
- Align Getting Started with contract 8.

## Result

The macOS Apple Silicon qualification passed. `pnpm verify` passed, and the packaged installer passed all 19 installation, upgrade, dashboard, and Native Messaging checks with Chrome. The native Chrome 157 suite passed concurrent session isolation, screenshots, guarded observations, activity requirements, verification pause and recheck, stop protection, and crash recovery. The Mac was locked during the final input run, so the suite used the native Chrome binary in headless mode. The verification challenge was a test fixture. The prior test installation data was preserved before the upgrade checks.
