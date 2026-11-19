import { describe, expect, it } from 'vitest';
import { initialPointer, jitteredInterval, pointerPath, seededRandom, wheelBurst } from '../../apps/shared/protocol/src/human-motion.js';

describe('human motion generation', () => {
  it('is deterministic for one seed', () => {
    const a = pointerPath({ x: 10, y: 10 }, { x: 400, y: 300 }, seededRandom(7));
    const b = pointerPath({ x: 10, y: 10 }, { x: 400, y: 300 }, seededRandom(7));
    expect(a).toEqual(b);
    expect(seededRandom(7)()).toBe(seededRandom(7)());
  });

  it('lands within two pixels of the requested target and never beyond it', () => {
    for (const seed of [1, 2, 3, 11, 42]) {
      const path = pointerPath({ x: 30, y: 900 }, { x: 640, y: 120 }, seededRandom(seed));
      const final = path.at(-1)!;
      expect(Math.abs(final.x - 640)).toBeLessThanOrEqual(2);
      expect(Math.abs(final.y - 120)).toBeLessThanOrEqual(2);
      expect(path.length).toBeGreaterThanOrEqual(4);
      for (const point of path) expect(point.delayMs).toBeGreaterThanOrEqual(8);
    }
  });

  it('keeps a short move to a single step instead of a fake crawl', () => {
    const path = pointerPath({ x: 100, y: 100 }, { x: 101, y: 101 }, seededRandom(5));
    expect(path.length).toBe(1);
  });

  it('starts the first pointer from inside the viewport, never the origin corner', () => {
    for (const seed of [3, 9, 77]) {
      const point = initialPointer({ x: 500, y: 400 }, seededRandom(seed));
      expect(point.x).toBeGreaterThan(0);
      expect(point.y).toBeGreaterThan(0);
      expect(Math.hypot(point.x - 500, point.y - 400)).toBeGreaterThan(50);
    }
  });

  it('splits one wheel request into ticks that sum to the requested delta', () => {
    for (const seed of [1, 4, 9]) {
      const ticks = wheelBurst(0, 1000, seededRandom(seed));
      expect(ticks.length).toBeLessThanOrEqual(12);
      expect(ticks.reduce((sum, tick) => sum + tick.deltaY, 0)).toBe(1000);
      expect(ticks.reduce((sum, tick) => sum + tick.deltaX, 0)).toBe(0);
      expect(new Set(ticks.map(tick => tick.delayMs)).size).toBeGreaterThan(1);
    }
  });

  it('never returns pacing shorter than the documented minimum', () => {
    const random = seededRandom(1234);
    for (let index = 0; index < 200; index += 1) expect(jitteredInterval(72, random)).toBeGreaterThanOrEqual(72);
    const varied = new Set(Array.from({ length: 200 }, () => jitteredInterval(90, random)));
    expect(varied.size).toBeGreaterThan(20);
    expect(jitteredInterval(0, random)).toBe(0);
  });
});
