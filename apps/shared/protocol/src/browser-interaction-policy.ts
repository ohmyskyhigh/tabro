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

export const BrowserRulesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rules: z.array(z.strictObject({
    id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
    domain: z.string().transform((value, context) => {
      try { return normalizeRuleDomain(value); }
      catch (error) { context.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER; }
    }),
    mode: z.literal('input_only')
  })).max(1000)
}).superRefine((value, context) => {
  for (const field of ['id', 'domain'] as const) {
    if (new Set(value.rules.map(rule => rule[field])).size !== value.rules.length) {
      context.addIssue({ code: 'custom', path: ['rules'], message: `Duplicate rule ${field}.` });
    }
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
  return { mode: rule ? 'input_only' as const : 'standard' as const, domain, matched_rule: rule?.id ?? null, matched_domain: rule?.domain ?? null };
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
    super(`${domain || 'This tab'} requires input-only manipulation. ${method}: ${detail ?? 'This method or parameter can change page state.'} Observe with DOM.getDocument, DOM.querySelector, DOM.getBoxModel, Accessibility.getFullAXTree or Page.captureScreenshot; act with Input.dispatchMouseEvent, Input.dispatchKeyEvent or Input.insertText. Do not repeat the blocked command. File pickers and unsupported clipboard/composition require user handoff.`);
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
