# Tabro

[English](./README.md) | [简体中文](./README.zh-CN.md) | [中文文档](./doc/zh-CN/README.md)

Open-source Chromium browser automation for AI agents: one shared Broker, separate task workspaces, and per-profile proxies through MCP.

**[Get started →](./GETTING_STARTED.md)** Set up Hermes, Codex or another MCP agent, then connect a new managed browser or an existing Chrome, Edge or AdsPower SunBrowser profile.

> [!TIP]
> **Copy this prompt to your agent**
>
> Follow the [Getting Started guide](./GETTING_STARTED.md) in `ohmyskyhigh/tabro`. Download the available installer for my OS and CPU and verify its SHA-256. Run setup on the desktop host under the same OS account as Chrome, outside the agent sandbox. Keep Chrome’s own security sandbox enabled.
>
> Register the local stdio MCP server and help me load the unpacked extension into my chosen Chrome profile. Confirm that the profile appears in MCP, then use a Tabro workspace to read the title of `https://example.com`. If you lack host or browser access, give me the steps to run on that host.

Tabro was previously named Octopus Browser Relay. New MCP registrations use `tabro`; existing profile data, extension identity, Native Messaging registration, and legacy environment variables remain compatible. The repository is now [ohmyskyhigh/tabro](https://github.com/ohmyskyhigh/tabro); the previous repository address redirects to it, and historical release asset filenames remain valid.

Tabro connects a local MCP gateway to one extension instance in each browser profile. An agent asks for browser capacity, receives broker-issued workspace and tab references, submits extension-supported Chrome DevTools Protocol (CDP) commands, and polls durable request tickets. The extension relays those commands through `chrome.debugger`; Chrome does not need a public remote-debugging port.

> [!IMPORTANT]
> The `0.5.0` source tree implements the twenty-two-tool runtime, authenticated HTTP(S)/SOCKS5 profile proxies, relay-v2, Native Messaging and extension-backed CDP. The published [0.4.2 Windows preview](https://github.com/ohmyskyhigh/tabro/releases/tag/hermes-v0.4.2) remains available while the new installers are qualified and [Hermes relisting](https://github.com/ohmyskyhigh/tabro/issues/2) is pending. The `v0.3.0` standalone release uses the previous Octopus name and fourteen-tool contract. See [Getting Started](./GETTING_STARTED.md) for setup and the [real-world runbook](./doc/06-Files/Real-World-Runbook.md) for platform qualification.

## Features

Screenshots from the [Tabro 0.4.0 preview](https://github.com/ohmyskyhigh/tabro/releases/tag/hermes-v0.4.0) show three core features.

### Multiple agents share one Broker

Multiple agents connect to the same local Broker and discover the same browser profiles. They can share a logged-in browser and account, or work across different profiles.

![Tabro profile list showing shared Broker discovery of Tabro-managed and user-managed profiles](./assets/hermes/multiple-agents-one-broker.png)

### Each agent creates separate workspaces for different tasks

Each agent can create dedicated tab-group workspaces for different tasks. The Broker tracks ownership and keeps browser commands scoped to the correct workspace, so agents can share an account without taking over each other's tabs.

![Chrome sidebar showing separate Tabro workspaces as browser tab groups](./assets/hermes/workspaces-for-each-task.png)

### Each Broker-managed profile can use its own authenticated proxy

Configure HTTP, HTTPS, or SOCKS5 proxies with username/password authentication through MCP. With saved credentials, an agent can configure each profile while closed, open the browsers, verify their exit IPs, and compare results across regions from a single request.

![OLIPOP Google visibility comparison using separate Tabro profiles and verified US and Australia proxy exit IPs](./assets/hermes/proxy-seo-visibility.png)

## Quick start

Start with [Getting started](./GETTING_STARTED.md) for standalone installers, local MCP registration and Chrome pairing. The release workflow stages Windows x64, macOS arm64 and x64, and Linux x64 packages and requires a real Chrome check for each. The Windows Hermes catalog and source-build paths remain available separately.

The current Windows source updater requires a release declaring shared runtime discovery support. The published `v0.3.0` installer retains its older contract. The getting-started guide also covers the separate Windows 0.4.2 preview package.

### The source installer prepares the current twenty-two-tool shared runtime

1. Prepare the Windows source-build prerequisites under [Requirements](#requirements), then clone this repository and open its root directory.
2. Run `pwsh -NoProfile -File .\tools\install-local.ps1 -Install -StartBroker`. Add `-EnableManagedProfiles` when using the verified managed Chrome lifecycle.
3. For external profiles, load the reported extension directory through `chrome://extensions` and wait for Native companion connection. Managed Profiles load their extension during create/open.
4. Apply `.relay-data/bootstrap/codex-mcp.toml` or the generated `hermes-mcp.txt` command, then start a new agent session and verify twenty-two tools.
5. Read actual MCP and relay addresses from `.relay-data/runtime.json`. Broker health and a real managed-tab operation establish different parts of readiness.

The [Release installation section](#github-releases-provide-verified-installation-and-updates) retains the published-package procedure; its historical package contract differs from this source baseline.

## What agents can do

- discover connected browser-profile endpoints and broker-issued window choices;
- list all extension-registered Profiles with broker/user ownership, create broker-owned ones, and reopen or stop them;
- configure authenticated HTTP(S)/SOCKS5 proxies on closed broker-owned Profiles, then reopen and verify their exit IP;
- request one or more workspaces on distinct profiles;
- receive an initial managed tab and CDP event cursor for each workspace;
- create additional managed tabs;
- send raw CDP commands from the extension-supported capability manifest;
- poll asynchronous request tickets and read retained CDP events;
- transfer, pause, resume, terminate, or recover workspace control; and
- pause or resume every owned workspace on one endpoint.

The broker keeps the relationship among agent sessions, endpoints, windows, workspaces, tabs, tickets, and live extension connections. Agent-facing calls use broker-issued references and endpoint nicknames instead of Chrome profile IDs, extension IDs, window IDs, tab IDs, socket IDs, or debug ports.

## Architecture

```mermaid
flowchart LR
  C["Codex session"] --> A1["Session-owned stdio adapter"]
  H["Hermes session"] --> A2["Session-owned stdio adapter"]
  A1 --> M["HTTP MCP gateway\n22 tools"]
  A2 --> M
  M --> B["Local broker\nrouting, status, tickets, controls, logs"]
  B <--> D["SQLite durable state"]
  B <--> G["Extension gateway\nrelay protocol v2"]
  G <--> N["Native Messaging companion"]
  N <--> E1["Profile A extension"]
  N <--> E2["Profile B extension"]
  E1 <--> P1["Chrome profile A\nchrome.debugger"]
  E2 <--> P2["Chrome profile B\nchrome.debugger"]
```

Normal installed profiles use the Native Messaging companion. The companion forwards extension messages to the broker's loopback relay. Direct extension-to-WebSocket transport remains available only for diagnostics.

Read the canonical [Product definition](./doc/01-Product/Product-Definition.md), [MCP contract](./doc/03-User-Interface/MCP-Contract.md), [System architecture](./doc/04-System/System-Architecture.md), and [Component architecture](./doc/05-Components/Component-Architecture.md) for the complete design.

## Requirements

Use [Getting Started](./GETTING_STARTED.md#standalone-installers) for the standalone packages. The Windows source installation below uses these requirements.

- Windows with PowerShell, current-user Native Messaging registry access, and WinHTTP WebSocket support;
- Node.js `22.12.0` or newer;
- pnpm `11.19.0` or another compatible pnpm 11 release;
- A compatible Chrome, Chromium or Microsoft Edge browser; managed profiles and the Hermes plugin require version `153` or newer; and
- Visual Studio C++ Build Tools with an x64 compiler and Windows SDK when rebuilding the native companion.

## Installation

### The installer builds, registers, and prepares the local runtime

From the repository root, run:

```powershell
corepack enable
pwsh -NoProfile -File .\tools\install-local.ps1 -Install -StartBroker
```

The installer runs the frozen pnpm install and build unless skip switches are supplied, verifies the compiled stdio MCP adapter, registers the `io.github.ohmyskyhigh.octopus_browser_relay` Native Messaging companion for the current Windows user, migrates an attributable prototype registration, optionally starts the compiled broker, and creates these local handoff files:

```text
.relay-data/bootstrap/PAIRING.md
.relay-data/bootstrap/MCP-REGISTRATION.md
.relay-data/bootstrap/codex-mcp.toml
.relay-data/bootstrap/hermes-mcp.txt
```

It does not overwrite Codex configuration. The generated Hermes registration command updates every Hermes profile installed when it runs. The installer also leaves browser-profile data and existing broker state in place.

### Preflight reports each missing setup action as JSON

With the Broker running, use the installer’s read-only readiness entry point; it derives health addresses from the data-directory runtime record:

```powershell
pwsh -NoProfile -File .\tools\install-local.ps1
```

The standalone preflight retains fixed-port defaults. Supply discovered URLs when using it directly:

```powershell
$runtime = Get-Content -Raw .relay-data/runtime.json | ConvertFrom-Json
$mcpHealth = $runtime.mcpUrl -replace '/mcp$', '/health'
$relayHealth = ($runtime.relayUrl -replace '^ws:', 'http:') -replace '/relay$', '/health'
pwsh -NoProfile -File .\tools\real-world-preflight.ps1 -McpUrl $runtime.mcpUrl -McpHealthUrl $mcpHealth -RelayHealthUrl $relayHealth
```

The check verifies the workspace, built extension files, required manifest declarations, native executable, compiled stdio adapter, Native Messaging manifest, every configured Native Messaging registry value, generated pairing and MCP handoff files, and both health endpoints. It exits with code `10` when operator action is still required. Pass the same `-NativeRegistryRoots` values to installation and preflight when a browser build uses different roots.

The handoff validator still expects a literal broker URL in generated registration files and can report `mcp_registration_handoffs: ACTION_REQUIRED` for valid runtime-file registrations. Inspect the generated discovery/token paths and verify actual tool discovery; do not treat that warning as a passed full preflight or repeatedly reinstall. The [runbook](./doc/06-Files/Real-World-Runbook.md) records this implementation gap.

### GitHub Releases provide verified installation and updates

Use [Getting Started](./GETTING_STARTED.md#standalone-installers) for the standalone installers. The Windows legacy updater uses its own ZIP and checksum and requires `runtimeDiscoveryVersion: 1` for the current source runtime. The historical `v0.3.0` package exposes fourteen tools. Reproduce that exact release with its versioned updater.

```powershell
Invoke-WebRequest `
  https://github.com/ohmyskyhigh/tabro/releases/download/v0.3.0/octopus-browser-relay-update.ps1 `
  -OutFile .\octopus-browser-relay-update.ps1
pwsh -NoProfile -File .\octopus-browser-relay-update.ps1 -Repository ohmyskyhigh/tabro -Version v0.3.0
```

The updater installs under `%LOCALAPPDATA%\Octopus Browser Relay`, preserves durable data under its `data` directory, registers the versioned native host, starts the broker, and prints the stable extension directory. It also writes these handoff files under `%LOCALAPPDATA%\Octopus Browser Relay\bootstrap`:

```text
INSTALLATION.md
codex-mcp.toml
hermes-mcp.txt
current-release.json
```

Open `chrome://extensions`, enable developer mode, choose **Load unpacked**, and select the returned extension directory once. Do not select the downloaded ZIP itself; the updater extracts and maintains the stable extension directory.

For later updates, run the installed updater:

```powershell
pwsh -NoProfile -File "$env:LOCALAPPDATA\Octopus Browser Relay\update-local.ps1"
```

Later updates keep the unpacked-extension path unchanged. Reload the extension after updating its files to activate the new code; its pairing identity is preserved. The broker accepts different extension package versions when relay protocol negotiation succeeds and does not request a reload based on version differences.

Maintainers build the assets with:

```powershell
pnpm package:release
```

### The stop command refuses to terminate an unrelated process

An installer-started broker records its process ID in `.relay-data/broker.pid`. Stop it with:

```powershell
pwsh -NoProfile -File .\tools\stop-local-broker.ps1
```

The command inspects the recorded Windows process and stops it only when it is `node.exe` running this workspace's absolute compiled broker entry point. A missing PID file is a successful no-op; a stale PID is retained for inspection; a process mismatch is rejected without stopping anything or deleting the PID file. Use `Ctrl+C` for a foreground `pnpm dev` broker.

### Development mode runs the broker directly from TypeScript

After the one-time Native Messaging registration, use this shorter development loop:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm build:extension
pnpm dev
```

`pnpm dev` runs `apps/broker/src/runtime/main.ts` through `tsx`. Rebuild and reload `dist/browser-extension` after extension source changes.

## Browser profile pairing

### Every browser profile loads and pairs its own extension instance automatically

Repeat these steps inside each Chrome profile that the broker should control:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `dist/browser-extension`.
4. Confirm the extension ID is `caekiojlchhifdomfghejkbfpmaklafe`.
5. Open **Tabro Settings**. The extension displays an editable two-word profile-local pairing code and its compact combined nickname, such as `MINT-WAVE` and `mintwave`.
6. Keep the generated code or enter two three-to-eight-letter words, keep **Native companion** selected, and choose **Save settings and reconnect** after any change.
7. Wait until the extension reports `Status: connected` with the final endpoint nickname.

The extension generates the default readable code and registers itself with the running loopback broker; there is no broker-issued code command or copy step. The saved generated or customized code remains authoritative across browser windows and restarts. An existing endpoint is renamed only after reconnect authentication proves the profile's persisted cryptographic identity. A nickname collision preserves the requested code and shows an error until you choose another. The readable code helps correlate this profile with its endpoint and is not an authorization secret. Repeat the load-and-connect steps in every participating profile.

### Direct WebSocket stays available for explicit diagnostics

The extension options page can connect directly to the `relayUrl` published in the runtime record, but that mode is not the normal Chrome setup. Browser kernels can block extension-initiated loopback WebSockets even when ordinary page requests to `127.0.0.1` work. Use **Native companion** for installed profiles and switch to direct WebSocket only while diagnosing transport behavior.

## Agent registration

### The installer generates a Codex stdio MCP configuration fragment

Merge `.relay-data/bootstrap/codex-mcp.toml` into the active Codex `config.toml`, then start a new Codex session. The generated fragment launches Node with `dist/mcp-stdio-adapter/src/main.js` and passes the broker URL, token-file path, and `codex` runtime label as process environment.

The token remains in `.relay-data/admin-token.txt`; the generated fragment points to that file instead of embedding the token. The repository does not choose or modify the active Codex configuration file.

### The installer generates one Hermes command for every installed profile

Open `.relay-data/bootstrap/MCP-REGISTRATION.md` and run the exact PowerShell command stored in `.relay-data/bootstrap/hermes-mcp.txt`. It discovers the default and every installed named Hermes profile, then registers the same compiled adapter with `TABRO_RUNTIME=hermes`, the broker URL, and the local token-file path in each isolated profile. Start a new session in each profile, then run:

```powershell
hermes -p <profile> mcp test tabro
```

Run the generated command again after creating another Hermes profile. Hermes CLI releases can change their configuration syntax. The current repository generates the command and readiness handoff but does not install Hermes or prove a particular external Hermes release.

### One stdio adapter process supplies caller evidence for one agent session

The adapter prefers runtime-owned environment values in this order:

- `CODEX_THREAD_ID`;
- `CODEX_SESSION_ID`;
- `HERMES_SESSION_ID`; and
- `HERMES_AGENT_SESSION_ID`.

`TABRO_RUNTIME_SESSION` can supply an explicit fallback. When none exists, the adapter generates one random session key at startup and retains it for that process. Parent-session variants are forwarded for related subagents.

The adapter forwards these facts to the HTTP broker as `x-octopus-runtime`, `x-octopus-runtime-session`, and optional `x-octopus-parent-runtime-session` headers. They are adapter-supplied evidence, not values for the model to invent or include in tool bodies.

## MCP tools

### Twenty-two tools cover profiles, proxies, browser work, monitoring and control

| Execution | Tool | Purpose |
| --- | --- | --- |
| Read | `list_browser_profiles` | List registered broker-owned and user-owned Profiles, including offline identities and observed readiness. |
| Async | `create_browser_profile` | Create a broker-owned persistent Profile, launch the configured browser, and connect its extension. |
| Async | `open_browser_profile` | Open a broker-owned Profile or reuse its running instance. |
| Async | `stop_browser_profile` | Normally close a broker-owned Profile after its active work ends. |
| Read | `get_browser_proxy` | Read saved routing, application status and the last exit-IP observation for a broker-owned Profile. |
| Async | `set_browser_proxy` | Save proxy routing for a closed broker-owned Profile, to apply on its next explicit open. |
| Async | `clear_browser_proxy` | Clear Tabro proxy routing for a closed broker-owned Profile. |
| Async | `check_browser_proxy` | Check routing and observe the exit IP of a connected broker-owned Profile. |
| Read | `get_browser_context` | Read one narrow, paginated broker, endpoint, window, capability, workspace, tab, or request-summary view. |
| Async | `request_browser_workspace` | Request an exact number of workspaces on distinct eligible profile endpoints. |
| Async | `create_browser_tab` | Create one managed tab in an owned workspace. |
| Async | `send_cdp_command` | Submit one supported raw CDP command to one managed tab. |
| Read | `read_cdp_events` | Read retained CDP events from a broker-issued tab cursor. |
| Read | `get_browser_request` | Read one visible request ticket. |
| Async | `take_over_workspace` | Transfer one exactly identified workspace. |
| Async | `terminate_workspace` | Reconcile running work, archive the tab group, and end the workspace. |
| Async | `resolve_browser_request` | Resolve one owner-visible request paused for confirmation. |
| Immediate | `close_browser_request` | Remove one terminal ticket from public discovery while retaining audit history. |
| Async | `stop_workspace_automation` | Pause one workspace manually. |
| Async | `resume_workspace_automation` | Reconcile and clear the workspace's manual-stop cause. |
| Async | `kill_browser_endpoint` | Pause every active workspace on one entirely owned endpoint. |
| Async | `resume_browser_endpoint` | Reconcile the endpoint and clear its endpoint-kill cause. |

Every asynchronous tool returns an accepted `request_ref` before its browser effect becomes eligible for dispatch. The agent polls that reference with `get_browser_request`. The exact request and result schemas live in [MCP-Contract.schema.json](./doc/03-User-Interface/MCP-Contract.schema.json).

The current extension capability baseline is [extension-baseline.json](./apps/shared/protocol/capabilities/extension-baseline.json). It includes selected Accessibility, DOM, Emulation, Input, Network, Page, and Runtime methods, all confined to a managed tab.

### Agents can select local images and other files with DOM.setFileInputFiles

Use `DOM.getDocument` and `DOM.querySelector` to locate an `input[type="file"]` in the managed tab, then call `send_cdp_command` with its node ID:

```json
{
  "workspace_ref": "<workspace_ref>",
  "target": { "kind": "tab", "tab_ref": "<tab_ref>" },
  "method": "DOM.setFileInputFiles",
  "params": { "nodeId": 42, "files": ["C:\\uploads\\image.png"] }
}
```

Poll the returned `request_ref` with `get_browser_request` until completion. Supply absolute paths accessible on the **browser's machine**; Tabro forwards paths and does not transfer file bytes from a remote agent. The command also accepts `backendNodeId` or `objectId` instead of `nodeId`, multiple paths for a multiple-file input, and `files: []` to clear the selection. Setting the input selects files; complete any page-specific upload or submit step afterward. See the [CDP method definition](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-setFileInputFiles).

## Local endpoints and state

The table shows the Windows source layout. Standalone installations keep the runtime record, database, token, PID and logs under `data/` in the reported install root. Windows publishes an additional relay record beside the native executable. macOS and Linux share `data/runtime.json` between the Native Host and stdio adapter.

| Purpose | Default |
| --- | --- |
| MCP and MCP health | Dynamic loopback HTTP port; read `mcpUrl` in `.relay-data/runtime.json` and replace `/mcp` with `/health` |
| Extension relay and relay health | Dynamic loopback WebSocket port; read `relayUrl` in the same runtime record |
| Shared discovery | `.relay-data/runtime.json`; Native Host reads `relay-runtime.json` beside its executable |
| SQLite state | `.relay-data/relay.sqlite` |
| Generated bearer token | `.relay-data/admin-token.txt` |
| Installer-managed broker PID | `.relay-data/broker.pid` |
| Generated setup handoff | `.relay-data/bootstrap/` |

Demo and ordinary MCP sessions share one Broker. Both listeners default to port `0`, so the operating system chooses available ports. Registrations use `TABRO_RUNTIME_FILE` and a token file rather than fixed port numbers. The adapter checks the instance identity and reconnects before a new tool call after a Broker restart; it never retries a dispatched browser mutation. Native Host reads the current relay record on each connection.

The broker creates the token on first start when `RELAY_ADMIN_TOKEN` is unset. `.relay-data/` is ignored by Git.

Supported environment variables are `RELAY_HOST`, `RELAY_MCP_PORT`, `RELAY_WS_PORT`, `RELAY_DB_PATH`, `RELAY_LOG_LEVEL`, `RELAY_HEARTBEAT_TIMEOUT_MS`, `RELAY_ERROR_THRESHOLD`, `RELAY_LEASE_TTL_MS`, `RELAY_ADMIN_TOKEN`, and `RELAY_PROFILES_CONFIG`. Configuration validation lives in `apps/broker/src/runtime/config.ts`. `TABRO_RUNTIME_FILE` and `TABRO_NATIVE_RUNTIME_FILE` select the discovery outputs in `apps/broker/src/runtime/main.ts`.

## Verification

### Automated checks exercise contracts, storage, gateways, broker policy, and packaging

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

`pnpm verify` runs those checks as one gate. On Windows, `pnpm build` uses the C++ toolchain for the Native Messaging companion. On macOS, it uses Clang for the process and Keychain helper. The [release workflow](./.github/workflows/release.yml) packages the runtime and qualifies each installer against Chrome.

## Troubleshooting

### A disconnected extension is diagnosed from the native host toward the broker

1. Read `relayUrl` from the runtime record, change `ws:` to `http:` and `/relay` to `/health`, and confirm it responds.
2. Confirm the extension ID is `caekiojlchhifdomfghejkbfpmaklafe` and **Native companion** is selected.
3. Confirm the extension directory still exists at the path reported by the updater.
4. Check the setup output and the native registration for your browser. The legacy Windows updater writes its handoff to `%LOCALAPPDATA%\Octopus Browser Relay\bootstrap\INSTALLATION.md`.
5. Reload the unpacked extension after updating its files. If it reports a required-version mismatch, update and restart the broker to remove the old version gate, then reconnect the extension.

For a source checkout, run `pwsh -NoProfile -File .\tools\real-world-preflight.ps1`. For a GitHub Release install, check both health endpoints and the generated handoff files directly.

### An agent that cannot see twenty-two tools needs a fresh stdio adapter process

Confirm the broker health first. Then verify that the Codex or Hermes registration points to the generated stable adapter launcher and token-file path. Rerun `hermes-mcp.txt` if the affected Hermes profile is missing its entry, and restart the agent session after changing its MCP registration. Hermes can check that profile with:

```powershell
hermes -p <profile> mcp test tabro
```

Exactly twenty-two tools must be discovered. Do not point an agent at the relay WebSocket port; agents use the stdio adapter and HTTP MCP gateway.

### Dynamic port allocation avoids conflicts without stopping unrelated applications

Both ports default to `0`; clients use the actual addresses in the discovery record. `tools/start-local-broker.ps1` serializes launches and reuses a healthy instance; the Broker also locks its data directory against duplicate startup. Use the installed `stop-installed-broker.ps1` or source checkout's `tools/stop-local-broker.ps1` for verified shutdown. Explicit nonzero port overrides remain available for compatibility.

## Current limits

- The legacy updater and checked-in Hermes catalog package target Windows x64. The [qualification record](./doc/06-Files/Real-World-Runbook.md#packaged-installation) tracks standalone evidence by OS and architecture.
- The Windows source installer accepts `-NativeRegistryRoots` for browser-specific registry locations. macOS and Linux setup accepts `--browser-data-dir` for a custom browser user-data directory.
- The Windows source installer and legacy updater generate the Codex fragment and the all-profile Hermes command. Standalone packages print a local stdio MCP handoff for the operator to register.
- Independent sessions remain distinct when the host launches one adapter process per session or supplies a supported runtime session environment value. A host that deliberately reuses one adapter process across unidentified sessions also reuses that adapter identity.
- The HTTP broker confirms an accepted ticket after handing it to the stdio adapter. MCP has no transaction spanning that HTTP handoff and the adapter's later stdout write, so an adapter crash in that narrow interval can dispatch work whose ticket the agent runtime did not receive.
- The extension executes only methods published by `octopus-extension-baseline-v1`; flattened child CDP sessions are disabled.
- Relay-v2 extension envelopes are limited to 1 MiB. Capability and inventory limits are published in the same manifest.
- The relay-v1 compatibility bridge remains enabled for migration, while the public MCP gateway exposes only the canonical twenty-two tools.
- The repository does not install Codex, Hermes, or Chrome. The current release has recorded a three-profile, independent-Codex-session, and Hermes physical qualification; another machine or browser build still requires its own preflight and physical evidence.
- There is a PID-verified broker stop command but no full uninstall command yet.

## Repository layout

```text
doc/                    Top-down knowledge vault and change governance
apps/broker/            Broker runtime, core, MCP, relay, and storage source
apps/browser-extension/ Manifest V3 extension source
apps/mcp-stdio-adapter/ Session-owned stdio bridge for Codex and Hermes
apps/native-host/       Platform Native Messaging companions and macOS helper
apps/shared/protocol/   MCP schemas, relay schemas, domain facts, and capabilities
tools/                  Build, install, pairing, preflight, and test automation
tests/                  Contract, unit, integration, fault, E2E, and physical tests
dist/                   Generated broker, adapter, extension, and native artifacts
```

Start with the [top-down vault map](./doc/TOP-DOWN-MOC.md) for project knowledge and the [repository map](./doc/06-Files/Repository-Map.md) for exact implementation paths.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md), the vault [editing rules](./doc/AGENTS.md), and [SECURITY.md](./SECURITY.md) before changing contracts, routing, transport, listener scope, or identity behavior. Do not include bearer tokens, pairing codes, private browser identifiers, profile paths, or SQLite files in public reports.

## License

Tabro is available under the [MIT License](./LICENSE).

## Managed Profiles

### Agents can create and reopen persistent Chromium browser Profiles through MCP

The development implementation includes list_browser_profiles, create_browser_profile, open_browser_profile and stop_browser_profile under MCP contract v5. The pairing alias (`endpoint_nickname`) is each Profile's only public name; creation requires only an idempotency key. Managed launch supports compatible Chrome, Chromium and Edge 153+ on Windows with one-time Native Messaging installation. The exact Chrome build lock has been replaced by version and runtime capability checks. New Profiles automatically load the extension; normal stop retains cookies, website storage and identity. The Hermes package includes this implementation; see its installation guide for the selected-browser prerequisite.

Use `tools/install-local.ps1 -Install -EnableManagedProfiles` for local setup, or `-EnableManagedProfiles` with a package built from this source. Broker and adapter must upgrade together. Read the [single-Agent Demo runbook](./tests/demo/RUNBOOK.md) for the two verified three-Profile runs and reproduction steps.

## Domain rules

### Selected domains can require input actions while preserving observation

The contract-6 source implementation supports a persistent `data/browser-rules.json` list shared by Codex and Hermes. Add a domain to require mouse/keyboard input for manipulation while permitting guarded JavaScript, DOM, accessibility and screenshots for observation. Domains include nested subdomains and all paths. See [rule configuration](./GETTING_STARTED.md#domain-rules) for the format, validation and recovery behavior. Native release qualification is tracked in the [implementation plan](./doc/80-Plans/domain-input-only-rules-2026-11-10/README.md); this source update does not publish a new package.

## Extension dashboard

### Open the extension to see connection details, profiles and website rules

Click the **Tabro toolbar icon** or open its **Extension options**. The **Connection** tab shows the pairing code, profile alias and live connection status, with reconnect and pairing settings. **Broker management** lists profiles and their status, and lets you add, edit or remove input-only domain rules. Profile management is read-only in this version. Rules use the same persistent file across Codex and Hermes; conflicting edits require a refresh before saving. See [dashboard setup](./GETTING_STARTED.md#extension-dashboard). The dashboard is included in source builds; upgrade the Broker and extension together when a matching package is released.

Profile rows show **Connection** and **Automation** separately: connected automation can be paused, and connection failures show their error. New tabs open in the background by default. Agents may explicitly bring a tab forward when a website needs it to start or receive input; background operation is a soft preference, while input-only rules still apply.
