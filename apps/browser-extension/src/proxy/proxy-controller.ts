import { ExtensionAdapterError } from '../browser/inventory.js';
export interface ProxyCommand { action: 'read' | 'apply' | 'clear' | 'probe'; revision: number; port: number | null }
interface SavedProxy { revision: number; port: number | null }
const KEY = 'tabroProfileProxy';
export class ExtensionProxyController {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly api: typeof chrome = chrome, private readonly fetcher: typeof fetch = fetch) {}
  execute(command: ProxyCommand): Promise<Record<string, unknown>> {
    const work = this.queue.catch(() => {}).then(() => this.run(command)); this.queue = work; return work;
  }
  private async setting(): Promise<{ value: chrome.proxy.ProxyConfig; levelOfControl: string }> {
    return new Promise((ok, fail) => this.api.proxy.settings.get({ incognito: false }, result => {
      if (this.api.runtime.lastError) fail(new ExtensionAdapterError('PROXY_APPLY_FAILED', 'Cannot inspect proxy settings.'));
      else ok(result as { value: chrome.proxy.ProxyConfig; levelOfControl: string });
    }));
  }
  private async change(config: chrome.proxy.ProxyConfig | null): Promise<void> {
    await new Promise<void>((ok, fail) => {
      const done = () => this.api.runtime.lastError ? fail(new ExtensionAdapterError('PROXY_APPLY_FAILED', 'Cannot change proxy settings.')) : ok();
      if (config) this.api.proxy.settings.set({ value: config, scope: 'regular_only' }, done);
      else this.api.proxy.settings.clear({ scope: 'regular_only' }, done);
    });
  }
  private async run(command: ProxyCommand): Promise<Record<string, unknown>> {
    if (!this.api.proxy) throw new ExtensionAdapterError('PROXY_UNSUPPORTED', 'Proxy permission is unavailable.');
    let saved = (await this.api.storage.local.get(KEY))[KEY] as SavedProxy | undefined;
    if (saved && command.revision < saved.revision) throw new ExtensionAdapterError('PROXY_REVISION_CONFLICT', 'Proxy revision is stale.');
    const before = await this.setting();
    if (command.action === 'apply' || command.action === 'clear') {
      if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(before.levelOfControl)) {
        throw new ExtensionAdapterError('PROXY_CONTROL_CONFLICT', 'A policy or another extension controls this setting.');
      }
      if (command.action === 'apply' && (!Number.isInteger(command.port) || command.port! < 1 || command.port! > 65535)) throw new ExtensionAdapterError('INVALID_ARGUMENT', 'Invalid local proxy port.');
      saved = { revision: command.revision, port: command.action === 'apply' ? command.port : null };
      // Persist intent first; read-back below is what proves application after a worker restart.
      await this.api.storage.local.set({ [KEY]: saved });
      await this.change(saved.port === null ? null : { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: saved.port } } });
    }
    const observed = await this.setting();
    const proxy = observed.value.rules?.singleProxy;
    const matches = saved?.port != null && observed.levelOfControl === 'controlled_by_this_extension'
      && observed.value.mode === 'fixed_servers' && proxy?.scheme === 'http' && proxy.host === '127.0.0.1' && proxy.port === saved.port
      && !observed.value.rules?.bypassList?.length;
    const state = !saved?.port ? 'unmanaged' : matches ? 'applied' : 'control_conflict';
    const result: Record<string, unknown> = { revision: saved?.revision ?? 0, state, level_of_control: observed.levelOfControl, observed_at: new Date().toISOString() };
    if (command.action === 'probe') {
      if (state !== 'applied' || saved?.revision !== command.revision) throw new ExtensionAdapterError('PROXY_NOT_READY', 'Apply the current proxy revision first.');
      const start = Date.now();
      try {
        const response = await this.fetcher.call(globalThis, 'https://api.ipify.org?format=json', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!response.ok || !response.body) throw new Error('HTTP failure');
        const reader = response.body.getReader(); let body = ''; let size = 0;
        try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 1024) throw new Error('too large'); body += new TextDecoder().decode(chunk.value); } }
        finally { await reader.cancel().catch(() => {}); }
        const ip = (JSON.parse(body) as { ip?: unknown }).ip;
        if (typeof ip !== 'string' || ip.length > 45 || !/^[0-9a-fA-F.:]+$/u.test(ip)) throw new Error('invalid IP');
        result.exit = { ip, latency_ms: Date.now() - start, observed_at: new Date().toISOString(), revision: command.revision, source: 'browser' };
      } catch { throw new ExtensionAdapterError('PROXY_CHECK_FAILED', 'The browser exit-IP check failed.'); }
    }
    return result;
  }
}
