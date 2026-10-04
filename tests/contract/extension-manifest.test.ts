import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OCTOPUS_VERSION } from '../../apps/shared/protocol/src/version.js';

describe('extension manifest', () => {
  it('uses the shared release version across runtime packages', () => {
    const root = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const adapter = JSON.parse(readFileSync('apps/mcp-stdio-adapter/package.json', 'utf8')) as { version: string };
    const manifest = JSON.parse(readFileSync('apps/browser-extension/manifest.json', 'utf8')) as { version: string };
    expect(manifest.version).toBe(OCTOPUS_VERSION);
    expect(root.version).toBe(OCTOPUS_VERSION);
    expect(adapter.version).toBe(OCTOPUS_VERSION);
  });
  it('uses MV3, Chrome 116+, no remote code, and loopback plus fixed IP-check host access', () => {
    const manifest = JSON.parse(readFileSync('apps/browser-extension/manifest.json', 'utf8')) as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116);
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*', 'http://localhost/*', 'https://api.ipify.org/*']);
    expect(manifest.permissions).toContain('nativeMessaging');
    expect(manifest.permissions).toContain('alarms');
    expect(manifest.permissions).toContain('proxy');
    expect(manifest.permissions).toContain('tabGroups');
    expect(manifest.permissions).toContain('debugger');
    expect(typeof manifest.key).toBe('string');
    expect(JSON.stringify(manifest)).not.toContain("'unsafe-eval'");
    expect(JSON.stringify(manifest)).not.toContain('https://*/*');
  });

  it('lets the user persist a customized two-word pairing code', () => {
    const options = readFileSync('apps/browser-extension/options.html', 'utf8');
    expect(options).toContain('Pairing code');
    expect(options).toContain('persists across browser windows and restarts');
    expect(options).toContain('registers automatically');
    expect(options).toMatch(/<input[^>]+id="pairing-code"/);
  });
});
