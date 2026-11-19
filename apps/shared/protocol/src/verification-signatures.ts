import type { VerificationSignatureConfig } from './browser-interaction-policy.js';

/** A signature with exactly one matcher set and the rest explicitly null. */
type SignatureMatcher = Partial<Record<'url_contains' | 'title_contains' | 'frame_url_contains' | 'selector_visible', string>>;

function signature(id: string, matcher: SignatureMatcher): VerificationSignatureConfig {
  return { id, url_contains: null, title_contains: null, frame_url_contains: null, selector_visible: null, ...matcher };
}

/**
 * Built-in human-verification signatures shipped with Tabro. Matching is a
 * case-insensitive substring test on the values reported from the page: the URL's
 * host and path (never its query or fragment), the title, visible iframe sources and
 * visible selectors. URL entries pause at once, so each must name a challenge page itself.
 * The list is extended per deployment through `verification_signatures` in browser-rules.json.
 */
export const BUILTIN_VERIFICATION_SIGNATURES: readonly VerificationSignatureConfig[] = [
  signature('taobao-punish-url', { url_contains: '/_____tmd_____/' }),
  signature('taobao-login-redirect-url', { url_contains: 'login.taobao.com/' }),
  signature('taobao-slider-selector', { selector_visible: '#nc_1_wrapper' }),
  signature('taobao-captcha-selector', { selector_visible: '.J_MIDDLEWARE_FRAME_WIDGET' }),
  signature('geetest-selector', { selector_visible: '.geetest_panel' }),
  signature('geetest-slider-selector', { selector_visible: '.geetest_slider_button' }),
  signature('tencent-captcha-selector', { selector_visible: '.TencentCaptcha' }),
  signature('recaptcha-frame', { frame_url_contains: 'google.com/recaptcha' }),
  signature('hcaptcha-frame', { frame_url_contains: 'hcaptcha.com' }),
  signature('cf-challenge-frame', { frame_url_contains: 'challenges.cloudflare.com' }),
  signature('cf-challenge-title', { title_contains: 'just a moment' }),
  signature('cf-challenge-url', { url_contains: 'cdn-cgi/challenge-platform' }),
  signature('cf-blocked-title', { title_contains: 'attention required' })
];

export interface VerificationPageReport {
  readonly url: string;
  readonly title: string;
  readonly frames: readonly string[];
  readonly found: readonly string[];
}

/** One signature matched the page report. Evidence names the matched value, never raw page content. */
export interface VerificationMatch {
  readonly signature: string;
  readonly evidence: string;
  /** A URL redirect is unambiguous; page-content matches may resolve without a person. */
  readonly kind: 'url' | 'title' | 'frame' | 'selector';
}

const includes = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * `host/path` of a URL, without scheme, credentials, query or fragment. URL signatures are
 * matched only against this, so a search term or a redirect parameter naming a challenge
 * host cannot pause an ordinary page; an unparsable value keeps only its part before ? or #.
 */
export function signatureLocation(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return (url.split(/[?#]/u)[0] ?? '').toLowerCase();
  }
}

export function activeVerificationSignatures(user: readonly VerificationSignatureConfig[] | undefined)
  : readonly VerificationSignatureConfig[] {
  const byId = new Map<string, VerificationSignatureConfig>();
  for (const entry of BUILTIN_VERIFICATION_SIGNATURES) byId.set(entry.id, entry);
  for (const entry of user ?? []) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function matchVerificationSignatures(
  signatures: readonly VerificationSignatureConfig[],
  report: VerificationPageReport
): VerificationMatch | null {
  const location = signatureLocation(report.url);
  for (const candidate of signatures) {
    if (candidate.url_contains !== null && includes(location, candidate.url_contains)) {
      return { signature: candidate.id, evidence: `url matches ${candidate.url_contains}`, kind: 'url' };
    }
    if (candidate.title_contains !== null && report.title.length > 0 && includes(report.title, candidate.title_contains)) {
      return { signature: candidate.id, evidence: `title matches ${candidate.title_contains}`, kind: 'title' };
    }
    if (candidate.frame_url_contains !== null) {
      const needle = candidate.frame_url_contains;
      const frame = report.frames.find(item => includes(item, needle));
      if (frame !== undefined) return { signature: candidate.id, evidence: `visible frame matches ${needle}`, kind: 'frame' };
    }
    if (candidate.selector_visible !== null && report.found.includes(candidate.selector_visible)) {
      return { signature: candidate.id, evidence: `visible element matches ${candidate.selector_visible}`, kind: 'selector' };
    }
  }
  return null;
}
