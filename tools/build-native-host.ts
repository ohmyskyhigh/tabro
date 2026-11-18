import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
if (process.platform === 'win32') {
  execFileSync('pwsh', ['-NoProfile', '-File', resolve(root, 'tools/build-native-host.ps1')], { stdio: 'inherit' });
} else {
  mkdirSync(resolve(root, 'dist/native-host'), { recursive: true });
  if (process.platform === 'darwin') {
    execFileSync('clang', ['-O2', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-framework', 'Security',
      resolve(root, 'apps/native-host/src/tabro-macos.c'), '-o', resolve(root, 'dist/native-host/tabro-macos')], { stdio: 'inherit' });
  }
  execFileSync(process.platform === 'darwin' ? 'clang' : 'cc', [
    '-O2', '-Wall', '-Wextra', '-Werror', '-shared', '-fPIC',
    ...(process.platform === 'darwin' ? ['-undefined', 'dynamic_lookup'] : []),
    resolve(root, 'apps/native-host/src/machine-lock.c'), '-o', resolve(root, 'dist/native-host/machine-lock.node')
  ], { stdio: 'inherit' });
}
