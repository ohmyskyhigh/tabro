# Hermes all-profile MCP registration plan

Status: completed on 2026-09-01 from the user's instruction to expose Octopus Browser Relay to all installed Hermes profiles.

Parent: [`Development plans`](../_MOC.md).

## Outcome

### One scripted handoff registers the same relay in every installed Hermes profile

Replace the unscoped default-profile command with a helper that discovers the default and named Hermes profiles, registers the compiled stdio adapter in each, and reports the profile set it changed.

## Work

### Runtime registration, installer generation, release staging, documentation, and verification change together

1. Register and verify the relay in every Hermes profile on the qualification device.
2. Add the reusable profile-discovery and registration helper.
3. Make source and release installers generate a command that invokes the helper.
4. Stage the helper in portable releases and include it in readiness validation.
5. Update the confirmed UX, System, Component, File, English, and Simplified Chinese installation guidance.
6. Run focused tests, typechecking, packaging checks, and per-profile Hermes discovery.
