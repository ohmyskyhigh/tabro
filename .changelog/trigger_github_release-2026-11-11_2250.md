# Trigger GitHub release

## Objective

Commit and push the prepared Tabro update and trigger the v0.5.0 GitHub release.

## Changes

Committed the update as `5512b45`, pushed `main` and the `v0.5.0` tag together, and inspected the release workflow results. Two unrelated local research changelogs were excluded from the commit.

## Result

The commit, push, and release trigger succeeded. The release has not been published: the Intel macOS source test timed out, the Apple Silicon macOS Chrome extension connection check timed out, and the Windows packaged installation check failed with an invalid path and closed connection. Linux qualification was still running at the last check. The release workflow requires all platform jobs to pass before publication.
