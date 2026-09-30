# Managed Profile lifecycle

## Decision

### The user approved implementation of MCP-managed Profiles and the single-Agent Demo

On 2026-09-27 the user authorized the detailed plan. Product, UX, MCP contract v2, System, Components and Files now include persistent Profile management, with extension-backed website execution and native Tab Groups retained. Broker and adapter expose eighteen tools and reject incompatible contract versions before dispatch.

## Evidence

### Two real three-Profile runs and isolated upgrade rollback have passed

The current Agent completed two real runs, each passing 25 evidence checks. Formal lifecycle probes also confirm Broker restart and retained identity. Full verification passed 178 checks and two E2E tests; the eighteen-tool smoke check passed. A staged installation operated a real Profile through its packaged MCP adapter, refused an upgrade while a Profile was running, and recovered from an injected installation failure. A separately built v0.3.0 runtime was upgraded and restored from a consistent snapshot while retaining new Profile directories and exported metadata.

See the [implementation report](../80-Plans/single-agent-multi-chrome-demo-2026-09-27/implementation-report.md) for artifact paths, test scope, cleanup and implementation differences. The verified browser is Windows Chrome 153.0.8010.53. This is a local development change; no remote release, commit or push was performed.
