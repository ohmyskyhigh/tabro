import { beforeEach, describe, expect, it } from 'vitest';
import { ExtensionProxyController } from '../../apps/browser-extension/src/proxy/proxy-controller.js';

describe('extension Profile proxy control', () => {
  let storage: Record<string, unknown>; let value: chrome.proxy.ProxyConfig; let level: string; let calls: string[];
  let api: typeof chrome;
  beforeEach(() => {
    storage = {}; value = { mode: 'system' }; level = 'controllable_by_this_extension'; calls = [];
    api = {
      runtime: {}, storage: { local: { get: async () => storage, set: async (v: Record<string, unknown>) => { storage = { ...storage, ...v }; } } },
      proxy: { settings: {
        get: (_details: unknown, callback: (v: unknown) => void) => callback({ value, levelOfControl: level }),
        set: (details: { value: chrome.proxy.ProxyConfig; scope: string }, callback: () => void) => { expect(details.scope).toBe('regular_only'); calls.push('set'); value = details.value; level = 'controlled_by_this_extension'; callback(); },
        clear: (_details: unknown, callback: () => void) => { calls.push('clear'); value = { mode: 'system' }; level = 'controllable_by_this_extension'; callback(); }
      } }
    } as unknown as typeof chrome;
  });
  const apply = { action: 'apply', revision: 1, port: 22345 } as const;
  it('persists routing across worker restarts and clears back to underlying settings', async () => {
    const first = new ExtensionProxyController(api);
    expect(await first.execute(apply)).toMatchObject({ state: 'applied', revision: 1 });
    expect(value).toEqual({ mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: 22345 } } });
    const restarted = new ExtensionProxyController(api);
    expect(await restarted.execute({ ...apply, action: 'read' })).toMatchObject({ state: 'applied' });
    expect(await restarted.execute({ action: 'clear', revision: 2, port: null })).toMatchObject({ state: 'unmanaged', revision: 2 });
    expect(value.mode).toBe('system'); expect(calls).toEqual(['set', 'clear']);
  });
  it.each(['not_controllable', 'controlled_by_other_extensions'])('respects %s without changing settings', async control => {
    level = control;
    await expect(new ExtensionProxyController(api).execute(apply)).rejects.toThrow('A policy or another extension'); expect(calls).toEqual([]);
  });
  it('rejects stale revision writes and detects settings replaced outside Tabro', async () => {
    const controller = new ExtensionProxyController(api); await controller.execute(apply);
    await expect(controller.execute({ ...apply, revision: 0 })).rejects.toThrow('stale');
    value = { mode: 'direct' }; level = 'controlled_by_other_extensions';
    expect(await controller.execute({ ...apply, action: 'read' })).toMatchObject({ state: 'control_conflict' });
  });
  it('serializes conflicting commands so a late older operation cannot win', async () => {
    const controller = new ExtensionProxyController(api);
    const result = await Promise.allSettled([controller.execute({ ...apply, revision: 2 }), controller.execute(apply)]);
    expect(result.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(storage.tabroProfileProxy).toMatchObject({ revision: 2 });
  });
  it('fetches the exit IP from the browser and forbids arbitrary destinations', async () => {
    const fetcher: typeof fetch = async (url, options) => { expect(url).toBe('https://api.ipify.org?format=json'); expect(options?.redirect).toBe('error'); return new Response('{"ip":"203.0.113.8"}'); };
    const controller = new ExtensionProxyController(api, fetcher); await controller.execute(apply);
    expect(await controller.execute({ ...apply, action: 'probe' })).toMatchObject({ exit: { ip: '203.0.113.8', revision: 1, source: 'browser' } });
  });
  it.each(['x'.repeat(1025), '{"ip":"not-an-ip"}'])('rejects malformed or oversized probe responses', async body => {
    const controller = new ExtensionProxyController(api, async () => new Response(body)); await controller.execute(apply);
    await expect(controller.execute({ ...apply, action: 'probe' })).rejects.toThrow('exit-IP check failed');
  });
});
