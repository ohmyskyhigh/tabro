# Source-of-truth audit and synchronization

## Scope

### The user requested a complete documentation check followed by synchronization

On 2026-10-02 the user authorized checking and updating the source of truth after the initial drift report. The audit inspected the canonical Product → User Experience → User Interface → System → Components → Files chain, navigation, public English/Chinese guides, adapter and Demo guidance, and supporting plans and change records against the current working tree. Historical plans and release evidence retain their original scope; they do not become current implementation claims.

## Applied changes

### The canonical chain now includes the shared runtime and the complete Profile contract

System now records dynamic MCP/relay listeners, runtime discovery version 1, instance validation, pre-call adapter reconnection, native discovery precedence, startup exclusion and Demo reuse. Components and the repository map assign those responsibilities to existing source and verification paths, including migration utilities and managed Profile support.

MCP navigation and explanatory prose now consistently describe contract version 2 with eighteen tools: thirteen asynchronous submissions, four reads and one terminal close. Profile references, caller-provided creation keys, principal authority, Profile pagination and bounded lifecycle waits are distinguished from workspace/raw-CDP rules. The JSON Schema and runtime tool contract were not changed by this documentation synchronization.

### Operator instructions use actual discovery addresses and preserve historical release boundaries

English and Chinese quick starts direct current-feature users to the source installation. Health examples read the actual runtime record, ordinary registrations use a runtime-file path and separate credential file, and the environment example uses dynamic ports. Historical `v0.3.0` package instructions are explicitly separated from the current source and discovery-capable package requirements.

Demo guidance separates shared Broker/Profile data from per-run fixtures and evidence, explains fixture-only shutdown, and records the saved-URL caller's restart workaround. The vault entry and plan index distinguish completed migrations from pending Plugin, cross-platform and upstream menu work. Navigation now links preserved directory README files directly.

## Implementation gaps

### Unimplemented helpers and older conformance requirements remain visible follow-up work

[Runtime conformance follow-up](../80-Plans/runtime-conformance-follow-up-2026-10-02/README.md) records five areas with source evidence and acceptance conditions:

- readiness validation still expects literal URLs in generated handoffs and the standalone preflight retains fixed-port defaults;
- the Demo caller forwards a saved MCP URL rather than its saved discovery path;
- isolated physical probes do not provision native discovery independently of the shared deployment;
- the general Broker lacks the documented global/per-endpoint worker and queue limits;
- log rotation, audit expiry and event age/count pruning are not implemented in the inspected runtime.

The existing requirements remain canonical. Their implementation status is now explicit instead of being inferred from design prose or unrelated passing tests. This task changed documentation and the environment example; it did not implement those runtime follow-ups or modify live registrations, databases or browser sessions.

## Verification

### Source, contract and link checks establish the scope of this documentation update

The initial inventory covered 108 Markdown files, including historical supporting documents. The final inventory contains 110 after adding this audit and the follow-up plan. Local Markdown file links, canonical implementation paths and heading anchors all resolve; the vault has no documents unreachable from its entry links. Structural checks found no malformed headings or unclosed code fences. All eighteen catalog tools have both input and output schema roots.

Six selected Vitest files passed all 20 tests: public documentation, MCP v2 contract, Profile management contract, runtime discovery, native runtime discovery, and Tabro configuration compatibility. The Windows native discovery test ran successfully rather than skipping. Python migration discovery passed all 17 tests. No physical Chrome journey, installer deployment, cross-platform qualification, remote publication or live configuration migration was performed by this audit.

The public-documentation tests were rerun after the final files were added and passed both checks. `git diff --check` passed. Private audit scratch files remain under ignored `artifacts/doc-audit-20261002/`; they are not another documentation authority.

Parent: [Vault changelog](./_MOC.md).
