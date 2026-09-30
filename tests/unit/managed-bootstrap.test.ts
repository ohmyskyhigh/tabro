import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { BootstrapGrants } from '../../apps/broker/src/profiles/bootstrap-grants.js';

describe('managed bootstrap authority', () => {
  let store: SqliteRelayStore;
  let grants: BootstrapGrants;
  let processVerified: boolean;
  const key = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
  beforeEach(() => {
    store = new SqliteRelayStore(':memory:');
    processVerified = true;
    grants = new BootstrapGrants(store.profiles, async () => processVerified);
  });
  afterEach(() => store.close());
  function setup() {
    const principal = store.createAgent('test', []).principal.principalId;
    const profile = store.profiles.create(principal, 'test', 'chrome');
    const instance = store.profiles.createInstance(profile.profileRef);
    store.canonical.logical.createEndpoint({ endpointRef: `ep_${profile.profileRef}`, nickname: profile.profileRef });
    return { profile, instance, claim: grants.issue(instance), endpoint: `ep_${profile.profileRef}` };
  }
  it('does not consume on HELLO, binds on signed AUTH, and recovers a lost READY', async () => {
    const { profile, instance, claim, endpoint } = setup();
    expect(store.profiles.grant(claim.grantRef!)?.secretHash).not.toBe(claim.secret);
    await grants.check(claim, null, key);
    expect(store.profiles.get(profile.profileRef)?.endpointRef).toBeNull();
    expect(store.profiles.grant(claim.grantRef!)?.consumedAt).toBeNull();
    await grants.authenticated(claim, endpoint, key);
    expect(store.profiles.get(profile.profileRef)?.endpointRef).toBe(endpoint);
    await grants.authenticated(claim, endpoint, key);
    await grants.check({ instanceRef: instance.instanceRef, generation: 1 }, endpoint, key);
    await expect(grants.check(undefined, endpoint, key)).rejects.toThrow('PROFILE_BOOTSTRAP_REQUIRED');
    await expect(grants.check(claim, endpoint, { ...key, x: 'wrong' })).rejects.toThrow('PROFILE_IDENTITY_MISMATCH');
  });
  it('rejects wrong credentials, expired grants and unverified processes without consuming them', async () => {
    const { claim } = setup();
    await expect(grants.check({ ...claim, secret: 'wrong' }, null, key)).rejects.toThrow('PROFILE_BOOTSTRAP_INVALID');
    processVerified = false;
    await expect(grants.check(claim, null, key)).rejects.toThrow('PROFILE_INSTANCE_UNVERIFIED');
    expect(store.profiles.grant(claim.grantRef!)?.consumedAt).toBeNull();
    const grant = store.profiles.grant(claim.grantRef!)!;
    store.profiles.saveGrant({ ...grant, grantRef: 'expired', expiresAt: 1 });
    await expect(grants.check({ ...claim, grantRef: 'expired' }, null, key)).rejects.toThrow('PROFILE_BOOTSTRAP_INVALID');
  });
  it('isolates three out-of-order authentications and fences retired instances', async () => {
    const values = [setup(), setup(), setup()];
    for (const value of [values[2]!, values[0]!, values[1]!]) await grants.authenticated(value.claim, value.endpoint, key);
    for (const value of values) expect(store.profiles.get(value.profile.profileRef)?.endpointRef).toBe(value.endpoint);
    const first = values[0]!;
    store.profiles.updateInstance({ ...first.instance, endedAt: new Date().toISOString(), browserState: 'stopped' });
    const next = store.profiles.createInstance(first.profile.profileRef);
    await expect(grants.check(first.claim, first.endpoint, key)).rejects.toThrow('PROFILE_INSTANCE_UNVERIFIED');
    await expect(grants.check({ instanceRef: next.instanceRef, generation: next.generation }, first.endpoint, key)).rejects.toThrow('PROFILE_BOOTSTRAP_REQUIRED');
    await grants.authenticated(grants.issue(next), first.endpoint, key);
  });
});
