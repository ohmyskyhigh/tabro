# Real-world Chrome, AdsPower, Codex, and Hermes runbook

Status: executable operator runbook for the `0.3.1` source runtime with MCP contract v2 and shared dynamic discovery.

This runbook proves physical behavior separately from simulated tests. A failed checkpoint is evidence of a runtime or setup gap; it must not be rewritten as a pass because a lower-level unit or integration test succeeded.


## Scope

### The qualification uses real agent sessions and separately installed browser profiles

The complete run uses:

- one local Tabro broker;
- one Codex session and one Hermes session;
- at least three browser profiles, with one Tabro extension instance in each;
- Native Messaging for every normal profile connection;
- the checked-in local fixture server; and
- extension-proposed endpoint nicknames and broker-issued Profile, window references, workspace references, tab references, request references, and event cursors.

Chrome and AdsPower can be mixed. Each profile must retain separate extension storage, and every extension must pair with a distinct nickname.

### Direct WebSocket results count only as transport diagnostics

Selecting **Direct WebSocket (diagnostics only)** can isolate Native Messaging failures, but it does not pass the installed-profile transport checkpoint. The normal qualification keeps **Native companion** selected in Chrome and AdsPower.

## Prerequisites

### The local machine supplies the Windows native build and two agent runtimes

Confirm these commands or applications are available before starting:

```powershell
node --version
pnpm --version
pwsh --version
```

Node must satisfy the root `package.json` engine (`>=22.12.0`). Building the native host requires Visual Studio C++ Build Tools, an x64 compiler, and a Windows SDK. Codex, Hermes, Chrome, and AdsPower are external prerequisites; the repository does not install them.

### Existing browser profiles and pairing state remain user data

The setup and test commands do not delete browser profiles. Do not reset extension pairing merely to repeat a run or change its alias. Edit and save the pairing code to rename the existing authenticated endpoint. Use **Reset pairing** only when intentionally replacing that endpoint identity; the extension then generates a new readable code, key, and nickname candidate and registers automatically.

## Installation

### One installer command builds artifacts, registers Native Messaging, and starts the broker

From the repository root:

```powershell
corepack enable
pwsh -NoProfile -File .\tools\install-local.ps1 -Install -StartBroker
```

The command writes local generated state below `.relay-data/`. Keep the final JSON output; it names the actual extension path, native host path, registration manifest, configured registry roots, MCP instructions, pairing instructions, broker PID file, and health conditions used by this run. The default Windows registration roots are Google Chrome, Chromium, and `HKCU:\Software\AdsPower\SunBrowser\NativeMessagingHosts`, which is the installed AdsPower/SunBrowser root on the qualification device. Pass the actual roots through `-NativeRegistryRoots` when testing another browser build.

### A GitHub Release installation keeps one extension path across updates

The historical published-package path uses the standalone updater below. Repository publication records identify `v0.3.0` as the earlier fourteen-tool runtime. It cannot pass this runbook’s twenty-two-tool/shared-discovery qualification; use the current source installer or a locally built discovery-capable package for that scope:

```powershell
Invoke-WebRequest `
  https://github.com/ohmyskyhigh/tabro/releases/latest/download/octopus-browser-relay-update.ps1 `
  -OutFile .\octopus-browser-relay-update.ps1
