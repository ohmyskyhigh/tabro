---
name: tabro-browser
description: Use Tabro to automate compatible Chrome, Chromium or Edge profiles through MCP, coordinate session-owned tab-group workspaces, or configure authenticated profile proxies. Includes first-time Windows setup guidance.
---

# Tabro browser automation

## Setup

### First-time setup installs the included Broker before MCP can connect

This plugin is Windows x64. Locate the installed plugin directory two parents above this skill's directory, or through `hermes plugins list` in the active Hermes profile. Run its `setup.ps1 -DownloadNode` with PowerShell when the user asks to set up Tabro. Setup installs the Broker, adapter and extension and verifies the Native Host pinned by the package. See the [plugin README](../../README.md#installation) for prerequisites and installation options. Then reload that profile's Hermes MCP or start a new session.

Run setup on the desktop host as the same OS user as the target browser profile, outside the agent sandbox, container or WSL. Keep the browser's security sandbox enabled. If you lack access to that host, give the user the setup steps and report which checks they still need to run.

Hermes requires `TABRO_BROWSER_PATH` in its launch environment, pointing to the selected Chrome, Chromium or Edge executable with file version 153 or newer. Its application gate rejects a missing/older browser before installation. Setup accepts `-BrowserPath` (`-ChromePath` is an alias) and preserves a shared installation's saved browser on repeat setup. A compatible version alone does not prove readiness: opening a Profile also checks the Chromium engine, extension loading, authentication and inventory. Do not silently substitute another browser after an explicit selection fails.

Preserve the active `HERMES_HOME`; never assume setup is running for the default profile. For an explicitly selected profile, use `hermes -p <name> plugins list/install/enable` as appropriate. Every participating profile enables its own plugin, while the Windows user shares one Broker installation outside Hermes homes and `PLUGIN_DATA`. Repeated setup reuses that installation. If using a custom `TABRO_INSTALL_ROOT`, keep the same absolute path in all participating profile launch environments; `mcp.json` explicitly forwards it to the MCP subprocess. When unset, setup and MCP launch use `%LOCALAPPDATA%\Tabro`. Do not stop the shared daemon merely because one profile disconnects.

If a different Tabro Native Host is registered, preserve its running work. Explain the setup diagnostic before using the explicit replacement option. An existing `mcp_servers.tabro` entry takes precedence over this plugin: migrate that specific entry with a backup when requested, keeping other MCP servers unchanged.

### Existing browser profiles need the extension loaded and verified in that profile

Open `chrome://extensions` in the target Chrome profile or `edge://extensions` in Edge. Enable **Developer mode**, choose **Load unpacked**, and select the `extensionPath` folder reported by setup. In Tabro's extension options, keep **Native companion** selected and wait for **Status: connected**. Match the displayed profile alias with `list_browser_profiles` and verify a browser action from the local MCP session. Broker-owned profiles load the extension automatically when opened.

## Browser work

### LinkedIn feed posts use a separate approval and verification workflow

For preparing or publishing LinkedIn text/image feed posts, use the sibling [tabro-linkedin-post skill](../tabro-linkedin-post/SKILL.md). It retains this skill's workspace ownership and asynchronous ticket rules, adds composer/upload instructions, and requires exact post readback. It does not authorize publication or automatic reposting.

### Profile launch ownership is separate from workspace ownership

Discover Profiles and use their returned aliases and opaque references. `ownership=broker` allows authorized MCP create/open/stop; `ownership=user` requires the human to launch Chrome before its extension connects. Both use session-owned workspaces. Acquire your own workspace and use its `workspace_ref` and `tab_ref`. Do not invent identifiers or operate another session's tab group.

### Browser commands are asynchronous and remain scoped to a managed tab

Use current tool schemas. Poll accepted `request_ref` tickets to a terminal result. Inspect browser context and permitted CDP methods, then send raw CDP commands and interpret their results. Mouse input uses supported `Input` methods in the chosen managed tab; screenshots use supported `Page` methods. Read events with returned cursors. Never automatically replay an effect reported as ambiguous after a disconnect; use the explicit resolution flow.

### Background work is preferred and explicit foreground activation remains available

New managed tabs open without becoming selected. Reuse the task workspace and prefer background observation and navigation. Some websites need visibility or focus to initialize or accept input; explicitly use `Page.bringToFront` when needed. This is a soft preference, not a hard foreground ban or a new approval requirement. Do not bring a page forward before every command or repeatedly restore focus after the user switches away. Interrupted held input still requires the existing recovery procedure; background preference never permits injected page mutations on an input-only domain.

To end a stopped task, acknowledge confirmed released input using the current recovery reference, then call `terminate_workspace`. It can abandon an uncertain command while recording that its effect may have occurred. Do not invent a successful website result just to clean up; termination does not replay input or create a replacement tab.

## Proxies

### Change a proxy only while its broker-owned Profile is closed

Finish workspace work, stop the broker-owned Profile, read its current proxy revision, then set or clear HTTP, HTTPS or SOCKS5 configuration. Explicitly reopen and check the exit IP after application. Saving a setting is not proof of routing. User-owned Profiles cannot receive Tabro proxy configuration.

Use an operator-provisioned `credential_ref` for username/password authentication. The plugin's `proxy-credential.ps1` prompts locally and stores the secret with Windows DPAPI; it returns only a reference. Do not place credentials in the plugin, skills, SOUL files or command arguments. Honor the user's chosen provider and endpoints; none are preconfigured.

## Domain rules

### Listed domains allow observation and require input for manipulation

Use `get_browser_context` with the `tab` view (`workspace_ref`, `tab_ref`) to inspect `interaction_policy` and `input_recovery`. The user edits `data/browser-rules.json` or explicitly asks a host agent to edit it. Each domain includes itself, nested subdomains and all paths. The current top-level URL selects the rule. Do not remove or weaken a rule merely because a browser command is rejected.

On `input_only` sites, use guarded JavaScript, DOM/accessibility reads and screenshots for observation. Use `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` and `Input.insertText` for manipulation. Scripts must not click, focus, scroll, write values, dispatch synthetic events or issue action requests. If guarded JavaScript is refused, follow `INPUT_ONLY_REQUIRED` alternatives such as `DOM.getBoxModel`; do not retry with the guard disabled. Use user handoff for file pickers and unsupported clipboard/composition.

### Native dropdowns need verified keyboard selection and guarded reads may need simpler alternatives

For a native select control, move focus with ordinary Tab input and inspect `document.activeElement` before typing the option's label. On macOS Chrome, this selected the option successfully when key events sent to an already-open native popup did not. Read back the selected value; a successful input acknowledgement alone does not prove selection. Hand unsupported native UI to the user instead of assigning the value with JavaScript.

Chrome can refuse a read-only helper expression such as constructing a URL and reading its search parameters. Read the current URL with `Page.getFrameTree` and parse it outside the website, or use the suggested DOM/accessibility alternatives. Keep the observation guard enabled.

### Interrupted input requires observation and explicit recovery before more actions

Match each press with its intentional release during normal operation. After interruption, never send a cleanup release or repeat the gesture automatically. Inspect the page and the last confirmed input step. Ask the user to finish or cancel held input if reconciliation cannot establish release. Only after that intervention pass the current `input_recovery: {recovery_ref, user_confirmed_released: true}` to `resume_workspace_automation`. An acknowledgement may be recorded while resume still reports an unresolved effect; use `resolve_browser_request` to resolve that effect separately, then resume. Never invent a user confirmation or clear an unrelated pause cause.
