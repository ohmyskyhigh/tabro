import type * as NodeFs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof NodeFs>(),
  realpathSync: () => '/fixture',
  readFileSync: () => 'fixture-maintenance-token'
}));
vi.mock('../../apps/shared/protocol/src/machine-registration.js', () => ({
  readMachineRegistration: () => ({ installationRoot: '/fixture', dataRoot: '/fixture/data' }),
  sameMachinePath: () => true
}));
vi.mock('../../apps/shared/protocol/src/runtime-discovery.js', () => ({
  readBrokerRuntime: () => ({ instanceRef: 'fixture-instance', mcpUrl: 'http://127.0.0.1:7331/mcp' })
}));
vi.mock('../../apps/shared/protocol/src/machine-auth.js', () => ({
  readMachineSecret: () => Buffer.alloc(32),
  sealCredential: () => 'sealed-fixture-credential',
  verifyBrokerHealth: async () => {}
}));
import { maintenanceRequest } from '../../apps/shared/protocol/src/maintenance-client.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function delayedResponse(milliseconds: number) {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response('{}', { status: 200 })), milliseconds);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const request = (action: 'enter' | 'resume' | 'stop') => maintenanceRequest('/fixture', new URL('http://127.0.0.1:7331/mcp'), action, 'fixture-transaction', 'fixture-instance');

it('waits for slow resume activation without repeating the mutation', async () => {
  const fetch = delayedResponse(10_000);
  const result = expect(request('resume')).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps ordinary maintenance requests bounded and never retries a lost response', async () => {
  const fetch = delayedResponse(10_000);
  const result = expect(request('enter')).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(5_000);
  await result;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('bounds a stalled resume without replaying it', async () => {
  const fetch = delayedResponse(120_000);
  const result = expect(request('resume')).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(60_000);
  await result;
  expect(fetch).toHaveBeenCalledTimes(1);
});