pwsh -NoProfile -File .\octopus-browser-relay-update.ps1
```

The result names the stable extension directory under `%LOCALAPPDATA%\Octopus Browser Relay`. Load that directory unpacked once in every intended profile. A later invocation of the installed `update-local.ps1` verifies and installs the next version behind the same extension path. The broker requests one extension reload when versions differ; pairing storage remains in the profile.

Before qualifying an update, require the updater's broker health to report the selected version and require every intended endpoint to reconnect. A repeated extension-version mismatch is a failed checkpoint, not permission to reload indefinitely.

### Preflight exposes setup gaps and the remaining legacy handoff check

Run:

```powershell
pwsh -NoProfile -File .\tools\install-local.ps1
```

The installer without `-Install` reads the current data-directory discovery record for health checks. The standalone preflight still has legacy fixed-port defaults; when using it directly, supply actual URLs:

```powershell
$runtime = Get-Content -Raw .relay-data/runtime.json | ConvertFrom-Json
$mcpHealth = $runtime.mcpUrl -replace '/mcp$', '/health'
$relayHealth = ($runtime.relayUrl -replace '^ws:', 'http:') -replace '/relay$', '/health'
pwsh -NoProfile -File .\tools\real-world-preflight.ps1 -McpUrl $runtime.mcpUrl -McpHealthUrl $mcpHealth -RelayHealthUrl $relayHealth
```

The handoff validator in `tests/real-world/setup-readiness-checks.ts` still requires a literal broker URL in both registration files. Discovery-based handoffs may therefore report `mcp_registration_handoffs: ACTION_REQUIRED` even when health and tool discovery succeed. Record that implementation gap, inspect runtime/token paths and test MCP discovery directly; do not report a fully passed preflight or repeatedly reinstall to satisfy the obsolete comparison.

Expected top-level result:

```json
{
  "status": "READY"
}
```

If it reports `ACTION_REQUIRED`, perform the first returned `nextAction` and rerun it. Exit code `10` means setup is incomplete, not that the script crashed. Readiness checks the compiled stdio adapter, all generated Codex and Hermes handoff files, and every configured Windows Native Messaging registry value in addition to the build, manifest, pairing, and health checks. Use the same `-NativeRegistryRoots` values for installation and preflight.

### The installer-started broker stops only after its PID and command line match

The installer launches a hidden compiled broker and records its process ID in `.relay-data/broker.pid`. Stop that process with:

```powershell
pwsh -NoProfile -File .\tools\stop-local-broker.ps1
```

The stop command requires the recorded process to be `node.exe` running this workspace's absolute compiled broker entry point. It refuses an unrelated PID, retains stale or mismatched PID files for inspection, and deletes the PID file only after the matching process has stopped. A foreground `pnpm dev` broker still stops with `Ctrl+C`.

### Development runs can replace the compiled broker after one-time registration

Stop the installer-started broker with `tools\stop-local-broker.ps1` before replacing the process that owns the same data directory. The data-directory lock rejects a second live owner even when both request dynamic ports. Then run:

```powershell
pnpm build:extension
pnpm dev
```

Keep that terminal open. Reload the unpacked extension in every profile after rebuilding it.

## Browser pairing

### Each Chrome or AdsPower profile loads the same build into separate extension storage

In every intended profile:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the absolute `extensionPath` printed by the installer.
4. Confirm extension ID `caekiojlchhifdomfghejkbfpmaklafe`.
5. Accept the extension's `debugger`, `tabGroups`, and Native Messaging permissions.
6. Open **Tabro Settings**, keep or customize the profile-local readable pairing code, and observe the derived endpoint nickname and connection status.

### The extension pairs automatically without a copied broker code

In that profile's extension options:

1. keep the generated pairing code or enter two three-to-eight-letter words separated by a hyphen, space, or underscore;
2. keep **Native companion** selected;
3. let Native Host discover `relayUrl` from `relay-runtime.json` beside its executable; only direct-WebSocket diagnostics require copying the current runtime URL into extension options;
4. choose **Save settings and reconnect** after any change; and
5. wait for `Status: connected`.

On its first connection the extension sends its saved generated or customized two-word code, combined lowercase nickname, and public profile identity to the loopback broker. For example, `MINT-WAVE` appears as endpoint nickname `mintwave`. The broker registers the endpoint automatically, then uses challenge authentication for that and later connections. A code change on an existing endpoint takes effect only after that authentication. The readable code identifies this installation for the human; it is not a password or an authorization grant.

Repeat this in every profile. Each profile has separate extension storage and therefore retains its own identity, code, and nickname across ordinary browser restarts. If another endpoint already owns the chosen nickname, the extension preserves the code and displays a conflict; enter a different code and save again.

### Health confirms how many paired endpoints are currently connected

Read both health endpoints:

```powershell
$runtime = Get-Content -Raw .relay-data/runtime.json | ConvertFrom-Json
Invoke-RestMethod ($runtime.mcpUrl -replace '/mcp$', '/health') | ConvertTo-Json -Depth 8
Invoke-RestMethod (($runtime.relayUrl -replace '^ws:', 'http:') -replace '/relay$', '/health') | ConvertTo-Json -Depth 8
```

Record the observed `connectedEndpoints` count from MCP health. It must equal the number of profile extensions that currently show `Status: connected`. An endpoint count alone does not prove CDP execution; the later checkpoints do.

## Local fixture

### The fixture server gives each profile an unambiguous page marker

Start the checked-in fixture in another terminal and leave it running:

```powershell
pnpm exec tsx tests/real-world/fixture-server.ts --port=7340
```

These pages are available only on loopback:

| Role | URL | Expected marker |
| --- | --- | --- |
| A | `http://127.0.0.1:7340/fixture/A` | `fixture-A` |
| B | `http://127.0.0.1:7340/fixture/B` | `fixture-B` |
| C | `http://127.0.0.1:7340/fixture/C` | `fixture-C` |

