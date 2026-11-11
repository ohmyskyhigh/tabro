import { ExtensionAdapterError, type PrivateTabLocator } from '../browser/inventory.js';
import { BrowserPolicyError, effectiveBrowserPolicy, guardedBrowserCommand, isBrowserInput, isRecoveryObservation, isSideEffectRefusal,
  type BrowserPolicySnapshot } from '../../../shared/protocol/src/browser-interaction-policy.js';
import type {
  RecentAttemptCache,
  RecentAttemptOutcome
} from '../executor/recent-command-cache.js';
import type { DebuggerAttachmentManager } from './attachment-manager.js';

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/;

const payloadBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;

export interface ExecuteCdpInput {
  policyRevision?: string;
  recoveryObservation?: boolean;
  attemptId: string;
  connectionGeneration: number;
  inventoryGeneration: number;
  privateTab: PrivateTabLocator;
  attachmentGeneration: number;
  method: string;
  params?: Record<string, unknown>;
  childSessionId?: string;
}

export interface ExecuteCdpSuccess {
  attemptId: string;
  connectionGeneration: number;
  inventoryGeneration: number;
  tabGeneration: number;
  attachmentGeneration: number;
  rawResult: object | null;
}

const asAdapterError = (error: unknown): ExtensionAdapterError => {
  if (error instanceof ExtensionAdapterError) return error;
  return new ExtensionAdapterError(
    'CDP_COMMAND_FAILED',
    error instanceof Error ? error.message : 'Chrome rejected the CDP command.',
    true
  );
};

export class CdpExecutor {
  private policy: { connectionGeneration: number; snapshot: BrowserPolicySnapshot } | null = null;
  applyPolicy(snapshot: BrowserPolicySnapshot, connectionGeneration: number): void {
    const previous = this.policy;
    if (previous?.connectionGeneration === connectionGeneration && (snapshot.generation < previous.snapshot.generation
      || (snapshot.generation === previous.snapshot.generation && snapshot.revision !== previous.snapshot.revision))) {
      throw new ExtensionAdapterError('INPUT_POLICY_STALE', 'A newer browser rule revision is already active.');
    }
    this.policy = { connectionGeneration, snapshot };
  }
  constructor(
    private readonly attachments: DebuggerAttachmentManager,
    private readonly attempts: RecentAttemptCache,
    private readonly maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES
  ) {}

  async execute(input: ExecuteCdpInput): Promise<ExecuteCdpSuccess> {
    this.validateInput(input);
    let output: ExecuteCdpSuccess;
    let dispatched = false;
    try {
      this.attachments.assertAttached(input.privateTab, input.attachmentGeneration, input.childSessionId);
      const target: chrome.debugger.DebuggerSession = {
        tabId: input.privateTab.tabId,
        ...(input.childSessionId === undefined ? {} : { sessionId: input.childSessionId })
      };
      const policy = this.policy;
      if ((policy || input.policyRevision) && (policy?.connectionGeneration !== input.connectionGeneration || policy.snapshot.revision !== input.policyRevision)) {
        throw new ExtensionAdapterError('INPUT_POLICY_STALE', 'Synchronize the current browser rules before dispatch.');
      }
      const tab = policy || input.recoveryObservation ? await this.attachments.currentTab(input.privateTab) : null;
      if (tab && typeof tab.url !== 'string') throw new ExtensionAdapterError('INPUT_POLICY_STALE', 'The current top-level tab URL is unavailable.');
      const effective = policy ? effectiveBrowserPolicy(tab!.url!, policy.snapshot.configuration) : null;
      if (input.recoveryObservation && !isRecoveryObservation(input.method)) throw new ExtensionAdapterError('INPUT_RECOVERY_REQUIRED', 'Only guarded observations can run during input recovery.');
      const guarded = effective?.mode === 'input_only' || input.recoveryObservation === true;
      const params = guarded ? guardedBrowserCommand(input.method, input.params ?? {}, effective?.domain ?? '') : input.params;
      // No await between this revision check and dispatch: a newly synchronized policy fences older queued commands.
      if (this.policy !== policy) throw new ExtensionAdapterError('INPUT_POLICY_STALE', 'The browser rules changed before execution.');
      dispatched = true;
      const rawResult = await this.sendCommand(target, input.method, params, guarded);
      if (guarded && rawResult && isSideEffectRefusal(rawResult)) throw new BrowserPolicyError(input.method, effective?.domain ?? '', 'Chrome could not establish read-only execution. Use a DOM or accessibility observation fallback.');
      if (payloadBytes(rawResult) > this.maxPayloadBytes) {
        throw new ExtensionAdapterError('PAYLOAD_TOO_LARGE', 'The CDP result exceeds the relay payload limit.');
      }
      output = {
        attemptId: input.attemptId,
        connectionGeneration: input.connectionGeneration,
        inventoryGeneration: input.inventoryGeneration,
        tabGeneration: input.privateTab.tabGeneration,
        attachmentGeneration: input.attachmentGeneration,
        rawResult: rawResult ?? null
      };
    } catch (error) {
      if (dispatched && isBrowserInput(input.method)) throw new ExtensionAdapterError('CDP_OUTCOME_UNCERTAIN', 'Chrome may have executed the input. Reconcile the original attempt; do not replay it.');
      const normalized = error instanceof BrowserPolicyError ? new ExtensionAdapterError(error.code, error.message) : asAdapterError(error);
      await this.remember(input, {
        ok: false,
        error: { code: normalized.code, message: normalized.message }
      });
      throw normalized;
    }
    try { await this.remember(input, { ok: true, output }); }
    catch { throw new ExtensionAdapterError('CDP_OUTCOME_UNCERTAIN', 'Chrome executed the command but its outcome could not be persisted. Reconcile; do not replay.'); }
    return output;
  }

