# Linux release qualification

## Objective

Fix the remaining Linux release check, commit and push the repair, and publish v0.5.0 from the latest verified main.

## Changes

Preserve LANG, LC_ALL and LC_CTYPE in the Unix installation's desktop environment and allow the Broker service to restore LC_CTYPE. MCP's default subprocess environment omits locale variables; after a Broker restart, Linux Chrome otherwise cannot resolve the Chinese extension installation path. Strengthen the packaged installation test to verify authenticated proxy traffic again after the Broker restarts.

## Result

The failed native Linux job reproduced on unchanged main. A sandboxed Linux Chrome 157.0.8103.50 probe reproduced `File path cannot be resolved` without a locale and loaded the same Chinese path successfully with either LANG=C.UTF-8 or LANG=C plus LC_CTYPE=C.UTF-8. The local full source gate passed: lint, type checking, 321 tests, two end-to-end tests, and build. Native four-platform qualification and public release verification remain pending at this commit; publication must use this repaired main rather than the old v0.5.0 tag target.
