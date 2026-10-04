# Tabro for Hermes

Local Chromium browser automation across persistent profiles, with session-owned tab-group workspaces and authenticated HTTP, HTTPS and SOCKS5 proxies. All Tabro components are MIT-licensed open source.

## Installation

### The plugin includes the Broker and first-time setup installs its runtime

This package supports **Windows x64**, Windows PowerShell 5.1 or later, and compatible **Chrome, Chromium or Microsoft Edge 153+** browsers. Node is prepared by setup; a preinstalled Tabro Broker is not required. The version floor admits newer builds; runtime checks still require the Chromium engine, `Extensions.loadUnpacked`, the expected extension identity and a connected extension before a Profile becomes ready. Other Chromium derivatives must meet the same checks; compatibility is not implied by their name alone.

### Select a browser before Hermes installs or enables the plugin

Set `TABRO_BROWSER_PATH` to the absolute executable path of the browser you want Tabro to use. For example, with Edge:

```powershell
$env:TABRO_BROWSER_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
[Environment]::SetEnvironmentVariable('TABRO_BROWSER_PATH', $env:TABRO_BROWSER_PATH, 'User')
```

For Chrome, a common path is `C:\Program Files\Google\Chrome\Application\chrome.exe`; custom install paths are accepted. Start Hermes from this shell, or restart Hermes so it inherits the saved variable. Keep this variable available for later plugin discovery and enablement, including each named Hermes profile.

The official Hermes application declaration checks that this selected file exists on Windows and reads its PE file version, requiring `153.0.0.0` or newer. An unset path, missing browser, older version or unsupported OS is refused before installation replaces the plugin tree. This uses Hermes's existing declaration format without requiring Chrome alongside Edge. The package remains Windows x64; this OS-level gate does not establish ARM64 compatibility.

Install and enable the plugin through Hermes. Before catalog admission, choose the full 40-character release commit from the repository and install its plugin subdirectory:

```text
hermes plugins install "ohmyskyhigh/tabro#integrations/hermes" --ref <full-commit-sha> --no-enable
hermes plugins enable tabro
```

After catalog admission:

```text
hermes plugins install tabro
hermes plugins enable tabro
```

Find this plugin's installed location with `hermes plugins list`, then run its setup script:

```powershell
powershell.exe -NoProfile -File "<installed-plugin-directory>\setup.ps1" -DownloadNode
```

Hermes downloads the Broker, adapter, Native Host and extension as part of the pinned plugin package. Setup verifies and installs those files into `%LOCALAPPDATA%\Tabro`, downloads the fixed Node 22.22.3 dependency from nodejs.org if needed, verifies its SHA-256 and starts the local Broker. All Hermes profiles using this installation share that Broker and retain separate MCP sessions. Setup can reuse the exact verified Node executable with `-NodePath` instead of downloading it.

Reload Hermes MCP or start a new session after setup. The first MCP connection before setup returns an installation diagnostic. `-InstallRoot` selects an alternate installation; set `TABRO_INSTALL_ROOT` to the same path in the Hermes launch environment. `-BrowserPath` selects a browser explicitly (`-ChromePath` remains an alias). Repeat setup preserves the installation's recorded browser; changing it requires stopping the shared Broker first. Without a saved selection, setup uses `TABRO_BROWSER_PATH`, then searches common Chrome, Edge and Chromium locations. Standalone setup discovery does not replace Hermes's pre-install environment requirement.

### Named Hermes profiles share the daemon and enable their own plugin connections

Install and enable Tabro in each Hermes profile that should use it. For example, after catalog admission:

```text
hermes -p tabro-1 plugins install tabro
hermes -p tabro-1 plugins enable tabro
hermes -p tabro-2 plugins install tabro
hermes -p tabro-2 plugins enable tabro
```

Use the plugin directory returned by `hermes -p <name> plugins list` for that profile's setup. Within an agent session, preserve the active `HERMES_HOME` and use the loaded skill's plugin directory; do not assume the default `~/.hermes` home. Hermes supplies `PLUGIN_ROOT` and profile-scoped `PLUGIN_DATA` to MCP processes. Setup does not rewrite any Hermes profile's configuration or enable plugins in other profiles.

The shared installation belongs to the Windows user at `%LOCALAPPDATA%\Tabro`, outside every Hermes home and `PLUGIN_DATA`. It does not depend on which profile starts first or on that profile's working directory. Setup from another profile reuses the compatible daemon and credentials; setup and launch share a lock to prevent concurrent installation/startup races. For a custom location, use the same **absolute** `TABRO_INSTALL_ROOT` in every participating profile's process environment.

Each connection gets its own adapter and session workspace authority. Closing a profile's MCP connection leaves the daemon and other profiles' connections running. All participating plugin copies must match the installed runtime; a mismatched copy returns a setup diagnostic instead of replacing another profile's running daemon. Update the participating profiles together after active browser work ends. An old `mcp_servers.tabro` entry must be migrated in each affected profile because it takes precedence over that profile's plugin connection.

### Browser-owned data stays outside the plugin directory

Broker-owned profiles automatically load the included extension when created or opened. For an existing user-owned browser profile, enable developer mode in `chrome://extensions` or `edge://extensions` and load the extension directory reported by setup. Its paired alias is the Profile's name. A user-owned profile supports workspace automation after connection; MCP cannot launch it or configure its proxy.

