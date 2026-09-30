declare const brokerReferenceBrand: unique symbol;
declare const privateRelayIdentifierBrand: unique symbol;
declare const generationBrand: unique symbol;

/**
 * Opaque references are issued by Broker Core and echoed unchanged across MCP.
 * The brand is compile-time only: public code must never decode routing data from it.
 */
export type BrokerIssuedRef<Kind extends string> = string & {
  readonly [brokerReferenceBrand]: Kind;
};

/** Opaque cursors are scoped snapshots, not parseable offsets. */
export type BrokerIssuedCursor<Kind extends string> = string & {
  readonly [brokerReferenceBrand]: Kind;
};

export type SessionRef = BrokerIssuedRef<'session'>;
export type LineageRef = BrokerIssuedRef<'lineage'>;
export type ExtensionRef = BrokerIssuedRef<'extension'>;
export type BrowserRef = BrokerIssuedRef<'browser'>;
export type WindowRef = BrokerIssuedRef<'window'>;
export type WorkspaceRef = BrokerIssuedRef<'workspace'>;
export type TabRef = BrokerIssuedRef<'tab'>;
export type RequestRef = BrokerIssuedRef<'request'>;
export type ProfileRef = BrokerIssuedRef<'profile'>;
export type BrowserInstanceRef = BrokerIssuedRef<'browser_instance'>;
export type PaginationCursor = BrokerIssuedCursor<'pagination'>;
export type EventCursor = BrokerIssuedCursor<'event'>;

/**
 * Relay identifiers never cross the public MCP boundary. Separate brands make an
 * accidental public/private assignment a TypeScript error even when both values
 * are represented as strings or numbers on their respective wires.
 */
export type PrivateRelayId<Kind extends string> = string & {
  readonly [privateRelayIdentifierBrand]: Kind;
};

export type EndpointIdentity = PrivateRelayId<'endpoint_identity'>;
export type RelayMessageId = PrivateRelayId<'relay_message'>;
export type AttemptId = PrivateRelayId<'attempt'>;
export type ReconciliationId = PrivateRelayId<'reconciliation'>;
export type CdpSessionId = PrivateRelayId<'cdp_session'>;

export type PrivateGeneration<Kind extends string> = number & {
  readonly [generationBrand]: Kind;
};

export type ConnectionGeneration = PrivateGeneration<'connection'>;
export type InventoryGeneration = PrivateGeneration<'inventory'>;
export type WindowGeneration = PrivateGeneration<'window'>;
export type TabGeneration = PrivateGeneration<'tab'>;
export type TabGroupGeneration = PrivateGeneration<'tab_group'>;
export type AttachmentGeneration = PrivateGeneration<'attachment'>;

export interface PrivateWindowLocator {
  readonly windowId: number;
  readonly windowGeneration: WindowGeneration;
}

export interface PrivateTabLocator {
  readonly tabId: number;
  readonly tabGeneration: TabGeneration;
  readonly windowId: number;
  readonly windowGeneration: WindowGeneration;
}

export interface PrivateTabGroupLocator {
  readonly tabGroupId: number;
  readonly groupGeneration: TabGroupGeneration;
  readonly windowId: number;
  readonly windowGeneration: WindowGeneration;
}

export function asBrokerIssuedRef<Kind extends string>(value: string): BrokerIssuedRef<Kind> {
  if (value.length === 0) throw new TypeError('A broker-issued reference cannot be empty.');
  return value as BrokerIssuedRef<Kind>;
}

export function asBrokerIssuedCursor<Kind extends string>(value: string): BrokerIssuedCursor<Kind> {
  if (value.length === 0) throw new TypeError('A broker-issued cursor cannot be empty.');
  return value as BrokerIssuedCursor<Kind>;
}

