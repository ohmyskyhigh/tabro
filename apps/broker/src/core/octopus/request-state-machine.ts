export const requestStates = ['queued', 'running', 'succeeded', 'failed', 'uncertain'] as const;
export type OctopusRequestState = (typeof requestStates)[number];

export const requestPauseReasons = [
  'extension_disconnected',
  'user_confirmation_required',
  'manual_workspace_stop',
  'endpoint_killed',
  'debugger_detached',
  'broker_restarted'
] as const;
export type OctopusPauseReason = (typeof requestPauseReasons)[number];

const transitions: Readonly<Record<OctopusRequestState, readonly OctopusRequestState[]>> = {
  queued: ['running', 'failed'],
  running: ['succeeded', 'failed', 'uncertain'],
  succeeded: [],
  failed: [],
  uncertain: []
};

export function isTerminalRequestState(state: OctopusRequestState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'uncertain';
}

export function assertRequestTransition(from: OctopusRequestState, to: OctopusRequestState): void {
  if (from === to || !transitions[from].includes(to)) {
    throw new Error(`Invalid Tabro request transition: ${from} -> ${to}`);
  }
}

export interface RequestProgress {
  state: OctopusRequestState;
  phase: string;
  pauseCondition: OctopusPauseReason | null;
  checkpointName: string;
  checkpointDetails: Record<string, unknown>;
}

export function updateRequestProgress(
  current: RequestProgress,
  update: Partial<Omit<RequestProgress, 'state'>> & { state?: OctopusRequestState }
): RequestProgress {
  if (update.state !== undefined && update.state !== current.state) {
    assertRequestTransition(current.state, update.state);
  }
  const next = { ...current, ...update };
  if (isTerminalRequestState(next.state) && next.pauseCondition !== null) {
    throw new Error('A terminal Tabro request cannot retain a pause condition.');
  }
  return next;
}