An existing `mcp_servers.tabro` configuration wins over the plugin's MCP server. Back up and remove only that old entry when migrating to this plugin. Setup refuses to overwrite a different Native Host registration unless you explicitly pass `-ReplaceNativeRegistration` after its browser work has ended. `-SkipNativeRegistration` is for isolated installation tests and does not qualify browser readiness.

## Browser automation

### Twenty-two MCP tools preserve profile and workspace ownership

The plugin supplies the `tabro` MCP server and the `tabro-browser` workflow skill. Discover Profiles, create or open a broker-owned Profile, acquire a session workspace and use returned tab references for CDP commands. Poll asynchronous request tickets. Separate agents can share a browser through their own tab groups. Commands, events, screenshots and mouse input use the extension's managed-tab CDP scope.

No remote-debugging port is exposed to agents. Tabro uses a private lifecycle connection to prepare and normally close its broker-owned browser instances; website automation runs through the extension's `chrome.debugger` API.

## Proxies

### HTTP(S) and SOCKS5 support username and password authentication

Proxy configuration applies to a **closed broker-owned Profile**. Finish its work, close it, read the current proxy revision, set or clear the proxy, reopen explicitly, then check its observed exit IP. Saving configuration alone does not prove routing. Regular profile traffic is supported; this is not a system VPN or an incognito proxy manager.

To provision credentials locally, run `proxy-credential.ps1` from this plugin directory. It prompts for a username and hidden password, encrypts them with Windows DPAPI for the current user and prints an opaque `credential_ref` for MCP. No proxy provider, endpoint or customer credential is included in the plugin. Credentials are never put in MCP configuration or command arguments.

## Updates

### Catalog updates determine the installed code version

The plugin contains no Tabro self-updater and does not fetch a moving latest release. Its runtime payload and file hashes are part of the reviewed Git revision. Finish browser work in all participating Hermes profiles and disconnect their Tabro MCP connections, then run this plugin's `stop.ps1`. It verifies the recorded process and Broker identity and refuses to stop a Broker reporting active work. Update through Hermes, update the other participating plugin copies and run the new plugin's `setup.ps1`. Setup preserves browser data and rejects mixing a running release with a different package. Reload Hermes MCP afterward.

Disabling or uninstalling the Hermes plugin disconnects that integration. It leaves the shared Broker installation, browser profiles and encrypted credentials on disk so another client can continue to use them.

## Disclosures

### The plugin controls local browsers and runs a shared background Broker

- **Network:** Setup can download the pinned Node archive from `nodejs.org`. The Broker and Native Host use loopback listeners; browser traffic reaches sites selected by the user or agent, optionally through the configured proxy. Exit checks contact `https://api.ipify.org`. Tabro has no added telemetry.
- **Local files:** Setup writes its user-owned installation directory and Chrome, Edge and Chromium Native Messaging registration under HKCU. The Broker stores its database, logs, managed browser profiles, local authentication token and encrypted proxy credentials in the installation data directory. The Native Host reads adjacent runtime discovery metadata.
- **Processes:** Setup invokes PowerShell, curl, Windows ACL tooling and Node, and starts a hidden background Broker. MCP connections start their own adapter. Authorized profile lifecycle operations launch and close Tabro-owned browser processes.
- **Browser access:** The extension needs debugger, tabs, tab groups, Native Messaging and proxy permissions, plus local-host and exit-check host access. It can act on signed-in sites in the workspace selected by the user or agent. It does not extract another client's OAuth token store; operators should still treat browser control as access to the accounts logged in to those profiles.
- **Package:** The payload includes a Windows Native Host executable and bundled JavaScript dependencies. Readable source, build tooling and dependency notices are public in the Tabro repository; `runtime/build-inputs.json` and `runtime-manifest.json` record source and payload fingerprints. Third-party dependencies retain their own licenses.

## Development

### The payload is built from the version-matched source tree

From the Tabro repository root, run `pnpm install --frozen-lockfile`, `pnpm verify`, then `pnpm stage:hermes`. Commit the generated runtime and manifest together with the source. Validate the resulting directory with `hermes plugins validate integrations/hermes --install-deps` before catalog submission. The official catalog entry uses this directory as its `subdir` and pins the complete Git SHA. The SDK's schema validators are bundled separately from filesystem services; their GitHub URLs identify embedded JSON schemas and do not fetch updates.

### Installation qualification exercises two independent Hermes profile homes

On a compatible Windows machine, set `TABRO_TEST_HERMES_INSTALL=1` and run `pnpm exec vitest run tests/real-world/hermes-plugin-installation.test.ts`. To also exercise Hermes's actual plugin discovery and launch configuration, set `TABRO_TEST_HERMES_SOURCE` to its installed source directory and `TABRO_TEST_HERMES_PYTHON` to the interpreter with that installation's dependencies. These paths are test inputs, not plugin prerequisites.

The suite uses two isolated named profile homes and plugin copies, concurrent setup and MCP connections, a shared temporary user-data root, and paths containing spaces and non-ASCII text. It checks session separation, repeat setup, one profile disconnecting, mismatched releases and encrypted credential provisioning. It leaves existing Hermes configurations and Native Host registrations untouched. This is installation/MCP qualification; browser extension pairing still needs its separate real-browser checks.
