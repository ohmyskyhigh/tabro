import type {
  StoredCallerSession,
  StoredRequestTicket
} from '../../storage/index.js';
import type { PublicProblem } from './broker-problem.js';

export type JsonObject = Record<string, unknown>;

export const callerFacts = (caller: StoredCallerSession): JsonObject => ({
  session_ref: caller.sessionRef,
  lineage_ref: caller.lineageRef,
  parent_session_ref: caller.parentSessionRef
});

const checkpoint = (ticket: StoredRequestTicket): JsonObject => {
  const value = ticket.checkpoint;
  return {
    name: typeof value.name === 'string' && value.name.length > 0 ? value.name : ticket.phase,
    recorded_at: typeof value.recorded_at === 'string' ? value.recorded_at : ticket.updatedAt,
    details: value.details && typeof value.details === 'object' && !Array.isArray(value.details)
      ? value.details
      : {}
  };
};

export const requestTicketFacts = (ticket: StoredRequestTicket): JsonObject => {
  const terminal = ticket.state === 'succeeded' || ticket.state === 'failed' || ticket.state === 'uncertain';
  return {
    request_ref: ticket.requestRef,
    state: ticket.state,
    phase: ticket.phase,
    checkpoint: checkpoint(ticket),
    pause_condition: ticket.pauseCondition === null
      ? null
      : { reason: ticket.pauseCondition, paused_at: ticket.updatedAt },
    request: ticket.normalizedBody,
    submitted_at: ticket.acceptedAt,
    started_at: ticket.state === 'queued' ? null : ticket.acknowledgedAt ?? ticket.updatedAt,
    finished_at: terminal ? ticket.terminalAt ?? ticket.updatedAt : null,
    updated_at: ticket.updatedAt,
    result: ticket.state === 'succeeded' ? ticket.result : null,
    failure: ticket.state === 'failed' ? ticket.result : null,
    uncertainty: ticket.state === 'uncertain' ? ticket.result : null
  };
};

export const pollAction = (requestRef: string): JsonObject => ({
  tool: 'get_browser_request',
  arguments: { request_ref: requestRef },
  required_arguments: []
});

export const closeAction = (requestRef: string): JsonObject => ({
  tool: 'close_browser_request',
  arguments: { request_ref: requestRef },
  required_arguments: []
});

export const acceptedSubmission = (caller: StoredCallerSession, ticket: StoredRequestTicket): JsonObject => ({
  contract_version: '2',
  disposition: 'accepted',
  observed_at: new Date().toISOString(),
  caller: callerFacts(caller),
  problem: null,
  facts: { ticket: requestTicketFacts(ticket) },
  available_actions: [pollAction(ticket.requestRef)]
});

export const rejectedSubmission = (caller: StoredCallerSession, rejectedProblem: PublicProblem): JsonObject => ({
  contract_version: '2',
  disposition: 'rejected',
  observed_at: new Date().toISOString(),
  caller: callerFacts(caller),
  problem: rejectedProblem,
  facts: null,
  available_actions: []
});

export const completeRead = (
  caller: StoredCallerSession,
  facts: JsonObject,
  availableActions: JsonObject[] = []
): JsonObject => ({
  contract_version: '2',
  disposition: 'complete',
  observed_at: new Date().toISOString(),
  caller: callerFacts(caller),
  problem: null,
  facts,
  available_actions: availableActions
});

export const rejectedRead = (caller: StoredCallerSession, rejectedProblem: PublicProblem): JsonObject => ({
  contract_version: '2',
  disposition: 'rejected',
  observed_at: new Date().toISOString(),
  caller: callerFacts(caller),
  problem: rejectedProblem,
  facts: null,
  available_actions: []
});
