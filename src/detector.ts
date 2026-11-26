// Oracle state detector. Pure: no clock, no I/O. The runner feeds it ticks and
// evaluation times, so live operation and historical replay run the same code.
//
// What the API does not say is whether the deployer's oracle is currently
// following an external market or its own internal pricing. Two independent
// pieces of evidence are combined:
//   calendar  - is the underlying market open, per data/venues.json
//   behavior  - how the oracle has been moving over the last few minutes
// Observed on 2026-11-26 (US holiday): with the underlying closed, oracle
// updates were rare and every one of them moved toward the mark price; with the
// underlying open, updates were frequent and moved toward the mark about half
// the time. The thresholds below come from that single short sample and must be
// recalibrated once a week of data exists.

import type { Phase } from "./calendar.ts";

export interface DetectorConfig {
  windowMs: number;
  /** Minimum oracle updates in the window before behavior is judged at all. */
  minUpdates: number;
  /** Share of updates moving toward mark at or above which pricing looks internal. */
  internalToward: number;
  /** Share at or below which pricing looks external. */
  externalToward: number;
  staleMs: number;
  staleMinMarkChanges: number;
  /** Consecutive evaluations a new mode must hold before a switch is declared. */
  switchConfirmations: number;
  basisBreachBp: number;
  basisBreachZ: number;
  basisBreachHoldMs: number;
  /** Half-life of the per-mode basis baseline. */
  baselineHalfLifeMs: number;
  baselineMinSamples: number;
  oracleJumpBp: number;
  /** A step only counts as one oracle update if the two ticks are this close. */
  oracleJumpMaxGapMs: number;
  fundingExtreme: number;
  oiCapNear: number;
}

export const defaultConfig: DetectorConfig = {
  windowMs: 5 * 60_000,
  minUpdates: 6,
  internalToward: 0.9,
  externalToward: 0.7,
  staleMs: 15 * 60_000,
  staleMinMarkChanges: 5,
  switchConfirmations: 2,
  basisBreachBp: 50,
  basisBreachZ: 3,
  basisBreachHoldMs: 60_000,
  baselineHalfLifeMs: 6 * 3_600_000,
  baselineMinSamples: 120,
  oracleJumpBp: 100,
  oracleJumpMaxGapMs: 60_000,
  fundingExtreme: 0.0005,
  oiCapNear: 0.9,
};

export interface DTick {
  ts: number;
  oracle: number;
  mark: number;
  funding: number;
  openInterest: number;
}

export type Mode = "external" | "internal";
export type State = Mode | "transition" | "stale" | "unknown";
export type Behavior = Mode | "inconclusive";
export type Confidence = "both" | "behavior" | "calendar" | "none";

export interface SessionInput {
  /** "unknown" when the ticker has no identified underlying venue. */
  phase: Phase | "unknown";
  /** True within the configured margin of a scheduled open or close. */
  nearBoundary: boolean;
}

export interface OracleState {
  coin: string;
  ts: number;
  state: State;
  confidence: Confidence;
  calendar: SessionInput["phase"];
  behavior: Behavior;
  /** Calendar and behavior point at different modes. Usually means the calendar is wrong. */
  conflict: boolean;
  metrics: {
    basisBp: number;
    basisZ: number | null;
    funding1h: number;
    oracleUpdates: number;
    towardMark: number | null;
    secondsSinceOracleChange: number | null;
    oiCapUsage: number | null;
  };
}

export type EventKind =
  | "mode_switch"
  | "basis_breach"
  | "oracle_jump"
  | "oracle_stale"
  | "funding_extreme"
  | "oi_cap_near"
  | "calendar_conflict";

export interface DetectorEvent {
  coin: string;
  ts: number;
  kind: EventKind;
  detail: Record<string, number | string | null>;
}

interface Baseline {
  mean: number;
  variance: number;
  n: number;
}

