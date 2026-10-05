# Getting started with Tabro

Install the local Broker, connect your agent, then connect a browser. Multiple agents can share the same Broker and browser account while using separate task workspaces.

Choose your agent: [Hermes](#hermes) · [Codex and other MCP agents](#other-agents). Then choose your browser connection: [create a profile through MCP](#create-and-open-a-browser-profile-through-mcp) or [load the extension into an existing browser](#connect-an-existing-chrome-edge-or-adspower-sunbrowser-profile).

## Requirements

- Windows x64 and Windows PowerShell 5.1 or later.
- Chrome, Chromium or Microsoft Edge **153+** for setup and Tabro-managed browser profiles.
- An agent that can launch a local stdio MCP server on this Windows machine.

Setup installs the Broker, MCP adapter, Native Messaging companion and extension, and can download the required Node runtime. You do not need to build Tabro or install Hermes to use another MCP agent. Existing AdsPower **SunBrowser** profiles can connect through the extension; their browser build must support the extension's Native Messaging, debugger and tab-group APIs. AdsPower is optional.

This guide uses the [0.4.2 Windows preview](https://github.com/ohmyskyhigh/tabro/releases/tag/hermes-v0.4.2). Its runtime is pinned to commit `6b0b7e526cb6d85dc3fb3d0eae63d051b5be127a`.

## Hermes

### Install the plugin into the Hermes profile you want to use

In PowerShell, select your browser before installing or enabling the plugin. Use its actual executable path; this example selects Chrome:

```powershell
$env:TABRO_BROWSER_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
[Environment]::SetEnvironmentVariable('TABRO_BROWSER_PATH', $env:TABRO_BROWSER_PATH, 'User')
```

For Edge, a common path is `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. Restart an already-open Hermes app so it inherits the variable.

While [catalog admission](https://github.com/NousResearch/hermes-agent/pull/132619) is pending, install the pinned plugin directly:

```powershell
hermes plugins install "ohmyskyhigh/tabro#integrations/hermes" --ref 6b0b7e526cb6d85dc3fb3d0eae63d051b5be127a --no-enable
hermes plugins list
```

For an existing named Hermes profile, add `-p <profile-name>` immediately after `hermes` in each command, including install, list and enable. For example, `hermes -p tabro-1 plugins list`. Repeat installation and enablement for every participating Hermes profile. See [Hermes's plugin documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins/) for its installation and enablement controls.

### Run setup once and enable the plugin in each participating profile

Set `$TabroPackage` to the plugin directory reported by `hermes plugins list`, then run:

```powershell
$TabroPackage = 'C:\path\to\installed\tabro'
powershell.exe -NoProfile -File "$TabroPackage\setup.ps1" -DownloadNode
hermes plugins enable tabro
```

Setup starts the Broker and prints `status: INSTALLED`, `nativeRegistered: true` and an `extensionPath`. Keep that extension path for the manual browser connection below. Reload Hermes MCP or start a new agent session after setup.

All participating Hermes profiles share `%LOCALAPPDATA%\Tabro` and have separate MCP sessions. Setup from another profile reuses that installation. Keep their plugin versions aligned. For a custom location, follow the [custom-root instructions](./integrations/hermes/README.md#named-hermes-profiles-share-the-daemon-and-enable-their-own-plugin-connections).

Ask Hermes:

> Use Tabro to list my browser profiles.

An empty list on a fresh installation is normal: [connect a browser](#browser-connection) next. Once Tabro is admitted to the catalog, `hermes plugins install tabro` can replace the direct repository install command above.

## Other agents

### Reuse an installed Broker or install the same portable runtime

If Hermes setup is already complete, skip this installation step and reuse its Broker. Otherwise, download `tabro-hermes-0.4.2-windows-x64.zip` and `SHA256SUMS-0.4.2` from the [0.4.2 release](https://github.com/ohmyskyhigh/tabro/releases/tag/hermes-v0.4.2). Despite the package name, the included runtime can also serve other local MCP agents.

Compare the ZIP's SHA-256 with the checksum file:

```powershell
Get-FileHash .\tabro-hermes-0.4.2-windows-x64.zip -Algorithm SHA256
```

Extract the ZIP into a folder you will keep. Set `$TabroPackage` to that folder, select your browser and run setup:

```powershell
$TabroPackage = 'C:\path\to\extracted\tabro-hermes-0.4.2'
powershell.exe -NoProfile -File "$TabroPackage\setup.ps1" -DownloadNode -BrowserPath 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

Setup starts the same shared Broker and prints the extension path. Continue with the registration below; you do not need to install the Hermes application.

### Read the installed paths before registering an MCP server

Run this in PowerShell. If you selected a custom install root, replace the first line with that absolute path.

```powershell
$TabroRoot = Join-Path $env:LOCALAPPDATA 'Tabro'
$TabroState = Get-Content -LiteralPath (Join-Path $TabroRoot 'installation.json') -Raw | ConvertFrom-Json
$TabroNode = $TabroState.nodePath
$TabroRuntime = Join-Path $TabroRoot $TabroState.runtimeDirectory
$TabroAdapter = Join-Path $TabroRuntime 'adapter\main.js'
$TabroRuntimeFile = Join-Path $TabroRoot 'data\runtime.json'
$TabroTokenFile = Join-Path $TabroRoot 'data\admin-token.txt'
```

The following configurations use those paths. The token stays in its local file. The runtime record supplies the current Broker address, so you do not need to copy port numbers.

### Codex connects through its stdio MCP registration

With the variables above still set, run:

```powershell
codex mcp add tabro --env "TABRO_RUNTIME_FILE=$TabroRuntimeFile" --env "TABRO_TOKEN_FILE=$TabroTokenFile" --env TABRO_RUNTIME=codex -- $TabroNode $TabroAdapter
codex mcp list
```

Start a new Codex session and ask it to use Tabro to list browser profiles. The command follows the [official Codex MCP configuration guide](https://developers.openai.com/codex/mcp/).

### Other local MCP clients use the same command, arguments and environment

Generate a JSON configuration containing your actual paths:

```powershell
@{
  mcpServers = @{
    tabro = @{
      command = $TabroNode
      args = @($TabroAdapter)
      env = @{
        TABRO_RUNTIME_FILE = $TabroRuntimeFile
        TABRO_TOKEN_FILE = $TabroTokenFile
        TABRO_RUNTIME = 'mcp-agent'
      }
    }
  }
} | ConvertTo-Json -Depth 6
```

Merge the generated `tabro` entry into your agent's MCP settings. If its UI asks for separate fields, select **stdio** and copy `command`, `args` and `env`. Restart its MCP connection, then ask it to list Tabro profiles. The client must support local process execution; a cloud-only HTTP connector cannot launch this server.

Each independent agent session needs its own adapter process when the host supplies no session identity. A single adapter shared by unidentified agents also shares its workspace authority.

Keep the Broker running. These direct adapter configurations connect to an existing Broker; after restarting Windows, rerun the matching package's setup to start it again. After a runtime update, regenerate the paths and update these MCP entries because the adapter lives in a versioned directory.

## Browser connection

Choose a connection method based on who opens the browser:

| Connection | Profile ownership | Who opens and closes it? | Tabro proxy configuration |
| --- | --- | --- | --- |
| Create a new profile through MCP | `broker` | Tabro through MCP | Supported while closed |
| Load the extension in an existing Chrome, Edge or SunBrowser profile | `user` | You, or AdsPower | Managed outside Tabro |

Both types appear in the same profile list and can provide agent workspaces once connected. Launch ownership is separate from workspace ownership.

### Create and open a browser profile through MCP

Ask your agent:

> Use Tabro to create a browser profile, open it, and create a workspace for this task.

Tabro creates a separate profile using the browser selected during setup, loads its extension and waits for connection. Existing cookies and logins are not copied into the new profile; sign in there when needed.

The agent's MCP sequence is:

1. Call `list_browser_profiles` with `{}` to discover existing profiles.
2. For a new one, call `create_browser_profile` with `{"idempotency_key":"getting-started-001"}`. This creates **and opens** it. Use a new key for each additional profile; reuse the key only when retrying the same creation.
3. Poll the returned ticket with `get_browser_request`, passing `{"request_ref":"<returned request_ref>"}`, until it finishes. Read any reported problem before continuing.
4. To reopen an existing broker-owned profile, call `open_browser_profile` with `{"profile_ref":"<returned profile_ref>"}` and poll its ticket.
5. Use `request_browser_workspace` to acquire a workspace on the connected profile before controlling tabs.

Keep the returned references unchanged. The generated pairing alias is the profile's name; there is no separate display-name field or name argument for creation. You do not manually load an extension for this path. Broker-owned browsers use a random loopback debugging port while open, as disclosed in the [plugin README](./integrations/hermes/README.md#browser-automation).

### Connect an existing Chrome, Edge or AdsPower SunBrowser profile

Use this path to keep an existing logged-in browser account.

1. Complete Broker setup on the same Windows machine and user account as the browser.
2. Open the desired Chrome profile, or start the desired **SunBrowser** profile from AdsPower. For Edge, open the desired Edge profile.
3. In that browser window, open `chrome://extensions` (`edge://extensions` for Edge).
4. Turn on **Developer mode**, choose **Load unpacked**, and select the `extensionPath` printed by setup. Select the folder containing `manifest.json`.
5. Open **Tabro → Details → Extension options**. Keep **Native companion (recommended)** selected and wait for **Status: connected**. If you changed settings, click **Save settings and reconnect**.
6. Note the **Profile alias** and ask your agent to list Tabro profiles again. That alias should appear with `ownership: user` and a connected extension.

The extension registers automatically. Its readable pairing code produces the alias, for example `MINT-WAVE` → `mintwave`; you do not request a code from the Broker. Native Messaging discovers the local Broker through the installed companion, so you do not need to enter a relay URL or port.

To recover the extension path for a package installation:

```powershell
$TabroRoot = Join-Path $env:LOCALAPPDATA 'Tabro'
$TabroState = Get-Content -LiteralPath (Join-Path $TabroRoot 'installation.json') -Raw | ConvertFrom-Json
Join-Path (Join-Path $TabroRoot $TabroState.runtimeDirectory) 'browser-extension'
```

Use your custom root if applicable. For a source installation, use the installer-reported path, normally `dist\browser-extension`.

In AdsPower, loading directly inside SunBrowser is local to that profile on this machine. AdsPower also has a team extension distribution workflow; see its [extension installation guide](https://help.adspower.com/docs/extensions). This Tabro walkthrough uses local unpacked loading and still requires the Native Messaging companion installed by setup. Verify connection on your SunBrowser build; registering its Windows key alone does not establish browser compatibility.

Then ask your agent, replacing `mintwave` with the displayed alias:

> Use Tabro with mintwave. Create a workspace for this task and search for coffee shops.

Keep the browser open. Tabro can automate its workspaces, while you or AdsPower retain responsibility for opening, closing and configuring the profile's proxy. Two agents using the same account should each request their own workspace in this same profile.

## Verification

### A connected profile and a successful browser action confirm setup

Ask:

> Use Tabro to list my profiles. Pick a connected profile, create a workspace, open example.com, and tell me the page title.

Success means the agent discovers Tabro's **22 tools**, sees the expected profile alias, obtains its own workspace and reads the page. A healthy Broker alone does not prove the extension is connected. For two agents, repeat in separate sessions and confirm they get separate tab groups.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| No Tabro tools in Hermes | Enable the plugin in the active Hermes profile, keep `TABRO_BROWSER_PATH` available, and reload MCP. An old `mcp_servers.tabro` entry takes precedence over the plugin; migrate that entry using the plugin guide. |
| MCP connects but the profile list is empty | Create a managed profile through MCP or load the extension into an open browser profile. |
| Extension cannot find the Native Host | Run setup under the browser's Windows user with Native Messaging registration enabled. `-SkipNativeRegistration` is for isolated tests. |
| Extension is disconnected | Confirm the Broker is running, keep Native companion selected, and check the error shown in Extension options. If setup reports another installation's registration, follow its diagnostic before replacing it. |
| A user-owned profile cannot be opened or stopped through MCP | Open or close it in Chrome, Edge or AdsPower; then acquire a workspace after it connects. |
| Profile is connected but automation is paused | Inspect its automation status and use the authorized resume action. Connection and automation pause are separate states. |
| Broker and adapter versions differ | End active work, update participating clients together, and rerun the matching package's setup. See the [update procedure](./integrations/hermes/README.md#updates). |

For source builds, see [the repository installation instructions](./README.md#the-installer-builds-registers-and-prepares-the-local-runtime). For profile proxies, see [proxy setup](./integrations/hermes/README.md#proxies).
