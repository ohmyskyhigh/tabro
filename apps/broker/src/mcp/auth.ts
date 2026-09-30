import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { RelayRepositories } from '../storage/index.js';

export function authenticateRequest(request: IncomingMessage, store: RelayRepositories): AuthInfo | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (token.length < 16 || token.length > 4096) return null;
  const principal = store.authenticateAgent(token);
  if (!principal) return null;
  return {
    token,
    clientId: principal.principalId,
    scopes: [...principal.scopes],
    extra: { displayName: principal.displayName }
  };
}

export function rejectUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer realm="tabro"'
  });
  response.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
}

export function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
