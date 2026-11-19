import { describe, expect, it } from 'vitest';
import { activeVerificationSignatures, BUILTIN_VERIFICATION_SIGNATURES, matchVerificationSignatures, signatureLocation } from '../../apps/shared/protocol/src/verification-signatures.js';
import { BrowserRulesSchema } from '../../apps/shared/protocol/src/browser-interaction-policy.js';

const report = (over: Partial<Parameters<typeof matchVerificationSignatures>[1]> = {}) => ({
  url: 'https://s.taobao.com/search?q=usb', title: '淘宝搜索', frames: [], found: [], ...over
});

describe('human-verification signatures', () => {
  it('matches a challenge URL, title, visible frame and visible selector', () => {
    const signatures = activeVerificationSignatures([]);
    expect(matchVerificationSignatures(signatures, report({ url: 'https://fanli.taobao.com/_____tmd_____/punish?x=1' })))
      .toMatchObject({ kind: 'url' });
    expect(matchVerificationSignatures(signatures, report({ title: 'Just a moment...' })))
      .toMatchObject({ signature: 'cf-challenge-title', kind: 'title' });
    expect(matchVerificationSignatures(signatures, report({ frames: ['https://challenges.cloudflare.com/cdn-cgi/content'] })))
      .toMatchObject({ signature: 'cf-challenge-frame', kind: 'frame' });
    expect(matchVerificationSignatures(signatures, report({ found: ['#nc_1_wrapper'] })))
      .toMatchObject({ signature: 'taobao-slider-selector', kind: 'selector' });
    expect(matchVerificationSignatures(signatures, report())).toBeNull();
  });

  it('matches URL signatures against host and path only, never the query or fragment', () => {
    const signatures = activeVerificationSignatures([]);
    expect(signatureLocation('https://login.taobao.com/member/login.jhtml?redirect=x')).toBe('login.taobao.com/member/login.jhtml');
    // URL matches pause at once on any domain, so search terms and redirect parameters must not trigger them.
    for (const url of [
      'https://www.google.com/search?q=captcha-solver+login.taobao.com/',
      'https://item.taobao.com/item.htm?id=1&redirectURL=https%3A%2F%2Flogin.taobao.com%2Fmember',
      'https://example.com/page#/_____tmd_____/punish',
      'https://github.com/someone/hcaptcha-solver'
    ]) expect(matchVerificationSignatures(signatures, report({ url }))).toBeNull();
    expect(matchVerificationSignatures(signatures, report({ url: 'https://login.taobao.com/member/login.jhtml?redirectURL=x' })))
      .toMatchObject({ signature: 'taobao-login-redirect-url', kind: 'url' });
    expect(matchVerificationSignatures(signatures, report({ url: 'https://example.com/cdn-cgi/challenge-platform/h/b' })))
      .toMatchObject({ signature: 'cf-challenge-url', kind: 'url' });
  });

  it('ignores frames the page does not actually show', () => {
    const signatures = activeVerificationSignatures([]);
    // The extension probe only reports visible frames, so a hidden resident bframe never appears.
    expect(matchVerificationSignatures(signatures, report({ frames: [] }))).toBeNull();
  });

  it('merges deployment additions by id over a built-in entry', () => {
    const merged = activeVerificationSignatures([{ id: 'cf-challenge-title', url_contains: null, title_contains: null,
      frame_url_contains: 'mcaptcha.example', selector_visible: null }]);
    expect(merged.find(candidate => candidate.id === 'cf-challenge-title')!.frame_url_contains).toBe('mcaptcha.example');
    expect(merged.find(candidate => candidate.id === 'taobao-slider-selector')).toBeDefined();
  });

  it('is case-insensitive on matched values', () => {
    const signatures = activeVerificationSignatures([]);
    expect(matchVerificationSignatures(signatures, report({ frames: ['HTTPS://CHALLENGES.CLOUDFLARE.COM/CDN-CGI/X'] })))
      .toMatchObject({ signature: 'cf-challenge-frame' });
    expect(matchVerificationSignatures(signatures, report({ title: 'ATTENTION REQUIRED' })))
      .toMatchObject({ signature: 'cf-blocked-title' });
  });

  it('keeps the built-in list inside the rule schema shape', () => {
    for (const entry of BUILTIN_VERIFICATION_SIGNATURES) {
      expect(() => BrowserRulesSchema.parse({ schemaVersion: 1, rules: [], verification_signatures: [entry] })).not.toThrow();
      const matchers = [entry.url_contains, entry.title_contains, entry.frame_url_contains, entry.selector_visible].filter(value => value !== null);
      expect(matchers).toHaveLength(1);
    }
  });

  it('rejects a signature with no matcher or two matchers', () => {
    expect(() => BrowserRulesSchema.parse({ schemaVersion: 1, rules: [], verification_signatures: [{ id: 'bad' }] })).toThrow();
    expect(() => BrowserRulesSchema.parse({ schemaVersion: 1, rules: [],
      verification_signatures: [{ id: 'bad', url_contains: 'abc', title_contains: 'abc' }] })).toThrow();
    expect(() => BrowserRulesSchema.parse({ schemaVersion: 1, rules: [],
      verification_signatures: [{ id: 'a', url_contains: 'abc' }, { id: 'a', title_contains: 'abc' }] })).toThrow(/Duplicate/u);
  });

  it('keeps a legacy rules file without signatures valid and revision-stable', () => {
    const parsed = BrowserRulesSchema.parse({ schemaVersion: 1, rules: [{ id: 'r', domain: 'example.com', mode: 'human_simulation' }] });
    expect(parsed.verification_signatures).toEqual([]);
  });
});
