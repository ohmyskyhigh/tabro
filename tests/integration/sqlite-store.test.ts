import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRelayStore } from '../../apps/broker/src/storage/index.js';
import { testBinding, testPrincipal, testTarget } from '../helpers.js';

describe('SQLite relay store', () => {
  let store: SqliteRelayStore;

  beforeEach(() => { store = new SqliteRelayStore(':memory:'); });
  afterEach(() => store.close());

  it('migrates idempotently and authenticates hashed agent tokens', () => {
    const created = store.createAgent('agent-a', ['browser:read'], 'a'.repeat(32));
    expect(store.authenticateAgent('a'.repeat(32))).toEqual(created.principal);
    expect(store.authenticateAgent('wrong-token-that-is-long-enough')).toBeNull();
  });

  it('consumes pairing codes once and preserves private identity internally', () => {
    const code = store.createPairingCode('profile-a', new Date(Date.now() + 60_000).toISOString());
    const target = store.consumePairingCode(code, { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, ['list_tabs']);
    expect(target.alias).toBe('profile-a');
    expect(target.targetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => store.consumePairingCode(code, {}, [])).toThrow('PAIRING_CODE_INVALID');
  });

  it('registers an extension identity automatically and rejects a nickname collision', () => {
    const firstKey = { kty: 'EC', crv: 'P-256', x: 'profile-x', y: 'profile-y' };
    const first = store.registerExtension('mintwave', firstKey, ['baseline-v1']);
    const recovered = store.registerExtension(
      'mintwave',
      { y: 'profile-y', x: 'profile-x', crv: 'P-256', kty: 'EC' },
      ['baseline-v1', 'updated-capability']
    );

    expect(recovered.targetId).toBe(first.targetId);
    expect(recovered.capabilities).toEqual(['baseline-v1', 'updated-capability']);
    expect(() => store.registerExtension(
      'mintwave',
      { kty: 'EC', crv: 'P-256', x: 'another-profile', y: 'another-key' },
      ['baseline-v1']
    )).toThrow('ENDPOINT_NICKNAME_CONFLICT');
  });

  it('renames the legacy target and canonical endpoint together', () => {
    const target = store.registerExtension(
      'mintwave',
      { kty: 'EC', crv: 'P-256', x: 'profile-x', y: 'profile-y' },
      ['baseline-v1']
    );
    store.canonical.logical.createEndpoint({
      endpointRef: 'ep_profile',
      nickname: target.alias,
      legacyTargetId: target.targetId
    });
    const other = store.registerExtension(
      'brightsky',
      { kty: 'EC', crv: 'P-256', x: 'other-x', y: 'other-y' },
      ['baseline-v1']
    );
    store.canonical.logical.createEndpoint({
      endpointRef: 'ep_other',
      nickname: other.alias,
      legacyTargetId: other.targetId
    });

    store.renameTarget('mintwave', 'calmreef');

    expect(store.getTargetById(target.targetId)?.alias).toBe('calmreef');
    expect(store.canonical.logical.getEndpoint('ep_profile')?.nickname).toBe('calmreef');
    expect(() => store.renameTarget('calmreef', 'brightsky')).toThrow('ENDPOINT_NICKNAME_CONFLICT');
    expect(store.getTargetById(target.targetId)?.alias).toBe('calmreef');
    expect(store.canonical.logical.getEndpoint('ep_profile')?.nickname).toBe('calmreef');
    store.revokeTarget('brightsky');
    expect(() => store.renameTarget('calmreef', 'brightsky')).toThrow('ENDPOINT_NICKNAME_CONFLICT');
  });

  it('rotates a revoked target pairing without changing its alias or private target identity', () => {
    const firstCode = store.createPairingCode('profile-c', new Date(Date.now() + 60_000).toISOString());
    const first = store.consumePairingCode(firstCode, { kty: 'EC', crv: 'P-256', x: 'old-x', y: 'old-y' }, ['snapshot']);
    store.revokeTarget('profile-c');
    const replacementCode = store.createPairingCode('profile-c', new Date(Date.now() + 60_000).toISOString());
    const replacementKey = { kty: 'EC', crv: 'P-256', x: 'new-x', y: 'new-y' };
    const replacement = store.consumePairingCode(replacementCode, replacementKey, ['snapshot', 'list_tabs']);

    expect(replacement.targetId).toBe(first.targetId);
    expect(replacement.alias).toBe('profile-c');
    expect(replacement.publicKeyJwk).toEqual(replacementKey);
    expect(replacement.revoked).toBe(false);
  });

  it('allows only one active lease and binds session handles to principals', () => {
    const a = store.createAgent('a', ['sessions:write']);
    const b = store.createAgent('b', ['sessions:write']);
    const { targetId } = testTarget(store);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = store.acquireLease(targetId, a.principal.principalId, expiresAt);
    expect(first).not.toBeNull();
    expect(store.acquireLease(targetId, b.principal.principalId, expiresAt)).toBeNull();
    expect(store.resolveSession(first!.sessionHandle, b.principal.principalId, new Date().toISOString())).toBeNull();
    expect(store.resolveSession(first!.sessionHandle, a.principal.principalId, new Date().toISOString())?.fencingToken).toBe(1);
    expect(store.releaseSession(first!.sessionHandle, a.principal.principalId)).toBe(true);
    expect(store.acquireLease(targetId, b.principal.principalId, expiresAt)?.lease.fencingToken).toBe(2);
  });

  it('enforces one active agent-to-target binding on each side', () => {
    const a = store.createAgent('a', ['browser:read']);
    const b = store.createAgent('b', ['browser:read']);
    const first = testTarget(store, 'profile-a');
    const second = testTarget(store, 'profile-b');
    const binding = store.createBinding(a.principal.principalId, first.targetId);
    expect(binding.bindingRef).toMatch(/^br_[A-Za-z0-9_-]{32}$/);
    expect(store.getActiveBindingForPrincipal(a.principal.principalId)?.targetAlias).toBe('profile-a');
    expect(() => store.createBinding(a.principal.principalId, second.targetId)).toThrow('BINDING_CONFLICT');
    expect(() => store.createBinding(b.principal.principalId, first.targetId)).toThrow('BINDING_CONFLICT');
    expect(store.acquireLease(first.targetId, a.principal.principalId, new Date(Date.now() + 60_000).toISOString())).not.toBeNull();
    expect(store.revokeBindingForPrincipal(a.principal.principalId)).toBe(true);
    expect(store.getActiveLease(first.targetId, new Date().toISOString())).toBeNull();
    expect(store.createBinding(b.principal.principalId, first.targetId).principalId).toBe(b.principal.principalId);
  });

  it('preserves the real-world run identifier when commands are reconstructed', () => {
    const principal = testPrincipal(store).principal;
    const { targetId } = testTarget(store);
    const bindingRef = testBinding(store, principal.principalId, targetId);
    const runId = 'rw-storage-regression';
    const stored = store.createCommand({
      command: {
        commandId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        principalId: principal.principalId,
        runId,
        bindingRef,
        targetId,
        operation: 'snapshot',
        parameters: {},
        idempotencyClass: 'read',
        deadlineAt: new Date(Date.now() + 60_000).toISOString()
      },
      decision: { disposition: 'deliver', reasonCode: 'TARGET_READY', evaluatedStatusVersion: 1 },
      initialState: 'QUEUED'
    });

    expect(stored.runId).toBe(runId);
    expect(store.getCommand(stored.commandId)?.runId).toBe(runId);
    expect(store.listCommandsByRunId(runId)[0]?.runId).toBe(runId);
  });
});