Check `http://127.0.0.1:7340/health` before assigning browser work.

## Agent registration

### Codex launches a session-owned stdio adapter from the generated fragment

Open `.relay-data/bootstrap/MCP-REGISTRATION.md`. Merge `.relay-data/bootstrap/codex-mcp.toml` into the active Codex configuration and start a new Codex session. Confirm the session can list an MCP server named `tabro` and exactly twenty-two tools.

The generated fragment launches the compiled Node stdio adapter and supplies `TABRO_RUNTIME_FILE` pointing to `.relay-data/runtime.json`, the `.relay-data/admin-token.txt` path, and `codex` runtime label. It does not embed the token. The repository generates the fragment but does not locate or overwrite the active Codex configuration.

### Hermes registers the generated adapter in every installed profile

Open `.relay-data/bootstrap/hermes-mcp.txt` and run its exact command. The command invokes the profile-aware registration helper, discovers the default profile and every installed named profile, and registers the same stdio adapter with the shared runtime-file path, local token-file path, and `hermes` runtime label in each profile. Start a new session in every profile being qualified, then run:

```powershell
hermes -p <profile> mcp test tabro
```

Repeat the generated registration command after creating another Hermes profile. The repository does not install Hermes or validate every Hermes CLI release. If the installed CLI rejects the generated syntax, capture `hermes mcp add --help` and treat registration as blocked rather than changing the broker contract.

### Separate stdio adapter processes distinguish independent sessions without model-authored IDs

