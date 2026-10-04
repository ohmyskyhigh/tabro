# System MOC

Authority level: System.

This level owns end-to-end flows, system boundaries, domain and data ownership, cross-component invariants, reliability, recovery, observability, and the internal policies that realize the confirmed Product, User Experience, and User Interface contracts.

Status: confirmed as the implementation baseline and ready for Component decomposition.

## Canonical architecture

### One broker coordinates ticketed extension-backed CDP across many profiles and agents

[`System-Architecture.md`](./System-Architecture.md) defines:

- broker-owned routing, status, request, event, and audit truth;
- automatic extension-initiated local pairing with a readable correlation code, persisted-key reconnect authentication, and one endpoint per browser profile;
- verified GitHub Release installation behind versioned runtimes, stable local launchers, and a one-reload extension version gate;
- public logical windows, workspaces, tabs, requests, and cursors over private browser generations;
- thirteen acknowledgement-gated submissions, four immediate reads, and terminal close;
- exact distinct-endpoint workspace allocation and existing-window selection;
- versioned managed-tab CDP capability enforcement through `chrome.debugger`;
- full-cycle per-tab FIFO lanes, scoped controls, ownership epochs, and orderly termination;
- durable restart, reconnect, cursor, debugger-detach, and human-resolution recovery; and
- bounded scheduling, retention, logging, and explicit payload failures.

### Real-world evidence may tune implementation parameters without redefining invariants

Worker counts, queue bounds, retention amounts, status thresholds, polling guidance, capability fixtures, and runtime adapters are initial System defaults. Codex, Hermes, Chrome, and AdsPower evidence may revise them through a proposal when public behavior remains compatible.

The accepted historical proposal remains at [`../90-Proposals/System-Architecture.md`](../90-Proposals/System-Architecture.md).

The shared-runtime topology in `System-Architecture.md` owns dynamic listener discovery, instance validation, client reconnection, startup exclusion and Demo reuse. Its Profile lifecycle section owns principal-scoped identities, bootstrap binding and lifecycle serialization. These realize the existing agent journey without changing the twenty-two-tool contract.

Parent: [`03-User-Interface`](../03-User-Interface/_MOC.md).

## Profile networking

### Profile proxy support follows the accepted network decision

The [Profile proxy decision](../90-Proposals/Profile-Proxy.md) permits authenticated HTTP, HTTPS and SOCKS5 configuration only for closed broker-owned Profiles. The canonical owner in this directory defines its layer; [the implementation plan](../80-Plans/profile-proxy-2026-10-03/README.md) and implementation report track delivery evidence.
