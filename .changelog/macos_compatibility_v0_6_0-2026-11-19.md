## Objective

Verify Tabro v0.6.0 and its new functionality on macOS, fix compatibility problems, and prepare the changes for Windows testing.

## Changes

- Preserved the old installation and a separate backup; stopped its verified Broker and managed Chrome without deleting the retained workspace state.
- Provisioned a new local test installation and qualified the packaged runtime with real Chrome on Apple Silicon.
- Corrected dashboard qualification expectations for legacy rules normalized to Human Simulation Mode, and made the pacing test less sensitive to runner scheduling.
- Added real-Chrome checks for same-chat concurrent allocation, adapter restart and cross-runtime isolation, screenshots, and stopping queued input.
- Adjusted the Claude Code skill to expand its adapter path in a nested Bash process after the session environment is loaded.
- Exercised Codex's current thread identity, Claude Code's SessionStart hook, and the DSH native tool against the new Broker; Claude Code and DSH used local simulated model responses.

## Result

The packaged macOS installation, real-Chrome qualification, session isolation, screenshot, stop and recovery checks passed. The final full source verification passed: 332 automated tests, 11 migration tests and 2 simulated end-to-end tests passed; 26 environment-dependent tests were skipped. The gated real-Chrome qualification also passed. GitHub qualification of the original commit failed the old-rule assertion; the corrected version still requires Windows compatibility testing.
