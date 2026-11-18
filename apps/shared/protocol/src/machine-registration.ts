import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

interface MachineNative {
  directory(): string;
  account(): string;
  acquire(): void;
  verifyPermissions(): void;
  verifyPrivate(path: string): void;
  verifyAncestor(path: string): void;
  verifySystemAncestor(path: string): void;
}

const require = createRequire(import.meta.url);
let loadedNative: MachineNative | undefined;

export function machineNative(): MachineNative {
  if (loadedNative) return loadedNative;
  const entry = dirname(resolve(process.argv[1] ?? ''));
  const paths = [
    resolve(import.meta.dirname, 'machine-lock.node'),
    resolve(import.meta.dirname, 'native-host/machine-lock.node'),
    resolve(import.meta.dirname, '../native-host/machine-lock.node'),
    resolve(import.meta.dirname, 'runtime/native-host/machine-lock.node'),
    resolve(entry, '../native-host/machine-lock.node'),
    resolve(entry, 'runtime/native-host/machine-lock.node'),
    resolve(import.meta.dirname, '../../../../dist/native-host/machine-lock.node')
  ];
  const path = paths.find(candidate => existsSync(candidate));
  if (!path) throw new Error('The Tabro machine lock component is missing. Rebuild or reinstall Tabro.');
  loadedNative = require(path) as MachineNative;
  return loadedNative;
}

const RegistrationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  owner: z.union([z.number().int().nonnegative(), z.string().regex(/^S-1-(?:\d+-)*\d+$/u)]),
  installationRoot: z.string().min(1),
  dataRoot: z.string().min(1)
});
export type MachineRegistration = z.infer<typeof RegistrationSchema>;

export function sameMachinePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function verifyAncestors(path: string, systemOnly: boolean): void {
  let current = realpathSync(path);
  for (;;) {
    if (systemOnly) machineNative().verifySystemAncestor(current);
    else machineNative().verifyAncestor(current);
    if (process.platform !== 'win32') {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || (stat.uid !== 0 && (systemOnly || stat.uid !== process.getuid?.())) || (stat.mode & 0o022) !== 0) {
        throw new Error('A machine installation ancestor is not protected.');
      }
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function readMachineRegistration(): MachineRegistration {
  if (!((process.platform === 'win32' && process.arch === 'x64') ||
        (process.platform === 'darwin' && (process.arch === 'arm64' || process.arch === 'x64')) ||
        (process.platform === 'linux' && process.arch === 'x64'))) throw new Error('This Tabro platform is not supported.');
  const native = machineNative();
  const directory = native.directory();
  const file = resolve(directory, 'registration.json');
  if (!existsSync(directory) || !existsSync(file)) throw new Error('Tabro machine registration is missing. Run the package provision-machine-registration command on this host.');
  native.verifyPermissions();
  verifyAncestors(dirname(realpathSync(directory)), true);
  const dirStat = lstatSync(directory);
  const fileStat = lstatSync(file);
  if (!dirStat.isDirectory() || !fileStat.isFile() || fileStat.nlink !== 1 || fileStat.size > 16_384 ||
      (process.platform !== 'win32' && (dirStat.uid !== 0 || (dirStat.mode & 0o022) !== 0 || fileStat.uid !== 0 || (fileStat.mode & 0o022) !== 0))) {
    throw new Error('The machine registration permissions are unsafe.');
  }
  const registration = RegistrationSchema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  if ((process.platform === 'win32' ? typeof registration.owner !== 'string' : typeof registration.owner !== 'number') || String(registration.owner) !== native.account()) {
    throw new Error('This OS account does not own the Tabro installation.');
  }
  for (const root of [registration.installationRoot, registration.dataRoot]) {
    if (!isAbsolute(root) || !sameMachinePath(realpathSync(root), root)) throw new Error('The machine registration contains a non-canonical path.');
    verifyAncestors(root, false);
  }
  return registration;
}

export function assertMachineInstallation(registration: MachineRegistration, installationRoot: string, dataRoot: string): void {
  if (!sameMachinePath(realpathSync(installationRoot), registration.installationRoot) || !sameMachinePath(realpathSync(dataRoot), registration.dataRoot)) {
    throw new Error('This installation does not own the machine Tabro registration.');
  }
}
