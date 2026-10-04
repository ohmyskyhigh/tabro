# Profile proxy decision

**Status:** Accepted for implementation on 2026-10-03 by the user's instruction “执行吧”.

## Decision

### Profile-wide authenticated proxy support follows the reviewed implementation plan

Implement HTTP, HTTPS and SOCKS5 with username/password support, Broker-local forwarding, extension application, four MCP operations and protected credentials. The user subsequently required a closed Profile and restricted proxy configuration to MCP-managed Profiles (`ownership=broker`). This supersedes the initial idle-only, both-ownership scope. The [plan](../80-Plans/profile-proxy-2026-10-03/README.md) and [closed-Profile amendment](../80-Plans/profile-proxy-2026-10-03/closed-profile-amendment.md) supply delivery and verification details.

### Only closed broker-owned Profiles accept proxy configuration changes

Set and clear reject user-owned references, regardless of whether their extension is connected. Broker-owned Profiles must be closed; the Broker verifies actual Chrome process absence before committing. A saved change waits for the next explicit launch, which applies or clears the setting before automation becomes ready. Set and clear never automatically close or open a browser. Reading saved facts remains available; exit checks require an applied proxy on an open broker-owned Profile. The ownership wire value stays `broker`; the user's word “mcp” refers to that existing ownership.

### Capability negotiation preserves relay compatibility while MCP moves to version 5

The plan's proposed relay-version bump is replaced by an explicit optional `profileProxy: 1` capability on existing authenticated relay-2 registration. New messages are sent only to advertising extensions; old extensions retain ordinary automation when no proxy is configured. This is a transport detail within the approved feature scope. MCP's closed tool catalog advances to version 5 with twenty-two tools.
