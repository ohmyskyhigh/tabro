import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bootstrapRoot = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(await readFile(resolve(bootstrapRoot, 'current-release.json'), 'utf8'));
if (typeof state.brokerEntry !== 'string') throw new Error('The installed release has no broker entry.');
const managedConfig = resolve(dirname(process.env.RELAY_DB_PATH ?? resolve(bootstrapRoot, '../data/relay.sqlite')), 'managed-profiles.json');
if (existsSync(managedConfig)) process.env.RELAY_PROFILES_CONFIG = managedConfig;
await import(pathToFileURL(state.brokerEntry).href);
