import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqliteProfileRepository } from '../storage/sqlite/profile-repository.js';
import type { RelayV2PayloadByType } from '../../../shared/protocol/src/relay/v2-messages.js';
import { ProfileError, type ManagedBrowserInstance } from './types.js';

export type ManagedConnectionClaim = NonNullable<RelayV2PayloadByType['HELLO']['managedClaim']>;
const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex');
export const managedIdentityHash = (key: JsonWebKey): string => {
  if (key.kty !== 'EC' || key.crv !== 'P-256' || !key.x || !key.y) throw new ProfileError('PROFILE_IDENTITY_MISMATCH');
  return digest(`${key.x}:${key.y}`);
};

export class BootstrapGrants {
  constructor(private readonly repository: SqliteProfileRepository,
    private readonly verifyProcess: (instance: ManagedBrowserInstance) => Promise<boolean>) {}

  issue(instance: ManagedBrowserInstance): ManagedConnectionClaim {
    const grantRef = `grt_${randomUUID()}`;
    const secret = randomBytes(32).toString('base64url');
    this.repository.saveGrant({ grantRef, profileRef: instance.profileRef, instanceRef: instance.instanceRef,
      generation: instance.generation, secretHash: digest(secret), expiresAt: Date.now() + 300_000, consumedAt: null });
    return { instanceRef: instance.instanceRef, generation: instance.generation, grantRef, secret };
  }

  private validate(claim: ManagedConnectionClaim, endpointRef: string | null, key: JsonWebKey): ManagedBrowserInstance {
    const instance = this.repository.getInstance(claim.instanceRef);
    if (!instance || instance.endedAt || instance.generation !== claim.generation || instance.browserState === 'stopping') throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
    const profile = this.repository.get(instance.profileRef)!;
    const identityHash = managedIdentityHash(key);
    if (profile.identityHash && profile.identityHash !== identityHash) throw new ProfileError('PROFILE_IDENTITY_MISMATCH');
    if (profile.endpointRef && profile.endpointRef !== endpointRef) throw new ProfileError('PROFILE_IDENTITY_MISMATCH');
    if (this.repository.instanceAuthenticated(instance.instanceRef) && profile.identityHash === identityHash && profile.endpointRef === endpointRef) return instance;
    if (!claim.grantRef || !claim.secret) throw new ProfileError('PROFILE_BOOTSTRAP_REQUIRED');
    const grant = this.repository.grant(claim.grantRef);
    if (!grant || grant.instanceRef !== instance.instanceRef || grant.profileRef !== instance.profileRef || grant.generation !== instance.generation
      || grant.consumedAt !== null || grant.expiresAt <= Date.now()
      || !timingSafeEqual(Buffer.from(grant.secretHash, 'hex'), Buffer.from(digest(claim.secret), 'hex'))) throw new ProfileError('PROFILE_BOOTSTRAP_INVALID');
    return instance;
  }

  async check(claim: ManagedConnectionClaim | undefined, endpointRef: string | null, key: JsonWebKey): Promise<void> {
    if (!claim) {
      if (endpointRef && this.repository.forEndpoint(endpointRef)) throw new ProfileError('PROFILE_BOOTSTRAP_REQUIRED');
      return;
    }
    const instance = this.validate(claim, endpointRef, key);
    if (!await this.verifyProcess(instance)) throw new ProfileError('PROFILE_INSTANCE_UNVERIFIED');
    this.validate(claim, endpointRef, key);
  }

  /** Called only after the endpoint's challenge signature has been verified. */
  async authenticated(claim: ManagedConnectionClaim | undefined, endpointRef: string, key: JsonWebKey): Promise<void> {
    await this.check(claim, endpointRef, key);
    if (!claim) return;
    this.repository.transaction(() => {
      const instance = this.validate(claim, endpointRef, key);
      if (!this.repository.instanceAuthenticated(instance.instanceRef)) {
        if (!claim.grantRef || !this.repository.consumeGrant(claim.grantRef)) throw new ProfileError('PROFILE_BOOTSTRAP_INVALID');
        this.repository.bind(instance.profileRef, endpointRef, managedIdentityHash(key));
        this.repository.authenticateInstance(instance.instanceRef);
      }
    });
  }
}
