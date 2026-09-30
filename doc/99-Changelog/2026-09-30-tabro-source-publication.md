# Tabro source publication

## Authorization

### The user requested updated README files and a GitHub push

On 2026-09-30 the user instructed “README啥的也都改了吧。推送”. The source publication includes the approved Tabro rename, MCP-managed Profile lifecycle, persistent custom pairing labels, Hermes all-profile registration, and their documentation and verification support. The target repository is `ohmyskyhigh/tabro` on `main`.

## Documentation

### Current public guidance uses Tabro and describes all eighteen tools

English and Simplified Chinese README files, current architecture guidance, package and extension metadata, contribution and security guidance, MCP registration instructions, repository links, and updater defaults use the new name. The README tool tables include list/create/open/stop Profile operations as well as workspace and CDP tools. They distinguish the current source tree from the previously published `v0.3.0` installation package, which retains its former name and fourteen-tool contract. Historical evidence and compatibility identifiers keep their original spelling.

## Verification

### The full source gate and publication audit passed

`pnpm verify` passed lint, typechecking, 180 non-E2E tests, two E2E tests, and extension, TypeScript, and native builds. The native source compiled successfully in a temporary location while the unchanged running companion retained its existing locked executable. Staged whitespace checks passed, and all eighteen tool names were checked against the English and Chinese tool tables.

The publication audit checked staged text against both known local Broker tokens and common credential patterns without printing credential contents. It found no credential or local identity matches and no generated or private files. Root artifact output is now ignored along with runtime databases, browser data, build output, and local environment files. A source push does not create a new version tag or packaged GitHub Release.
