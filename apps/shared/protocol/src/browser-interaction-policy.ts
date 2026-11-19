import { z } from 'zod';

export function normalizeRuleDomain(value: string): string {
  if (!value || value !== value.trim() || /[\s/:@?#*\\%]/u.test(value)) throw new Error('Use a domain or subdomain only, without a scheme, path or wildcard.');
  const hostname = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/u, '');
  if (hostname.length > 253 || !hostname.includes('.') || /^[\d.]+$/u.test(hostname)
    || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new Error('Rules require a valid domain or subdomain, not an IP address.');
  }
  return hostname;
}

/** A verification signature. Exactly one non-null matcher; matching is a case-insensitive substring test. */
export const VerificationSignatureSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
  url_contains: z.string().min(3).max(512).nullable().default(null),
  title_contains: z.string().min(2).max(256).nullable().default(null),
  frame_url_contains: z.string().min(3).max(512).nullable().default(null),
  selector_visible: z.string().min(1).max(256).nullable().default(null)
}).refine(value => [value.url_contains, value.title_contains, value.frame_url_contains, value.selector_visible]
  .filter(item => item !== null).length === 1,
  { message: 'A verification signature needs exactly one of url_contains, title_contains, frame_url_contains or selector_visible.' });
export type VerificationSignatureConfig = z.infer<typeof VerificationSignatureSchema>;

export const BrowserRulesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rules: z.array(z.strictObject({
    id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
    domain: z.string().transform((value, context) => {
      try { return normalizeRuleDomain(value); }
      catch (error) { context.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER; }
    }),
    mode: z.enum(['human_simulation', 'input_only']).transform(() => 'human_simulation' as const)
  })).max(1000),
  verification_signatures: z.array(VerificationSignatureSchema).max(200).default([])
}).superRefine((value, context) => {
  for (const field of ['id', 'domain'] as const) {
    if (new Set(value.rules.map(rule => rule[field])).size !== value.rules.length) {
      context.addIssue({ code: 'custom', path: ['rules'], message: `Duplicate rule ${field}.` });
    }
  }
  const signatures = value.verification_signatures ?? [];
  if (new Set(signatures.map(signature => signature.id)).size !== signatures.length) {
    context.addIssue({ code: 'custom', path: ['verification_signatures'], message: 'Duplicate verification signature id.' });
  }
});
export type BrowserRules = z.infer<typeof BrowserRulesSchema>;
export const BrowserPolicySnapshotSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  generation: z.number().int().positive(),
  configuration: BrowserRulesSchema
});
export type BrowserPolicySnapshot = z.infer<typeof BrowserPolicySnapshotSchema>;

