import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

type JsonObject = Record<string, unknown>;

export function assertFreshProbeRoot(path: string): void {
  if (existsSync(path)) throw new Error('Probe output already exists; use a new run ID.');
}

export function probeIdentityHash(key: JsonObject, previous = ''): string {
  if (typeof key.x !== 'string' || typeof key.y !== 'string') throw new Error('Extension public identity missing.');
  const hash = createHash('sha256').update(`${key.x}:${key.y}`).digest('hex');
  if (previous && hash !== previous) throw new Error('Extension identity changed on reopen.');
  return hash;
}

export function assertProbeConnectionStatus(status: JsonObject): void {
  if (status.connectionStatus === 'error') {
    throw new Error(`Extension connection failed: ${String(status.lastError ?? 'unknown native transport failure')}`);
  }
}

/** Browser-level experiment connection; website work must use the Tabro MCP. */
export class ChromeProbeControl {
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (value: JsonObject) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', data => {
      let message: { id?: number; result?: JsonObject; error?: { message?: string } };
      try { message = JSON.parse(data.toString()) as typeof message; } catch { return; }
      if (message.id === undefined) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message ?? 'Chrome protocol error'));
      else request.resolve(message.result ?? {});
    });
    socket.on('close', () => this.failPending(new Error('Chrome management connection closed.')));
    socket.on('error', error => this.failPending(error));
  }

  static async connect(url: string): Promise<ChromeProbeControl> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') throw new Error('Expected loopback Chrome endpoint.');
    const socket = new WebSocket(url, { handshakeTimeout: 5_000 });
    const control = new ChromeProbeControl(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return control;
  }

  send(method: string, params: JsonObject = {}, sessionId?: string): Promise<JsonObject> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chrome management connection not open.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome protocol timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async disconnect(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 2_000);
      this.socket.once('close', () => { clearTimeout(timer); resolve(); });
      this.socket.close();
    });
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
