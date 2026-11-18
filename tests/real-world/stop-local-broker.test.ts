import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const stopScript = resolve('tools/stop-local-broker.ps1');

describe.runIf(process.platform === 'win32').each(['pwsh', 'powershell'])('local broker stop command (%s)', shell => {
  it('rejects a PID-file override without stopping an unrelated process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tabro-stop-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(root, 'broker.pid'), String(child.pid));
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', stopScript,
        '-DataRoot', root, '-BrokerEntryPath', resolve('apps/broker/src/runtime/main.ts')], { encoding: 'utf8', windowsHide: true });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Source path overrides cannot select a separate Broker');
      expect(child.exitCode).toBeNull();
      expect(existsSync(join(root, 'broker.pid'))).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
        child.kill(); await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
