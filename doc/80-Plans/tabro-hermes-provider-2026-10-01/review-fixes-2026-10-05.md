# Hermes review fixes

## Scope

### The October 5 review requests a relay Origin check and accurate installation behavior

The user authorized implementing [Teknium's review](https://github.com/NousResearch/hermes-agent/pull/132619#pullrequestreview-5410318729), updating the existing catalog PR and pushing Tabro to main. The [decision record](../../90-Proposals/hermes-review-fixes-2026-10-05.md) places these changes within existing extension registration and shared-runtime contracts.

## Delivery

### Version 0.4.2 will preserve Native Messaging while blocking web-page relay upgrades

1. Reject every present relay Origin except the exact Tabro extension origin before WebSocket upgrade; retain missing Origin for WinHTTP. Test rejected origins and successful automatic pairing for both allowed paths.
2. Disclose all Native Messaging registry targets and the temporary loopback browser debugging listener.
3. Forward `TABRO_INSTALL_ROOT` explicitly through the portable MCP environment, retain the default when Hermes leaves an unset placeholder, and qualify two named Hermes profiles through actual environment filtering at default and custom paths.
4. Build and re-stage the matching payload, validate its hashes and Hermes admission, push main, update the catalog SHA and reply to the review.
