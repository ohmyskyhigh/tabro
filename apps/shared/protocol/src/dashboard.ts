import { z } from 'zod';
import { BrowserRulesSchema } from './browser-interaction-policy.js';

// Advertise through the existing manifest-id list so older strict HELLO parsers still accept it.
export const DASHBOARD_CAPABILITY_ID = 'tabro-dashboard-v1';

export const DashboardCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('snapshot') }),
  z.strictObject({ action: z.literal('rules.save'), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u), configuration: BrowserRulesSchema })
]);
export type DashboardCommand = z.infer<typeof DashboardCommandSchema>;

export const DashboardSnapshotSchema = z.object({
  brokerVersion: z.string(), currentProfileRef: z.string(),
  profiles: z.array(z.object({
    profile_ref: z.string(), endpoint_nickname: z.string(), ownership: z.enum(['broker', 'user']),
    browser_state: z.string(), extension_state: z.string(), ready: z.boolean(), automation_paused: z.boolean(),
    observed_at: z.string(), problem_code: z.string().nullable()
  })),
  rules: z.object({ configuration: BrowserRulesSchema.nullable(), revision: z.string().nullable(), diagnostic: z.string().nullable() })
});
export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>;
