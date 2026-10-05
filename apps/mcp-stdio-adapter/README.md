# Tabro stdio MCP adapter

For installation and client configuration, start with [Getting started](../../GETTING_STARTED.md#other-agents).

## Purpose

### One adapter process gives one Codex or Hermes session private caller evidence

The adapter publishes the canonical twenty-two Tabro tools over stdio and forwards every call to the loopback HTTP broker. It injects runtime and session headers outside tool arguments, so the agent never generates or sees caller identity fields. It requires MCP contract v5, checks Broker health before connecting and sends the contract version header.

### Runtime session evidence prefers host IDs and otherwise lasts for one process

Session lookup prefers `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `HERMES_SESSION_ID`, and `HERMES_AGENT_SESSION_ID`, in that order. `TABRO_RUNTIME_SESSION` is an explicit fallback. If none exists, the adapter creates a random value once at startup and retains it for that process lifetime. Parent-session equivalents are forwarded when present.

## Configuration

### Runtime-file discovery selects the shared Broker while credentials remain separate

- `TABRO_RUNTIME_FILE` points to the shared runtime record and takes precedence over a fixed URL. Source installations use `.relay-data/runtime.json`; installed packages use their data directory.
- Without `TABRO_RUNTIME_FILE`, `TABRO_BROKER_URL` retains the legacy fallback `http://127.0.0.1:7331/mcp`. That fallback is not the dynamic Broker default; use discovery for current installations.
- `TABRO_TOKEN_FILE` points to the installer's local token file.
- `TABRO_TOKEN` or `TABRO_AGENT_TOKEN` can supply the same token directly instead.
- `TABRO_RUNTIME` can force the runtime label to `codex`, `hermes`, or another safe local name.

The token file wins when both forms exist, preventing an inherited stale token from overriding the installed broker credential. The token and session evidence are transport configuration. They are not MCP tool inputs.

### Legacy environment names continue to connect existing installations

The pre-existing URL, token, runtime/session, adapter-version and Demo-trace settings also accept their corresponding `OCTOPUS_*` names; the new `TABRO_RUNTIME_FILE` setting has no legacy alias; `TABRO_TOKEN` and `TABRO_TOKEN_FILE` correspond to `OCTOPUS_BROWSER_RELAY_TOKEN` and `OCTOPUS_BROWSER_RELAY_TOKEN_FILE`. A nonempty Tabro value wins over the legacy value for the same setting. Runtime-provided session IDs still precede either explicit fallback. Native Messaging identity, extension identity, wire headers, and profile storage remain unchanged.

## Reconnection

### A changed Broker instance reconnects before a new tool call without replaying prior work

The adapter validates the discovery record, loopback addresses and process liveness. It then requires matching MCP contract version and health instance UUID before connection. Each new tool call rereads discovery; an instance change reconnects the HTTP client while preserving the adapter's caller identity. Invalid or missing configured discovery fails rather than falling back to a fixed URL. A call already dispatched is never automatically retried.

The discovery format's version `1` is independent of MCP contract version `5`, relay version `2`, and the package version. The runtime file contains no bearer credential.

## Delivery boundary

### Ticket acknowledgement remains ordered but cannot be atomic across both transports

The HTTP broker dispatches an accepted ticket only after its response is handed to the adapter. The adapter then writes that response to the agent runtime over stdio. MCP provides no transaction spanning both transports, so an adapter crash in the narrow interval between those two handoffs can leave dispatched work whose ticket was not received by the agent. Normal delivery keeps ticket-before-dispatch ordering at the broker boundary, and the adapter never invents or replaces a `request_ref`.

### One adapter process is the isolation boundary when a host exposes no session ID

If Codex or Hermes launches one stdio server process per agent session, the random fallback separates sessions that share one bearer token. A host that deliberately reuses one adapter process across multiple otherwise-unidentified sessions also reuses that caller identity; it must supply a supported session environment variable or launch separate processes.
