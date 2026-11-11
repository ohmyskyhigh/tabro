import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import type { ChromeManagementConnection } from '../../apps/broker/src/profiles/management-connection.js';

/** Real extension-page input; no mocked Chrome APIs or dashboard responses. */
export async function probeDashboard(control: ChromeManagementConnection, extensionId: string, rulesPath: string, evidenceRoot: string,
  verifyEnforcement: () => Promise<void>): Promise<string[]> {
  const checks: string[] = [];
  const original = JSON.parse(readFileSync(rulesPath, 'utf8')) as { schemaVersion: 1; rules: Array<{ id: string; domain: string; mode: 'input_only' }> };
  const { targetId } = await control.send('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` });
  const { sessionId } = await control.send('Target.attachToTarget', { targetId, flatten: true });
  const session = String(sessionId);
  const send = (method: string, params: Record<string, unknown> = {}) => control.send(method, params as never, session);
  const read = async (expression: string): Promise<unknown> => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    expect(result.exceptionDetails, JSON.stringify(result)).toBeUndefined();
    return (result.result as { value: unknown }).value;
  };
  const click = async (selector: string) => {
    const position = () => read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,height:innerHeight}})()`) as Promise<{ x: number; y: number; height: number }>;
    let point = await position();
    if (point.y < 0 || point.y >= point.height) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.height / 2, deltaX: 0, deltaY: point.y - point.height / 2 });
      await expect.poll(async () => { point = await position(); return point.y > 0 && point.y < point.height; }).toBe(true);
    }
    const { x, y } = point;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const type = async (selector: string, text: string) => {
    await click(selector);
    const length = Number(await read(`document.querySelector(${JSON.stringify(selector)}).value.length`));
    // Plain keys work even when a background macOS test window does not receive menu shortcuts.
    for (const [key, code, virtualKey] of [['ArrowRight', 'ArrowRight', 39], ['Backspace', 'Backspace', 8]] as const) {
      for (let index = 0; index <= length; index++) {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtualKey });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
      }
    }
    expect(await read(`document.querySelector(${JSON.stringify(selector)}).value`)).toBe('');
    await send('Input.insertText', { text });
    expect(await read(`document.querySelector(${JSON.stringify(selector)}).value`)).toBe(text);
  };
  const screenshot = async (name: string) => {
    const metrics = await send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize as { width: number; height: number };
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(resolve(evidenceRoot, `${process.platform}-${process.arch}-dashboard-${name}.png`), Buffer.from(String(result.data), 'base64'));
  };
  const saved = async () => expect.poll(() => read('document.querySelector("#rule-dialog").open'), { timeout: 10000 }).toBe(false);
  const rules = () => JSON.parse(readFileSync(rulesPath, 'utf8')) as typeof original;
  try {
    await expect.poll(() => read('document.querySelector("#status")?.textContent'), { timeout: 15000 }).toBe('Connected');
    expect(await read('document.querySelector("#pairing-code").value')).toMatch(/^[A-Z]+-[A-Z]+$/u);
    expect(await read('document.querySelector("#profile-nickname").textContent')).toMatch(/^[a-z]+$/u);
    await screenshot('connection');
    await click('#tab-connection');
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    expect(await read('document.activeElement.id')).toBe('tab-broker');
    expect(await read('document.querySelector("#panel-broker").hidden')).toBe(false);
    await expect.poll(() => read('document.querySelector("#profile-rows").children.length'), { timeout: 15000 }).toBeGreaterThan(0);
    expect(await read('document.querySelector("#profile-rows").textContent')).toContain('This profile');
    expect(await read('document.querySelectorAll("#profile-rows button").length')).toBe(0);
    checks.push('dashboard connection details, keyboard tab navigation and read-only profile status loaded through Native companion');

    await click('#add-rule'); await type('#rule-domain', 'https://invalid.example/path'); await click('#save-rule');
    await expect.poll(() => read('document.querySelector("#rule-error").hidden')).toBe(false);
    expect(rules()).toEqual(original);
    await type('#rule-domain', 'fixture.test'); await click('#save-rule'); await saved();
    expect(rules().rules).toContainEqual(expect.objectContaining({ domain: 'fixture.test', mode: 'input_only' }));
    await screenshot('broker');
    await verifyEnforcement();
    await send('Page.bringToFront');
    checks.push('dashboard validation rejected a URL, saved a domain and immediately enforced its input-only rule through MCP');

    await click('button[aria-label="Edit rule for fixture.test"]'); await type('#rule-domain', 'app.fixture.test'); await click('#save-rule'); await saved();
    expect(rules().rules).toContainEqual(expect.objectContaining({ domain: 'app.fixture.test' }));
    await click('button[aria-label="Remove rule for app.fixture.test"]'); await click('#cancel-confirm');
    expect(rules().rules).toContainEqual(expect.objectContaining({ domain: 'app.fixture.test' }));
    await click('button[aria-label="Remove rule for app.fixture.test"]'); await click('#accept-confirm');
    await expect.poll(() => read('document.querySelector("#confirm-dialog").open')).toBe(false);
    expect(rules()).toEqual(original);
    checks.push('dashboard edits and confirmed removals persist; cancel preserves the rule');

    await click('#add-rule'); await type('#rule-domain', 'draft.fixture.test');
    const external = { ...original, rules: [...original.rules, { id: 'external-edit', domain: 'external.example', mode: 'input_only' }] };
    writeFileSync(rulesPath, JSON.stringify(external));
    await click('#save-rule');
    await expect.poll(() => read('document.querySelector("#rule-error").textContent')).toContain('RULES_CONFLICT');
    expect(rules()).toEqual(external);
    expect(await read('document.querySelector("#rule-domain").value')).toBe('draft.fixture.test');
    await click('#cancel-rule'); await click('#refresh-broker');
    await expect.poll(() => read('document.querySelector("#rule-rows").textContent')).toContain('external.example');
    await click('button[aria-label="Remove rule for external.example"]'); await click('#accept-confirm');
    await expect.poll(() => read('document.querySelector("#confirm-dialog").open')).toBe(false);
    expect(rules()).toEqual(original);
    checks.push('dashboard rejects stale saves without overwriting external edits and preserves the typed draft');

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    expect(await read('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await screenshot('narrow');
    await send('Emulation.clearDeviceMetricsOverride');
    await click('#tab-connection');
    await type('#pairing-code', 'CALM-REED');
    await click('#save-settings');
    await expect.poll(() => read('document.querySelector("#status").textContent'), { timeout: 15000 }).toBe('Connected');
    await expect.poll(() => read('document.querySelector("#profile-nickname").textContent'), { timeout: 15000 }).toBe('calmreed');
    checks.push('dashboard stays within a narrow viewport and pairing alias updates after authenticated reconnect');
    return checks;
  } catch (error) { await screenshot('failure').catch(() => {}); throw error; }
  finally { await control.send('Target.closeTarget', { targetId }); }
}
