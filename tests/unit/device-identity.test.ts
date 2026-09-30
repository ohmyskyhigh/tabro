import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadOrCreateIdentity,
  saveCustomPairingCode,
  savePairing
} from '../../apps/browser-extension/src/identity/device-identity.js';

describe('extension device identity persistence', () => {
  let values: Record<string, unknown>;

  beforeEach(() => {
    values = {};
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        storage: {
          local: {
            get: async (keys: string | string[]) => {
              const selected = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(selected.filter((key) => key in values).map((key) => [key, values[key]]));
            },
            set: async (changes: Record<string, unknown>) => { Object.assign(values, changes); },
            remove: async (keys: string | string[]) => {
              for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
            }
          }
        }
      } as unknown as typeof chrome
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'chrome');
  });

  it('loads the same generated identity and alias across repeated starts', async () => {
    const first = await loadOrCreateIdentity();
    const reopened = await loadOrCreateIdentity();

    expect(reopened.pairingCode).toBe(first.pairingCode);
    expect(reopened.proposedNickname).toBe(first.proposedNickname);
    expect(reopened.publicKeyJwk).toEqual(first.publicKeyJwk);
    expect(reopened.privateKeyJwk).toEqual(first.privateKeyJwk);
  });

  it('keeps a customized code authoritative after pairing and reconnect', async () => {
    await loadOrCreateIdentity();
    await saveCustomPairingCode('calm reef');
    await savePairing('31c5f0e3-ef82-4bfd-a747-9e4780b541a8', 'calmreef');

    const reopened = await loadOrCreateIdentity();
    expect(reopened.pairingCode).toBe('CALM-REEF');
    expect(reopened.proposedNickname).toBe('calmreef');
    expect(reopened.nickname).toBe('calmreef');
    expect(reopened.endpointId).toBe('31c5f0e3-ef82-4bfd-a747-9e4780b541a8');
  });
});
