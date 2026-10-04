import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assertReleaseVersions } from './stage-release.js';

const root = resolve(import.meta.dirname, '..');
const plugin = resolve(root, 'integrations/hermes');
const runtime = resolve(plugin, 'runtime');
const version = assertReleaseVersions();
if (JSON.parse(readFileSync(resolve(plugin, 'plugin.json'), 'utf8')).version !== version) throw new Error('Hermes plugin version differs from the runtime.');
// This fixed generated directory is the only recursive cleanup target.
if (runtime !== resolve(root, 'integrations/hermes/runtime')) throw new Error('Unexpected runtime output.');
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceSha = (file: string): string => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/gu, '\n')).digest('hex');
const inputNames = new Set<string>();
// Keep the SDK's JSON Schema validators separate from filesystem services.
// AJV uses GitHub URLs as schema identifiers, not as update/download endpoints.
// Preserving this boundary also avoids embedding the server validator twice.
for (const sdk of ['server', 'client']) {
  const result = await build({ entryPoints: [fileURLToPath(import.meta.resolve(`@modelcontextprotocol/${sdk}/_shims`))],
    outfile: resolve(runtime, `validators/mcp-${sdk}.js`), bundle: true, platform: 'node', format: 'esm',
    target: 'node22', external: ['node:*'], metafile: true, logLevel: 'warning' });
  for (const input of Object.keys(result.metafile.inputs)) inputNames.add(input);
}
for (const [source, output] of [
  ['apps/broker/src/runtime/main.ts', 'broker/main.js'],
  ['apps/mcp-stdio-adapter/src/main.ts', 'adapter/main.js'],
  ['tools/provision-proxy-credential.ts', 'broker/provision-proxy-credential.js']
] as const) {
  const result = await build({ entryPoints: [resolve(root, source)], outfile: resolve(runtime, output), bundle: true,
    platform: 'node', format: 'esm', target: 'node22', external: ['node:*'], metafile: true,
    plugins: [{ name: 'shared-mcp-validators', setup(builder) {
      builder.onResolve({ filter: /^@modelcontextprotocol\/(server|client)\/_shims$/ }, args => ({
        path: `../validators/mcp-${args.path.split('/')[1]}.js`, external: true
      }));
    } }],
    banner: { js: "import { createRequire as __tabroCreateRequire } from 'node:module'; const require = __tabroCreateRequire(import.meta.url);" }, logLevel: 'warning' });
  for (const input of Object.keys(result.metafile.inputs)) inputNames.add(input);
}
cpSync(resolve(root, 'apps/broker/src/storage/sqlite/migrations'), resolve(runtime, 'broker/migrations'), { recursive: true });
cpSync(resolve(root, 'dist/browser-extension'), resolve(runtime, 'browser-extension'), { recursive: true, filter: path => !path.endsWith('.map') });
mkdirSync(resolve(runtime, 'native-host'), { recursive: true });
const nativeHostEntry = `native-host/relay-native-host-${version}.exe`;
cpSync(resolve(root, 'dist/native-host/relay-native-host.exe'), resolve(runtime, nativeHostEntry));
mkdirSync(resolve(runtime, 'helpers'), { recursive: true });
for (const name of ['configure-managed-profiles.ps1', 'browser-runtime.ps1']) cpSync(resolve(root, 'tools', name), resolve(runtime, 'helpers', name));
writeFileSync(resolve(runtime, 'package.json'), JSON.stringify({ name: 'tabro-hermes-runtime', version, private: true, type: 'module', license: 'MIT' }, null, 2) + '\n');
cpSync(resolve(root, 'LICENSE'), resolve(plugin, 'LICENSE'));
const licenseDir = resolve(runtime, 'licenses');
mkdirSync(licenseDir, { recursive: true });
const packages = new Map<string, { name: string; version: string; license: string }>();
for (const input of inputNames) {
  if (!input.includes('node_modules')) continue;
  let directory = dirname(resolve(root, input));
  while (directory.startsWith(root + sep)) {
    const file = resolve(directory, 'package.json');
    if (existsSync(file)) {
      const candidate = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (candidate.name && candidate.version) break;
    }
    directory = dirname(directory);
  }
  if (!existsSync(resolve(directory, 'package.json'))) continue;
  const info = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { name: string; version: string; license: string };
  const key = `${info.name}@${info.version}`;
  if (packages.has(key)) continue;
  packages.set(key, { name: info.name, version: info.version, license: info.license });
  for (const name of readdirSync(directory).filter(name => /^(license|licence|copying|notice)(\.|$)/iu.test(name))) {
    if (statSync(resolve(directory, name)).isFile()) cpSync(resolve(directory, name), resolve(licenseDir, key.replace(/[^a-z0-9.-]/giu, '_') + '-' + name));
  }
}
writeFileSync(resolve(runtime, 'licenses/dependencies.json'), JSON.stringify([...packages.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n');
writeFileSync(resolve(runtime, 'build-inputs.json'), JSON.stringify({ version, sourceHashEncoding: 'utf8-lf',
  packageLockSha256: sourceSha(resolve(root, 'pnpm-lock.yaml')),
  sources: [...inputNames].sort().filter(name => !name.includes('node_modules')).map(name => ({ path: relative(root, resolve(root, name)).split(sep).join('/'), sha256: sourceSha(resolve(root, name)) })),
  nativeSource: { path: 'apps/native-host/src/relay-native-host.cpp', sha256: sourceSha(resolve(root, 'apps/native-host/src/relay-native-host.cpp')) }
}, null, 2) + '\n');
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
}
const manifest = { schemaVersion: 1, version, contractVersion: '5', platform: 'windows-x64', nativeHostEntry,
  minimumBrowserVersion: '153.0.0.0',
  node: { version: '22.22.3', url: 'https://nodejs.org/dist/v22.22.3/node-v22.22.3-win-x64.zip',
    archiveSha256: '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33',
    executableSha256: '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b' },
  files: files(runtime).sort().map(file => ({ path: relative(runtime, file).split(sep).join('/'), bytes: statSync(file).size, sha256: sha(file) })) };
writeFileSync(resolve(plugin, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: 'STAGED', plugin, version, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) }));
