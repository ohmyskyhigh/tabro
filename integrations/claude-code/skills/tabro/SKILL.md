---
name: tabro
description: Use Tabro to operate tabs in the current Claude Code chat's browser workspace.
---

Use the Bash tool to invoke Node with the installed Tabro adapter entry in `TABRO_ADAPTER_ENTRY`.
The Tabro plugin supplies identity through the session environment. Preserve it when
launching the adapter, and use one workspace per chat.

Use `bash -c 'node "$TABRO_ADAPTER_ENTRY" --list-tools'` to discover the available
tool names and inputs. Pipe a JSON object to
`bash -c 'node "$TABRO_ADAPTER_ENTRY" --call <tool>'` to call one tool. The inner
shell expands the adapter path after the session environment is loaded. Poll
accepted requests with `get_browser_request`.

On Human Simulation Mode sites, take screenshots to observe the page and use
read-only DOM commands for specific elements. Use CDP input events for interaction
and follow any input recovery instructions on the returned request ticket.