The adapter prefers `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `HERMES_SESSION_ID`, or `HERMES_AGENT_SESSION_ID`. If none exists, it creates a random identity once for that process. A related subagent can supply the matching parent-session environment value.

Confirm the agent runtime launches one stdio adapter process per independent session. A host that reuses one process across several unidentified sessions also reuses its caller identity and cannot pass the independent-session checkpoint.

### The two-transport acknowledgement boundary remains visible during failure testing

The broker hands an accepted ticket to the stdio adapter before dispatch eligibility. The adapter then writes that result to the agent over stdio. MCP supplies no atomic transaction across those two handoffs. If the adapter is killed in that narrow interval, browser work can become eligible even though the agent did not receive its `request_ref`; record that outcome as the known adapter-boundary limitation rather than a normal pass.

## Single-session browser cycle

### The agent discovers choices before requesting browser capacity

Give the agent this task in natural language:

> Use Tabro. First read the connected endpoint choices and their eligible windows. Do not invent any reference. Request one workspace on endpoint `<nickname>` using the most recently focused eligible window, and poll the returned request ticket until it reaches a terminal or paused condition. Report the broker-issued `workspace_ref`, initial `tab_ref`, and initial event cursor.

Passing evidence contains:

- an endpoint nickname that matches the intended extension;
- a broker-issued window choice or use of the documented most-recently-focused default;
- an accepted `request_ref` returned before completion;
- a succeeded workspace ticket; and
- one initial managed tab and cursor returned by that ticket.

### The agent navigates and reads one marker through ticketed CDP

Continue the task:

> On that initial tab, send `Page.navigate` to `<fixture URL>`. Poll its `request_ref` until complete. Then send `Runtime.evaluate` with `returnByValue: true` to read `document.querySelector('[data-relay-marker]')?.getAttribute('data-relay-marker')`. Poll that second ticket and report the returned marker.

The returned marker must match the profile's assigned fixture. A result from the wrong letter is a routing failure.

### Every accepted browser command is verified through its broker-issued ticket

For each asynchronous call, capture the acceptance result and the final `get_browser_request` result. Do not infer completion from the visible page alone. If the ticket pauses, follow its returned actions instead of replaying the CDP command without resolution.

## Codex and Hermes equivalence

### Both runtimes perform the same contract without runtime-specific tool bodies

Run the single-session cycle once from Codex and once from Hermes, using separate fixtures or separate workspaces. Both sessions must see the same twenty-two tool names, use the same MCP input structure, receive broker-issued IDs, poll tickets, and obtain the assigned marker.

Record any difference in schema loading, structured results, authorization headers, session evidence, or polling behavior. Adapter differences are failures to investigate; they do not authorize a different browser contract for one runtime.

## Multi-profile and concurrent execution

### One session can request several distinct profiles in one capacity call

Ask one agent to request three workspaces and designate three connected endpoint nicknames. The accepted request must either return all three workspaces or fail as one capacity request; it must not quietly return fewer than requested.

Navigate the three initial tabs to fixtures A, B, and C, poll all tickets, and evaluate each marker. Every workspace must remain associated with its selected endpoint.

### Independent sessions on one endpoint receive different workspace tab groups

Only run this checkpoint when the MCP adapters supply distinct session evidence. Ask Codex and Hermes to request separate workspaces on the same endpoint. Confirm that each receives a different `workspace_ref`, initial `tab_ref`, and Chrome tab group. Send different fixture navigations concurrently and verify both markers.

Related parent/subagent work can intentionally continue the same lineage workspace when the parent-session evidence is supplied. Do not use this variation as evidence that unrelated sessions are isolated.

### Same-tab commands complete in ticket-acceptance order

From one owning session, submit several short commands to the same `tab_ref` without waiting between submissions. Record the returned tickets in acceptance order and poll them. Later commands must not complete their browser cycles ahead of earlier accepted commands on that tab.

## Recovery and controls

### Closing one profile pauses its work without disconnecting other endpoints

With workspaces active on A, B, and C:

1. close profile B completely;
2. confirm MCP health decreases its connected endpoint count;
3. submit or observe B's next browser request and record its paused condition;
4. confirm A and C still complete commands;
5. reopen B and wait for its extension to report `Status: connected`; and
6. poll B's request until reconciliation and the documented retry/resolution path finishes.

The broker process must remain running throughout this checkpoint.

### Manual stop blocks new workspace work until a separate resume request completes

Call `stop_workspace_automation` for one owned `workspace_ref`, poll the stop ticket, then attempt another command. Confirm the workspace remains paused. Call `resume_workspace_automation`, poll its ticket, and verify a new CDP command can complete after reconciliation.

### Endpoint kill and resume apply to every active workspace on that endpoint

Call `kill_browser_endpoint` with one entirely owned endpoint nickname and poll its ticket. Confirm every workspace on that endpoint is paused while other endpoints continue. Call `resume_browser_endpoint`; after reconciliation, poll resumed work from its existing checkpoints.

### Termination archives the tab group and waits for running work

Call `terminate_workspace` while the target workspace is idle or after recording any running ticket. Poll termination to completion. Confirm the tab group remains visible with its archive suffix, the workspace no longer accepts new work, and the human can close the archived group after inspection.

## Acceptance evidence

### A release candidate passes only when every applicable checkpoint has direct evidence

Record this table for the run:

| Checkpoint | Required evidence |
| --- | --- |
| Setup | Installer output and preflight `READY` |
| Pairing | A distinct saved generated or customized code and endpoint nickname plus `Status: connected` in every profile, with no broker-issued code entry |
| MCP surface | Exactly twenty-two canonical tools in Codex and Hermes |
| Ticket ordering | Accepted `request_ref` observed before terminal result |
| Routing | A/B/C workspaces return A/B/C fixture markers |
| Concurrency | Independent workspaces and same-tab acceptance order behave as specified |
| Recovery | Closing and reopening one profile pauses and resumes only its affected work |
| Controls | Stop/resume, endpoint kill/resume, and termination produce polled terminal evidence |
| Transport | Normal runs report Native Messaging, not direct WebSocket |

State which browser product and version, extension version, broker service version, MCP contract version, and relay protocol version were observed. The readable pairing code may be checked on screen during installation but should not be retained in shared qualification evidence. Do not include bearer tokens, private browser identifiers, profile paths, or the SQLite database.

## Known qualification limits

### The current runbook exposes unsupported setup rather than hiding it

- The native host and installer are Windows-specific.
- The defaults include the installed AdsPower/SunBrowser Native Messaging root; another AdsPower or Chromium variant can require its actual registry root through the installer's and preflight's `-NativeRegistryRoots` parameter.
- The installer generates but does not apply Codex configuration. Its generated Hermes command applies registration to every profile installed when that command runs; profiles created later require another run.
- Independent-session proof requires one stdio adapter process per session or a supported runtime session environment value; a deliberately shared unidentified adapter process cannot pass it.
- An adapter crash between the broker's HTTP handoff and the adapter's stdout write can leave dispatched work whose ticket was not received by the agent runtime.
- The relay-v1 compatibility path and older real-world harness files are migration evidence; they do not substitute for the canonical twenty-two-tool checkpoints above.
- The older isolated Chrome/Profile probes set their own relay URL but do not provision isolated native discovery. A Native Host already pointing at the shared Broker overrides that URL; follow the limitation in [the probe guide](../../tests/demo/README.md) before a new physical run.
- The System's general worker/queue bounds and time/size retention policies remain implementation targets. Current source does not enforce those bounds or implement log rotation, audit expiry or event pruning; a successful routing test does not prove them.
- Direct WebSocket proves only its diagnostic transport path.
- The extension capability manifest excludes unsupported CDP methods and flattened child sessions.

## Cleanup

### Stopping test processes preserves browser and broker state for inspection

Stop the fixture server and a foreground broker with `Ctrl+C` after recording results. Stop an installer-started hidden broker with `pwsh -NoProfile -File .\tools\stop-local-broker.ps1`. Do not delete `.relay-data` or reset pairing as routine cleanup. Archived tab groups remain for the human to inspect and close.

Generated evidence under `artifacts/real-world/` can be preserved. The existing cleanup script intentionally prints the evidence location and does not delete Chrome profiles:

```powershell
pwsh -NoProfile -File .\tools\real-world-cleanup.ps1 -RunId "<run-id>"
```

## Shared runtime qualification

### Restart discovery preserves caller identity without retrying a dispatched operation

After source installation, `tools/start-local-broker.ps1` starts or reuses the matching healthy Broker and reports the actual endpoints. Compare the discovery instance UUID with MCP health; do not assume an old port still belongs to Tabro. Ordinary registrations use `TABRO_RUNTIME_FILE` and a separate token file. Native Host reads the adjacent relay record. Demo fixture shutdown must leave the shared Broker healthy.

Automated coverage is in `tests/integration/runtime-discovery.test.ts` and `tests/integration/native-runtime-discovery.test.ts`. The native test requires its named Windows test binary and otherwise skips; report the actual result. A new physical qualification must record its own results rather than reusing the October 1 migration report as a fresh pass.

## Managed Profile qualification

### Broker-owned Profiles require enabled launch support while both ownerships support automation

Use the current source installer with `-Install -EnableManagedProfiles -StartBroker` on the verified Windows/Chrome runtime described in [Operational defaults](../02-User-Experience/Operational-Defaults.md). Follow [the Demo runbook](../../tests/demo/RUNBOOK.md) for create/open/stop, Profile isolation, native tab groups and persisted identity. `list_browser_profiles` includes every authenticated extension identity, with or without a configured launcher. Report each nickname and `ownership`: `broker` supports MCP launch; `user` needs the human to open Chrome. Both use the same workspace and CDP tools after connection. Update the Broker and adapters together to MCP contract version 5; existing version-2 or version-3 adapter processes must reconnect with the rebuilt adapter. Profile names come only from `endpoint_nickname`; creation takes an idempotency key and the extension assigns the alias.

End active workspaces before stopping a managed Profile. Stop preserves its data. Broker shutdown and fixture shutdown are not commands to delete or close unrelated Chrome instances. Hermes Plugin packaging, cross-platform installation and upstream Provider discovery remain pending in [the Provider plan](../80-Plans/tabro-hermes-provider-2026-10-01/README.md).

## Profile proxies

### Operators provision credentials locally before agents configure a Profile

Build the 0.4.0 Broker, adapter and extension together. MCP uses contract 5; reconnect existing MCP clients after upgrading. Proxy configuration is available only for `ownership=broker`. Those Profiles load the rebuilt extension on their next MCP launch. User-owned Chrome remains available for ordinary workspace automation but does not accept proxy configuration.

Provision a credential reference from a local PowerShell prompt. This sends the secret over stdin instead of putting it in command arguments or MCP history:

```powershell
$proxyLogin = Get-Credential -Message 'Proxy username and password'
@{ username = $proxyLogin.UserName; password = $proxyLogin.GetNetworkCredential().Password } |
  ConvertTo-Json -Compress |
  pnpm exec tsx tools/provision-proxy-credential.ts
