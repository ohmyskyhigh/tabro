# User Interface MOC

Authority level: User Interface.

For this vault, User Interface is the runtime-independent, agent-facing MCP contract rather than a graphical interface. It owns exact tool names and modes, model-authored inputs, returned envelopes, public facts, problems, request tickets, event cursors, available actions, and machine-readable schemas.

Status: confirmed as wire-contract version `2` and ready for System realization. Numeric limits and runtime adapters remain evidence-tunable only where the contract advertises the active value and preserves the same public semantics.

## Canonical contract

### Fourteen tools expose ten submissions, three reads, and one terminal close

[`MCP-Contract.md`](./MCP-Contract.md) defines:

- ten asynchronous submissions: `request_browser_workspace`, `create_browser_tab`, `send_cdp_command`, `take_over_workspace`, `terminate_workspace`, `resolve_browser_request`, `stop_workspace_automation`, `resume_workspace_automation`, `kill_browser_endpoint`, and `resume_browser_endpoint`;
- three immediate reads: `get_browser_context`, `read_cdp_events`, and `get_browser_request`; and
- one immediate terminal-ticket control: `close_browser_request`.

### One Draft 2020-12 bundle defines every public body

[`MCP-Contract.schema.json`](./MCP-Contract.schema.json) is the exact closed schema bundle for the fourteen input roots, fourteen output roots, common facts, request tickets, problems, raw CDP results, pause and recovery facts, pagination, and executable available actions.

The broker issues every Tabro reference and cursor. Caller identity is injected outside model-authored inputs. Agents only echo returned references and browser-issued CDP handles accepted by a supported method.

## Compatibility

### Real runtimes validate the contract without becoming its design authority

Codex and Hermes must prove equivalent schema loading, caller-context injection, acknowledgement delivery, ticket polling, managed-tab targeting, recovery, and structured results. Chrome and AdsPower fixtures must prove extension-backed CDP behavior.

Test evidence may tune advertised numeric limits, polling guidance, implementation backpressure, and adapter workarounds. Any change to a public tool, required field, discriminator, reference, lifecycle, authority rule, or recovery meaning requires a new proposal and contract version.

The accepted historical proposal remains at [`../90-Proposals/User-Interface-MCP-Contract.md`](../90-Proposals/User-Interface-MCP-Contract.md).

Parent: [`02-User-Experience`](../02-User-Experience/_MOC.md).
