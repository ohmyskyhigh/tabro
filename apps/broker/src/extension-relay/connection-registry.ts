import type { WebSocket } from 'ws';

export interface LiveExtensionConnection {
  profileProxy?: boolean;
  targetId: string;
  /** Canonical broker-private endpoint reference. Present on relay-v2 sessions. */
  endpointRef?: string;
  /** Extension-private UUID retained for handshake continuity. */
  endpointId?: string;
  protocolVersion: 1 | 2;
  epoch: number;
  socket: WebSocket;
  connectedAt: number;
  lastHeartbeatAt: number;
  lastProbeAt: number;
  inventoryGeneration: number;
  maxEnvelopeBytes: number;
}

export class ConnectionRegistry {
  private readonly currentByTarget = new Map<string, LiveExtensionConnection>();
  private readonly currentByEndpoint = new Map<string, LiveExtensionConnection>();
  private readonly counters = new Map<string, number>();

  nextEpoch(targetId: string): number {
    const epoch = (this.counters.get(targetId) ?? 0) + 1;
    this.counters.set(targetId, epoch);
    return epoch;
  }

  bind(connection: LiveExtensionConnection): LiveExtensionConnection | null {
    const previous = connection.endpointRef
      ? this.currentByEndpoint.get(connection.endpointRef) ?? this.currentByTarget.get(connection.targetId) ?? null
      : this.currentByTarget.get(connection.targetId) ?? null;
    this.currentByTarget.set(connection.targetId, connection);
    if (connection.endpointRef) this.currentByEndpoint.set(connection.endpointRef, connection);
    return previous;
  }

  get(targetId: string): LiveExtensionConnection | null {
    return this.currentByTarget.get(targetId) ?? null;
  }

  getEndpoint(endpointRef: string): LiveExtensionConnection | null {
    return this.currentByEndpoint.get(endpointRef) ?? null;
  }

  remove(targetId: string, epoch: number): boolean {
    const current = this.currentByTarget.get(targetId);
    if (!current || current.epoch !== epoch) return false;
    this.currentByTarget.delete(targetId);
    if (current.endpointRef && this.currentByEndpoint.get(current.endpointRef) === current) {
      this.currentByEndpoint.delete(current.endpointRef);
    }
    return true;
  }

  removeEndpoint(endpointRef: string, epoch: number): boolean {
    const current = this.currentByEndpoint.get(endpointRef);
    if (!current || current.epoch !== epoch) return false;
    this.currentByEndpoint.delete(endpointRef);
    if (this.currentByTarget.get(current.targetId) === current) this.currentByTarget.delete(current.targetId);
    return true;
  }

  values(): LiveExtensionConnection[] {
    return [...new Set(this.currentByTarget.values())];
  }
}
