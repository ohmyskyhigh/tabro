import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import process from 'node:process';

// The updater invokes this after its fenced broker stop; no Chrome process is terminated here.
const database = resolve(process.argv[2]);
const backup = resolve(process.argv[3]);
if (database === backup) throw new Error('Backup must differ from the live database.');
if (existsSync(database)) {
  const db = new DatabaseSync(database);
  try {
    const table = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (table('managed_browser_instances') && db.prepare('SELECT 1 FROM managed_browser_instances WHERE ended_at IS NULL LIMIT 1').get()) throw new Error('Stop all managed Profile instances through MCP before upgrading.');
    if (table('browser_workspaces') && db.prepare("SELECT 1 FROM browser_workspaces WHERE lifecycle='active' LIMIT 1").get()) throw new Error('Terminate active workspaces before upgrading.');
    if (table('request_tickets') && db.prepare("SELECT 1 FROM request_tickets WHERE state IN ('queued','running') LIMIT 1").get()) throw new Error('Finish pending browser requests before upgrading.');
    if (process.argv.includes('--check-only')) process.exitCode = 0;
    else {
    mkdirSync(dirname(backup), { recursive: true });
    db.prepare('VACUUM INTO ?').run(backup);
    if (table('managed_profiles')) writeFileSync(`${backup}.profiles.json`, JSON.stringify(db.prepare('SELECT profile_ref,principal_id,data_dir_key,runtime_ref,endpoint_ref,identity_hash FROM managed_profiles').all(), null, 2));
    }
  } finally { db.close(); }
}
