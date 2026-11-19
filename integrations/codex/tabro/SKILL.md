---
name: tabro
description: Use Tabro to operate a browser workspace bound to the current Codex chat.
---

Run the installed Tabro adapter through the shell tool so it receives the
current chat's `CODEX_THREAD_ID`. If it is absent, report that identity is
unavailable. For each invocation set `TABRO_RUNTIME=codex` and set
`TABRO_RUNTIME_SESSION` to the value of `CODEX_THREAD_ID` in that shell.
Use the installed adapter path configured in `TABRO_ADAPTER_ENTRY`. Never
invent a thread ID or use a machine-wide session ID.

Invoke Node with the adapter and `--list-tools` to read its tool names and input
schemas. Pipe a JSON object to the adapter with `--call <tool>` to call a tool.
Poll accepted requests with `get_browser_request`. Tabro reuses this chat's workspace.

On Human Simulation Mode sites, observe with screenshots, targeted read-only DOM
commands, or guarded Runtime.evaluate that returns plain data (scroll first, then
read). Use CDP input events to interact: Tabro spaces them, draws human pointer and
wheel paths, and requires the tab to be active in a focused window (one
Page.bringToFront when needed). Hover, scroll and dwell before leaving a read page,
and page listings by clicking. Act on any input recovery instructions on the request
ticket. If Tabro reports HUMAN_VERIFICATION_REQUIRED, stop, ask the user to complete
the challenge in that browser window, and only resume after their confirmation.
