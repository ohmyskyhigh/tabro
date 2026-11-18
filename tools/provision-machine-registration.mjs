import { constants, closeSync, fchmodSync, fchownSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import console from 'node:console';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';

// Run once as root, after the desktop user has created both private directories.
if (!['darwin', 'linux'].includes(process.platform) || process.getuid?.() !== 0) throw new Error('Run this provisioning command as root on macOS or Linux.');
const unregister = process.argv[2] === '--unregister';
const [ownerText, installArg, dataArg, addon, ...extra] = process.argv.slice(unregister ? 3 : 2);
if (extra.length || (!unregister && addon) || (unregister && (!addon || !isAbsolute(addon))) || !/^[1-9]\d*$/u.test(ownerText ?? '') || !installArg || !dataArg || !isAbsolute(installArg) || !isAbsolute(dataArg)) {
  throw new Error('Usage: sudo node provision-machine-registration.mjs [--unregister] <desktop-uid> <existing-install-root> <existing-data-root> [absolute-machine-lock-addon]');
}
const owner = Number(ownerText);
if (!Number.isSafeInteger(owner)) throw new Error('Invalid desktop UID.');
const privateRoot = path => {
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (resolve(path) !== canonical || !stat.isDirectory() || stat.uid !== owner || (stat.mode & 0o077) !== 0) {
    throw new Error(`Directory must exist, be canonical, and be private to UID ${owner}: ${path}`);
  }
  return canonical;
};
const installationRoot = privateRoot(installArg);
const dataRoot = privateRoot(dataArg);
if (dataRoot !== resolve(installationRoot, 'data')) throw new Error('The data root must be the installation root’s data directory.');
const parent = process.platform === 'darwin' ? '/var/db' : '/var/lib';
const directory = resolve(parent, 'tabro');
const registration = resolve(directory, 'registration.json');
const lock = resolve(directory, 'broker.lock');
const expected = { schemaVersion: 1, owner, installationRoot, dataRoot };
const parentStat = lstatSync(parent);
if (!parentStat.isDirectory() || parentStat.uid !== 0 || (parentStat.mode & 0o022)) throw new Error(`Untrusted registration parent: ${parent}`);
if (!unregister) { try { mkdirSync(directory, { mode: 0o755 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
const dirStat = lstatSync(directory);
if (!dirStat.isDirectory() || dirStat.uid !== 0 || (dirStat.mode & 0o022)) throw new Error(`Untrusted registration directory: ${directory}`);
if (unregister) {
  const stat = lstatSync(registration);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.nlink !== 1) throw new Error('Existing machine registration is unsafe.');
  const actual = JSON.parse(readFileSync(registration, 'utf8'));
  if (actual.schemaVersion !== 1 || actual.owner !== owner || actual.installationRoot !== installationRoot || actual.dataRoot !== dataRoot || Object.keys(actual).length !== 4) throw new Error('Registration does not match the specified owner and roots.');
  createRequire(import.meta.url)(realpathSync(addon)).acquire();
  const recheck = JSON.parse(readFileSync(registration, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(recheck)) throw new Error('Registration changed while acquiring the machine lock.');
  unlinkSync(registration);
  const fd = openSync(directory, constants.O_RDONLY);
  try { try { fsyncSync(fd); } catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; } } finally { closeSync(fd); }
  console.log(JSON.stringify({ status: 'unregistered', ...expected }));
  process.exit(0);
}
{
  let fd;
  try {
    fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    fchownSync(fd, owner, -1);
    fchmodSync(fd, 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fd = openSync(lock, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== owner || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error('Existing machine lock has unsafe ownership or permissions.');
  } finally { closeSync(fd); }
  const temporary = resolve(directory, `.registration-${randomUUID()}`);
  const output = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(output, JSON.stringify(expected) + '\n'); fchmodSync(output, 0o644); fsyncSync(output); } finally { closeSync(output); }
  let alreadyRegistered = false;
  try { linkSync(temporary, registration); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = lstatSync(registration);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Existing machine registration is unsafe.');
    const actual = JSON.parse(readFileSync(registration, 'utf8'));
    if (actual.schemaVersion !== 1 || actual.owner !== owner || actual.installationRoot !== installationRoot || actual.dataRoot !== dataRoot || Object.keys(actual).length !== 4) throw new Error('This device is already registered to a different Tabro installation or owner.');
    for (const name of readdirSync(directory).filter(name => /^\.registration-[a-f0-9-]{36}$/u.test(name))) {
      const path = resolve(directory, name);
      const candidate = lstatSync(path);
      if (candidate.isFile() && candidate.uid === 0 && candidate.dev === stat.dev && candidate.ino === stat.ino) unlinkSync(path);
    }
    if (lstatSync(registration).nlink !== 1) throw new Error('Existing machine registration has unexpected links.');
    alreadyRegistered = true;
  } finally {
    unlinkSync(temporary);
  }
  const dir = openSync(directory, constants.O_RDONLY);
  try { try { fsyncSync(dir); } catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; } } finally { closeSync(dir); }
  console.log(JSON.stringify({ status: alreadyRegistered ? 'already_registered' : 'registered', ...expected }));
}
