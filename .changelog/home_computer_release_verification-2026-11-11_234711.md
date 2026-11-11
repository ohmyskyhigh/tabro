# Home computer release verification

## Objective

Use the home computer runners to verify the Tabro v0.5.0 release repairs.

## Changes

Located the online ThreadWave repository-scoped Windows and Linux runners and confirmed they are not registered to Tabro. On this Apple Silicon Mac, ran the packaged installer/dashboard and input-recovery tests with Chrome for Testing 157.0.8103.50. Corrected the input fixture's headless viewport after reproducing an off-screen scroll target. Prepared release workflow changes for a pinned macOS test browser and signed official Ubuntu package sources, added recovery diagnostics, and corrected Windows short-path comparison in the installer test. Checked TypeScript, ESLint, workflow YAML and patch whitespace.

## Result

The packaged macOS installer/dashboard test and input-recovery test pass locally. Windows and Linux runner verification remains outstanding: those runners belong to ThreadWave, and this Mac is logged out of Tailscale. The local changes are uncommitted; the v0.5.0 GitHub release has not been published.
