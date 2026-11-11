# Repository instructions

## Local installation

### Agents install Tabro on the host that runs the target Chrome profile

Run the installer and register the local MCP adapter on the same host and under the same OS account as the target Chrome profile. Do not install Tabro in an agent sandbox, container, or WSL environment as a substitute for that host. Keep Chrome's own security sandbox enabled. If you lack host access, give the user the host setup steps and report which checks still need to run.

Follow [Getting Started](./GETTING_STARTED.md) for the supported package and MCP registration. For an existing Chrome profile, open `chrome://extensions` in that profile, enable **Developer mode**, and choose **Load unpacked**. Select the installer-reported `extensionPath` folder containing `manifest.json`. In Tabro's **Extension options**, keep **Native companion** selected, wait for **Status: connected**, and confirm the displayed profile alias through `list_browser_profiles`. Verify a browser action from the local MCP session before reporting setup complete. Broker-owned profiles load the extension automatically.

## Documentation headings

Use level-two headings as concise category labels in the document's top-down hierarchy. Do not rewrite a level-two category as a one-line problem, feature, rule, or conclusion statement.

For every documentation file created or revised in this repository, write each level-three heading as a specific, one-line statement of the problem, feature, rule, or conclusion introduced by that section. Do not use a topic label that requires the following paragraph to explain why the topic matters. For example, prefer `### Launching and tracking several debug-enabled browser windows is complex` over `### Browser and port lifecycle complexity`.
