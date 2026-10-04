# Missing workspace retirement

## Correction

### Stale workspace records blocked authorized Profile closure

Hermes stop requests for `mapleglen` and `fairwave` passed Profile lifecycle authorization but failed with `PROFILE_HAS_ACTIVE_WORK`. Six old workspaces remained active and paused after their browser groups had disappeared. Their old session ownership made manual termination unavailable to the current agents.

## Behavior

### Current inventory ends missing idle workspaces without transferring ownership

Broker reconciliation now retires a missing workspace only with fresh connected inventory, no surviving tracked active tabs, no unreadable active-tab locator, and no unfinished workspace request, acquisition or endpoint control. Retirement atomically fences the control epoch, ends the workspace, closes missing tab records, clears pause causes and records an audit event. Live work and unresolved effects retain their protections. Active-work errors now explain that lifecycle authorization passed and browser work is blocking closure.

## Evidence

### Automated checks and real MCP closure verify the correction

Typecheck, lint, build, 209 tests and two E2E tests passed. The unchanged locked native companion was retained after fresh temporary compilation succeeded. The local Broker was backed up and restarted. Its inventory reconciliation ended all six affected records; MCP then reported no paused automation on either Profile. Both normal stop tickets succeeded with stopped browsers and no problem code. See `artifacts/profile-close-repair-20261003.json` and the [implementation plan](../80-Plans/missing-workspace-retirement-2026-10-03/README.md).
