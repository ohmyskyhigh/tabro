/**
 * Human-like pointer, wheel and timing generation for Human Simulation Mode.
 * Pure and seedable so Broker behaviour is reproducible in tests.
 */
export type Random = () => number;

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random: Random, min: number, max: number): number => min + (max - min) * random();

/** Standard normal sample (Box-Muller). */
function normal(random: Random): number {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * The documented minimum interval plus a log-normally distributed extra delay.
 * The result never falls below `base`, so pacing minima stay guaranteed.
 */
export function jitteredInterval(base: number, random: Random): number {
  if (base <= 0) return 0;
  const extra = Math.min(Math.exp(normal(random) * 0.45) - 0.75, 1.1);
  return Math.round(base * (1 + Math.max(0, extra)));
}

export interface Point { readonly x: number; readonly y: number }
export interface TimedPoint extends Point { readonly delayMs: number }

const easeInOut = (t: number): number => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
  };
}

const round = (point: Point): Point => ({ x: Math.max(0, Math.round(point.x)), y: Math.max(0, Math.round(point.y)) });

/** A plausible in-viewport origin for the first pointer movement in a tab (never 0,0). */
export function initialPointer(target: Point, random: Random): Point {
  const angle = between(random, 0, 2 * Math.PI);
  const distance = between(random, 140, 360);
  return round({ x: Math.max(8, target.x + Math.cos(angle) * distance), y: Math.max(8, target.y + Math.sin(angle) * distance) });
}

/**
 * Expand one pointer movement into a curved, eased path with a small overshoot
 * and a landing point within two pixels of the target. The final point is the landing point.
 */
export function pointerPath(from: Point, target: Point, random: Random): TimedPoint[] {
  const landing = round({ x: target.x + Math.round(between(random, -2, 2)), y: target.y + Math.round(between(random, -2, 2)) });
  const dx = landing.x - from.x;
  const dy = landing.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 3) return [{ ...landing, delayMs: Math.round(between(random, 12, 30)) }];
  const normalX = distance === 0 ? 0 : -dy / distance;
  const normalY = distance === 0 ? 0 : dx / distance;
  const bend = between(random, -0.22, 0.22) * distance;
  const c1 = { x: from.x + dx * between(random, 0.2, 0.4) + normalX * bend, y: from.y + dy * between(random, 0.2, 0.4) + normalY * bend };
  const c2 = { x: from.x + dx * between(random, 0.6, 0.85) + normalX * bend * 0.5, y: from.y + dy * between(random, 0.6, 0.85) + normalY * bend * 0.5 };
  const overshoot = distance > 150 ? between(random, 0.03, 0.07) : 0;
  const end = overshoot > 0 ? { x: landing.x + dx * overshoot, y: landing.y + dy * overshoot } : landing;
  const steps = Math.max(6, Math.min(28, Math.round(distance / 22 + between(random, 2, 6))));
  const points: TimedPoint[] = [];
  let previous: Point | null = null;
  for (let index = 1; index <= steps; index += 1) {
    const point = round(bezier(from, c1, c2, end, easeInOut(index / steps)));
    if (previous && point.x === previous.x && point.y === previous.y) continue;
    points.push({ ...point, delayMs: Math.round(between(random, 8, 18)) });
    previous = point;
  }
  if (overshoot > 0) {
    const correction = Math.max(2, Math.round(between(random, 2, 4)));
    const last = points.at(-1) ?? from;
    for (let index = 1; index <= correction; index += 1) {
      const t = index / correction;
      points.push({ ...round({ x: last.x + (landing.x - last.x) * t, y: last.y + (landing.y - last.y) * t }), delayMs: Math.round(between(random, 14, 32)) });
    }
  }
  const final = points.at(-1);
  if (!final || final.x !== landing.x || final.y !== landing.y) points.push({ ...landing, delayMs: Math.round(between(random, 10, 24)) });
  return points;
}

/** Split one wheel request into a burst of uneven ticks that sum to the requested delta. */
export function wheelBurst(deltaX: number, deltaY: number, random: Random): Array<{ deltaX: number; deltaY: number; delayMs: number }> {
  const magnitude = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  const ticks = Math.max(1, Math.min(12, Math.ceil(magnitude / between(random, 80, 125))));
  const weights = Array.from({ length: ticks }, () => between(random, 0.75, 1.25));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let sentX = 0;
  let sentY = 0;
  return weights.map((weight, index) => {
    const last = index === ticks - 1;
    const x = last ? deltaX - sentX : Math.round(deltaX * weight / total);
    const y = last ? deltaY - sentY : Math.round(deltaY * weight / total);
    sentX += x;
    sentY += y;
    return { deltaX: x, deltaY: y, delayMs: Math.round(between(random, 35, 95)) };
  });
}

/** Reading pause after a wheel burst before the next control event. */
export const readingPause = (random: Random): number => Math.round(between(random, 300, 900));
