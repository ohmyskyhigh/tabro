import { afterEach, describe, expect, it } from 'vitest';
import { createServer, globalAgent } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { ProxyGatewayManager } from '../../apps/broker/src/proxy/proxy-gateway-manager.js';
import type { ProxyBinding } from '../../apps/broker/src/proxy/types.js';
import { echoFixture, httpProxyFixture, socksProxyFixture, throughProxy, fixtureCert, fixtureKey, listen, proxyTunnel } from '../helpers/proxy-fixtures.js';

describe('authenticated proxy gateway', () => {
  const cleanup: Array<() => Promise<void>> = [];
  const originalCa = globalAgent.options.ca;
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); globalAgent.options.ca = originalCa; });
  function manager(password = 'fixture:p@ss/#') {
    const gateway = new ProxyGatewayManager({ read: async () => ({ username: 'fixture-user', password }) }, () => {});
    cleanup.push(() => gateway.close()); return gateway;
  }
  function binding(scheme: 'http' | 'https' | 'socks5', port: number, profileRef = 'profile1'): ProxyBinding {
    return { profileRef, proxy: { scheme, host: '127.0.0.1', port, credential_ref: 'pcr_00000000-0000-0000-0000-000000000000' },
      revision: 1, port: null, principalId: 'principal', state: 'pending_connection', appliedRevision: null, connectionGeneration: null, observedAt: new Date().toISOString(), problemCode: null, exit: null };
  }
  it.each(['http', 'https', 'socks5'] as const)('authenticates %s without exposing upstream secrets', async scheme => {
    const echo = await echoFixture(); cleanup.push(echo.close);
    const upstream = scheme === 'socks5' ? await socksProxyFixture(echo.port) : await httpProxyFixture(scheme === 'https'); cleanup.push(upstream.close);
    if (scheme === 'https') globalAgent.options.ca = fixtureCert;
    const gateway = manager(); const port = await gateway.ensure(binding(scheme, upstream.port));
    const host = scheme === 'socks5' ? 'echo.proxy.test' : '127.0.0.1';
    expect(await throughProxy(port, `http://${host}:${echo.port}/hello`)).toEqual({ status: 200, body: 'proxy-echo' });
    expect(upstream.count()).toBeGreaterThan(0); expect(echo.requests).toEqual(['/hello']);
    if ('hosts' in upstream) expect(upstream.hosts).toContain('echo.proxy.test');
  });
  it.each(['http', 'https', 'socks5'] as const)('does not fall back to direct when %s authentication fails', async scheme => {
    const echo = await echoFixture(); cleanup.push(echo.close);
    const upstream = scheme === 'socks5' ? await socksProxyFixture(echo.port) : await httpProxyFixture(scheme === 'https'); cleanup.push(upstream.close);
    if (scheme === 'https') globalAgent.options.ca = fixtureCert;
    const port = await manager('wrong-password').ensure(binding(scheme, upstream.port));
    expect((await throughProxy(port, `http://127.0.0.1:${echo.port}/direct-must-not-happen`)).status).toBeGreaterThanOrEqual(400);
    expect(echo.requests).toEqual([]);
  });
  it('rejects an untrusted TLS proxy certificate', async () => {
    const echo = await echoFixture(); cleanup.push(echo.close); const upstream = await httpProxyFixture(true); cleanup.push(upstream.close);
    const port = await manager().ensure(binding('https', upstream.port));
    expect((await throughProxy(port, `http://127.0.0.1:${echo.port}/no`)).status).toBeGreaterThanOrEqual(400); expect(echo.requests).toEqual([]);
  });
  it('keeps Profile listeners isolated and blocks an empty upstream after clear', async () => {
    const echo = await echoFixture(); cleanup.push(echo.close); const a = await httpProxyFixture(); cleanup.push(a.close); const b = await httpProxyFixture(); cleanup.push(b.close);
    const gateway = manager(); const first = binding('http', a.port); const second = binding('http', b.port, 'profile2');
    const pa = await gateway.ensure(first); const pb = await gateway.ensure(second); expect(pa).not.toBe(pb);
    await throughProxy(pa, `http://127.0.0.1:${echo.port}/a`); await throughProxy(pb, `http://127.0.0.1:${echo.port}/b`);
    expect(a.count()).toBe(1); expect(b.count()).toBe(1);
    await gateway.ensure({ ...first, revision: 2, proxy: null });
    expect((await throughProxy(pa, `http://127.0.0.1:${echo.port}/blocked`)).status).toBe(503);
    expect(echo.requests).toEqual(['/a', '/b']);
  });
  it('refuses to steal an occupied persisted listener port', async () => {
    const occupied = await echoFixture(); cleanup.push(occupied.close);
    await expect(manager().ensure({ ...binding('http', 54321), port: occupied.port })).rejects.toThrow('PROXY_LISTENER_UNAVAILABLE');
  });
  it.each(['http', 'https', 'socks5'] as const)('tunnels TLS and WebSocket over %s and closes old connections on switch', async scheme => {
    const target = createServer({ key: fixtureKey, cert: fixtureCert }, (_req, res) => res.end('secure-echo'));
    const sockets = new WebSocketServer({ server: target });
    sockets.on('connection', client => client.on('message', data => client.send(data)));
    const targetPort = await listen(target);
    cleanup.push(async () => { for (const client of sockets.clients) client.terminate(); sockets.close(); target.closeAllConnections(); await new Promise<void>(ok => target.close(() => ok())); });
    const upstream = scheme === 'socks5' ? await socksProxyFixture(targetPort) : await httpProxyFixture(scheme === 'https'); cleanup.push(upstream.close);
    if (scheme === 'https') globalAgent.options.ca = fixtureCert;
    const gateway = manager(); const config = binding(scheme, upstream.port); const port = await gateway.ensure(config);
    const secure = async () => {
      const socket = await proxyTunnel(port, `localhost:${targetPort}`);
      const tls = tlsConnect({ socket, servername: 'localhost', ca: fixtureCert });
      await once(tls, 'secureConnect'); return tls;
    };
    const http = await secure(); let response = '';
    http.on('data', data => { response += String(data); });
    const end = once(http, 'end'); http.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'); await end;
    expect(response).toContain('secure-echo');
    const tunnel = await secure(); const ws = new WebSocket(`wss://localhost:${targetPort}`, { createConnection: () => tunnel });
    await once(ws, 'open'); const echoed = once(ws, 'message'); ws.send('socket-echo'); expect(String((await echoed)[0])).toBe('socket-echo');
    const closed = once(ws, 'close'); await gateway.ensure({ ...config, revision: 2, proxy: null }); await closed;
    expect(upstream.count()).toBe(2);
  });
});
