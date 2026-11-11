# Background input and cached extension worker

## Objective

Identify and fix the causes of INPUT_RECOVERY_REQUIRED and INPUT_POLICY_UNSUPPORTED reported during the camera research chat.

## Changes

Confirmed that inventory handling treated an unchanged background window or inactive tab as a focus transition. Added a fresh inventory baseline before a new input gesture and compare subsequent focus, active tab, target identity and URL in the shared reconciliation path. Actual target changes, disconnects and uncertain input retain recovery protection. Improved the unsupported-policy message to describe the running extension rather than its on-disk version.

Read the live quietharbor extension worker through Chrome's debugger without changing the running profile. Its loaded script omitted browserInputPolicy in HELLO and had SHA-256 aef07c57c7e77cc36b8bc18b455acdc1923732c0afcb95060bdab5a79e68e490; the installed script advertised the capability and had SHA-256 0cbfec9d61ce8e5cb1d5ca93ad715250796c5c77b8ff3841815dde4dc91048ec. Reproduced the cache mismatch in an isolated Chrome profile: replacing worker bytes at the same URL and package version still ran the old worker after restart and loadUnpacked. Managed profile preparation now uses a worker filename derived from its content hash, retaining the extension ID and storage.

Added integration cases for background clicks and real focus, tab, target and navigation changes. Extended the real Chrome suite to publish unchanged inventory between a background mouse press and release, and to upgrade an existing profile from an unchanged worker URL while checking its preserved storage.

## Result

The old code failed the new background-input regressions and the old package reproduced the same pause in real Chrome. The same-version upgrade test failed before the launcher change and passed afterward. CI=1 pnpm verify passed lint, type checking, 317 tests, 2 end-to-end tests and the complete build; 22 environment-gated tests were skipped. A newly staged package passed all 3 native tests on macOS ARM64 with Chrome for Testing 157.0.8103.50: background/input recovery qualification, migration from the old worker URL with storage preserved, and packaged installation/dashboard qualification. Input evidence is at /tmp/tabro-root-cause-after/darwin-arm64-input-only.json; installer evidence is at artifacts/qualification/darwin-arm64-portable-installation.json. Lint, type checking and patch whitespace checks also passed after the final test changes. Root causes were reproduced and fixes verified locally. Windows/Linux and actual Codex/Hermes application UI flows were not requalified. No commit, push, production installation update or acknowledgement of the user's held-input state was performed.
