# Prepare GitHub release

## Objective

Publish the current Tabro update as a new GitHub release.

## Changes

Inspected the working tree, release workflow, version metadata, and existing GitHub releases. Ran `git diff --check` and `pnpm verify`; the latter passed lint, type checking, tests, end-to-end tests, and the build.

## Result

Version 0.5.0 is prepared in the working tree, but the goal is not yet achieved. The update is uncommitted, and the repository instructions require an explicit instruction to commit before it can be pushed and released. GitHub's platform qualification must also pass before the release is published.
