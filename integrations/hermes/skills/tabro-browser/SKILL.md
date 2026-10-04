---
name: tabro-browser
description: Use Tabro to automate Chrome profiles through MCP, coordinate session-owned tab-group workspaces, or configure authenticated profile proxies. Includes first-time Windows setup guidance.
---

# Tabro browser automation

## Setup

### First-time setup installs the included Broker before MCP can connect

This plugin is Windows x64. Locate the installed plugin directory two parents above this skill's directory, or through `hermes plugins list` in the active Hermes profile. Run its `setup.ps1` with PowerShell when the user asks to set up Tabro. It installs the bundled Broker, adapter, Native Host and extension, and can download the pinned Node dependency with `-DownloadNode`. See the plugin README for prerequisites and installation options. Then reload that profile's Hermes MCP or start a new session.

Preserve the active `HERMES_HOME`; never assume setup is running for the default profile. For an explicitly selected profile, use `hermes -p <name> plugins list/install/enable` as appropriate. Every participating profile enables its own plugin, while the Windows user shares one Broker installation outside Hermes homes and `PLUGIN_DATA`. Repeated setup reuses that installation. If using a custom `TABRO_INSTALL_ROOT`, keep the same absolute path in all participating profile launch environments. Do not stop the shared daemon merely because one profile disconnects.

If a different Tabro Native Host is registered, preserve its running work. Explain the setup diagnostic before using the explicit replacement option. An existing `mcp_servers.tabro` entry takes precedence over this plugin: migrate that specific entry with a backup when requested, keeping other MCP servers unchanged.

## Browser work

### Profile launch ownership is separate from workspace ownership

Discover Profiles and use their returned aliases and opaque references. `ownership=broker` allows authorized MCP create/open/stop; `ownership=user` requires the human to launch Chrome before its extension connects. Both use session-owned workspaces. Acquire your own workspace and use its `workspace_ref` and `tab_ref`. Do not invent identifiers or operate another session's tab group.

### Browser commands are asynchronous and remain scoped to a managed tab

Use current tool schemas. Poll accepted `request_ref` tickets to a terminal result. Inspect browser context and permitted CDP methods, then send raw CDP commands and interpret their results. Mouse input uses supported `Input` methods in the chosen managed tab; screenshots use supported `Page` methods. Read events with returned cursors. Never automatically replay an effect reported as ambiguous after a disconnect; use the explicit resolution flow.

## Proxies

### Change a proxy only while its broker-owned Profile is closed

Finish workspace work, stop the broker-owned Profile, read its current proxy revision, then set or clear HTTP, HTTPS or SOCKS5 configuration. Explicitly reopen and check the exit IP after application. Saving a setting is not proof of routing. User-owned Profiles cannot receive Tabro proxy configuration.

Use an operator-provisioned `credential_ref` for username/password authentication. The plugin's `proxy-credential.ps1` prompts locally and stores the secret with Windows DPAPI; it returns only a reference. Do not place credentials in the plugin, skills, SOUL files or command arguments. Honor the user's chosen provider and endpoints; none are preconfigured.
