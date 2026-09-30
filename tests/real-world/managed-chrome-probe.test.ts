import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startManagedChromeProbeFixture, validateProbeRunId } from '../helpers/managed-chrome-probe-fixture.js';
import { assertFreshProbeRoot, assertProbeConnectionStatus, ChromeProbeControl, probeIdentityHash } from '../../tools/lib/chrome-probe-control.js';

describe('managed Chrome probe isolation', () => {
  it('refuses an existing output directory and a different extension identity', () => {
    const existing = mkdtempSync(join(tmpdir(), 'octopus-probe-test-'));
    try { expect(() => assertFreshProbeRoot(existing)).toThrow('already exists'); }
    finally { rmdirSync(existing); }
    const original = probeIdentityHash({ x: 'first-x', y: 'first-y' });
    expect(() => probeIdentityHash({ x: 'second-x', y: 'first-y' }, original)).toThrow('identity changed');
    expect(() => probeIdentityHash({})).toThrow('identity missing');
    expect(() => assertProbeConnectionStatus({ connectionStatus: 'error', lastError: 'Specified native messaging host not found.' })).toThrow('host not found');
  });
  it('rejects paths and markup in run IDs', () => {
    for (const value of ['', '../shared', 'a/b', 'a\\b', '<script>', 'x'.repeat(65)]) {
      expect(() => validateProbeRunId(value)).toThrow();
    }
    expect(validateProbeRunId('probe-2026-09')).toBe('probe-2026-09');
  });

  it('serves an isolated marker without silently restoring a deleted cookie', async () => {
    const fixture = await startManagedChromeProbeFixture('test-isolation');
    try {
      const response = await fetch(fixture.url);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toContain('data-probe="test-isolation"');
      expect((await fetch(`${fixture.url}missing`)).status).toBe(404);
    } finally { await fixture.close(); }
  });

  it('rejects non-local management connections before opening a socket', async () => {
    await expect(ChromeProbeControl.connect('ws://example.com:9222/devtools/browser/a')).rejects.toThrow('loopback');
    await expect(ChromeProbeControl.connect('wss://127.0.0.1:9222/')).rejects.toThrow('loopback');
  });

  it('reports an extension installation error without converting it into success', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
    server.on('connection', socket => socket.on('message', data => {
      const command = JSON.parse(data.toString()) as { id: number };
      socket.send(JSON.stringify({ id: command.id, error: { message: 'Extension directory missing.' } }));
    }));
    const control = await ChromeProbeControl.connect(`ws://127.0.0.1:${address.port}/devtools/browser/test`);
    try {
      await expect(control.send('Extensions.loadUnpacked', { path: 'missing' })).rejects.toThrow('Extension directory missing');
    } finally { await control.disconnect(); server.close(); }
  });

  it('bounds an unresponsive browser call and rejects calls after disconnection', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
    const control = await ChromeProbeControl.connect(`ws://127.0.0.1:${address.port}/devtools/browser/test`);
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const result = expect(control.send('Browser.getVersion')).rejects.toThrow('timeout');
      await vi.advanceTimersByTimeAsync(15_001);
      await result;
      vi.useRealTimers();
      await control.disconnect();
      await expect(control.send('Browser.getVersion')).rejects.toThrow('not open');
    } finally { vi.useRealTimers(); await control.disconnect(); server.close(); }
  });
});
