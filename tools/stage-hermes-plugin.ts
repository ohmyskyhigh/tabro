import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { MINIMUM_BROWSER_MAJOR } from '../apps/broker/src/profiles/browser-compatibility.js';
import { containedPath } from '../apps/broker/src/profiles/runtime-config.js';
import { MCP_CONTRACT_VERSION } from '../apps/shared/protocol/src/mcp/tool-catalog.js';
import { assertReleaseVersions } from './stage-release.js';

const root = resolve(import.meta.dirname, '..');
const sourcePlugin = resolve(root, 'integrations/hermes');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
const catalogFrom = process.argv.find(arg => arg.startsWith('--catalog-from='))?.slice('--catalog-from='.length);
const plugin = output ? containedPath(root, 'artifacts/release', output) : sourcePlugin;
const windows = process.platform === 'win32';
const platform = `${windows ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
const runtime = containedPath(plugin, 'runtime');
const version = assertReleaseVersions();
const catalog = JSON.parse(readFileSync(resolve(sourcePlugin, 'plugin.json'), 'utf8'));
const minimumBrowserVersion = `${MINIMUM_BROWSER_MAJOR}.0.0.0`;
const windowsScripts = ['broker-service.mjs', 'common.ps1', 'setup.ps1', 'stop.ps1', 'launch.ps1', 'proxy-credential.ps1'];
const windowsNativeHost = `native-host/relay-native-host-${version}.exe`;
const nativeHostUrl = `https://github.com/ohmyskyhigh/tabro/releases/download/v${version}/tabro-native-host-v${version}-windows-x64.exe`;
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
type FileFact = { path: string; bytes: number; sha256: string };

