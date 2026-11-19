import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserRulesSchema, BROWSER_METHOD_POLICY, effectiveBrowserPolicy, guardedBrowserCommand, humanSimulationCommand, normalizeRuleDomain, stripRemoteObjectIds, VERIFICATION_PAUSE_ALLOWED } from '../../apps/shared/protocol/src/browser-interaction-policy.js';
import { CONSERVATIVE_CAPABILITY_MANIFEST } from '../../apps/shared/protocol/src/index.js';
import { BrowserRulesFile } from '../../apps/broker/src/runtime/browser-rules.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const configuration = BrowserRulesSchema.parse({ schemaVersion: 1, rules: [
  { id: 'parent', domain: 'Example.COM.', mode: 'input_only' },
  { id: 'specific', domain: 'app.example.com', mode: 'input_only' }
] });

describe('domain input-only policy', () => {
  it.each([
    ['https://example.com/', 'parent'], ['https://x.example.com/a?b=c', 'parent'],
    ['https://nested.app.example.com/any/path', 'specific'], ['https://example.com.evil.test/', null],
    ['https://notexample.com/', null], ['https://elsewhere.test/', null], ['about:blank', null]
  ])('matches only the current hostname in %s', (url, matched_rule) => {
    expect(effectiveBrowserPolicy(url, configuration).matched_rule).toBe(matched_rule);
  });
  it('normalizes internationalized domains and rejects invalid or duplicate entries', () => {
    expect(normalizeRuleDomain('例子.测试')).toBe('xn--fsqu00a.xn--0zwm56d');
    for (const domain of ['https://example.com', 'example.com/a', '*.example.com', '127.0.0.1', 'example.com:443', ' example.com', 'foo..com', 'x@site.test']) {
      expect(() => normalizeRuleDomain(domain), domain).toThrow();
    }
    expect(() => BrowserRulesSchema.parse({ schemaVersion: 1, rules: [configuration.rules[0], { id: 'duplicate', domain: 'EXAMPLE.com', mode: 'input_only' }] })).toThrow(/Duplicate/u);
  });
  it('allows every Human Simulation rule a guarded plain-data evaluate without a separate option', () => {
    expect(humanSimulationCommand('Runtime.evaluate', { expression: "document.title" }, 'example.com'))
      .toMatchObject({ expression: "document.title", returnByValue: true, throwOnSideEffect: true, silent: true, generatePreview: false, timeout: 1000 });
    expect(humanSimulationCommand('Runtime.evaluate', { expression: 'x', returnByValue: false, timeout: 90_000 }, 'example.com'))
      .toMatchObject({ returnByValue: true, timeout: 1000 });
    for (const params of [{ expression: 'x', contextId: 4 }, { expression: 'x', uniqueContextId: 'a' }, { expression: 'x', objectGroup: 'g' },
      { expression: 'x', userGesture: true }, { expression: 'x', awaitPromise: true }]) {
      expect(() => humanSimulationCommand('Runtime.evaluate', params, 'example.com')).toThrow(/Human Simulation Mode/u);
    }
    expect(() => humanSimulationCommand('Runtime.evaluate', { expression: 'x'.repeat(8_193) }, 'example.com')).toThrow(/8192/u);
    expect(() => humanSimulationCommand('Runtime.evaluate', {}, 'example.com')).toThrow(/nonempty/u);
    // Evaluate stays part of the mode; page mutation and remote-object following never do.
    for (const method of ['Runtime.callFunctionOn', 'Runtime.getProperties', 'DOM.setAttributeValue', 'Page.addScriptToEvaluateOnNewDocument']) {
      expect(() => humanSimulationCommand(method, {}, 'example.com')).toThrow(/Human Simulation Mode/u);
    }
    expect(humanSimulationCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaY: 100 }, 'example.com'))
      .toMatchObject({ deltaY: 100 });
  });

  it('keeps only observations and activation available during a verification pause', () => {
    expect(VERIFICATION_PAUSE_ALLOWED.has('Page.captureScreenshot')).toBe(true);
    expect(VERIFICATION_PAUSE_ALLOWED.has('Page.bringToFront')).toBe(true);
    for (const method of ['Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.insertText', 'Page.navigate', 'Page.reload', 'DOM.setFileInputFiles']) {
      expect(VERIFICATION_PAUSE_ALLOWED.has(method)).toBe(false);
    }
  });

  it('strips every nested remote object identifier from an observation result', () => {
    const stripped = stripRemoteObjectIds({ result: { type: 'object', objectId: 'r1', value: [{ objectId: 'x', ok: 1 }] },
      exceptionDetails: { exception: { objectId: 'e1', description: 'boom' } } }) as Record<string, unknown>;
    expect(JSON.stringify(stripped)).not.toMatch(/objectId/u);
    expect((stripped.exceptionDetails as Record<string, unknown>)).toMatchObject({ exception: { description: 'boom' } });
  });

  it('classifies every advertised method and refuses unknown mutations', () => {
    expect(Object.keys(BROWSER_METHOD_POLICY).sort()).toEqual(CONSERVATIVE_CAPABILITY_MANIFEST.cdpMethods.map(item => item.method).sort());
    for (const method of ['DOM.focus', 'DOM.setFileInputFiles', 'DOM.setAttributeValue', 'Input.setIgnoreInputEvents', 'Network.setCacheDisabled', 'Emulation.setDeviceMetricsOverride', 'Unknown.execute']) {
      expect(() => guardedBrowserCommand(method, {}, 'example.com')).toThrow(/Human Simulation Mode/u);
    }
  });
  it('forces observation guards and refuses action-like parameters', () => {
    for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn']) {
      expect(guardedBrowserCommand(method, { returnByValue: true }, 'example.com')).toMatchObject({ throwOnSideEffect: true, userGesture: false });
      for (const params of [{ throwOnSideEffect: false }, { userGesture: true }, { awaitPromise: true }]) {
        expect(() => guardedBrowserCommand(method, params, 'example.com')).toThrow();
      }
    }
    expect(guardedBrowserCommand('Runtime.evaluate', { timeout: 90000 }, 'example.com').timeout).toBe(1000);
    expect(() => guardedBrowserCommand('Page.navigate', { url: 'javascript:alert(1)' }, 'example.com')).toThrow();
    expect(() => guardedBrowserCommand('Page.reload', { scriptToEvaluateOnLoad: 'foo()' }, 'example.com')).toThrow();
    expect(() => guardedBrowserCommand('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['selectAll'] }, 'example.com')).toThrow();
    expect(guardedBrowserCommand('DOM.getBoxModel', { nodeId: 1 }, 'example.com')).toEqual({ nodeId: 1 });
  });
  it('allows explicit foreground activation on an input-only domain', () => {
    expect(guardedBrowserCommand('Page.bringToFront', {}, 'example.com')).toEqual({});
  });
});

