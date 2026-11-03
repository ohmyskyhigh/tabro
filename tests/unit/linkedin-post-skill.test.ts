import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '../../apps/shared/protocol/src/mcp/tool-catalog.js';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, 'integrations/hermes/skills/tabro-linkedin-post');
const skillPath = resolve(directory, 'SKILL.md');
const referencePath = resolve(directory, 'references/cdp-workflow.md');
const read = (path: string): string => readFileSync(path, 'utf8');

describe('packaged LinkedIn publishing skill', () => {
  it('ships a discoverable, portable skill with bounded scope', () => {
    expect(existsSync(skillPath)).toBe(true);
    const skill = read(skillPath);
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toContain('name: tabro-linkedin-post');
    const description = /^description: (.+)$/mu.exec(skill)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(60);
    expect(description.endsWith('.')).toBe(true);
    for (const section of ['## When to Use', '## Prerequisites', '## Procedure', '## Pitfalls', '## Verification']) {
      expect(skill).toContain(section);
    }
    expect(skill).toContain('references/cdp-workflow.md');
    expect(skill).not.toMatch(/(?<![a-z])[A-Z]:[\\/]|amberlion|geo-content|base-token/iu);
  });

  it('requires authorization, evidence and uncertain-result recovery', () => {
    const skill = read(skillPath);
    for (const rule of ['explicit approval', 'personal profile', 'company page', 'uncertain',
      'Do not click Post again', 'not a saved draft', 'terminate_workspace', '24-hour']) {
      expect(skill).toContain(rule);
    }
    expect(skill).toContain('not authorized by this skill');
  });

  it('keeps MCP examples on the shipped tool catalog', () => {
    const reference = read(referencePath);
    const examples = [...reference.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(match => JSON.parse(match[1]!) as { tool: string; arguments: Record<string, unknown> });
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const example of examples) {
      expect(MCP_TOOL_NAMES as readonly string[]).toContain(example.tool);
      expect(typeof example.arguments).toBe('object');
    }
    const cdp = examples.filter(example => example.tool === 'send_cdp_command');
    for (const example of cdp) {
      expect(example.arguments).toMatchObject({ workspace_ref: '<workspace_ref>', target: { kind: 'tab', tab_ref: '<tab_ref>' } });
    }
  });

  it('provides syntactically executable DOM probes without a publish click', () => {
    const reference = read(referencePath);
    const scripts = [...reference.matchAll(/```javascript\n([\s\S]*?)\n```/gu)].map(match => match[1]!);
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for (const script of scripts) {
      expect(() => new Script(script)).not.toThrow();
      expect(script).not.toContain('.click(');
    }
    expect(reference).toContain('Input.insertText');
    expect(reference).toContain('DOM.setFileInputFiles');
    expect(reference).toContain('returnByValue: false');
    expect(reference).toContain('No positional fallback');
  });

  it('defines supplied-copy text-only and image publishing paths', () => {
    const skill = read(skillPath);
    expect(skill).toContain('## Input and Output');
    expect(skill).toContain('does not write, translate, rewrite or design');
    expect(skill).toContain('**Text-only:** skip the media picker');
    expect(skill).toContain('**Text plus images:**');
    expect(skill).toContain('preserving order');
    expect(skill).toContain('not publication prerequisites');
    expect(skill).toContain('Do not ask again unless');
  });

  it('links the skill from plugin documentation and the general skill', () => {
    expect(read(resolve(root, 'integrations/hermes/README.md'))).toContain('skills/tabro-linkedin-post/SKILL.md');
    expect(read(resolve(root, 'integrations/hermes/skills/tabro-browser/SKILL.md'))).toContain('../tabro-linkedin-post/SKILL.md');
  });
});
