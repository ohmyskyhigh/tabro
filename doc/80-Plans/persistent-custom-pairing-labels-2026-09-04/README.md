# Persistent custom pairing labels

## Scope

### A saved pairing code must remain authoritative across browser restarts

Make the profile-local pairing code editable while preserving automatic generation for new installations. Derive the public endpoint alias from the saved code on every connection, retain the same cryptographic profile identity, and require authenticated proof before the broker renames an existing endpoint.

### Naming conflicts must remain visible until the operator resolves them

Stop replacing a requested label automatically. Return a specific conflict to the extension, preserve the saved code, and ask the operator to choose another two-word code.

## Implementation

### Extension, gateway, and storage changes must preserve one atomic identity contract

Update the extension identity store and options page, carry the requested alias through relay-v2 authentication, and atomically synchronize the legacy target alias with the canonical browser-endpoint nickname.

## Verification

### Automated checks cover persistence, authenticated renaming, and collisions

Add pure extension identity tests, options-page contract coverage, gateway authentication coverage, and SQLite rename rollback coverage. Run the repository verification pipeline and rebuild the unpacked extension before handoff.
