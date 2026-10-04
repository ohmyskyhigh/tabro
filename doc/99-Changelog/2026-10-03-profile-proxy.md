# Profile proxy support

This records the initial delivery. Its both-ownership and idle-only scope is superseded by [closed managed Profile proxies](./2026-10-03-closed-managed-profile-proxy.md).

## Decision

### The approved proxy feature applies to both launch ownerships

The user selected authenticated HTTP(S) and SOCKS5 and approved execution on 2026-10-03. [The accepted decision](../90-Proposals/Profile-Proxy.md) establishes Profile-wide regular-browser routing, protected credentials, idle-only changes and separate saved/applied/observed facts.

## Authority

### The source of truth now traces proxy behavior from Product through Files

Updated Product definition, User Experience definition, MCP contract and schema, System architecture, Component architecture, Repository map and their MOCs. MCP contract advances to 5 with twenty-two tools. Relay remains 2 with an optional extension capability. The operational runbook documents local provisioning and rollout.

## Evidence

### Automated and real-browser qualification support the delivered implementation

The [implementation report](../80-Plans/profile-proxy-2026-10-03/implementation-report.md) records test commands, isolated Chrome evidence, deployment facts, draft adjustments and supported boundaries. No production account proxy was enabled during qualification.
