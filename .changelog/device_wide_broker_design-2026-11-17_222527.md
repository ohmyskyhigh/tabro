# Device-wide Broker Hardening

## Objective

Review and implement one designated Tabro installation per device, test failure and recovery paths on real macOS, and prepare the code for Windows qualification.

## Changes

Reviewed startup, discovery, native hosts, installers, authentication, database merging and release qualification. Implementation was delegated to GPT-6.1 Terra with xhigh reasoning as requested.

Added protected machine registration, one designated desktop account and canonical installation/data roots, and a native lifetime lock held by the actual Broker process. Production startup validates the selected installed release and rejects alternate roots and unsupported account ownership. Discovery uses challenge proofs; relay authentication rejects replay; MCP credentials are sealed per request and bound to the instance, method, path and body.

Added durable maintenance fences, quiescence checks, authenticated self-shutdown, upgrade snapshots, rollback before admission resumes, and fail-closed handling of ambiguous resume outcomes. Installers, source launchers, native companions, credential tools and Hermes use the designated registration. Repeated setup reconciles native registrations and validates installed files. Legacy installations receive an explicit offline migration refusal before launch; the existing getting-started guide explains backup and external browser-profile/configuration/credential limits.

Fixed database merging against the actual migration schemas, including singleton rows, conflicts and live state. Expanded integration, native package and CI checks for exclusivity, crashes, authentication, maintenance and updates. Qualification gates require their host prerequisites rather than silently passing when they are missing.

## Result

The final full source verification passed lint, TypeScript, native build, 327 tests, 11 merge tests and two end-to-end tests; 25 platform/qualification-gated cases were skipped in this ungated source run. The final packaged macOS rerun also passed launcher-only update and damaged-release refusal checks. Windows Hermes qualification was updated to use the designated root, reject legacy state safely, and test registry repair/conflict handling; its Windows-only cases were not executed here.

Real macOS 26.4.1 arm64, Node 22.22.2 and Chrome 157.0.8103.79 passed packaged Chrome/Native/MCP control, dashboard checks, concurrent installers, busy update refusal, snapshot failure recovery, failed startup rollback, successful upgrade, lost resume response handling, input interruption recovery, production-process collision/SIGKILL recovery, stale runtime handling, wrong-root rejection, proof replay rejection, and maintenance persistence. Tests used an isolated installation with the real protected machine namespace, not a production bypass.

After macOS administrator authentication, the production Broker rejected the real `nobody` account before startup. The protected test registration was removed while holding the native machine lock. The packaged unregistered-machine test then passed: startup failed without creating state. The stopped, isolated test installation was removed; qualification evidence and the staged package were retained under ignored artifacts.

The user approved temporary interruption of the original Broker. Its browser processes and workspace were preserved, and it was restarted and verified healthy. Original installation and Chrome Native Messaging files match their saved SHA-256 hashes after cleanup. Implementation and macOS qualification are complete. Windows native/PowerShell behavior and Linux host behavior remain unqualified in this session. No public release was performed.
