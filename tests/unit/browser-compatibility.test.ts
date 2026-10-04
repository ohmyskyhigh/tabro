import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertCompatibleBrowser, MINIMUM_BROWSER_MAJOR } from '../../apps/broker/src/profiles/browser-compatibility.js';

describe('Chromium browser compatibility', () => {
  it.each(['Chrome/153.0.8010.53', 'Chrome/154.0.1.0', 'Chromium/155.0.0.0', 'Edg/154.0.4258.53'])(
    'accepts compatible builds and upgrades: %s', product => {
      expect(() => assertCompatibleBrowser({ product })).not.toThrow();
    });
  it('uses the Chromium engine version in a derivative browser user agent', () => {
    expect(() => assertCompatibleBrowser({ product: 'Vendor/1.2.3', userAgent: 'Mozilla/5.0 Chrome/154.0.0.0 Edg/154.0.4258.53' })).not.toThrow();
    expect(() => assertCompatibleBrowser({ product: 'Edg/154.0.4258.53', userAgent: 'Chrome/152.0.0.0' })).toThrow('PROFILE_RUNTIME_UNSUPPORTED');
  });
  it.each(['Chrome/152.0.0.0', 'Firefox/155.0', 'Chrome/bad', ''])('rejects unsupported engines: %s', product => {
    expect(() => assertCompatibleBrowser({ product })).toThrow('PROFILE_RUNTIME_UNSUPPORTED');
  });
  it('keeps the Hermes PE version gate aligned with runtime eligibility', () => {
    const plugin = JSON.parse(readFileSync('integrations/hermes/plugin.json', 'utf8'));
    const declaration = plugin.extensions['com.nousresearch.hermes'].servers.tabro;
    expect(declaration.requires).toEqual({ app: true, min_version: `${MINIMUM_BROWSER_MAJOR}.0.0.0` });
    expect(declaration.app).toEqual({ win32: {
      presence: 'executable', location: '%TABRO_BROWSER_PATH%', version: { kind: 'pe_resource' }
    } });
  });
});
