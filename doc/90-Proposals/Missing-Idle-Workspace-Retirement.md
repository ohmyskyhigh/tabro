# Missing idle workspace retirement

## Basis

### The existing missing-workspace rule requires stale idle records to stop blocking Profile closure

This is an implementation correction under the confirmed Product rule that a persisted workspace whose browser group and tabs are gone ends. The user's October 3 report and six missing September 30 workspaces demonstrate the defect. The correction does not grant callers ownership of another session's live workspace or permit closure while unresolved requests remain.

## Realization

### Current inventory retires only missing groups with no surviving tracked tabs or unfinished work

Accepted as conformance to the existing Product rule. Broker reconciliation checks a connected current generation and non-stale inventory, proves absence of the group and tracked active tabs, and preserves unfinished workspace requests, acquisition and endpoint controls. A single repository transaction fences the control epoch, ends the workspace, closes its missing tab records, clears its pause causes and records an audit event. Chrome is not mutated during retirement. Profile closure continues through the existing authorized lifecycle tool.
