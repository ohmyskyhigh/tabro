import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bootstrapRoot = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(await readFile(resolve(bootstrapRoot, 'current-release.json'), 'utf8'));
if (typeof state.mcpAdapterEntry !== 'string') throw new Error('The installed release has no MCP adapter entry.');
process.env.TABRO_RUNTIME_FILE ??= resolve(state.runtimeFile ?? resolve(bootstrapRoot, '../data/runtime.json'));
await import(pathToFileURL(state.mcpAdapterEntry).href);
