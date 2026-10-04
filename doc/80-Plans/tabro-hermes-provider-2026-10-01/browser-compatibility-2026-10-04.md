# Chromium browser compatibility

## Scope

### The approved browser requirement includes Chrome, Chromium and Microsoft Edge

The user requested compatible Chromium-based browsers rather than a Chrome-only dependency, then authorized implementation, publication and a reply on Hermes PR #132619. This supersedes the exact Chrome-build restriction for managed launch. It does not change Profile ownership, task workspaces, proxy eligibility or the Windows x64 package boundary.

## Delivery

### The existing Hermes application gate can inspect a selected executable

Declare the `tabro` server's Windows application at `%TABRO_BROWSER_PATH%`, read its version using `pe_resource`, and require `153.0.0.0` or newer. Document setting this environment variable before installation and keeping it available to Hermes. This accepts a chosen Chrome, Chromium or Edge installation without inventing an unsupported alternatives schema or requiring multiple browsers. CPU architecture and runtime capability checks remain Tabro responsibilities.

### Setup and launch must allow compatible upgrades without weakening process ownership

Setup preserves an existing browser selection, supports `-BrowserPath` with the old `-ChromePath` alias, and discovers common Chrome, Edge and Chromium installations when no selection exists. The launcher checks the Chromium engine floor, loads the extension and verifies its identity; the Profile Manager still waits for authentication and inventory. Process inspection includes custom Chromium executables and requires the recorded PID, creation time, executable path and exact user-data directory for control.

## Verification

### Host admission and real browser behavior need separate evidence

Exercise Hermes's actual installer refusal function for unset/missing paths, older versions, compatible newer versions and real Chrome/Edge executable metadata. Check unsupported operating systems. Run browser selection and process-identity regressions, the repository checks, two named Hermes profile installations, and isolated real Chrome/Edge lifecycle, workspace and authenticated proxy probes. Record results in the corresponding changelog before publishing a new immutable catalog pin.
