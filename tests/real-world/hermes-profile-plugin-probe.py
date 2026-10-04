"""Load the fixture's plugin through an installed Hermes, without starting an agent."""

import json
import sys

# The opt-in qualification command supplies the installed Hermes source tree.
sys.path.insert(0, sys.argv[1])
import hermes_bootstrap  # noqa: E402, F401
from hermes_cli.plugins import PluginManager  # noqa: E402

manager = PluginManager()
manager.discover_and_load()
config = manager.get_portable_mcp_servers().get("tabro")
if config is None:
    raise RuntimeError("The selected Hermes profile did not load the Tabro plugin")
print(json.dumps(config))
