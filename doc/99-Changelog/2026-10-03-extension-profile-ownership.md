# Extension registration and launch ownership

## Authority

### The user's October 3 decision replaces principal-filtered Profile discovery

The [accepted clarification](../90-Proposals/Extension-Profile-Ownership.md) defines all connected extensions as Broker-managed browser capacity. `broker` and `user` describe launch ownership, while workspace and request authority remain separately enforced.

## Changes

### Extension identities now drive Profile discovery and expose launch ownership

Product, UX and the downstream contract now specify one registered-Profile list, including identities retained while offline. MCP contract version 3 adds ownership to Profile, endpoint and window facts. Launch metadata enriches the extension registry without creating another registration step. Unconnected creation reservations remain accessible through lifecycle tickets and same-key retries.

### Broker-owned launch resources are shared without transferring other agents' work

Authorized lifecycle callers can reopen Broker resources created by another principal. Request read/close authority, workspace ownership, active-work stop checks and process verification remain enforced. User-owned Chrome has an explicit lifecycle rejection and uses the same workspace and CDP path after connection.

Verification is recorded with the [implementation plan](../80-Plans/extension-profile-ownership-2026-10-03/README.md).