  private async sendCommand(target: chrome.debugger.DebuggerSession, method: string, params: Record<string, unknown> | undefined, guarded: boolean): Promise<object | undefined> {
    if (!guarded || method !== 'Runtime.callFunctionOn') return this.attachments.api.sendCommand(target, method, params);
    // callFunctionOn has no protocol timeout. Bound this guarded observation using
    // Chrome's execution interruption, never a page-side timer or input event.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<object | undefined>((resolve, reject) => {
        let timedOut = false;
        timer = setTimeout(() => {
          timedOut = true;
          // Wait for Chrome to finish interruption before allowing the next queued
          // command, otherwise a late termination could kill that next observation.
          void this.attachments.api.sendCommand(target, 'Runtime.terminateExecution').then(
            () => reject(new ExtensionAdapterError('OBSERVATION_TIMEOUT', 'The guarded function observation timed out. Use a bounded DOM or accessibility read.')),
            () => reject(new ExtensionAdapterError('OBSERVATION_TIMEOUT', 'The guarded function observation timed out and Chrome could not confirm interruption. Inspect the tab before continuing.'))
          );
        }, 1000);
        void this.attachments.api.sendCommand(target, method, params).then(
          value => { if (!timedOut) resolve(value); },
          error => { if (!timedOut) reject(error); }
        );
      });
    } finally { if (timer) clearTimeout(timer); }
  }

  private validateInput(input: ExecuteCdpInput): void {
    if (!METHOD_PATTERN.test(input.method)) {
      throw new ExtensionAdapterError('INVALID_CDP_METHOD', 'The CDP method name is invalid.');
    }
    if (!Number.isInteger(input.connectionGeneration) || input.connectionGeneration <= 0) {
      throw new ExtensionAdapterError('STALE_CONNECTION_GENERATION', 'The connection generation is invalid.');
    }
    if (payloadBytes(input.params) > this.maxPayloadBytes) {
      throw new ExtensionAdapterError('PAYLOAD_TOO_LARGE', 'The CDP command exceeds the relay payload limit.');
    }
  }

  private remember(
    input: ExecuteCdpInput,
    outcome: Pick<RecentAttemptOutcome, 'ok' | 'output' | 'error'>
  ): Promise<void> {
    return this.attempts.remember({
      attemptId: input.attemptId,
      connectionGeneration: input.connectionGeneration,
      inventoryGeneration: input.inventoryGeneration,
      tabId: input.privateTab.tabId,
      windowId: input.privateTab.windowId,
      windowGeneration: input.privateTab.windowGeneration,
      tabGeneration: input.privateTab.tabGeneration,
      attachmentGeneration: input.attachmentGeneration,
      operation: input.method,
      recordedAt: new Date().toISOString(),
      ...outcome
    });
  }
}
