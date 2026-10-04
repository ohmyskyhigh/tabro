import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { OCTOPUS_VERSION } from '../apps/shared/protocol/src/version.js';

interface PackageJson { version: string }

export interface ReleaseFileFact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  runtimeDiscoveryVersion: 1;
  version: string;
  platform: 'windows-x64';
  extensionDirectory: 'browser-extension';
  brokerEntry: 'broker/main.mjs';
  mcpAdapterEntry: 'mcp-stdio-adapter/main.mjs';
  nativeHostEntry: string;
  files: ReleaseFileFact[];
}

const workspace = resolve(import.meta.dirname, '..');
const defaultOutput = resolve(workspace, 'artifacts', 'release', `tabro-v${OCTOPUS_VERSION}-windows-x64`);

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesBelow(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(current, entry.name);
    return entry.isDirectory() ? filesBelow(root, path) : [path];
  });
}

function assertSafeOutput(output: string): void {
  const normalized = resolve(output);
  if (normalized === workspace || normalized === resolve(normalized, sep) || basename(normalized).length < 8) {
    throw new Error(`Refusing unsafe release staging path: ${normalized}`);
  }
}

export function assertReleaseVersions(): string {
  const root = json<PackageJson>(resolve(workspace, 'package.json')).version;
  const extension = json<PackageJson>(resolve(workspace, 'apps/browser-extension/manifest.json')).version;
  const adapter = json<PackageJson>(resolve(workspace, 'apps/mcp-stdio-adapter/package.json')).version;
  const versions = new Set([root, extension, adapter, OCTOPUS_VERSION]);
  if (versions.size !== 1) {
    throw new Error(`Release versions differ: root=${root}, extension=${extension}, adapter=${adapter}, shared=${OCTOPUS_VERSION}.`);
  }
  return root;
}

export async function stageRelease(output = defaultOutput): Promise<{ output: string; manifest: ReleaseManifest }> {
  const version = assertReleaseVersions();
  const target = resolve(output);
  assertSafeOutput(target);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  await build({
    entryPoints: [resolve(workspace, 'apps/broker/src/runtime/main.ts')],
    outfile: resolve(target, 'broker/main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node:*'],
    banner: { js: "import { createRequire as __octopusCreateRequire } from 'node:module'; const require = __octopusCreateRequire(import.meta.url);" },
    logLevel: 'warning'
  });
  await build({
    entryPoints: [resolve(workspace, 'apps/mcp-stdio-adapter/src/main.ts')],
    outfile: resolve(target, 'mcp-stdio-adapter/main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node:*'],
    banner: { js: "import { createRequire as __octopusCreateRequire } from 'node:module'; const require = __octopusCreateRequire(import.meta.url);" },
    logLevel: 'warning'
  });

  cpSync(resolve(workspace, 'apps/broker/src/storage/sqlite/migrations'), resolve(target, 'broker/migrations'), { recursive: true });
  cpSync(resolve(workspace, 'dist/browser-extension'), resolve(target, 'browser-extension'), { recursive: true });
  mkdirSync(resolve(target, 'native-host'), { recursive: true });
  const nativeHostEntry = `native-host/relay-native-host-${version}.exe`;
  cpSync(resolve(workspace, 'dist/native-host/relay-native-host.exe'), resolve(target, nativeHostEntry));
  mkdirSync(resolve(target, 'tools'), { recursive: true });
  for (const name of [
    'update-local.ps1',
    'configure-managed-profiles.ps1',
    'browser-runtime.ps1',
    'managed-upgrade-snapshot.mjs',
    'stop-installed-broker.ps1',
    'register-hermes-profiles.ps1',
    'installed-broker-launcher.mjs',
    'installed-mcp-adapter-launcher.mjs'
  ]) {
    cpSync(resolve(workspace, 'tools', name), resolve(target, 'tools', name));
  }
  cpSync(resolve(workspace, 'README.md'), resolve(target, 'README.md'));
  cpSync(resolve(workspace, 'README.zh-CN.md'), resolve(target, 'README.zh-CN.md'));
  cpSync(resolve(workspace, 'doc/zh-CN'), resolve(target, 'doc/zh-CN'), { recursive: true });
  cpSync(resolve(workspace, 'LICENSE'), resolve(target, 'LICENSE'));

  const facts = filesBelow(target)
    .filter((path) => basename(path) !== 'release-manifest.json')
    .map((path) => ({
      path: relative(target, path).split(sep).join('/'),
      sha256: sha256(path),
      bytes: statSync(path).size
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    runtimeDiscoveryVersion: 1,
    version,
    platform: 'windows-x64',
    extensionDirectory: 'browser-extension',
    brokerEntry: 'broker/main.mjs',
    mcpAdapterEntry: 'mcp-stdio-adapter/main.mjs',
    nativeHostEntry,
    files: facts
  };
  writeFileSync(resolve(target, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { output: target, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const outputArgument = process.argv.find((value) => value.startsWith('--output='))?.slice('--output='.length);
  const result = await stageRelease(outputArgument);
  console.log(JSON.stringify({ status: 'STAGED', output: result.output, version: result.manifest.version, files: result.manifest.files.length }, null, 2));
}