describe('persistent browser rule file', () => {
  it('saves dashboard edits atomically, rejects stale revisions and preserves external invalid edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabro-rules-')); roots.push(root);
    const path = join(root, 'browser-rules.json');
    const source = new BrowserRulesFile(path, false, () => {});
    const initial = source.refresh()!;
    const saved = source.replace(configuration, initial.revision);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(configuration);
    expect(saved.revision).not.toBe(initial.revision);
    expect(() => source.replace({ schemaVersion: 1, rules: [] }, initial.revision)).toThrow('RULES_CONFLICT');
    expect(source.refresh()?.revision).toBe(saved.revision);
    expect(() => source.replace({ schemaVersion: 1, rules: [{ id: 'bad', domain: 'https://example.com', mode: 'input_only' }] }, saved.revision)).toThrow();
    expect(source.refresh()?.revision).toBe(saved.revision);
    writeFileSync(path, '{invalid');
    expect(() => source.replace({ schemaVersion: 1, rules: [] }, saved.revision)).toThrow('BROWSER_RULES_INVALID');
    expect(readFileSync(path, 'utf8')).toBe('{invalid');
  });

  it('rejects a valid but oversized dashboard edit before replacing the readable file', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabro-rules-')); roots.push(root);
    const path = join(root, 'browser-rules.json');
    const source = new BrowserRulesFile(path, false, () => {});
    const initial = source.refresh()!;
    const original = readFileSync(path, 'utf8');
    const rules = Array.from({ length: 1000 }, (_, index) => ({ id: `r${index}`, mode: 'input_only',
      domain: `${index}.${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.com` }));
    expect(() => source.replace({ schemaVersion: 1, rules }, initial.revision)).toThrow('BROWSER_RULES_TOO_LARGE');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(source.refresh()?.revision).toBe(initial.revision);
    expect(source.diagnostic).toBeNull();
  });

  it('initializes once, reloads atomically, preserves invalid edits and does not recreate deleted configuration after restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabro-rules-')); roots.push(root);
    const path = join(root, 'browser-rules.json');
    let initialized = false;
    const source = new BrowserRulesFile(path, initialized, () => { initialized = true; });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 1, rules: [] });
    expect(initialized).toBe(true);
    writeFileSync(path, JSON.stringify(configuration));
    const first = source.refresh()!;
    expect(first.configuration.rules).toHaveLength(2);
    writeFileSync(path, '{');
    expect(source.refresh()).toBe(first);
    expect(source.diagnostic).toContain('retaining');
    unlinkSync(path);
    expect(source.refresh()).toBe(first);
    const restarted = new BrowserRulesFile(path, initialized, () => { initialized = true; });
    expect(restarted.refresh()).toBeNull();
    expect(restarted.diagnostic).toContain('blocked');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, rules: [] }));
    expect(restarted.refresh()?.configuration.rules).toEqual([]);
    expect(restarted.diagnostic).toBeNull();
  });
  it('records initialization after a malformed initial file is repaired', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabro-rules-')); roots.push(root);
    const path = join(root, 'browser-rules.json'); writeFileSync(path, '{');
    let initialized = false;
    const source = new BrowserRulesFile(path, false, () => { initialized = true; });
    expect(initialized).toBe(false);
    writeFileSync(path, JSON.stringify(configuration)); source.refresh();
    expect(initialized).toBe(true);
  });
});
