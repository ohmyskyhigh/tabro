import { createServer } from 'node:http';

export function validateProbeRunId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) throw new Error('Invalid probe run ID.');
  return value;
}

export async function startManagedChromeProbeFixture(runId: string) {
  validateProbeRunId(runId);
  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'"
    });
    response.end(`<!doctype html><html><head><title>Tabro managed profile probe</title></head><body><main data-probe="${runId}">Tabro isolated persistence probe</main></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no address.');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
