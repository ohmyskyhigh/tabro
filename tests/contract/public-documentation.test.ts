import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '../../apps/shared/protocol/src/mcp/tool-catalog.js';

const workspace = resolve(import.meta.dirname, '../..');

function markdownFiles(): string[] {
  const docs = readdirSync(resolve(workspace, 'doc'), { recursive: true })
    .filter((path): path is string => typeof path === 'string' && path.endsWith('.md'))
    .map((path) => resolve(workspace, 'doc', path));
  return ['README.md', 'README.zh-CN.md', 'GETTING_STARTED.md', 'AGENTS.md'].map(file => resolve(workspace, file)).concat(docs);
}

describe('public documentation', () => {
  it('keeps the English and Chinese installation entry points aligned to generated handoffs', () => {
    for (const name of ['README.md', 'README.zh-CN.md']) {
      const text = readFileSync(resolve(workspace, name), 'utf8');
      expect(text).toContain('./GETTING_STARTED.md');
      expect(text).toContain('releases/download/v0.3.0/octopus-browser-relay-update.ps1');
      expect(text).toContain('-Version v0.3.0');
      expect(text).toContain('codex-mcp.toml');
      expect(text).toContain('hermes-mcp.txt');
      expect(text).toContain('chrome://extensions');
    }
  });

  it('lists the current MCP tools in the Chinese operator guide', () => {
    const text = readFileSync(resolve(workspace, 'doc/zh-CN/Architecture-and-MCP.md'), 'utf8');
    const tools = [...text.matchAll(/^\| (?:读取|异步|立即) \| `([a-z_]+)` \|/gmu)].map(match => match[1]);
    expect(tools.sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('resolves every local Markdown link in the public entry points and documentation vault', () => {
    const missing: string[] = [];
    for (const file of markdownFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        let target = (match[1] ?? '').trim().replace(/^<|>$/g, '');
        if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        target = target.split('#')[0]?.split('?')[0] ?? '';
        try {
          target = decodeURIComponent(target);
        } catch {
          missing.push(`${file}: invalid encoded link ${match[1]}`);
          continue;
        }
        if (!existsSync(resolve(dirname(file), target))) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
