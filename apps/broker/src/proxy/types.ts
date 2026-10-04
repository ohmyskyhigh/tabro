import { z } from 'zod';
export const upstreamProxySchema = z.strictObject({
  scheme: z.enum(['http', 'https', 'socks5']),
  host: z.string().min(1).max(253).regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9a-fA-F:]+\])$/u),
  port: z.number().int().min(1).max(65535),
  credential_ref: z.string().regex(/^pcr_[0-9a-f-]{36}$/u).optional()
});
export type UpstreamProxy = z.infer<typeof upstreamProxySchema>;
export type ProxyState = 'unmanaged' | 'pending_connection' | 'applying' | 'applied' | 'failed' | 'control_conflict';
export interface ProxyBinding {
  profileRef: string; revision: number; proxy: UpstreamProxy | null; port: number | null;
  state: ProxyState; appliedRevision: number | null; connectionGeneration: number | null;
  observedAt: string; problemCode: string | null; exit: ProxyExit | null; principalId: string | null;
}
export interface ProxyExit { ip: string; latency_ms: number; observed_at: string; revision: number; source: 'browser' }
export interface ProxyCredentials { username: string; password: string }
export interface CredentialReader { read(ref: string, principalId: string): Promise<ProxyCredentials> }
export const PROXY_OPERATIONS = ['set_browser_proxy', 'clear_browser_proxy', 'check_browser_proxy'] as const;
export type ProxyOperation = typeof PROXY_OPERATIONS[number];
export const isProxyOperation = (value: string): value is ProxyOperation => (PROXY_OPERATIONS as readonly string[]).includes(value);
