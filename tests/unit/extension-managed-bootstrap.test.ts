import { afterEach, expect, it, vi } from 'vitest';

const instanceRef = 'ins_11111111-1111-4111-8111-111111111111';
function environment(stored: Record<string, unknown> = {}) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ instanceRef, generation: 1, grantRef: 'grant', secret: 'secret', relayUrl: 'ws://127.0.0.1:7332/relay' })));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ description: '[octopus-managed]' }), getURL: (path: string) => path }, storage: { local: {
    get: async () => ({ ...stored }), set: async (value: Record<string, unknown>) => { Object.assign(stored, value); }
  } } });
  return { stored, fetch };
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('shares initialization across concurrent connects and forgets the consumed secret on READY', async () => {
  const { stored, fetch } = environment();
  const { initializeManagedBootstrap, rememberManagedAuthentication } = await import('../../apps/browser-extension/src/identity/managed-bootstrap.js');
  const [first, second] = await Promise.all([initializeManagedBootstrap(), initializeManagedBootstrap()]);
  expect(fetch).toHaveBeenCalledTimes(1); expect(first).toBe(second); expect(first?.secret).toBe('secret');
  expect(stored).toMatchObject({ brokerUrl: 'ws://127.0.0.1:7332/relay', transportMode: 'native' });
  await rememberManagedAuthentication(first); expect(first?.secret).toBeUndefined(); expect(stored.managedAuthenticatedInstance).toBe(instanceRef);
});
it('restarts a service worker with the same instance claim and no replayed grant', async () => {
  environment({ managedAuthenticatedInstance: instanceRef, publicKeyJwk: { x: 'public' }, privateKeyJwk: { d: 'private' } });
  const { initializeManagedBootstrap } = await import('../../apps/browser-extension/src/identity/managed-bootstrap.js');
  expect(await initializeManagedBootstrap()).toEqual({ instanceRef, generation: 1 });
});
it('refuses missing configuration and damaged identity rather than unmanaged registration', async () => {
  const { fetch } = environment(); fetch.mockResolvedValue(new Response('', { status: 404 }));
  let module = await import('../../apps/browser-extension/src/identity/managed-bootstrap.js');
  await expect(module.initializeManagedBootstrap()).rejects.toThrow('configuration is missing');
  vi.resetModules(); environment({ publicKeyJwk: { x: 'only-half-a-key' } });
  module = await import('../../apps/browser-extension/src/identity/managed-bootstrap.js');
  await expect(module.initializeManagedBootstrap()).rejects.toThrow('identity is damaged');
});
it('leaves ordinary extensions on their existing registration path', async () => {
  const { fetch } = environment(); vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ description: 'ordinary extension' }) } });
  const { initializeManagedBootstrap } = await import('../../apps/browser-extension/src/identity/managed-bootstrap.js');
  expect(await initializeManagedBootstrap()).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
});
