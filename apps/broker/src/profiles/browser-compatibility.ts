import { ProfileError } from './types.js';

export const MINIMUM_BROWSER_MAJOR = 153;

/** Check the Chromium engine, not an exact vendor build captured during setup. */
export function assertCompatibleBrowser(version: Record<string, unknown>): void {
  const product = typeof version.product === 'string' ? version.product : '';
  const agent = typeof version.userAgent === 'string' ? version.userAgent : '';
  const match = /\b(?:Chrome|Chromium|HeadlessChrome)\/(\d+)\./u.exec(agent)
    ?? /^(?:Chrome|Chromium|HeadlessChrome|Edg)\/(\d+)\./u.exec(product);
  if (!match || Number(match[1]) < MINIMUM_BROWSER_MAJOR) throw new ProfileError('PROFILE_RUNTIME_UNSUPPORTED');
}
