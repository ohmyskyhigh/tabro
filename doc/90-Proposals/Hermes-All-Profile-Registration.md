# Hermes all-profile registration proposal

Status: accepted by the user's explicit 2026-09-01 instruction and incorporated downward from User Experience through Files.

Parent: [`Vault proposals`](./_MOC.md).

## User Experience change

### Running the Hermes registration script covers every profile installed at that time

The setup actor runs one generated command. Octopus registers separately in the default Hermes profile and every installed named profile because Hermes keeps isolated MCP configuration per profile. A profile created later joins the set when the same command runs again.

## System and implementation consequence

### Profile isolation remains intact while every adapter reaches the same broker

Each Hermes profile stores its own MCP entry and launches its own session-owned stdio adapter. The helper discovers installed profiles, invokes the Hermes MCP registration command for each profile, enables the complete fourteen-tool surface, and reports the profiles registered. The broker, MCP schema, session evidence, workspace ownership, and browser-endpoint routing contracts do not change.
