# Missing workspace retirement

## Problem

### Missing idle workspaces keep broker-owned Profiles from closing

The user reported that Hermes could not close `mapleglen` and `fairwave`. Stored stop tickets show `PROFILE_HAS_ACTIVE_WORK`, after lifecycle authorization passed. Each endpoint retains three September 30 workspaces whose browser groups are absent. Their old session ownership prevents the current agents from terminating those records.

## Implementation

### Fresh inventory can retire missing workspaces after all pending work is resolved

Implement the existing Product requirement that missing browser workspaces end. Retire only when a current connected inventory proves the group and every tracked tab absent, there are no unfinished requests for that workspace, no active endpoint control and no workspace acquisition in progress. Commit lifecycle, tab state, pause cleanup and audit atomically without taking ownership or mutating Chrome. Keep real workspaces and unresolved effects protected. Then verify normal MCP closure of the two affected Profiles.

## Verification

### Both affected Profiles close successfully after their six missing workspaces end

Completed October 3. Typecheck, lint, build, 209 tests and two E2E tests passed. After a consistent database backup and Broker restart, fresh extension inventory ended all six affected workspaces. MCP reported both Profiles ready with no paused automation before closure. Both `stop_browser_profile` requests then succeeded and returned `browser_state=stopped`, `extension_state=disconnected` and no problem. Evidence is saved in `artifacts/profile-close-repair-20261003.json`.
