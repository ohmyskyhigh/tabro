import { createServer, request, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { Server } from 'proxy-chain';

export const fixtureKey = readFileSync(new URL('../fixtures/proxy/key.pem', import.meta.url));
export const fixtureCert = readFileSync(new URL('../fixtures/proxy/cert.pem', import.meta.url));
export const listen = (server: HttpServer) => new Promise<number>(ok => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
export async function echoFixture(body = 'proxy-echo') {
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(req.url ?? ''); res.end(body); });
  const port = await listen(server);
  return { server, port, requests, close: () => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()); }) };
}
export async function httpProxyFixture(tls = false, body?: string) {
  let authenticated = 0;
  const server = new Server({ host: '127.0.0.1', port: 0,
    ...(tls ? { serverType: 'https' as const, httpsOptions: { key: fixtureKey, cert: fixtureCert } } : { serverType: 'http' as const }),
    prepareRequestFunction: ({ username, password }) => {
      if (username !== 'fixture-user' || password !== 'fixture:p@ss/#') return { requestAuthentication: true };
      authenticated++; return body === undefined ? {} : { customResponseFunction: () => ({ statusCode: 200, body }) };
    }
  });
  server.on('requestFailed', () => {}); await server.listen();
  return { port: server.port, count: () => authenticated, close: () => server.close(true) };
}
// Deliberately tiny isolated SOCKS fixture; it only forwards to the given local echo server.
export async function socksProxyFixture(targetPort: number) {
  const sockets = new Set<Socket>(); const hosts: string[] = []; let authenticated = 0;
  const server = createNetServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0); let phase = 0;
    const parse = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (phase === 0 && buffer.length >= 2 + buffer[1]!) {
        buffer = buffer.subarray(2 + buffer[1]!); socket.write(Buffer.from([5, 2])); phase = 1;
      }
      if (phase === 1 && buffer.length >= 2) {
        const userLength = buffer[1]!; if (buffer.length < 3 + userLength) return;
        const passwordLength = buffer[2 + userLength]!; if (buffer.length < 3 + userLength + passwordLength) return;
        const username = buffer.subarray(2, 2 + userLength).toString();
        const password = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
        if (username !== 'fixture-user' || password !== 'fixture:p@ss/#') { socket.end(Buffer.from([1, 1])); return; }
        authenticated++; buffer = buffer.subarray(3 + userLength + passwordLength); socket.write(Buffer.from([1, 0])); phase = 2;
      }
      if (phase === 2 && buffer.length >= 5) {
        const type = buffer[3]!; const len = type === 1 ? 4 : type === 3 ? buffer[4]! : 16;
        const offset = type === 3 ? 5 : 4; if (buffer.length < offset + len + 2) return;
        hosts.push(type === 3 ? buffer.subarray(offset, offset + len).toString() : '<ip>');
        const destinationPort = buffer.readUInt16BE(offset + len);
        if (destinationPort !== targetPort) { socket.destroy(); return; }
        const remainder = buffer.subarray(offset + len + 2); phase = 3; socket.removeListener('data', parse);
        const upstream = connect(targetPort, '127.0.0.1', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (remainder.length) upstream.write(remainder); socket.pipe(upstream); upstream.pipe(socket);
        });
        sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream)); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
      }
    };
    socket.on('data', parse);
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return { port: (server.address() as AddressInfo).port, hosts, count: () => authenticated,
    close: () => new Promise<void>(ok => { for (const socket of sockets) socket.destroy(); server.close(() => ok()); }) };
}
export function throughProxy(port: number, destination: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ hostname: '127.0.0.1', port, path: destination, headers: { host: new URL(destination).host }, agent: false, timeout: 5000 }, response => {
      let body = ''; response.on('data', data => { body += String(data); }); response.on('end', () => ok({ status: response.statusCode!, body }));
    });
    req.on('timeout', () => req.destroy(new Error('fixture request timeout'))); req.on('error', fail); req.end();
  });
}
export function proxyTunnel(port: number, target: string): Promise<Socket> {
  return new Promise((ok, fail) => {
    const req = request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: target, agent: false, timeout: 5000 });
    req.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); fail(new Error(`CONNECT ${response.statusCode}`)); return; }
      if (head.length) socket.unshift(head); ok(socket);
    });
    req.on('timeout', () => req.destroy(new Error('CONNECT timeout'))); req.on('error', fail); req.end();
  });
}
