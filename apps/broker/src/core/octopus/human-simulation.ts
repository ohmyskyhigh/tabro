import { performance } from 'node:perf_hooks';

export interface HumanSimulationLimits {
  readonly dwellMs: number;
  readonly extraDwellPerEvaluateMs: number;
  readonly freeEvaluates: number;
  readonly wheelPx: number;
  readonly hovers: number;
  readonly loadIntervalMs: number;
  readonly pagesBeforeRest: number;
  readonly restMsMin: number;
  readonly restMsMax: number;
  readonly probeIntervalMs: number;
  readonly graceMs: number;
}

/** Accepted 2026-11-19 Human Simulation defaults. Non-user-configurable in contract 8. */
export const HUMAN_SIMULATION_LIMITS: HumanSimulationLimits = {
  dwellMs: 4_000,
  extraDwellPerEvaluateMs: 500,
  freeEvaluates: 3,
  wheelPx: 1_600,
  hovers: 3,
  loadIntervalMs: 6_000,
  pagesBeforeRest: 30,
  restMsMin: 120_000,
  restMsMax: 300_000,
  probeIntervalMs: 1_500,
  graceMs: 8_000
};

export interface ActivityDebt {
  readonly evaluates: number;
  readonly firstEvaluateAt: number;
  readonly wheelPx: number;
  readonly hoverPoints: number;
  readonly missing_dwell_ms: number;
  readonly missing_wheel_px: number;
  readonly missing_hovers: number;
}

interface TabLedger {
  evaluates: number;
  firstEvaluateAt: number | null;
  wheelPx: number;
  hovers: Set<string>;
  lastUrl: string | null;
  navigatedAt: number;
  sinceProbe: number;
}

interface DomainPace {
  loads: number;
  lastLoadAt: number;
  restUntil: number;
}

export interface PaceDecision {
  readonly waitMs: number;
  readonly earliestAt: string;
}

export interface VerificationState {
  tabRef: string;
  workspaceRef: string;
  endpointRef: string;
  signature: string;
  evidence: string;
  detectedAt: number;
  paused: boolean;
  since: number;
}

/** Per-tab activity debt, per-domain pacing and per-tab verification state for Human Simulation Mode. */
export class HumanSimulationController {
  private readonly tabs = new Map<string, TabLedger>();
  private readonly paces = new Map<string, DomainPace>();
  private readonly verifications = new Map<string, VerificationState>();
  private readonly limits: HumanSimulationLimits;
  constructor(limits: Partial<HumanSimulationLimits> = {}) { this.limits = { ...HUMAN_SIMULATION_LIMITS, ...limits }; }

  private ledger(tabRef: string): TabLedger {
    let value = this.tabs.get(tabRef);
    if (!value) {
      value = { evaluates: 0, firstEvaluateAt: null, wheelPx: 0, hovers: new Set(), lastUrl: null, navigatedAt: 0, sinceProbe: 0 };
      this.tabs.set(tabRef, value);
    }
    return value;
  }

  /** A committed navigation to a fresh document clears the previous document's debt. */
  noteNavigation(tabRef: string, url: string, at = performance.now()): void {
    const ledger = this.ledger(tabRef);
    if (ledger.lastUrl !== url) {
      ledger.evaluates = 0;
      ledger.firstEvaluateAt = null;
      ledger.wheelPx = 0;
      ledger.hovers = new Set();
      ledger.lastUrl = url;
      ledger.navigatedAt = at;
      ledger.sinceProbe = 0;
    }
  }

  noteEvaluate(tabRef: string, at = performance.now()): void {
    const ledger = this.ledger(tabRef);
    ledger.evaluates += 1;
    ledger.firstEvaluateAt ??= at;
  }

  noteWheel(tabRef: string, deltaY: number): void {
    const ledger = this.ledger(tabRef);
    ledger.wheelPx += Math.abs(Math.round(deltaY));
  }

  noteHover(tabRef: string, x: number, y: number): void {
    const ledger = this.ledger(tabRef);
    ledger.hovers.add(`${Math.round(x / 24)}:${Math.round(y / 24)}`);
  }

