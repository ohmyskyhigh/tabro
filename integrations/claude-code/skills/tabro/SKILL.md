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

On Human Simulation Mode sites, observe with screenshots, targeted read-only DOM
commands, or guarded Runtime.evaluate that returns plain data (scroll first, then
read). Use CDP input events for interaction: Tabro spaces them, draws human pointer
and wheel paths, and requires the tab to be active in a focused window (one
Page.bringToFront when needed). Hover, scroll and dwell before leaving a read page,
and page listings by clicking. Follow input recovery instructions on the returned
request ticket. If Tabro reports HUMAN_VERIFICATION_REQUIRED, stop, ask the user to
complete the challenge in that browser window, and only resume after their
confirmation.