export interface CoinMemory {
  window: DTick[];
  last: DTick | null;
  lastOracleChangeTs: number | null;
  markChangesSinceOracleChange: number;
  mode: Mode | null;
  candidate: Mode | null;
  candidateCount: number;
  baseline: Record<Mode, Baseline>;
  lastEvalTs: number | null;
  /** First tick since start or since the last data gap; switches are not reported until a full window has passed. */
  firstTs: number | null;
  /** Consecutive evaluations in which calendar and behavior disagreed. */
  conflictCount: number;
  /** Calendar phase that behavior has contradicted. While it lasts, the calendar alone cannot set the mode. */
  distrustedPhase: SessionInput["phase"] | null;
  breachSince: number | null;
  /** Conditions currently raised, so each is reported once per episode. */
  raised: Set<EventKind>;
  pendingJumps: DetectorEvent[];
}

export function newMemory(): CoinMemory {
  return {
    window: [],
    last: null,
    lastOracleChangeTs: null,
    markChangesSinceOracleChange: 0,
    mode: null,
    candidate: null,
    candidateCount: 0,
    baseline: { external: { mean: 0, variance: 0, n: 0 }, internal: { mean: 0, variance: 0, n: 0 } },
    lastEvalTs: null,
    firstTs: null,
    conflictCount: 0,
    distrustedPhase: null,
    breachSince: null,
    raised: new Set(),
    pendingJumps: [],
  };
}

export const basisBp = (t: Pick<DTick, "oracle" | "mark">): number => (t.mark / t.oracle - 1) * 10_000;

/** Feed one tick. Ticks must arrive in time order per coin. */
export function observe(mem: CoinMemory, coin: string, t: DTick, cfg: DetectorConfig = defaultConfig): void {
  const prev = mem.last;
  if (prev) {
    if (t.oracle !== prev.oracle) {
      const step = Math.abs(t.oracle / prev.oracle - 1) * 10_000;
      if (step >= cfg.oracleJumpBp && t.ts - prev.ts <= cfg.oracleJumpMaxGapMs) {
        mem.pendingJumps.push({
          coin, ts: t.ts, kind: "oracle_jump",
          detail: { stepBp: round(step), from: prev.oracle, to: t.oracle, mark: t.mark },
        });
      }
      mem.lastOracleChangeTs = t.ts;
      mem.markChangesSinceOracleChange = 0;
    } else if (t.mark !== prev.mark) {
      mem.markChangesSinceOracleChange++;
    }
  } else {
    mem.lastOracleChangeTs = t.ts;
  }
  mem.last = t;
  mem.firstTs ??= t.ts;
  mem.window.push(t);
}

/**
 * Call when the tick stream had a hole (collector down). Drops the window so
 * behavior is not judged across the hole; keeps the mode and baselines.
 */
export function resetAfterGap(mem: CoinMemory): void {
  mem.window = [];
  mem.last = null;
  mem.firstTs = null;
  mem.lastOracleChangeTs = null;
  mem.markChangesSinceOracleChange = 0;
  mem.candidate = null;
  mem.candidateCount = 0;
  mem.conflictCount = 0;
  mem.breachSince = null;
  mem.pendingJumps = [];
}

export interface WindowStats {
  updates: number;
  /** Of the updates made while mark differed from oracle, the share that moved toward mark. */
  towardMark: number | null;
}

export function windowStats(window: DTick[]): WindowStats {
  let updates = 0;
  let judged = 0;
  let toward = 0;
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1]!;
    const b = window[i]!;
    if (b.oracle === a.oracle) continue;
    updates++;
    if (a.mark === a.oracle) continue;
    judged++;
    if ((b.oracle - a.oracle) * (a.mark - a.oracle) > 0) toward++;
  }
  return { updates, towardMark: judged > 0 ? toward / judged : null };
}

