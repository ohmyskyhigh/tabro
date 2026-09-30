import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ChromeLauncher, matchesInstance, processUsesDataDir, type ChromeProcessIdentity } from '../../apps/broker/src/profiles/chrome-launcher.js';
import { containedPath, profileLayout, type ProfileRuntimeConfig } from '../../apps/broker/src/profiles/runtime-config.js';
import type { ManagedBrowserInstance } from '../../apps/broker/src/profiles/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('octopus-path-test-')) throw new Error('Invalid cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});
const processIdentity: ChromeProcessIdentity = { pid: 123, createdAt: 'time1', executablePath: 'C:\\Chrome\\chrome.exe', commandLine: 'chrome.exe "--user-data-dir=C:\\Profile Data" --no-first-run' };
const instance: ManagedBrowserInstance = { instanceRef: 'ins_test', profileRef: 'prf_test', generation: 1, browserState: 'running', extensionState: 'unknown',
  pid: 123, processCreatedAt: 'time1', executablePath: processIdentity.executablePath, dataDir: 'C:\\Profile Data', managementUrl: null, observedAt: 'now', endedAt: null };

describe('managed Chrome ownership', () => {
  it('parses quoted data directories without prefix matching another profile', () => {
    expect(processUsesDataDir(processIdentity, 'C:\\Profile Data')).toBe(true);
    expect(processUsesDataDir(processIdentity, 'C:\\Profile')).toBe(false);
    expect(processUsesDataDir({ ...processIdentity, commandLine: 'chrome.exe --user-data-dir="C:\\Profile Data"' }, 'C:\\Profile Data')).toBe(true);
    expect(processUsesDataDir({ ...processIdentity, commandLine: 'chrome.exe --user-data-dir=C:\\Profile' }, 'C:\\Profile')).toBe(true);
  });
  it('requires PID, process creation, executable and exact data directory together', () => {
    expect(matchesInstance(processIdentity, instance)).toBe(true);
    expect(matchesInstance({ ...processIdentity, createdAt: 'time2' }, instance)).toBe(false);
    expect(matchesInstance({ ...processIdentity, executablePath: 'C:\\Other\\chrome.exe' }, instance)).toBe(false);
    expect(matchesInstance({ ...processIdentity, pid: 124 }, instance)).toBe(false);
  });
  it('reports uncertainty when a PID is reused or the directory belongs to another process', async () => {
    const config = {} as ProfileRuntimeConfig;
    expect(await new ChromeLauncher(config, async () => []).inspect(instance)).toBe('stopped');
    expect(await new ChromeLauncher(config, async () => [processIdentity]).inspect(instance)).toBe('running');
    expect(await new ChromeLauncher(config, async () => [{ ...processIdentity, createdAt: 'time2' }]).inspect(instance)).toBe('unknown');
    expect(await new ChromeLauncher(config, async () => [{ ...processIdentity, pid: 124 }]).inspect(instance)).toBe('unknown');
    await expect(new ChromeLauncher(config, async () => { throw new Error('CIM unavailable'); }).inspect(instance)).rejects.toThrow('CIM unavailable');
  });
  it('rejects traversal and junctions before assigning a profile path', () => {
    const root = mkdtempSync(join(tmpdir(), 'octopus-path-test-')); roots.push(root);
    expect(() => containedPath(root, '..', 'escape')).toThrow('PROFILE_PATH_INVALID');
    expect(() => profileLayout(root, '../../escape')).toThrow('PROFILE_PATH_INVALID');
    expect(profileLayout(root, randomUUID()).dataDir.startsWith(root + sep)).toBe(true);
    const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(root, 'profiles'), 'junction');
    expect(() => profileLayout(root, randomUUID())).toThrow('PROFILE_PATH_INVALID');
  });
});
