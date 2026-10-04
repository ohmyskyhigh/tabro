# Extension Profile ownership

## Decision

### The October 3 user clarification approves one extension registry with two launch ownerships

Accepted from the user's direct instruction: every extension that establishes a connection is managed by the Broker MCP and available to agents. Browsers MCP can open have `ownership=broker`; browsers the user must open before connection have `ownership=user`. This supersedes discovery restricted to Profiles created by one MCP principal. It does not transfer another agent's workspace or ticket authority.

## Contract

### Ownership controls browser launch while extension connection enables automation for both values

All authenticated agents discover registered Profiles and their nicknames in one list. Previously connected offline Profiles retain their identity. Only broker-owned resources support MCP create/open/stop, subject to current lifecycle scopes and active-work fences; user-owned browsers become usable after the human opens Chrome. Browser windows report the launch ownership of their Profile, independently of who created an individual window.

Required ownership fields and shared discovery are published as MCP contract version 3. Relay protocol version 2 is unchanged. No historical pairing or browser data is reset.

Implementation and verification are tracked in [the plan](../80-Plans/extension-profile-ownership-2026-10-03/README.md).
