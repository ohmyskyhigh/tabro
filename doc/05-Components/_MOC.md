# Components MOC

Authority level: Components.

This level owns the deployable or operational owner of each confirmed System responsibility, including its interfaces, state ownership, dependencies, and component-level operation.

Status: confirmed for the implementation baseline.

## Canonical decomposition

### Eight components assign every System responsibility to one operational owner

[`Component-Architecture.md`](./Component-Architecture.md) defines Broker Runtime, MCP Gateway, Broker Core, Durable Store, Extension Gateway, Browser Extension, Protocol Contract, and Setup and Qualification.

The design preserves one broker consistency boundary while separating transport adapters, browser execution, persistence, schemas, release/update operations, and verification. Component dependencies point toward Protocol Contract and Broker Core decisions; gateways and storage never become alternate policy owners.

The physical repository nests broker-owned components under `apps/broker`, keeps independently launched or loaded programs as sibling app directories, keeps the shared wire contract under `apps/shared/protocol`, and reserves root `dist/` for generated artifacts.

Profile Manager and ProfileRequestService are Broker-owned responsibilities within this decomposition. Broker Runtime owns startup/discovery publication; Protocol Contract owns discovery validation; MCP and native transport adapters consume it; Setup and Qualification owns shared launch, Demo preparation and explicit migrations.

## Evidence-driven revision

### Component internals may change when public behavior and ownership remain stable

Real runtime evidence may split or combine internal modules, replace a transport adapter, tune worker topology, or alter storage indexes through a Component proposal. Moving routing, status, ownership, lifecycle, or recovery truth out of Broker Core requires System review.

Parent: [`04-System`](../04-System/_MOC.md).
