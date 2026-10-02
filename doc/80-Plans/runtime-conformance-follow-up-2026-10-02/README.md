# Runtime conformance follow-up

Status: pending implementation. This plan records gaps found during the user-requested source-of-truth audit on 2026-10-02. The documentation update does not mark these tasks implemented or authorize a change to the existing public contract.

## Authority

### Existing contracts define the behavior that these implementation tasks must realize

The parents are [Operational defaults](../../02-User-Experience/Operational-Defaults.md), [System architecture](../../04-System/System-Architecture.md), [Component architecture](../../05-Components/Component-Architecture.md), and [the physical runbook](../../06-Files/Real-World-Runbook.md). The shared dynamic runtime and eighteen-tool MCP contract already exist. These follow-ups complete helpers and older conformance requirements; they are distinct from the pending [Hermes Plugin and Provider work](../tabro-hermes-provider-2026-10-01/README.md).

## Diagnostics

### Preflight must validate runtime-file registrations without requiring a fixed URL

- [ ] Adapt `tests/real-world/setup-readiness-checks.ts`, `tests/real-world/setup-readiness.ts` and `tools/real-world-preflight.ps1` to distinguish runtime-file registration from the legacy URL form. Keep adapter, credential path and caller-identity checks.
- [ ] Extend the existing readiness checks to cover valid discovery handoffs, invalid records, stale or mismatched runtime identity, and legacy fixed URLs. Demonstrate the generated current handoffs pass without embedding the dynamically allocated URL.

Current evidence: the validator requires both Codex and Hermes files to contain `paths.brokerUrl`, while current installers generate `TABRO_RUNTIME_FILE`. The standalone preflight also retains fixed health defaults. Health success alone does not close this gap.

## Demo transport

### The Demo caller must use its saved runtime-file path across Broker restarts

- [ ] Adapt `tools/single-agent-demo-call.ts` to use the manifest's `runtimeFile` with the existing adapter discovery mechanism and preserve its stable caller session and trace configuration.
- [ ] Verify a new call after restart reaches the replacement instance, retains ticket access and never automatically replays a previously dispatched operation. Keep historical manifests without runtime discovery explicitly compatible or reject them with a clear diagnostic.

Current evidence: preparation saves `runtimeFile` and `mcpUrl`, but the caller reads and forwards only the URL. The runbook supplies an explicit URL-refresh workaround pending this fix.

## Physical probes

### Isolated Chrome probes need native routing that cannot select the shared deployment

- [ ] Reconcile `tools/probe-managed-chrome.ts` and `tools/probe-profile-manager.ts` with Native Host's adjacent discovery precedence. Provision and prove an isolated transport path before launching a physical probe; do not overwrite a live shared deployment's discovery record.
- [ ] Run a new scoped physical qualification with the shared deployment present, proving the probe extension reaches only its intended Broker and cleanup preserves the shared runtime.

Current evidence: these probes configure their own relay URL but do not publish isolated native discovery. The native executable uses its adjacent record in preference to the extension-supplied URL. September 27 physical results remain historical evidence.

## Scheduling

### General Broker concurrency and queue bounds need implementation evidence

- [ ] Implement and advertise the approved general worker and queue bounds in the Broker scheduler/admission owner, preserving ticket-first admission, control priority and full-cycle per-tab FIFO.
- [ ] Verify global and per-endpoint saturation, rejection before ticket creation, independent-tab progress and recovery after restart. Do not confuse the implemented three-operation Profile lifecycle bound with the general browser-work limits.

Current evidence: `apps/broker/src/core/octopus/octopus-broker.ts` has per-tab lane, running-worker and lease handling, but does not enforce the System's stated global/per-endpoint worker and pending-queue limits.

## Retention

### Log rotation and audit/event retention need explicit runtime owners and verification

- [ ] Implement the System's log size/age rotation and durable-audit retention requirements without losing open-ticket or recovery evidence.
- [ ] Implement bounded event retention with the already-defined expired-cursor recovery semantics. Verify stream replacement and ownership rules remain intact when data expires.

Current evidence: Broker Runtime creates a redacting Pino logger and scripts redirect streams to files; audit storage appends/lists records, and event storage supports pagination and stream replacement. These paths do not implement the documented rotation or age/count pruning. No bounded disk-usage claim is justified by the current code.

## Completion

### Passing existing tests does not close an untested conformance gap

Each item needs executable regression evidence plus any physical qualification named above. Update its canonical owner and runbook only after the observed behavior is verified. The audit's passing contract, discovery and migration tests establish their tested behavior; they do not count as tests for these missing mechanisms.

Parent: [Development plans](../_MOC.md).
