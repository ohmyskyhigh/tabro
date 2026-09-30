# Tabro branding

## Decision

### Tabro replaces the previous public product name

The user approved Tabro on 2026-09-30. The applied name appears in public English and Chinese documentation, current canonical product-through-file guidance, extension manifest and settings, runtime logs and MCP server identification, package metadata, demo labels, and future Windows release asset names. New MCP registrations use `tabro` and generated adapter settings use `TABRO_*`.

## Compatibility

### The rename preserves profiles and existing client connections

The stdio adapter accepts both Tabro and legacy environment names; a nonempty Tabro setting takes precedence for the same field. Token files still override direct tokens, and runtime-supplied session IDs retain precedence over explicit fallback IDs. Extension identity, Native Messaging registration, profile data, protocol and storage identifiers, installation directories, and GitHub addresses remain compatible. The adapter package retains its legacy executable alias alongside `tabro-mcp`.

The updater prefers a Tabro Windows archive and falls back to legacy archive names. Historical plans, proposals, changelog entries, and published social posts retain their original evidence.

## Verification

### Static checks, 182 tests, build output, and live MCP discovery passed

Lint, typechecking, 180 non-E2E tests, two E2E tests, full extension/TypeScript/native build, release staging, and source installation preflight passed. Release staging produced `artifacts/release/tabro-v0.3.1-windows-x64`. The native build compiled successfully in a temporary location because the running companion held its existing binary; its source did not require a binary update.

Thirteen local registrations were renamed in place: Hermes default plus eleven named profiles, and Codex. Parsed configurations were compared before and after to verify that connection and unrelated settings were preserved; timestamped backups were created beside each configuration. The pending Hermes prompts now request `tabro` tools. `hermes mcp test tabro` discovered eighteen tools.

The demo Broker was restarted after confirming that all request tickets were terminal. A read-only MCP check using the built adapter and only `TABRO_*` settings returned the same three Profile references, running instances, nicknames, and connected extensions with `ready: true`. Existing paused historical workspaces were preserved. Chrome windows remained open; their loaded extension labels can retain the old name until the extension is reloaded or the managed Profile is reopened.

The ordinary Broker was left running with its existing work. The remote repository and published releases were not renamed or republished in this task.

## Repository

### The separately approved GitHub rename preserves the existing repository

The user subsequently approved renaming the GitHub repository. GitHub now reports `ohmyskyhigh/tabro` at `https://github.com/ohmyskyhigh/tabro`, with the same repository ID `1349279575`. Both the new API route and the old API route resolve to that identity. The checkout's `origin` fetch and push URLs now use `https://github.com/ohmyskyhigh/tabro.git`; `git ls-remote origin HEAD` succeeded.

Current README and installation links, fresh-clone directory examples, and the updater's default repository use the new address. Existing checkout and Profile paths remain unchanged. Historical records and release asset filenames remain intact; GitHub's release API still lists the `v0.3.0` updater, ZIP, and checksum at the renamed repository. The updater passed PowerShell parsing and the patch passed whitespace checks.

The GitHub repository page was verified at its new address. Following redirects for the historical updater's download URL under `ohmyskyhigh/tabro` returned HTTP 200. The rename operation itself did not commit or push source changes; the subsequent user-authorized source publication is recorded in [`2026-09-30-tabro-source-publication.md`](./2026-09-30-tabro-source-publication.md).
