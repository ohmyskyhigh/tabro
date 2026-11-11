import { randomUUID } from 'node:crypto';
import type { JsonRecord, RequestRepository } from '../../storage/repositories.js';
import { OctopusBrokerError, problem } from './broker-problem.js';

export interface InputState {
  windowRef: string;
  endpointRef: string;
  workspaceRef: string;
  tabRef: string;
  ownerSessionRef: string;
  held: string[];
  lastConfirmedStep: string | null;
  lastActivity: number;
  pauseReason: string | null;
  recoveryRef: string;
  uncertain: boolean;
  pending: { attemptRef: string; requestRef: string; before: string[]; after: string[]; step: string } | null;
}

export class InputRecovery {
  constructor(private readonly requests: RequestRepository, private readonly now = Date.now) {}
  all(): InputState[] { return this.requests.inputStates() as unknown as InputState[]; }
  get(tabRef: string): InputState | null { return this.all().find(state => state.tabRef === tabRef) ?? null; }
  forWorkspace(workspaceRef: string): InputState[] { return this.all().filter(state => state.workspaceRef === workspaceRef); }
  private save(state: InputState): void { this.requests.saveInputState(state.tabRef, state as unknown as JsonRecord); }

  assertAvailable(tabRef: string, sessionRef: string): void {
    const state = this.get(tabRef);
    if (!state) return;
    if (state.pauseReason) throw new OctopusBrokerError(problem(state.uncertain ? 'INPUT_STATE_UNCERTAIN' : 'INPUT_RECOVERY_REQUIRED',
      `${state.pauseReason}. Last confirmed input: ${state.lastConfirmedStep ?? 'none'}. Possibly held: ${state.held.join(', ') || 'none'}. Observe the page; do not replay or send a cleanup release. After the user finishes or cancels the gesture, acknowledge its recovery_ref with resume_workspace_automation and resolve any uncertain request separately.`, false,
      { workspace_ref: state.workspaceRef, tab_ref: state.tabRef }));
    if (state.pending || state.ownerSessionRef !== sessionRef) {
      throw new OctopusBrokerError(problem('INPUT_BUSY', 'Held input reserves this tab for its initiating session.', true, { workspace_ref: state.workspaceRef, tab_ref: state.tabRef }));
    }
  }

  prepare(scope: Pick<InputState, 'windowRef' | 'endpointRef' | 'workspaceRef' | 'tabRef' | 'ownerSessionRef'>,
    attemptRef: string, requestRef: string, method: string, params: Record<string, unknown>): void {
    this.assertAvailable(scope.tabRef, scope.ownerSessionRef);
    const previous = this.get(scope.tabRef);
    const before = previous?.held ?? [];
    const after = new Set(before);
    const type = String(params.type ?? 'insertText');
    let key: string | null = null;
    if (method === 'Input.dispatchMouseEvent' && ['mousePressed', 'mouseReleased'].includes(type)) {
      if (!['left', 'right', 'middle', 'back', 'forward'].includes(String(params.button))) throw new OctopusBrokerError(problem('INVALID_ARGUMENT', 'Mouse press/release requires an explicit button.'));
      key = `mouse:${params.button}`;
    } else if (method === 'Input.dispatchKeyEvent' && type !== 'char') {
      const identity = params.code ?? params.key ?? params.windowsVirtualKeyCode;
      if (identity === undefined || String(identity) === '') throw new OctopusBrokerError(problem('INVALID_ARGUMENT', 'Key press/release requires code, key or windowsVirtualKeyCode.'));
      key = `key:${identity}`;
    }
    if (key) {
      if (type === 'mouseReleased' || type === 'keyUp') after.delete(key);
      else after.add(key);
    }
    this.save({ ...scope, held: [...new Set([...before, ...after])], lastConfirmedStep: previous?.lastConfirmedStep ?? null,
      lastActivity: previous?.lastActivity ?? this.now(), pauseReason: null, uncertain: true, recoveryRef: randomUUID(),
      pending: { attemptRef, requestRef, before, after: [...after], step: `${method}:${type}` } });
  }

  complete(attemptRef: string, succeeded: boolean): void {
    const state = this.all().find(item => item.pending?.attemptRef === attemptRef);
    if (!state?.pending) return; // A late result cannot clear a newer gesture or acknowledged recovery.
    state.held = succeeded ? state.pending.after : state.pending.before;
    if (succeeded) { state.lastConfirmedStep = state.pending.step; state.lastActivity = this.now(); }
    state.pending = null;
    state.uncertain = false;
    if (!state.held.length && !state.pauseReason) this.clear(state.tabRef);
    else this.save(state);
  }

  pause(tabRef: string, reason: string): void {
    const state = this.get(tabRef);
    if (!state || state.pauseReason) return;
    state.pauseReason = reason;
    state.recoveryRef = randomUUID();
    this.save(state);
  }
  pauseEndpoint(endpointRef: string, reason: string): void {
    for (const state of this.all().filter(item => item.endpointRef === endpointRef)) this.pause(state.tabRef, reason);
  }
  pauseWorkspace(workspaceRef: string, reason: string): void {
    for (const state of this.forWorkspace(workspaceRef)) this.pause(state.tabRef, reason);
  }
  sweep(): void {
    for (const state of this.all()) if (this.now() - state.lastActivity >= 30_000) this.pause(state.tabRef, 'held_input_inactivity');
  }
  recover(): void { for (const state of this.all()) this.pause(state.tabRef, 'broker_restarted'); }

  transferOwner(workspaceRef: string, sessionRef: string): void {
    for (const state of this.forWorkspace(workspaceRef)) {
      if (state.ownerSessionRef === sessionRef) continue;
      state.ownerSessionRef = sessionRef;
      state.pauseReason ??= 'workspace_owner_changed';
      state.recoveryRef = randomUUID();
      this.save(state);
    }
  }

  acknowledge(tabRef: string, workspaceRef: string, sessionRef: string, recoveryRef: unknown): void {
    const state = this.get(tabRef);
    if (!state) return;
    if (state.workspaceRef !== workspaceRef || state.ownerSessionRef !== sessionRef) throw new OctopusBrokerError(problem('INPUT_BUSY', 'Input recovery belongs to the initiating session and workspace.'));
    if ((state.held.length || state.uncertain) && recoveryRef !== state.recoveryRef) {
      throw new OctopusBrokerError(problem('INPUT_RECOVERY_REQUIRED', 'Confirm the user finished or cancelled the gesture using the current recovery_ref from get_browser_context.'));
    }
    // This only acknowledges physical input. The request's website effect is resolved separately.
    state.held = [];
    state.pending = null;
    state.uncertain = false;
    state.pauseReason = 'input_released_awaiting_resume';
    this.save(state);
  }

  clear(tabRef: string): void { this.requests.saveInputState(tabRef, null); }

  facts(tabRef: string): JsonRecord | null {
    const state = this.get(tabRef);
    return state ? { recovery_ref: state.recoveryRef, workspace_ref: state.workspaceRef, tab_ref: state.tabRef,
      owner_session_ref: state.ownerSessionRef, status: state.pauseReason ? (state.uncertain ? 'uncertain' : 'paused') : 'held',
      pause_reason: state.pauseReason, held_inputs: state.held, last_confirmed_step: state.lastConfirmedStep,
      pending_request_ref: state.pending?.requestRef ?? null } : null;
  }
}
