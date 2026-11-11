import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ProfileError } from './types.js';

export const MANAGED_EXTENSION_ID = 'caekiojlchhifdomfghejkbfpmaklafe';
export interface ProfileRuntimeConfig {
  launchesEnabled?: boolean | undefined;
  root: string;
  executablePath: string;
  extensionSource: string;
  /** Observed at setup, retained for legacy configurations; not an exact build lock. */
  expectedBrowserVersion: string;
  expectedExtensionDigest: string;
  relayUrl: string;
  nativeHostManifest?: string | undefined;
}

export function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new ProfileError('PROFILE_PATH_INVALID');
  if (stat.mode & 0o077) chmodSync(directory, 0o700);
}

export function containedPath(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  const rel = relative(base, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new ProfileError('PROFILE_PATH_INVALID');
  // Inspect every existing ancestor, including the configured root itself.
  let current = resolve(base).split(sep)[0]! + sep;
  for (const part of target.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ProfileError('PROFILE_PATH_INVALID');
  }
  if (existsSync(target)) {
    const physical = relative(realpathSync(base), realpathSync(target));
    if (isAbsolute(physical) || physical === '..' || physical.startsWith(`..${sep}`)) throw new ProfileError('PROFILE_PATH_INVALID');
  }
  return target;
}

export function profileLayout(root: string, key: string): { directory: string; dataDir: string; extensionDir: string } {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(key)) throw new ProfileError('PROFILE_PATH_INVALID');
  containedPath(root);
  mkdirSync(root, { recursive: true });
  const directory = containedPath(root, 'profiles', key);
  return { directory, dataDir: containedPath(root, 'profiles', key, 'user-data'), extensionDir: containedPath(root, 'profiles', key, 'extension') };
}

export function extensionDigest(directory: string): string {
  const hash = createHash('sha256');
  for (const file of ['manifest.json', 'service-worker.js', 'options.js', 'options.html']) hash.update(file).update(readFileSync(resolve(directory, file)));
  return hash.digest('hex');
}

export function validateRuntime(config: ProfileRuntimeConfig): void {
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new ProfileError('PROFILE_RUNTIME_UNSUPPORTED');
  const url = new URL(config.relayUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.pathname !== '/relay' || url.username || url.password) throw new ProfileError('PROFILE_RUNTIME_INVALID');
  if (!isAbsolute(config.executablePath) || !existsSync(config.executablePath)) throw new ProfileError('PROFILE_RUNTIME_MISSING');
  if (process.platform !== 'win32' && (!config.nativeHostManifest || !isAbsolute(config.nativeHostManifest) || !existsSync(config.nativeHostManifest))) {
    throw new ProfileError('PROFILE_RUNTIME_MISSING');
  }
  if (extensionDigest(config.extensionSource) !== config.expectedExtensionDigest) throw new ProfileError('PROFILE_EXTENSION_MISMATCH');
}
