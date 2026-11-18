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

On Human Simulation Mode sites, take screenshots to observe the page and use
read-only DOM commands for specific elements. Use CDP input events to interact
and follow any input recovery instructions on the request ticket.
