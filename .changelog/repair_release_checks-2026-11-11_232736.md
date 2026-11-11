# Repair release checks

## Objective

Fix the failing v0.5.0 release checks and publish the release.

## Changes

Retried the failed release jobs and inspected their logs. Set Windows setup output to UTF-8 and added a Unicode installation-path assertion, constrained CI test concurrency, raised the runtime-discovery test timeout, bounded Linux package-manager retries, and added Chrome and extension diagnostics to the packaged installation test. Ran the full verification suite with CI settings and the packaged macOS Apple Silicon browser and dashboard test.

## Result

Local verification passed, including 308 non-E2E tests, two E2E tests, the build, and the packaged macOS browser test; 21 environment-gated tests were skipped by the ordinary suite. The retried Windows and macOS jobs failed on the original commit, and the Linux job remained blocked by Ubuntu mirror DNS. The new changes are uncommitted and have not run on GitHub. The Apple Silicon runner's connection failure still needs the new diagnostics; v0.5.0 has not been published. The repository's no-commit and no-follow-up-commits rules require a new explicit commit instruction before these changes can be pushed.
