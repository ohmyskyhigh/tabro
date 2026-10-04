# Hermes plugin delivery record

Date: 2026-10-04. Parent: [Hermes delivery plan](./README.md). The user authorized publication and catalog submission after confirming the official portable-plugin design and support for multiple Hermes profiles.

## Scope

### The Windows package includes the runtime needed by a new Tabro installation

The `integrations/hermes` package contains portable manifests, the browser workflow skill, setup/launch/stop scripts and a version-matched runtime payload. Hermes downloads the pinned Git package; setup installs its Broker, adapter, Native Host and extension, and downloads a fixed, checksum-verified Node dependency when needed. Catalog code excludes the standalone updater. This package supports Windows x64 with the qualified Chrome version recorded in its manifest.

### Named Hermes profiles retain separate sessions while sharing one daemon

Each selected Hermes profile enables its own plugin and adapter. Its `PLUGIN_ROOT` selects its installed scripts; the shared runtime lives outside `HERMES_HOME` and `PLUGIN_DATA`. Installation and startup share a lock. Repeated setup reuses a compatible Broker; an incompatible plugin fails without replacing another profile's running release. Setup leaves Hermes profile configuration unchanged.

## Verification

### Automated checks and isolated installations passed with explicit browser limits

- `pnpm verify`: lint, typecheck, 246 tests, two simulated E2E tests and builds passed. The running Native Host locked the standard output; the helper compiled a temporary binary and reported that its source was not newer than the installed output.
- Nine Windows installation checks passed, including actual Hermes discovery in two isolated named profile homes, concurrent setup/connections, session separation, disconnect independence, release mismatch, failure rollback, encrypted fixture credentials and refusal to stop an unrelated process. Teardown exercised the guarded stop script.
- A separate isolated installation downloaded and verified the pinned Node archive without preinstalled Node being supplied to setup.
- Tests skipped Native Host registry replacement to preserve ongoing browser work. They do not establish clean-machine extension pairing or support for other Chrome builds. Existing proxy browser evidence remains in the [closed-Profile amendment](../profile-proxy-2026-10-03/closed-profile-amendment.md).
- Hermes portable validation passed with `caution`: the native executable, bundled validator `env ||` expressions and SQLite `.exec()` calls triggered findings. The latter two are not environment dumping or shell execution; warnings remain visible for upstream review.
- The SDK schema validators are separate bundled modules. Their embedded GitHub schema identifiers are preserved without combining them with Tabro filesystem services; the catalog's per-file self-updater check can distinguish these modules, and the Broker and adapter share the server validator.
- A clean committed checkout matched all 52 runtime payload hashes and 67 source fingerprints. The actual Hermes CLI installed the public Git URL at the pinned SHA into an isolated `HERMES_HOME`; the installed payload hashes matched. The install scanner remained enabled, its disclosed caution findings were reviewed, and the fixture was left disabled.

## Publication

### Catalog admission remains an upstream decision after publishing the release commit

The [Hermes 0.4.0 preview release](https://github.com/ohmyskyhigh/tabro/releases/tag/hermes-v0.4.0) publishes source and runtime bytes at `5c51e8c9160939ec35b2d3fbda295cdc69873701`. Its plugin ZIP is 1,075,223 bytes; the release includes a SHA-256 checksum file. It is a prerelease so it does not replace the standalone updater's latest stable release.

[Hermes catalog PR #132619](https://github.com/NousResearch/hermes-agent/pull/132619) adds only `plugin-catalog/tabro.yaml`, with that exact SHA and `subdir: integrations/hermes`. The official local structural validator accepted all 405 catalog files. The PR and README disclose browser/account access, the Node download, background processes, registry writes and encrypted credentials. At submission, upstream workflows report `action_required` pending maintainer authorization; local checks are not represented as upstream CI success. Catalog admission, provider-menu integration, macOS/Linux installation and a fresh-VM browser walkthrough remain separate milestones.
