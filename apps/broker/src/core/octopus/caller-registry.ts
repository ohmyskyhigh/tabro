import { createHash } from 'node:crypto';
import type {
  CanonicalRepositories,
  StoredCallerSession
} from '../../storage/index.js';
import type { ReferenceFactory } from './reference-factory.js';

export interface CallerEvidence {
  managementAuthority?: { principalId: string; scopes: readonly string[] };
  runtimeName: string;
  runtimeSessionKey: string;
  parentRuntimeSessionKey?: string;
}

const hashRuntimeKey = (runtimeName: string, runtimeSessionKey: string): string =>
  createHash('sha256').update(`${runtimeName}\0${runtimeSessionKey}`).digest('base64url');

/** Resolves non-model runtime evidence into broker-issued public caller refs. */
export class CallerRegistry {
  constructor(
    private readonly repositories: CanonicalRepositories,
    private readonly references: ReferenceFactory
  ) {}

  resolve(evidence: CallerEvidence): StoredCallerSession {
    const runtimeSessionKeyHash = hashRuntimeKey(evidence.runtimeName, evidence.runtimeSessionKey);
    const current = this.repositories.logical.scanLogicalRecovery().activeSessions
      .find((session) => session.runtimeSessionKeyHash === runtimeSessionKeyHash);
    if (current) return this.repositories.logical.touchSession(current.sessionRef) ?? current;

    const parentHash = evidence.parentRuntimeSessionKey === undefined
      ? null
      : hashRuntimeKey(evidence.runtimeName, evidence.parentRuntimeSessionKey);
    const parent = parentHash === null
      ? null
      : this.repositories.logical.scanLogicalRecovery().activeSessions
        .find((session) => session.runtimeSessionKeyHash === parentHash) ?? null;
    const lineageRef = parent?.lineageRef ?? this.references.issue('lineage');
    if (!parent) this.repositories.logical.registerLineage({ lineageRef, runtimeName: evidence.runtimeName });
    return this.repositories.logical.registerSession({
      sessionRef: this.references.issue('session'),
      lineageRef,
      ...(parent ? { parentSessionRef: parent.sessionRef } : {}),
      runtimeSessionKeyHash
    });
  }
}

