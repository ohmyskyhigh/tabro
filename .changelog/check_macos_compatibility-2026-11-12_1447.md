# Check macOS compatibility after Windows qualification

## Objective

Check the Windows-qualified main commit `8ca365802fbf2caf5f8bb7f01492d7e3189b30ae` on the native macOS host and distinguish local compatibility from release CI status.

## Changes

Fast-forwarded the checkout from `7afe34f` to `8ca3658`; no application, test, workflow or version files were edited. Reviewed the intervening changes: new runtime behavior is guarded by Windows platform checks, while installer qualification adds lifecycle deadlines, configuration preservation assertions and failure diagnostics. Built and archived the ARM64 package, verified all 57 runtime manifest hashes, and tested its extracted bytes in isolated Chrome profiles on this host. Evidence is in `artifacts/qualification/macos-compat-8ca3658/`, including verification logs, native installation/input reports, Chrome for Testing results and CI failure reports.

## Result

Local macOS ARM64 qualification passed on macOS 26.4.1, Node 22.22.2, pnpm 11.19.0 and Chrome 157.0.8103.50. `pnpm verify` passed lint, type checking, 321 tests (23 environment-gated tests skipped), 2 end-to-end tests and the complete build. Native qualification passed all 4 tests: Keychain credentials, packaged installation/dashboard/Native Messaging/managed Chrome/restart, tab-scoped input recovery and same-version worker updates. The input-recovery and worker-update tests also passed with CI's Chrome for Testing 157.0.8103.50. The paused tab retained its recovery state while new tabs in the same and another workspace remained operable, without automatic release or replay.

The archive SHA-256 is `e8074b95c6e3e758d728a3b0e15a9c5d7c8e5c9177e171fa411ca27444dde55f`. Both local qualification reports identify runtime manifest SHA-256 `d953bd86b65776991e336b8d274deab1d4bd3c953dffa7fd401b056798e2295c`. Tracked source and index matched the exact commit during testing; the input report's `sourceHasLocalChanges: true` includes three pre-existing unrelated untracked changelog files.

GitHub Actions run `43167213798` remains failed overall. macOS ARM64 job `131011772073` passed source verification, packaging, installation/dashboard/Keychain and same-version worker update, but the input fixture timed out after 25 seconds waiting for a ready extension. Its failure report records `connectionStatus: connecting`, no transport kind and no last error; that timeout was not reproduced locally and its root cause is not established. macOS Intel job `131011772303` passed its 321 source tests but failed the multi-agent end-to-end profile-readiness assertion at line 69; packaging and native qualification were consequently skipped. Native Intel compatibility and macOS 15 CI stability remain unqualified. Local compatibility checking is complete; this does not establish release readiness. No source fix, commit, push, release or production installation update was performed.