if (catalog.extensions?.['com.nousresearch.hermes']?.servers?.tabro?.requires?.min_version !== minimumBrowserVersion) {
  throw new Error('Hermes browser minimum differs from the managed launcher.');
}
if (catalogFrom) {
  if (output && output !== `tabro-hermes-v${version}-windows-x64`) throw new Error('Invalid Hermes catalog output name.');
  stageCatalog(realpathSync(catalogFrom));
} else {
  if (!['windows-x64', 'macos-arm64', 'macos-x64', 'linux-x64'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  if (output !== `tabro-v${version}-${platform}`) {
    throw new Error(`Use --output=tabro-v${version}-${platform} for a standalone build, or --catalog-from=<extracted Windows installer> for Hermes.`);
  }
  await stageStandalone();
}

function stageCatalog(standalone: string): void {
  const sourceRuntime = containedPath(standalone, 'runtime');
  if (relative(runtime, sourceRuntime) === '') throw new Error('Use an extracted Windows standalone package as the catalog source.');
  const manifestFile = containedPath(standalone, 'runtime-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.platform !== 'windows-x64' ||
      manifest.contractVersion !== MCP_CONTRACT_VERSION || manifest.minimumBrowserVersion !== minimumBrowserVersion ||
      manifest.nativeHostEntry !== windowsNativeHost || manifest.nativeHostUrl !== nativeHostUrl) {
    throw new Error('Use an extracted Windows standalone package for this source version.');
  }
  const facts: FileFact[] = manifest.files;
  const nativeHost = facts.find(fact => fact.path === windowsNativeHost);
  if (!nativeHost || nativeHost.bytes <= 0) throw new Error('Missing Native Host checksum.');
  const paths = new Set<string>();
  for (const fact of facts) {
    const file = containedPath(sourceRuntime, fact.path);
    if (relative(sourceRuntime, file).split(sep).join('/') !== fact.path || paths.has(fact.path.toLowerCase())) {
      throw new Error(`Invalid or duplicate runtime path: ${fact.path}`);
    }
    paths.add(fact.path.toLowerCase());
    const stat = statSync(file);
    if (!stat.isFile() || stat.size !== fact.bytes || sha(file) !== fact.sha256) throw new Error(`Package integrity check failed: ${fact.path}`);
    if (fact.path !== windowsNativeHost && /\.exe$/iu.test(fact.path)) throw new Error(`Unexpected catalog executable: ${fact.path}`);
    containedPath(runtime, fact.path);
  }
  if (output) {
    mkdirSync(plugin, { recursive: true });
    for (const name of ['LICENSE', 'README.md', 'mcp.json', 'skills', ...windowsScripts]) {
      cpSync(resolve(sourcePlugin, name), resolve(plugin, name), { recursive: true });
    }
  }
  rmSync(runtime, { recursive: true, force: true });
  for (const fact of facts.filter(fact => fact.path !== windowsNativeHost)) {
    const target = containedPath(runtime, fact.path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(containedPath(sourceRuntime, fact.path), target);
  }
  // The exact manifest digest lets the Windows installer and Hermes share one installed runtime.
  cpSync(manifestFile, resolve(plugin, 'runtime-manifest.json'));
  writeFileSync(resolve(plugin, 'plugin.json'), JSON.stringify({ ...catalog, version }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'STAGED_CATALOG', plugin, version, nativeHostUrl }));
}

async function stageStandalone(): Promise<void> {
  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime, { recursive: true });
  for (const name of windows ? windowsScripts : []) {
    cpSync(resolve(sourcePlugin, name), resolve(plugin, name));
  }
  if (!windows) {
    cpSync(resolve(sourcePlugin, 'broker-service.mjs'), resolve(runtime, 'broker-service.mjs'));
    cpSync(resolve(root, 'tools/managed-upgrade-snapshot.mjs'), resolve(runtime, 'managed-upgrade-snapshot.mjs'));
  }
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
  const entries: Array<[string, string]> = [
    ['apps/broker/src/runtime/main.ts', 'broker/main.js'],
    ['apps/mcp-stdio-adapter/src/main.ts', 'adapter/main.js'],
    ['tools/provision-proxy-credential.ts', 'broker/provision-proxy-credential.js']
  ];
  if (!windows) entries.push(['apps/native-host/src/relay-native-host.ts', 'native-host/relay-native-host.js'], ['tools/tabro-setup.ts', '../setup.mjs']);
  for (const [source, entry] of entries) {
    const result = await build({ entryPoints: [resolve(root, source)], outfile: resolve(runtime, entry), bundle: true,
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
  const nativeHostEntry = windows ? windowsNativeHost : 'native-host/relay-native-host.js';
  if (windows) {
    cpSync(resolve(root, 'dist/native-host/relay-native-host.exe'), resolve(runtime, nativeHostEntry));
    mkdirSync(resolve(runtime, 'helpers'), { recursive: true });
    for (const name of ['configure-managed-profiles.ps1', 'browser-runtime.ps1']) cpSync(resolve(root, 'tools', name), resolve(runtime, 'helpers', name));
  } else if (process.platform === 'darwin') {
    cpSync(resolve(root, 'dist/native-host/tabro-macos'), resolve(runtime, 'native-host/tabro-macos'));
  }
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
    ...(process.platform === 'darwin' ? { macosHelperSource: { path: 'apps/native-host/src/tabro-macos.c', sha256: sourceSha(resolve(root, 'apps/native-host/src/tabro-macos.c')) } } : {}),
    nativeSource: { path: `apps/native-host/src/relay-native-host.${windows ? 'cpp' : 'ts'}`, sha256: sourceSha(resolve(root, `apps/native-host/src/relay-native-host.${windows ? 'cpp' : 'ts'}`)) }
  }, null, 2) + '\n');
  function files(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
  }
  const manifest = { schemaVersion: 1, version, contractVersion: MCP_CONTRACT_VERSION, platform, nativeHostEntry,
    minimumBrowserVersion,
    ...(windows ? { nativeHostUrl, node: { version: '22.22.3', url: 'https://nodejs.org/dist/v22.22.3/node-v22.22.3-win-x64.zip',
      archiveSha256: '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33',
      executableSha256: '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b' } } : {}),
    files: files(runtime).sort().map(file => ({ path: relative(runtime, file).split(sep).join('/'), bytes: statSync(file).size, sha256: sha(file) })) };
  writeFileSync(resolve(plugin, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'STAGED', plugin, version, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) }));
}
