"""Exercise the real Hermes installer gate without installing or enabling a plugin."""
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

# Keep Hermes bootstrap and any incidental diagnostics outside the user's home.
isolated_home = tempfile.TemporaryDirectory(prefix="tabro-hermes-gate-")
os.environ["HERMES_HOME"] = isolated_home.name
sys.path.insert(0, sys.argv[1])
import hermes_bootstrap  # noqa: E402, F401
from hermes_cli.agent_plugins import load_agent_plugin  # noqa: E402
from hermes_cli.plugins_cmd_install import _refuse_unavailable_portable_plugin  # noqa: E402
from hermes_platform.resolver.availability import availability  # noqa: E402
from hermes_platform.resolver.core import CheckState, Observation  # noqa: E402

root = Path(sys.argv[2]).resolve()
package = load_agent_plugin(root, root.parent / ".gate-test-data")
declaration = package.server_declarations["tabro"].declaration
checks = []

def check(label, state, *, os_family=None):
    result = availability(declaration, os_family=os_family)
    assert result.state == state, (label, result)
    if os_family is None:
        try:
            _refuse_unavailable_portable_plugin("tabro", root)
            assert state == "available", label
        except Exception as exc:
            assert state != "available" and state in str(exc), (label, exc)
    checks.append({"check": label, **result.as_dict()})

with patch.dict(os.environ, {}, clear=False):
    os.environ.pop("TABRO_BROWSER_PATH", None)
    check("unset browser path", "missing_app")
    os.environ["TABRO_BROWSER_PATH"] = str(root / "missing-browser.exe")
    check("missing executable", "missing_app")
    for browser in sys.argv[3:]:
        os.environ["TABRO_BROWSER_PATH"] = browser
        check(Path(browser).name + " real PE version", "available")
    for version, state in [("152.0.0.0", "version_too_old"), ("153.0.0.0", "available"), ("155.1.2.3", "available")]:
        with patch("hermes_platform.resolver.app._pe_version", return_value=Observation(CheckState.PRESENT, version)):
            check("version " + version, state)
    for family in ["linux", "darwin"]:
        check(family, "unsupported_os", os_family=family)
print(json.dumps({"status": "passed", "checks": checks}, indent=2))
isolated_home.cleanup()
