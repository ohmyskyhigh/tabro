import { ExtensionAdapterError, type PrivateTabLocator } from '../browser/inventory.js';
import { BrowserPolicyError, effectiveBrowserPolicy, guardedBrowserCommand, humanSimulationCommand, isBrowserInput, isRecoveryObservation, isSideEffectRefusal, stripRemoteObjectIds,
  type BrowserPolicySnapshot } from '../../../shared/protocol/src/browser-interaction-policy.js';
import { initialPointer, pointerPath, readingPause, seededRandom, wheelBurst, type Point, type Random } from '../../../shared/protocol/src/human-motion.js';
import type {
  RecentAttemptCache,
  RecentAttemptOutcome
} from '../executor/recent-command-cache.js';
import type { DebuggerAttachmentManager } from './attachment-manager.js';

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/;

const payloadBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

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
  /** Main frame ID per tab for the guarded observation world. */
  private readonly worlds = new Map<number, string>();
  private readonly pointers = new Map<number, Point>();
  private readonly motions = new Map<number, Random>();
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
      const humanSimulation = effective?.mode === 'human_simulation';
      const guarded = humanSimulation || input.recoveryObservation === true;
      const params = humanSimulation
        ? humanSimulationCommand(input.method, input.params ?? {}, effective.domain)
        : guarded ? guardedBrowserCommand(input.method, input.params ?? {}, effective?.domain ?? '') : (input.params ?? {});
      if (humanSimulation && isBrowserInput(input.method)) {
        if (tab!.active !== true) throw new ExtensionAdapterError('FOREGROUND_REQUIRED', `${effective.domain} is using Human Simulation Mode. ${input.method} needs the tab active in a focused window. Call Page.bringToFront once, or ask the user to focus the Tabro window. Do not retry while the tab is in the background.`);
        if (!(await this.attachments.windowFocused(tab!.windowId))) {
          throw new ExtensionAdapterError('FOREGROUND_REQUIRED', `${effective.domain} is using Human Simulation Mode. The window is not focused; browser input would produce page state no person could produce. Ask the user to focus the Tabro window before continuing.`);
        }
      }
      // No await between this revision check and dispatch: a newly synchronized policy fences older queued commands.
      if (this.policy !== policy) throw new ExtensionAdapterError('INPUT_POLICY_STALE', 'The browser rules changed before execution.');
      dispatched = true;
      const humanInput = humanSimulation && isBrowserInput(input.method);
      const rawResult = humanInput
        ? await this.executeHumanInput(target, input.method, params, input.privateTab.tabId)
        : await this.sendCommand(target, input.method, params, guarded, humanSimulation, input.privateTab.tabId);
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

  /**
   * Expand one agent movement or wheel request into the event sequence a person
   * produces. Coordinates for press/release stay exact; only the approach path and
   * the scroll ticks are synthesized here.
   */
  private async executeHumanInput(target: chrome.debugger.DebuggerSession, method: string,
    params: Record<string, unknown>, tabId: number): Promise<object | undefined> {
    const random = this.motion(tabId);
    let result: object | undefined;
    // A move with a held button is a drag step: coordinates must stay exact and unexpanded.
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && Number(params.buttons ?? 0) === 0) {
      const targetPoint = { x: Number(params.x ?? 0), y: Number(params.y ?? 0) };
      const from = this.pointers.get(tabId) ?? initialPointer(targetPoint, random);
      for (const point of pointerPath(from, targetPoint, random)) {
        result = await this.attachments.api.sendCommand(target, method,
          { ...params, x: point.x, y: point.y, buttons: 0 });
        await sleep(point.delayMs);
      }
      this.pointers.set(tabId, { x: Number(params.x ?? 0), y: Number(params.y ?? 0) });
      return result;
    }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') {
      const deltaX = Number(params.deltaX ?? 0);
      const deltaY = Number(params.deltaY ?? 0);
      for (const tick of wheelBurst(deltaX, deltaY, random)) {
        result = await this.attachments.api.sendCommand(target, method, { ...params, deltaX: tick.deltaX, deltaY: tick.deltaY });
        await sleep(tick.delayMs);
      }
      await sleep(readingPause(random));
      return result;
    }
    if (method === 'Input.dispatchMouseEvent') {
      if (params.x !== undefined && params.y !== undefined) this.pointers.set(tabId, { x: Number(params.x), y: Number(params.y) });
    }
    return this.attachments.api.sendCommand(target, method, params);
  }

  private motion(tabId: number): Random {
    let random = this.motions.get(tabId);
    if (!random) {
      random = seededRandom((tabId ^ (Date.now() & 0xffff)) >>> 0);
      this.motions.set(tabId, random);
    }
    return random;
  }

  /** Human Simulation Runtime.evaluate runs in an isolated world and returns plain data only. */
  private async sendCommand(target: chrome.debugger.DebuggerSession, method: string, params: Record<string, unknown> | undefined,
    guarded: boolean, humanSimulation: boolean, tabId: number): Promise<object | undefined> {
    if (humanSimulation && method === 'Runtime.evaluate') {
      // A child session would evaluate in that frame's page world, outside the isolated world.
      if (target.sessionId !== undefined) throw new BrowserPolicyError(method, '', 'Guarded Runtime.evaluate runs on the top-level tab only; omit sessionId.');
      const read = async (): Promise<object | undefined> => this.attachments.api.sendCommand(target, method,
        { ...params, contextId: await this.observationContext(target, tabId) });
      let result: object | undefined;
      try {
        result = await read();
      } catch (error) {
        // A replaced main frame invalidates the cached frame ID once; look it up again and retry the read.
        this.worlds.delete(tabId);
        if (!/context|frame|target/iu.test(error instanceof Error ? error.message : '')) throw error;
        result = await read();
      }
      return stripRemoteObjectIds(result) as object | undefined;
    }
    if (!guarded || method !== 'Runtime.callFunctionOn') {
      const result = await this.attachments.api.sendCommand(target, method, params);
      if ((method === 'Page.navigate' || method === 'Page.reload')) this.worlds.delete(tabId);
      return result;
    }
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

  /**
   * The isolated main-frame world for one guarded observation. Execution context IDs are not
   * unique across renderer processes, so after a cross-site navigation a cached ID could name
   * the new page's main world. Chrome returns the existing world for a repeated
   * createIsolatedWorld on the same document, so it is requested before every evaluate and only
   * the main frame ID is cached.
   */
  private async observationContext(target: chrome.debugger.DebuggerSession, tabId: number): Promise<number> {
    let frameId = this.worlds.get(tabId);
    if (frameId === undefined) {
      const tree = await this.attachments.api.sendCommand(target, 'Page.getFrameTree') as
        { frameTree?: { frame?: { id?: string } } } | undefined;
      frameId = tree?.frameTree?.frame?.id;
      if (!frameId) throw new ExtensionAdapterError('CDP_COMMAND_FAILED', 'Chrome did not report the main frame for the guarded observation world.');
      this.worlds.set(tabId, frameId);
    }
    const world = await this.attachments.api.sendCommand(target, 'Page.createIsolatedWorld', {
      frameId, worldName: 'tabro-observation', grantUniveralAccess: false
    }) as { executionContextId?: number } | undefined;
    if (typeof world?.executionContextId !== 'number') {
      throw new ExtensionAdapterError('CDP_COMMAND_FAILED', 'Chrome did not create the guarded observation world.');
    }
    return world.executionContextId;
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
