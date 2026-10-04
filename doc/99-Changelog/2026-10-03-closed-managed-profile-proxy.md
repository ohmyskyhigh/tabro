# Closed managed Profile proxies

## Decision

### Proxy configuration now requires a closed broker-owned Profile

The user required changes only while a Profile is closed, then selected only MCP-managed Profiles. The existing ownership value is `broker`. This supersedes the initial both-ownership, idle-only proxy scope without renaming ownership values or changing ordinary user-owned workspace automation.

## Authority

### The Product-to-Files hierarchy now describes close, configure and reopen

Updated the accepted proxy decision, all six canonical layer owners and MOCs, the operational runbook and plan entry point. The workflow is close the managed Profile, save set/clear, then explicitly reopen to apply. User-owned proxy operations reject regardless of connectivity. No automatic restart or human-closure confirmation path remains.

## Evidence

### Process checks and isolated Chrome qualification enforce the restriction

The [closed-Profile amendment](../80-Plans/profile-proxy-2026-10-03/closed-profile-amendment.md) records source changes, automated checks, current physical evidence and deployment. Historical proxy transport results remain in the initial implementation report with an explicit supersession notice.
