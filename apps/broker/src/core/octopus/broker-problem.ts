import type { PublicProblemCode } from '../../../../shared/protocol/src/error-codes.js';
export type { PublicProblemCode } from '../../../../shared/protocol/src/error-codes.js';

export interface PublicProblem {
  code: PublicProblemCode;
  message: string;
  retryable: boolean;
  affected_target: null | Record<string, string>;
}

export class OctopusBrokerError extends Error {
  constructor(readonly problem: PublicProblem) {
    super(problem.message);
    this.name = 'OctopusBrokerError';
  }
}

export const problem = (
  code: PublicProblemCode,
  message: string,
  retryable = false,
  affectedTarget: null | Record<string, string> = null
): PublicProblem => ({ code, message, retryable, affected_target: affectedTarget });

