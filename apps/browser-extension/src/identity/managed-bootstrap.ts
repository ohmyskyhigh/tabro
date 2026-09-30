import type { RelayV2PayloadByType } from '../../../shared/protocol/src/relay/v2-messages.js';

type Claim = NonNullable<RelayV2PayloadByType['HELLO']['managedClaim']>;
let initialization: Promise<Claim | undefined> | undefined;

/** All connect entry points await this before reading relay settings or identity. */
export function initializeManagedBootstrap(): Promise<Claim | undefined> {
  if (!chrome.runtime.getManifest().description?.includes('[octopus-managed]')) return Promise.resolve(undefined);
  initialization ??= (async () => {
    const response = await fetch(chrome.runtime.getURL('managed-bootstrap.json'), { cache: 'no-store' });
    if (!response.ok) throw new Error('Managed Profile bootstrap configuration is missing.');
    const config = await response.json() as Claim & { relayUrl: string; existingIdentity?: boolean };
    if (!/^ins_[0-9a-f-]{36}$/u.test(config.instanceRef) || !Number.isInteger(config.generation) || config.generation < 1) throw new Error('Invalid managed Profile instance.');
    const url = new URL(config.relayUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.pathname !== '/relay') throw new Error('Invalid managed Profile relay URL.');
    const stored = await chrome.storage.local.get(['publicKeyJwk', 'privateKeyJwk', 'managedAuthenticatedInstance']);
    if ((config.existingIdentity || stored.publicKeyJwk || stored.privateKeyJwk) && (!stored.publicKeyJwk || !stored.privateKeyJwk)) throw new Error('Managed Profile identity is damaged.');
    await chrome.storage.local.set({ brokerUrl: config.relayUrl, transportMode: 'native' });
    return { instanceRef: config.instanceRef, generation: config.generation,
      ...(stored.managedAuthenticatedInstance === config.instanceRef ? {} : { grantRef: config.grantRef, secret: config.secret }) };
  })();
  return initialization;
}

export async function rememberManagedAuthentication(claim: Claim | undefined): Promise<void> {
  if (claim) {
    await chrome.storage.local.set({ managedAuthenticatedInstance: claim.instanceRef });
    delete claim.grantRef; delete claim.secret;
  }
}
