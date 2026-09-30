import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const workspace = resolve('.');
const stopScript = resolve('tools/stop-local-broker.ps1');
const sourceBrokerEntry = resolve('apps/broker/src/runtime/main.ts');
const temporaryRoots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32').each(['pwsh', 'powershell'])('local broker stop command (%s)', (shell) => {
  it('refuses an unrelated Node PID and retains its PID file', () => {
    const dataRoot = temporaryDataRoot();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
    children.push(child);
    writeFileSync(join(dataRoot, 'broker.pid'), String(child.pid));

    const result = runStop(dataRoot, shell);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to stop process');
    expect(child.exitCode).toBeNull();
    expect(existsSync(join(dataRoot, 'broker.pid'))).toBe(true);
  });

  it('stops Node only when its command line contains the exact expected broker entry', () => {
    const dataRoot = temporaryDataRoot();
    const child = spawn(process.execPath, ['--import', 'tsx', sourceBrokerEntry], {
      cwd: workspace,
      stdio: 'ignore',
      env: {
        ...process.env,
        RELAY_DB_PATH: join(dataRoot, 'relay.sqlite'),
        RELAY_MCP_PORT: '0',
        RELAY_WS_PORT: '0',
        RELAY_ADMIN_TOKEN: 'stop-script-test-token-that-is-long-enough',
        RELAY_LOG_LEVEL: 'silent'
      }
    });
    children.push(child);
    writeFileSync(join(dataRoot, 'broker.pid'), String(child.pid));

    const result = runStop(dataRoot, shell);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'stopped', stopped: true, processId: child.pid });
    expect(existsSync(join(dataRoot, 'broker.pid'))).toBe(false);
  });
});

function temporaryDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'octopus-stop-'));
  temporaryRoots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function runStop(dataRoot: string, shell: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(shell, [
    '-NoProfile',
    '-NonInteractive',
    '-File', stopScript,
    '-WorkspaceRoot', workspace,
    '-DataRoot', dataRoot,
    '-BrokerEntryPath', sourceBrokerEntry
  ], { encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}