export function effectiveBrowserPolicy(url: string, configuration: BrowserRules) {
  let domain = '';
  try { domain = new URL(url).hostname.toLowerCase().replace(/\.$/u, ''); } catch { /* Unknown inventory URL. */ }
  const rule = configuration.rules.filter(candidate => domain === candidate.domain || domain.endsWith(`.${candidate.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  return { mode: rule ? 'human_simulation' as const : 'standard' as const, domain, matched_rule: rule?.id ?? null, matched_domain: rule?.domain ?? null };
}

// Every baseline method is explicitly classified. Unknown methods fail closed.
export const BROWSER_METHOD_POLICY: Readonly<Record<string, 'read' | 'evaluate' | 'input' | 'navigation' | 'blocked'>> = {
  'Accessibility.disable': 'read', 'Accessibility.enable': 'read', 'Accessibility.getFullAXTree': 'read',
  'Accessibility.getPartialAXTree': 'read', 'Accessibility.queryAXTree': 'read',
  'DOM.describeNode': 'read', 'DOM.disable': 'read', 'DOM.enable': 'read', 'DOM.focus': 'blocked',
  'DOM.getBoxModel': 'read', 'DOM.getDocument': 'read', 'DOM.getOuterHTML': 'read', 'DOM.querySelector': 'read',
  'DOM.querySelectorAll': 'read', 'DOM.removeAttribute': 'blocked', 'DOM.requestNode': 'read',
  'DOM.resolveNode': 'read', 'DOM.setAttributeValue': 'blocked', 'DOM.setFileInputFiles': 'blocked',
  'Emulation.clearDeviceMetricsOverride': 'blocked', 'Emulation.setDeviceMetricsOverride': 'blocked',
  'Emulation.setScrollbarsHidden': 'blocked', 'Input.dispatchKeyEvent': 'input', 'Input.dispatchMouseEvent': 'input',
  'Input.insertText': 'input', 'Input.setIgnoreInputEvents': 'blocked',
  'Network.disable': 'read', 'Network.enable': 'read', 'Network.getResponseBody': 'read', 'Network.setCacheDisabled': 'blocked',
  'Page.bringToFront': 'navigation', 'Page.captureScreenshot': 'read', 'Page.disable': 'read', 'Page.enable': 'read',
  'Page.getFrameTree': 'read', 'Page.getLayoutMetrics': 'read', 'Page.navigate': 'navigation', 'Page.reload': 'navigation',
  'Page.stopLoading': 'blocked', 'Runtime.callFunctionOn': 'evaluate', 'Runtime.disable': 'read', 'Runtime.enable': 'read',
  'Runtime.evaluate': 'evaluate', 'Runtime.getProperties': 'read', 'Runtime.releaseObject': 'read', 'Runtime.releaseObjectGroup': 'read'
};

export const isRecoveryObservation = (method: string): boolean => ['read', 'evaluate'].includes(BROWSER_METHOD_POLICY[method] ?? '');
export const isBrowserInput = (method: string): boolean => BROWSER_METHOD_POLICY[method] === 'input';

export class BrowserPolicyError extends Error {
  readonly code = 'INPUT_ONLY_REQUIRED';
  constructor(method: string, domain: string, detail?: string) {
    super(`${domain || 'This tab'} is using Human Simulation Mode. ${method}: ${detail ?? 'This method or parameter can change page state.'} Inspect the page with Page.captureScreenshot. For a specific element use DOM.querySelector, DOM.describeNode or DOM.getBoxModel; act with Input.dispatchMouseEvent, Input.dispatchKeyEvent or Input.insertText. Do not repeat the blocked command. File pickers and unsupported clipboard/composition require user handoff.`);
  }
}

export function guardedBrowserCommand(method: string, params: Record<string, unknown>, domain: string): Record<string, unknown> {
  const kind = BROWSER_METHOD_POLICY[method];
  const reject = (detail?: string): never => { throw new BrowserPolicyError(method, domain, detail); };
  if (!kind || kind === 'blocked') reject();
  if (kind === 'evaluate') {
    if (params.throwOnSideEffect === false || params.disableBreaks === true || params.allowUnsafeEvalBlockedByCSP === true
      || params.userGesture === true || params.awaitPromise === true) reject('Observation cannot disable guards, claim a user gesture or await page promises.');
    return { ...params, throwOnSideEffect: true, silent: true, userGesture: false,
      ...(method === 'Runtime.evaluate' ? { timeout: Math.min(typeof params.timeout === 'number' && params.timeout > 0 ? params.timeout : 1000, 1000), allowUnsafeEvalBlockedByCSP: false } : {}) };
  }
  if (method === 'Input.dispatchKeyEvent' && (params.commands !== undefined || !['keyDown', 'keyUp', 'rawKeyDown', 'char'].includes(String(params.type)))) reject('Use keyboard events without editing-command shortcuts.');
  if (method === 'Input.dispatchMouseEvent' && (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(params.type))
    || (params.pointerType !== undefined && params.pointerType !== 'mouse'))) reject('Use mouse movement, button press/release or wheel input.');
  if (method === 'Page.navigate' && (typeof params.url !== 'string' || !/^https?:\/\//iu.test(params.url))) reject('Navigation requires an ordinary HTTP(S) URL.');
  if (method === 'Page.reload' && params.scriptToEvaluateOnLoad !== undefined) reject('Reload cannot inject a script.');
  return params;
}

export function isSideEffectRefusal(result: object): boolean {
  const exception = (result as { exceptionDetails?: unknown }).exceptionDetails;
  return exception !== undefined && /(?:possible side.effect|side.effect check|side effects? cannot|side.effect-free)/iu.test(JSON.stringify(exception));
}

/**
 * Human Simulation allows screenshots, targeted read-only element inspection and guarded
 * Runtime.evaluate. Evaluate results are always returned by value, and the extension runs
 * the expression in an isolated world, so no page object reference reaches the agent.
 */
export function humanSimulationCommand(method: string, params: Record<string, unknown>, domain: string): Record<string, unknown> {
  const kind = BROWSER_METHOD_POLICY[method];
  if (kind !== 'input' && kind !== 'navigation' && !HUMAN_OBSERVATIONS.has(method)) {
    throw new BrowserPolicyError(method, domain, 'Use Runtime.evaluate returning plain data, a screenshot or targeted element inspection.');
  }
  if (method === 'DOM.getDocument' || method === 'DOM.describeNode') return { ...params, depth: Math.min(typeof params.depth === 'number' && params.depth >= 0 ? params.depth : 1, 1), pierce: false };
  if (method === 'Runtime.evaluate') {
    for (const key of ['contextId', 'uniqueContextId', 'objectGroup', 'includeCommandLineAPI', 'replMode', 'serializationOptions', 'generateWebDriverValue']) {
      if (params[key] !== undefined) throw new BrowserPolicyError(method, domain, `${key} is not available in Human Simulation Mode. Tabro selects an isolated execution context and returns plain data.`);
    }
    if (typeof params.expression !== 'string' || params.expression.length === 0) throw new BrowserPolicyError(method, domain, 'Runtime.evaluate needs a nonempty expression.');
    if (params.expression.length > 8192) throw new BrowserPolicyError(method, domain, 'The observation expression exceeds the 8192-character limit. Use a smaller targeted read.');
    return { ...guardedBrowserCommand(method, params, domain), returnByValue: true, generatePreview: false };
  }
  return guardedBrowserCommand(method, params, domain);
}

const HUMAN_OBSERVATIONS = new Set([
  'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.getFrameTree', 'Page.enable', 'Page.disable',
  'DOM.enable', 'DOM.disable', 'DOM.getDocument', 'DOM.querySelector', 'DOM.querySelectorAll',
  'DOM.describeNode', 'DOM.getBoxModel',
  'Accessibility.enable', 'Accessibility.disable', 'Accessibility.getPartialAXTree', 'Accessibility.queryAXTree',
  'Runtime.evaluate'
]);

/** Commands still available while a human-verification challenge pauses automation. */
export const VERIFICATION_PAUSE_ALLOWED = new Set([
  'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.getFrameTree', 'Page.bringToFront', 'Page.enable', 'Page.disable',
  'DOM.enable', 'DOM.disable', 'DOM.getDocument', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.describeNode', 'DOM.getBoxModel',
  'Accessibility.enable', 'Accessibility.disable', 'Accessibility.getPartialAXTree', 'Accessibility.queryAXTree'
]);

/** Recursively removes remote object identifiers so a result cannot be used to reach page objects. */
export function stripRemoteObjectIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRemoteObjectIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'objectId')
    .map(([key, child]) => [key, stripRemoteObjectIds(child)]));
}

/** Minimum time before the next control event in this tab. Reads bypass this timer. */
export function humanControlInterval(method: string, params: Record<string, unknown>): number {
  if (BROWSER_METHOD_POLICY[method] === 'navigation') return 220;
  if (method === 'Input.dispatchMouseEvent') {
    if (params.type === 'mouseMoved') return 32;
    if (params.type === 'mousePressed') return 72;
    if (params.type === 'mouseWheel') return 90;
    return 150;
  }
  if (method === 'Input.dispatchKeyEvent') return params.type === 'keyUp' ? 100 : 64;
  return method === 'Input.insertText' ? 160 : 0;
}
