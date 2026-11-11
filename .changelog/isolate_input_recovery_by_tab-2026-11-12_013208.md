# Isolate input recovery by tab

## Objective

Make input recovery block only its affected tab, allowing existing and newly created tabs in the same Chrome window to continue operating.

## Changes

Changed durable input state keys from window references to tab references. Migration 010 preserves existing held inputs, pending attempts, recovery references and ownership. Admission, dispatch, debugger detach, observations and failed-request recovery now use the target tab. Removed the window-wide input gate from tab and workspace creation.

Workspace stop, takeover and termination now handle only that workspace's tab states. Recovery acknowledgement selects a single tab by its current recovery reference and checks only that tab's uncertain effects. Tab context returns only its own recovery state; workspace-wide pause status is reserved for workspace controls. Updated MCP tool descriptions to explain the isolation.

Added tests for held, paused and uncertain input; new tabs and another session's workspace in the same window; independent recovery acknowledgement; unrelated workspace termination; migration and restart; and multi-tab ownership transfer. Extended real Chrome qualification to leave the original tab paused after a Broker crash, then click and type in newly created tabs in both the original and a separate workspace.

## Result

CI=1 pnpm verify passed lint, type checking, 321 tests, 2 end-to-end tests and the complete build, with 22 environment-gated tests skipped. The strengthened ownership and targeted recovery tests subsequently passed with type checking and lint. The previous package failed the new real-browser scenario at tab creation. The updated package passed all 3 native Chrome tests on macOS ARM64: input isolation/recovery, same-version extension upgrade and packaged installation/dashboard qualification. Real new tabs clicked and typed successfully in both workspaces while the original tab remained blocked with unchanged recovery facts and no injected cleanup/replay. Evidence: /tmp/tabro-tab-lock-after/darwin-arm64-input-only.json and artifacts/qualification/darwin-arm64-portable-installation.json. Windows/Linux and the Codex/Hermes application UIs were not requalified. The requested source change and local verification are complete. No commit, push, production installation update or acknowledgement of the user's existing recovery state was performed.
