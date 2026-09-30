export type RelayTransportKind = 'native' | 'websocket';

export interface RelayTransportClose {
  code: number;
  reason: string;
}

export interface RelayTransport {
  readonly kind: RelayTransportKind;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: (event: RelayTransportClose) => void): void;
  onError(listener: (message: string) => void): void;
}

export const NATIVE_HOST_NAME = 'io.github.ohmyskyhigh.octopus_browser_relay';
const CONNECT_TIMEOUT_MS = 5_000;

function assertLocalRelayUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:')
    || (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1')) {
    throw new Error('Tabro relay transport only permits local ws:// or wss:// broker URLs.');
  }
  return url;
}

class WebSocketRelayTransport implements RelayTransport {
  readonly kind = 'websocket' as const;
  private readonly messageListeners: Array<(text: string) => void> = [];
  private readonly closeListeners: Array<(event: RelayTransportClose) => void> = [];
  private readonly errorListeners: Array<(message: string) => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.messageListeners.forEach((listener) => listener(event.data));
    });
    socket.addEventListener('close', (event) => {
      this.closeListeners.forEach((listener) => listener({ code: event.code, reason: event.reason }));
    });
    socket.addEventListener('error', () => {
      this.errorListeners.forEach((listener) => listener('WebSocket transport failed.'));
    });
  }

  static open(url: string): Promise<WebSocketRelayTransport> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('WebSocket connection timed out.'));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new WebSocketRelayTransport(socket));
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket failed before authentication.'));
      }, { once: true });
    });
  }

  send(text: string): void {
    this.socket.send(text);
  }

  close(code = 1000, reason = 'Extension disconnect'): void {
    this.socket.close(code, reason);
  }

  onMessage(listener: (text: string) => void): void {
    this.messageListeners.push(listener);
  }

  onClose(listener: (event: RelayTransportClose) => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: (message: string) => void): void {
    this.errorListeners.push(listener);
  }
}

interface NativeControlMessage {
  nativeControl: {
    type: 'READY' | 'ERROR' | 'CLOSED';
    message?: string;
    code?: number;
  };
}

function isNativeControlMessage(value: unknown): value is NativeControlMessage {
  if (!value || typeof value !== 'object') return false;
  const control = (value as { nativeControl?: unknown }).nativeControl;
  if (!control || typeof control !== 'object') return false;
  const type = (control as { type?: unknown }).type;
  return type === 'READY' || type === 'ERROR' || type === 'CLOSED';
}

class NativeRelayTransport implements RelayTransport {
  readonly kind = 'native' as const;
  private readonly messageListeners: Array<(text: string) => void> = [];
  private readonly closeListeners: Array<(event: RelayTransportClose) => void> = [];
  private readonly errorListeners: Array<(message: string) => void> = [];
  private opened = false;
  private closed = false;
  private closeCode = 1006;
  private closeReason = 'Native companion disconnected.';

  private constructor(private readonly port: chrome.runtime.Port) {}

  static open(url: string): Promise<NativeRelayTransport> {
    return new Promise((resolve, reject) => {
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      } catch (error) {
        reject(error);
        return;
      }
      const transport = new NativeRelayTransport(port);
      const timer = setTimeout(() => {
        transport.close(1006, 'Native companion connection timed out.');
        reject(new Error('Native companion connection timed out.'));
      }, CONNECT_TIMEOUT_MS);
      port.onMessage.addListener((message: unknown) => {
        if (isNativeControlMessage(message)) {
          if (message.nativeControl.type === 'READY' && !transport.opened) {
            clearTimeout(timer);
            transport.opened = true;
            resolve(transport);
          } else if (message.nativeControl.type === 'ERROR') {
            clearTimeout(timer);
            const detail = message.nativeControl.message ?? 'Native companion failed.';
            if (!transport.opened) reject(new Error(detail));
            else {
              transport.closeReason = detail;
              transport.errorListeners.forEach((listener) => listener(detail));
            }
          } else if (message.nativeControl.type === 'CLOSED') {
            clearTimeout(timer);
            const detail = message.nativeControl.message ?? 'Relay WebSocket closed.';
            const code = message.nativeControl.code ?? 1006;
            if (!transport.opened) reject(new Error(detail));
            else transport.emitClose(code, detail);
          }
          return;
        }
        if (transport.opened) {
          const text = JSON.stringify(message);
          transport.messageListeners.forEach((listener) => listener(text));
        }
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        const runtimeMessage = chrome.runtime.lastError?.message;
        const reason = runtimeMessage ?? transport.closeReason;
        if (!transport.opened) reject(new Error(reason));
        transport.emitClose(transport.closeCode, reason);
      });
      port.postMessage({ nativeControl: { type: 'CONNECT', url } });
    });
  }

  send(text: string): void {
    this.port.postMessage(JSON.parse(text) as unknown);
  }

  close(code = 1000, reason = 'Extension disconnect'): void {
    if (this.closed) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.port.disconnect();
    this.emitClose(code, reason);
  }

  onMessage(listener: (text: string) => void): void {
    this.messageListeners.push(listener);
  }

  onClose(listener: (event: RelayTransportClose) => void): void {
    this.closeListeners.push(listener);
  }

  onError(listener: (message: string) => void): void {
    this.errorListeners.push(listener);
  }

  private emitClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeListeners.forEach((listener) => listener({ code, reason }));
  }
}

export async function openRelayTransport(
  mode: 'native' | 'websocket',
  url: string
): Promise<RelayTransport> {
  const localUrl = assertLocalRelayUrl(url).toString();
  if (mode === 'websocket') return WebSocketRelayTransport.open(localUrl);
  return NativeRelayTransport.open(localUrl);
}