  debt(tabRef: string, at = performance.now()): ActivityDebt | null {
    const ledger = this.ledger(tabRef);
    if (ledger.evaluates === 0 || ledger.firstEvaluateAt === null) return null;
    const required = this.limits.dwellMs
      + Math.max(0, ledger.evaluates - this.limits.freeEvaluates) * this.limits.extraDwellPerEvaluateMs;
    const dwell = Math.max(0, required - (at - ledger.firstEvaluateAt));
    const wheel = Math.max(0, this.limits.wheelPx - ledger.wheelPx);
    const hovers = Math.max(0, this.limits.hovers - ledger.hovers.size);
    if (dwell === 0 && wheel === 0 && hovers === 0) return null;
    return {
      evaluates: ledger.evaluates, firstEvaluateAt: ledger.firstEvaluateAt, wheelPx: ledger.wheelPx,
      hoverPoints: ledger.hovers.size, missing_dwell_ms: Math.round(dwell), missing_wheel_px: Math.round(wheel), missing_hovers: hovers
    };
  }

  /** Minimum spacing and periodic rest for top-level document loads on one Human Simulation domain. */
  pace(domain: string, at = performance.now()): PaceDecision | null {
    let value = this.paces.get(domain);
    if (!value) {
      value = { loads: 0, lastLoadAt: 0, restUntil: 0 };
      this.paces.set(domain, value);
    }
    if (at < value.restUntil) {
      return { waitMs: Math.ceil(value.restUntil - at), earliestAt: new Date(Date.now() + Math.ceil(value.restUntil - at)).toISOString() };
    }
    if (value.lastLoadAt > 0 && at - value.lastLoadAt < this.limits.loadIntervalMs) {
      const waitMs = Math.ceil(this.limits.loadIntervalMs - (at - value.lastLoadAt));
      return { waitMs, earliestAt: new Date(Date.now() + waitMs).toISOString() };
    }
    return null;
  }

  noteLoad(domain: string, at = performance.now(), random = Math.random): void {
    let value = this.paces.get(domain);
    if (!value) {
      value = { loads: 0, lastLoadAt: 0, restUntil: 0 };
      this.paces.set(domain, value);
    }
    value.loads += 1;
    value.lastLoadAt = at;
    if (value.loads > this.limits.pagesBeforeRest) {
      const span = this.limits.restMsMax - this.limits.restMsMin;
      value.restUntil = at + this.limits.restMsMin + Math.floor(random() * span);
      value.loads = 0;
    }
  }

  /** Records a detection; the pause itself follows once the grace period confirms it persisted. */
  noteDetection(scope: { tabRef: string; workspaceRef: string; endpointRef: string }, signature: string, evidence: string, at = performance.now()): VerificationState {
    const current = this.verifications.get(scope.tabRef);
    if (current && current.signature === signature) {
      current.evidence = evidence;
      current.workspaceRef = scope.workspaceRef;
      current.endpointRef = scope.endpointRef;
      return current;
    }
    const created: VerificationState = { ...scope, signature, evidence, detectedAt: at, paused: current?.paused ?? false, since: at };
    this.verifications.set(scope.tabRef, created);
    return created;
  }

  detection(tabRef: string): VerificationState | null { return this.verifications.get(tabRef) ?? null; }
  get gracePeriodMs(): number { return this.limits.graceMs; }
  clearDetection(tabRef: string): void { this.verifications.delete(tabRef); }
  markPaused(tabRef: string): void { const state = this.verifications.get(tabRef); if (state) state.paused = true; }
  shouldProbe(tabRef: string, at = performance.now()): boolean {
    const ledger = this.ledger(tabRef);
    return at - ledger.sinceProbe >= this.limits.probeIntervalMs;
  }
  markProbed(tabRef: string, at = performance.now()): void { this.ledger(tabRef).sinceProbe = at; }

  /** Drops the in-memory ledger for a tab whose workspace ended. */
  forget(tabRefs: readonly string[]): void {
    const removed = new Set(tabRefs);
    for (const tabRef of removed) { this.tabs.delete(tabRef); this.verifications.delete(tabRef); }
  }
}
