import type { AuthInfo, McpRequestContext } from '@modelcontextprotocol/server';
import type { CallerEvidence } from '../core/index.js';

export const OCTOPUS_RUNTIME_HEADER = 'x-octopus-runtime';
export const OCTOPUS_RUNTIME_SESSION_HEADER = 'x-octopus-runtime-session';
export const OCTOPUS_PARENT_RUNTIME_SESSION_HEADER = 'x-octopus-parent-runtime-session';

const SAFE_RUNTIME_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;
const SAFE_SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u;

export class InvalidCallerEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCallerEvidenceError';
  }
}

const readOptionalHeader = (
  context: McpRequestContext,
  header: string,
  pattern: RegExp
): string | undefined => {
  const value = context.requestInfo?.headers.get(header)?.trim();
  if (value === undefined || value === '') return undefined;
  if (!pattern.test(value)) {
    throw new InvalidCallerEvidenceError(`${header} contains unsupported characters or exceeds its size limit.`);
  }
  return value;
};

/**
 * Builds caller evidence only from the authenticated principal and transport
 * headers. Tool arguments are deliberately never consulted for caller identity.
 * The principal id namespaces runtime session keys so two installed runtimes
 * cannot collide even if they happen to use the same local session label.
 */
export function callerEvidenceFromContext(context: McpRequestContext, authInfo: AuthInfo): CallerEvidence {
  const suppliedRuntime = readOptionalHeader(context, OCTOPUS_RUNTIME_HEADER, SAFE_RUNTIME_NAME);
  const suppliedSession = readOptionalHeader(context, OCTOPUS_RUNTIME_SESSION_HEADER, SAFE_SESSION_KEY);
  const suppliedParent = readOptionalHeader(context, OCTOPUS_PARENT_RUNTIME_SESSION_HEADER, SAFE_SESSION_KEY);
  const displayName = typeof authInfo.extra?.displayName === 'string' ? authInfo.extra.displayName : undefined;
  const fallbackRuntime = displayName && SAFE_RUNTIME_NAME.test(displayName) ? displayName : 'mcp-agent';
  const runtimeName = suppliedRuntime ?? fallbackRuntime;
  const principalNamespace = `principal:${authInfo.clientId}`;

  return {
    managementAuthority: { principalId: authInfo.clientId, scopes: [...authInfo.scopes] },
    runtimeName,
    runtimeSessionKey: `${principalNamespace}:session:${suppliedSession ?? authInfo.clientId}`,
    ...(suppliedParent === undefined
      ? {}
      : { parentRuntimeSessionKey: `${principalNamespace}:session:${suppliedParent}` })
  };
}
