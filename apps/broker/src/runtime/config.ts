import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.strictObject({
  profiles: z.strictObject({
    launchesEnabled: z.boolean().optional(),
    root: z.string().min(1), executablePath: z.string().min(1), extensionSource: z.string().min(1),
    expectedBrowserVersion: z.string().min(1), expectedExtensionDigest: z.string().regex(/^[a-f0-9]{64}$/u), relayUrl: z.string().url()
  }).optional(),
  host: z.string().default('127.0.0.1'),
  mcpPort: z.coerce.number().int().min(0).max(65_535).default(7331),
  wsPort: z.coerce.number().int().min(0).max(65_535).default(7332),
  dbPath: z.string().min(1).default('.relay-data/relay.sqlite'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  heartbeatTimeoutMs: z.coerce.number().int().min(5_000).max(300_000).default(45_000),
  errorThreshold: z.coerce.number().int().min(1).max(100).default(3),
  leaseTtlMs: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  adminToken: z.string().min(16).max(4096)
});

export type RelayConfig = z.infer<typeof ConfigSchema>;

function localAdminToken(dbPath: string): string {
  const tokenPath = resolve(dirname(dbPath), 'admin-token.txt');
  mkdirSync(dirname(tokenPath), { recursive: true });
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return token;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const dbPath = env.RELAY_DB_PATH ?? '.relay-data/relay.sqlite';
  return ConfigSchema.parse({
    ...(env.RELAY_PROFILES_CONFIG ? { profiles: JSON.parse(readFileSync(resolve(env.RELAY_PROFILES_CONFIG), 'utf8')) as unknown } : {}),
    host: env.RELAY_HOST,
    mcpPort: env.RELAY_MCP_PORT,
    wsPort: env.RELAY_WS_PORT,
    dbPath,
    logLevel: env.RELAY_LOG_LEVEL,
    heartbeatTimeoutMs: env.RELAY_HEARTBEAT_TIMEOUT_MS,
    errorThreshold: env.RELAY_ERROR_THRESHOLD,
    leaseTtlMs: env.RELAY_LEASE_TTL_MS,
    adminToken: env.RELAY_ADMIN_TOKEN ?? localAdminToken(dbPath)
  });
}