export function judgeBehavior(s: WindowStats, cfg: DetectorConfig = defaultConfig): Behavior {
  if (s.updates < cfg.minUpdates || s.towardMark == null) return "inconclusive";
  if (s.towardMark >= cfg.internalToward) return "internal";
  if (s.towardMark <= cfg.externalToward) return "external";
  return "inconclusive";
}

const calendarMode = (p: SessionInput["phase"]): Mode | null =>
  p === "unknown" ? null : p === "closed" ? "internal" : "external";

const round = (x: number, d = 2): number => Math.round(x * 10 ** d) / 10 ** d;

export interface EvalInput {
  coin: string;
  now: number;
  session: SessionInput;
  /** Open-interest cap in USD notional for this coin, if the deployer publishes one. */
  oiCapUsd?: number;
}

/**
 * Evaluate one coin at `now`. Mutates `mem` (window trimming, baselines, raised
 * conditions) and returns the state plus any events that fired since the last call.
 */
export function evaluate(
  mem: CoinMemory,
  input: EvalInput,
  cfg: DetectorConfig = defaultConfig,
): { state: OracleState; events: DetectorEvent[] } {
  const { coin, now, session } = input;
  const events: DetectorEvent[] = mem.pendingJumps.splice(0);

  // Keep one tick from before the window so the first in-window update has a predecessor.
  const cut = now - cfg.windowMs;
  let drop = 0;
  while (drop + 1 < mem.window.length && mem.window[drop + 1]!.ts <= cut) drop++;
  if (drop > 0) mem.window.splice(0, drop);

  const last = mem.last;
  if (!last) {
    return {
      state: {
        coin, ts: now, state: "unknown", confidence: "none", calendar: session.phase,
        behavior: "inconclusive", conflict: false,
        metrics: { basisBp: 0, basisZ: null, funding1h: 0, oracleUpdates: 0, towardMark: null, secondsSinceOracleChange: null, oiCapUsage: null },
      },
      events,
    };
  }

  const stats = windowStats(mem.window);
  const behavior = judgeBehavior(stats, cfg);
  const cal = calendarMode(session.phase);
  const conflict = cal != null && behavior !== "inconclusive" && cal !== behavior;
  const sinceChange = mem.lastOracleChangeTs == null ? null : now - mem.lastOracleChangeTs;
  const isStale =
    sinceChange != null && sinceChange >= cfg.staleMs && mem.markChangesSinceOracleChange >= cfg.staleMinMarkChanges;

  // Behavior is what the oracle is actually doing, so it wins over the schedule.
  // Once behavior has contradicted a calendar phase, that phase is not trusted
  // again on its own: a quiet few minutes must not flip the mode back.
  mem.conflictCount = conflict ? mem.conflictCount + 1 : 0;
  if (conflict) mem.distrustedPhase = session.phase;
  else if (behavior !== "inconclusive" || session.phase !== mem.distrustedPhase) mem.distrustedPhase = null;
  const held = behavior === "inconclusive" && mem.distrustedPhase != null && mem.mode != null;
  const mode: Mode | null = behavior !== "inconclusive" ? behavior : held ? mem.mode : cal;
  let state: State;
  let confidence: Confidence;
  if (isStale) {
    state = "stale";
    confidence = "behavior";
  } else if (session.nearBoundary && behavior === "inconclusive") {
    state = "transition";
    confidence = "calendar";
  } else if (mode == null) {
    state = "unknown";
    confidence = "none";
  } else {
    state = mode;
    confidence = held ? "behavior" : behavior === "inconclusive" ? "calendar" : cal === behavior ? "both" : "behavior";
  }
  const warm = mem.firstTs != null && now - mem.firstTs >= cfg.windowMs;

  // Mode switch with hysteresis: only settled modes count, and a new one must repeat.
  if (state === "external" || state === "internal") {
    if (mem.mode == null || !warm) {
      // Until a full window has been seen the mode is only being established.
      mem.mode = state;
      mem.candidate = null;
      mem.candidateCount = 0;
    } else if (state !== mem.mode) {
      mem.candidateCount = mem.candidate === state ? mem.candidateCount + 1 : 1;
      mem.candidate = state;
      if (mem.candidateCount >= cfg.switchConfirmations) {
        events.push({
          coin, ts: now, kind: "mode_switch",
          detail: { from: mem.mode, to: state, confidence, basisBp: round(basisBp(last)) },
        });
        mem.mode = state;
        mem.candidate = null;
        mem.candidateCount = 0;
        mem.breachSince = null;
      }
    } else {
      mem.candidate = null;
      mem.candidateCount = 0;
    }
  }

  // Basis against the baseline for the current mode. z uses the baseline before this sample.
  const b = basisBp(last);
  let z: number | null = null;
  if (mem.mode) {
    const base = mem.baseline[mem.mode];
    if (base.n >= cfg.baselineMinSamples) {
      const sd = Math.sqrt(base.variance);
      z = (b - base.mean) / Math.max(sd, 0.5); // floor avoids huge z on a flat baseline
    }
    const dt = mem.lastEvalTs == null ? 0 : now - mem.lastEvalTs;
    const alpha = base.n === 0 ? 1 : 1 - 2 ** (-Math.max(dt, 1) / cfg.baselineHalfLifeMs);
    const diff = b - base.mean;
    base.mean += alpha * diff;
    base.variance = (1 - alpha) * (base.variance + alpha * diff * diff);
    base.n++;
  }
  mem.lastEvalTs = now;

  const breaching = Math.abs(b) >= cfg.basisBreachBp && z != null && Math.abs(z) >= cfg.basisBreachZ;
  if (breaching) {
    mem.breachSince ??= now;
    if (now - mem.breachSince >= cfg.basisBreachHoldMs && !mem.raised.has("basis_breach")) {
      mem.raised.add("basis_breach");
      events.push({ coin, ts: now, kind: "basis_breach", detail: { basisBp: round(b), z: round(z!), mode: mem.mode, heldMs: now - mem.breachSince } });
    }
  } else {
    mem.breachSince = null;
    mem.raised.delete("basis_breach");
  }

  const oiCapUsage = input.oiCapUsd ? (last.openInterest * last.mark) / input.oiCapUsd : null;
  const raise = (kind: EventKind, on: boolean, detail: DetectorEvent["detail"]) => {
    if (!on) return void mem.raised.delete(kind);
    if (mem.raised.has(kind)) return;
    mem.raised.add(kind);
    events.push({ coin, ts: now, kind, detail });
  };
  raise("oracle_stale", isStale, { seconds: sinceChange == null ? null : Math.round(sinceChange / 1000), markChanges: mem.markChangesSinceOracleChange });
  raise("funding_extreme", Math.abs(last.funding) >= cfg.fundingExtreme, { funding1h: last.funding, basisBp: round(b) });
  raise("oi_cap_near", oiCapUsage != null && oiCapUsage >= cfg.oiCapNear, { usage: oiCapUsage == null ? null : round(oiCapUsage, 3) });
  raise("calendar_conflict", warm && mem.conflictCount >= cfg.switchConfirmations, { calendar: session.phase, behavior, towardMark: stats.towardMark == null ? null : round(stats.towardMark), updates: stats.updates });

  return {
    state: {
      coin, ts: now, state, confidence, calendar: session.phase, behavior, conflict,
      metrics: {
        basisBp: round(b),
        basisZ: z == null ? null : round(z),
        funding1h: last.funding,
        oracleUpdates: stats.updates,
        towardMark: stats.towardMark == null ? null : round(stats.towardMark),
        secondsSinceOracleChange: sinceChange == null ? null : Math.round(sinceChange / 1000),
        oiCapUsage: oiCapUsage == null ? null : round(oiCapUsage, 3),
      },
    },
    events,
  };
}
