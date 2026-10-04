import type { RelayV2PayloadByType } from '../../../../shared/protocol/src/index.js';

export type ExtensionOperationType =
  | 'PROFILE_PROXY'
  | 'CREATE_TAB'
  | 'GROUP_TABS'
  | 'MOVE_TAB'
  | 'RENAME_GROUP'
  | 'ATTACH_DEBUGGER'
  | 'SEND_CDP'
  | 'DETACH_DEBUGGER'
  | 'RECONCILE_ATTEMPT';

export interface ExtensionConnectionSnapshot {
  endpointRef: string;
  connectionGeneration: number;
  inventoryGeneration: number;
  connected: boolean;
  profileProxy?: boolean;
}

export interface ExtensionEventSink {
  onInventory(endpointRef: string, payload: RelayV2PayloadByType['INVENTORY_SNAPSHOT']): void;
  onCdpEvent(endpointRef: string, payload: RelayV2PayloadByType['CDP_EVENT']): void;
  onDebuggerDetached(endpointRef: string, payload: RelayV2PayloadByType['DEBUGGER_DETACHED']): void;
  onDisconnected(endpointRef: string, connectionGeneration: number, reason: string): void;
}

/**
 * Transport-neutral extension boundary. Browser identifiers remain private on
 * this port and are never copied into an MCP result.
 */
export interface OctopusExtensionPort {
  setEventSink(sink: ExtensionEventSink): void;
  connection(endpointRef: string): ExtensionConnectionSnapshot | null;
  requestInventory(
    endpointRef: string,
    afterInventoryGeneration: number | null
  ): Promise<RelayV2PayloadByType['INVENTORY_SNAPSHOT']>;
  execute<Type extends ExtensionOperationType>(
    endpointRef: string,
    type: Type,
    payload: RelayV2PayloadByType[Type]
  ): Promise<RelayV2PayloadByType['OPERATION_RESULT']>;
}

