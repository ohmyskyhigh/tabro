# Octopus Browser Relay implementation plan

Status: historical implementation and qualification plan. The original fourteen-tool scope below is preserved; the current eighteen-tool contract and later runtime changes are routed from [the vault entry](../../TOP-DOWN-MOC.md). Unchecked tasks remain unverified rather than being retroactively marked complete.

This plan migrates the existing profile-aware relay into the canonical fourteen-tool, ticket-first, extension-backed CDP architecture. It preserves the working pairing and relay mechanics while replacing the old target-binding/session/custom-operation model.

## Outcome

### Codex and Hermes can control multiple separately paired browser profiles through one broker

The delivered system must let both runtimes:

1. inspect bounded endpoint and window context;
2. request an exact number of distinct-profile workspaces;
3. receive a broker-issued workspace, tab, and event cursor for each;
4. submit a raw extension-supported CDP command and receive `request_ref` before dispatch;
5. poll the ticket to terminal result;
6. read retained raw CDP events;
7. execute workspace, endpoint, takeover, recovery, and termination controls; and
8. recover coherently from extension and broker restart.

No agent composes an Octopus identifier or receives a raw Chrome routing identifier.

## Authority

### The plan implements the confirmed vault from top to bottom

- Product: [`../../01-Product/Product-Definition.md`](../../01-Product/Product-Definition.md)
- User Experience: [`../../02-User-Experience/User-Experience-Definition.md`](../../02-User-Experience/User-Experience-Definition.md) and [`Operational-Defaults.md`](../../02-User-Experience/Operational-Defaults.md)
- User Interface: [`../../03-User-Interface/MCP-Contract.md`](../../03-User-Interface/MCP-Contract.md) and its [`schema`](../../03-User-Interface/MCP-Contract.schema.json)
- System: [`../../04-System/System-Architecture.md`](../../04-System/System-Architecture.md)
- Components: [`../../05-Components/Component-Architecture.md`](../../05-Components/Component-Architecture.md)
- Files: [`../../06-Files/Repository-Map.md`](../../06-Files/Repository-Map.md)

The preserved 2026-08-27 plan and current implementation are evidence and migration inputs, not target authority.

## Strategy

### A thin vertical slice replaces the old public API before advanced controls are added

The first working slice is:

```text
get_browser_context
  -> request_browser_workspace
    -> create_browser_tab
      -> send_cdp_command Runtime.evaluate
        -> get_browser_request
          -> read_cdp_events
```

It must run through the real broker, store, extension gateway, extension, `chrome.debugger`, and one Chrome or AdsPower profile. This prevents months of isolated state-machine work before proving the actual extension-backed transport.

### Compatibility shims do not leak the old target API into the new contract

Old binding, lease, session-handle, target, `runId`, `idempotencyKey`, `tabId`, and custom-operation paths may remain temporarily behind tests while the vertical slice lands. They must not appear in the canonical fourteen-tool MCP catalog.

Once equivalent pairing and real-world setup are proven, obsolete public tools and runtime paths are removed in a dedicated migration group.

## Delivery groups

### Eleven groups progress from contracts to real-world qualification

1. Freeze and materialize the MCP and relay contracts.
2. Add canonical SQLite records and repository transactions.
3. Implement broker identity, context, workspace, and tab truth.
4. Implement tickets, acknowledgement gating, tab lanes, and workers.
5. Upgrade extension transport and browser inventory reconciliation.
6. Implement `chrome.debugger` command and event flow.
7. Complete the vertical-slice MCP tools and runtime adapters.
8. Add recovery, human resolution, controls, takeover, and termination.
9. Add restart, retention, status, logs, and bounded-load behavior.
10. Replace installation and runtime registration flows.
11. Qualify Codex, Hermes, Chrome, AdsPower, concurrency, faults, and soak.

Each group has its own automated gate. A group is not complete when files merely compile.

## Documents

### Technical and task documents keep architecture separate from execution order

- [`technical-architecture.md`](./technical-architecture.md) maps the migration, data model, ports, and test topology.
- [`implementation-tasks.md`](./implementation-tasks.md) names exact edits, checks, gates, and human-assisted real-browser steps.

## Completion

### Release qualification requires executable and human-observed evidence

The plan completes only when:

- `pnpm lint`, `pnpm typecheck`, contract, unit, integration, fault, and end-to-end suites pass;
- the extension builds and its manifest contract passes;
- the native host builds or reports the precise missing Windows prerequisite;
- Codex and Hermes each complete the same MCP scenario;
- at least one normal Chrome profile and two AdsPower profiles are separately paired;
- concurrent sessions prove independent workspaces and full-cycle same-tab FIFO;
- physical close, reopen, debugger detach, broker restart, stop, kill, takeover, and termination scenarios produce the expected tickets and logs; and
- the qualification report records versions, traces, failures, accepted tuning changes, and unresolved environmental limitations.

Parent: [`Development plans`](../_MOC.md).
