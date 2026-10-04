import { Server, RequestError } from 'proxy-chain';
import type { CredentialReader, ProxyBinding } from './types.js';
import { ProfileError } from '../profiles/types.js';

interface Listener { server: Server; revision: number; upstream: string | null }
export class ProxyGatewayManager {
  private readonly listeners = new Map<string, Listener>();
  constructor(private readonly credentials: CredentialReader, private readonly reserve: (profileRef: string, port: number) => void) {}
  async ensure(binding: ProxyBinding): Promise<number> {
    let listener = this.listeners.get(binding.profileRef);
    if (!listener) {
      const server = new Server({ host: '127.0.0.1', port: binding.port ?? 0, verbose: false,
        prepareRequestFunction: () => {
          const current = this.listeners.get(binding.profileRef);
          if (!current?.upstream) throw new RequestError('Proxy is unavailable', 503);
          return { upstreamProxyUrl: current.upstream, ignoreUpstreamProxyCertificate: false };
        }
      });
      server.server.maxConnections = 128;
      server.server.requestTimeout = 30_000;
      server.server.headersTimeout = 15_000;
      server.server.on('connection', socket => socket.setTimeout(60_000, () => socket.destroy()));
      server.on('requestFailed', () => {}); // Never log library errors containing upstream credentials.
      try { await server.listen(); this.reserve(binding.profileRef, server.port); }
      catch { await server.close(true).catch(() => {}); throw new ProfileError('PROXY_LISTENER_UNAVAILABLE'); }
      listener = { server, revision: -1, upstream: null };
      this.listeners.set(binding.profileRef, listener);
    }
    if (listener.revision !== binding.revision) {
      listener.upstream = null;
      for (const socket of listener.server.connections.values()) socket.destroy();
      if (!binding.proxy) { listener.revision = binding.revision; return listener.server.port; }
      const config = binding.proxy;
      if (config.port === listener.server.port && ['127.0.0.1', 'localhost', '[::1]'].includes(config.host.toLowerCase())) throw new ProfileError('INVALID_ARGUMENT');
      const url = new URL(`${config.scheme === 'socks5' ? 'socks5h' : config.scheme}://${config.host}:${config.port}`);
      if (config.credential_ref) {
        const secret = await this.credentials.read(config.credential_ref, binding.principalId!);
        url.username = secret.username; url.password = secret.password;
      }
      listener.upstream = url.toString(); listener.revision = binding.revision;
    }
    return listener.server.port;
  }
  ready(profileRef: string, revision: number): boolean { const v = this.listeners.get(profileRef); return !!v?.upstream && v.revision === revision; }
  async close(): Promise<void> { await Promise.all([...this.listeners.values()].map(v => v.server.close(true))); this.listeners.clear(); }
}
