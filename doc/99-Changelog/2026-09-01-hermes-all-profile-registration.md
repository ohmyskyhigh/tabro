# Hermes all-profile MCP registration

Applied: 2026-09-01.

## User Experience and System

### One generated command now registers every Hermes profile installed when it runs

The confirmed installation journey now covers the Hermes default profile and every installed named profile. Each isolated profile receives its own Octopus MCP entry and session-owned adapter configuration while reaching the same local broker. A profile created later is included when the command runs again.

## Components and Files

### A reusable helper replaces the unscoped default-profile command

`tools/register-hermes-profiles.ps1` discovers the installed profile set and applies the same adapter, broker URL, token-file reference, runtime label, and complete tool selection to each profile. Source and Release installers generate a configured invocation of that helper, release staging includes it, and setup readiness verifies both the invocation and helper contract.

## Evidence

### Automated and physical checks prove profile discovery and fourteen-tool exposure

The focused helper and readiness tests passed, the full non-E2E suite passed with 96 tests, lint and typechecking passed, source preflight reported `READY`, and release staging contained the helper. On the qualification device the helper registered four installed Hermes profiles; `hermes -p <profile> mcp test octopus-browser-relay` connected and discovered fourteen tools in each, and all four gateways were running after reload.
