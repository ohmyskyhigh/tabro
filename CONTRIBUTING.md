# Contributing to Tabro

Thanks for helping agents automate several local browser profiles through one brokered MCP contract.

## Before opening a change

### Contract changes begin at the canonical owner

Read the [top-down knowledge map](./doc/TOP-DOWN-MOC.md) and [vault editing rules](./doc/AGENTS.md) before changing behavior. Product, User Experience, User Interface, System, Components, and Files have separate owners. A code change cannot silently redefine a higher-level contract.

Open a proposal before changing MCP tool names or schemas, broker-issued identity, ownership, ticket-before-dispatch ordering, same-tab scheduling, extension capability admission, recovery, takeover, stop/kill behavior, termination, Native Messaging scope, or listener scope.

### Public reports exclude local credentials and browser-private evidence

Do not include bearer tokens, pairing codes, private browser identifiers, browser-profile paths, public-key material, `.relay-data` contents, SQLite databases, or physical-test credentials in an issue, pull request, log excerpt, or screenshot.

## Development workflow

### The local gate checks source, contracts, tests, and distributable artifacts

Requirements and installation are documented in [README.md](./README.md).

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` includes the Windows native build. Run the narrower checks separately when developing without the native C++ toolchain:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build:extension
```

Keep pull requests focused. Add or update tests for every changed observable behavior, and update [the repository map](./doc/06-Files/Repository-Map.md) when responsibilities or verification paths move.

### Physical browser behavior follows the checked-in runbook

Use the [real-world runbook](./doc/06-Files/Real-World-Runbook.md) for changes that affect Chrome, AdsPower, Native Messaging, pairing, Codex, Hermes, reconnect, or multi-profile behavior. Record what was actually exercised; do not turn a simulated or direct-WebSocket result into Native Messaging or physical-browser evidence.

## Architectural invariants

### Public browser work uses broker-issued workspaces, tabs, tickets, and cursors

- MCP caller identity comes from authentication and transport evidence, not model-authored identifiers.
- The broker owns logical identity, ownership, routing, status, request state, ordering, recovery, control state, and logs.
- Each profile-local extension reports browser facts and executes admitted commands; it does not select the calling agent or workspace owner.
- Agent-facing results do not expose raw Chrome profile, extension, window, tab, socket, connection-generation, or debugger-attachment identifiers.
- Every asynchronous tool commits and returns its `request_ref` before browser dispatch becomes eligible.
- Commands accepted for one managed tab complete full request cycles in ticket-acceptance order.
- A raw CDP effect that cannot be proven after disconnect or restart pauses for explicit resolution instead of being silently replayed.
- Installed Chrome and AdsPower profiles use Native Messaging; direct extension WebSocket is diagnostic transport.

## License

By contributing, you agree that your contribution is licensed under the repository's [MIT License](./LICENSE).