$proxyLogin = $null
```

The default database is `.relay-data/relay.sqlite`, and the credential belongs to its admin principal. Use `--db` and `--principal` to select another existing Broker principal. The output contains only `credential_ref`; copy that opaque value into `set_browser_proxy`. The local vault is `.relay-data/proxy-credentials/`; clearing a Profile binding does not delete its credential. The Windows account that provisions the credential must also run the Broker.

### Agents close a broker-owned Profile, save its proxy and explicitly reopen it

Resolve the Profile's stable reference through `list_browser_profiles` and verify `ownership=broker`. End active work and call `stop_browser_profile` first. Then call `get_browser_proxy` and use its revision for `set_browser_proxy`, with a new idempotency key and a proxy object containing `scheme`, `host`, `port` and optional `credential_ref`. Supported schemes are `http`, `https` and `socks5`. Poll the returned ticket with `get_browser_request`. An open Profile rejects even when it has no workspaces; extension disconnection alone does not prove closure.

The saved change reports `pending_connection` and leaves Chrome closed. Call `open_browser_profile`, then wait for `application.state=applied` before running `check_browser_proxy` with the current revision. The check runs in the extension against the fixed ipify HTTPS endpoint and returns a dated IP observation. To clear, close the Profile again and call `clear_browser_proxy` with its current revision and an idempotency key. It stays closed; the next explicit launch omits the startup proxy flag and releases the extension setting. User-owned references reject with `PROFILE_USER_OWNED`; no user confirmation bypass is provided.

### The isolated proxy harness verifies the delivered routing behavior

Run `pnpm exec tsx tools/probe-profile-proxy.ts` after building. It creates disposable Profiles and its own Native Messaging registration and controlled upstreams. It verifies the closed-configure-open flow on broker-owned Chrome and rejects user-owned changes both online and offline. It fails if the required Windows/Chrome environment is unavailable. Preserve its `report.json` under the emitted evidence directory. See the [closed-Profile amendment](../80-Plans/profile-proxy-2026-10-03/closed-profile-amendment.md) for current qualification and the [initial implementation report](../80-Plans/profile-proxy-2026-10-03/implementation-report.md) for historical transport evidence.

Parent: [`Files MOC`](./_MOC.md).
