import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BrowserRulesSchema, type BrowserPolicySnapshot } from '../../../shared/protocol/src/browser-interaction-policy.js';

export interface BrowserRulesSource {
  refresh(): BrowserPolicySnapshot | null;
  diagnostic: string | null;
}

export class BrowserRulesFile implements BrowserRulesSource {
  private current: BrowserPolicySnapshot | null = null;
  diagnostic: string | null = null;
  constructor(readonly path: string, private initialized: boolean, private readonly markInitialized: () => void) {
    try {
      if (!existsSync(path) && !initialized) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, rules: [] }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      }
      this.refresh();
    } catch (error) { this.diagnostic = `Cannot initialize ${path}: ${(error as Error).message}`; }
  }

  refresh(): BrowserPolicySnapshot | null {
    try {
      const raw = readFileSync(this.path, 'utf8');
      if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('Rule file exceeds 256 KiB.');
      const configuration = BrowserRulesSchema.parse(JSON.parse(raw));
      configuration.rules.sort((a, b) => a.domain.localeCompare(b.domain));
      const revision = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
      if (!this.initialized) { this.markInitialized(); this.initialized = true; }
      if (this.current?.revision !== revision) this.current = { configuration, revision, generation: (this.current?.generation ?? 0) + 1 };
      this.diagnostic = null;
    } catch (error) { this.diagnostic = `Invalid browser rules at ${this.path}; ${this.current ? 'retaining the last valid rules' : 'browser dispatch is blocked'}: ${(error as Error).message}`; }
    return this.current;
  }

  replace(configuration: unknown, expectedRevision: string): BrowserPolicySnapshot {
    const parsed = BrowserRulesSchema.parse(configuration);
    const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error('BROWSER_RULES_TOO_LARGE: The rule file cannot exceed 256 KiB. Remove some entries before saving.');
    const current = this.refresh();
    if (this.diagnostic || !current) throw new Error('BROWSER_RULES_INVALID: Repair the rule file before saving from the dashboard.');
    if (current.revision !== expectedRevision) throw new Error('RULES_CONFLICT: The rules changed in another window or file editor. Refresh and review the latest rules before saving.');
    if (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink()) throw new Error('BROWSER_RULES_INVALID: Dashboard saves require a regular rule file.');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
    const saved = this.refresh();
    if (!saved || this.diagnostic) throw new Error('BROWSER_RULES_INVALID: The saved rules could not be loaded. Refresh before trying again.');
    return saved;
  }
}
